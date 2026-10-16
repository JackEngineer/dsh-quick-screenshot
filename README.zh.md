# dsh-quick-screenshot

[English](README.md) | 中文

一键截取 DeepSeek Harness 窗口，并直接放进输入框草稿。

它是一个自包含的 DSH bundle：Host 半边用平台自带的工具截取 DSH 窗口（或指定窗口、整个桌面），通过一条带鉴权的 Fetch 路由把 PNG 交给页面；Client 半边是手写的 `./client` bundle。

## 它加了什么

| 位置 | 结果 |
| --- | --- |
| `conversation.input.left` | 输入框左侧工具行里的一个**相机控件**，就在 `+` 旁边 |

| 手势 | 截取目标 |
| --- | --- |
| 点击 | DeepSeek Harness 窗口（标题含 `DeepSeek Harness` 的最大可见窗口；找不到就用前台窗口） |
| Shift+点击 | 整个桌面（所有显示器） |
| Alt+点击 | 当前前台窗口 |
| `Ctrl+Shift+S` | 等同点击，作用于当前拥有键盘焦点的那个 composer |

每种手势的落点都一样：PNG 成为输入框里的草稿附件，下一条消息直接带着图。点击不会抢键盘——`mousedown` 已 preventDefault，光标留在原处。

控件就地汇报结果：宿主截图时转圈，之后几秒显示「已放入输入框」与截取尺寸，失败时显示宿主返回的原因；悬停提示里带着完整手势列表与最近一次结果。

## 图片怎么进到输入框

Client 半边走的是 composer 自己粘贴/拖拽时的同一条路：

1. `POST /api/quick-screenshot` 返回 PNG 字节（外加一小段元数据响应头）。
2. `ctx.conversation.createDrafts(sessionId, [file])` 登记这个浏览器文件并返回草稿 id。
3. 标准 prop `inputActions` 用 `addAttachments(ids)` 把这些 id 收进当前草稿——附件栏随即出现缩略图，发送时图片随消息一起序列化。

这些服务不可用时，客户端退回在 `[data-composer-input="true"]` 上派发一个携带该文件的合成 `paste` 事件——和手动粘贴走的是同一条路。

## 宿主路由

`GET /api/quick-screenshot` 说明当前宿主能截什么（`supported`、`platform`、`tool`、`modes`、`directory`）；`POST /api/quick-screenshot` 接受可选 JSON 体并返回 PNG：

```json
{ "mode": "window", "titlePattern": "DeepSeek Harness", "maxDimension": 0 }
```

| 字段 | 含义 |
| --- | --- |
| `mode` | `window`（默认）、`active` 或 `screen` |
| `titlePattern` | `window` 模式匹配的窗口标题，默认 `DeepSeek Harness` |
| `maxDimension` | 可选的最长边上限；`0` 保持原始截取尺寸 |

响应是 `image/png`，带 `Cache-Control: no-store`，并用一个 `X-Screenshot` 头携带 percent-encoded JSON 元数据（`mode`、`method`、`window`、`width`、`height`、`bytes`）。失败时返回 JSON，带稳定的 `code`（`CAPTURE_UNSUPPORTED`、`CAPTURE_TIMEOUT`、`CAPTURE_FAILED`、`METHOD_NOT_ALLOWED`）与面向使用者的说明。两种方法都通过 `ctx.connection.fetch` 注册，因此共享的 `/api` 桥会先做 Host/Origin 校验与浏览器 cookie 鉴权。

## 截图后端

| 平台 | 工具 | 说明 |
| --- | --- | --- |
| Windows | `powershell.exe` + `System.Drawing` | 先 `PrintWindow(PW_RENDERFULLCONTENT)`，被遮挡的窗口也能截；结果是一片纯色时，把窗口提到前台再按同一矩形读屏。Per-monitor-v2 DPI aware。 |
| macOS | `screencapture -x -o` | 整屏截取；`window`/`active` 都落到当前显示器。 |
| Linux | 依次尝试 `gnome-screenshot`、`spectacle`、`grim`、`import`、`scrot` | 整屏截取。 |

`DSH_SCREENSHOT_POWERSHELL` 可覆盖 Windows 使用的 shell（只装了 PowerShell 7 时有用）。

截图暂存在 `<tmpdir>/dsh-screenshot/`，目录只保留最新 24 个文件，因此插件不持有持久状态、也不会无限增长。同一时刻只截一张：并发点击排队，而不是抢跑。

## 安装

用 DSH 插件管理器的 `install_bundle` 指向本目录（本地路径 spec），或先用 pnpm 装好再写进 profile 的 `dsh.profile.bundles`。bundle 的 patch 插入一行 `id: screenshot`，指向本包。

从 GitHub 直接装，无构建步骤：

```sh
dsh plugin --profile web add github:JackEngineer/dsh-quick-screenshot
```

## 发布到插件市场

市场列表来自精选仓库 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，不在市场自己的仓库里——上架就是去那边提一个条目文件的 PR。[`PUBLISHING.md`](PUBLISHING.md) 写了完整路径（命名冲突、必需的 `dsh.bundle` manifest、`dsh-plugin` topic、仓库创建满 1 天的规则、条目 YAML、npm/tarball 选项与 CI 清单）。[`screenshots.json`](screenshots.json) 已经在本仓库内声明了商店截图。

新的 Loader 行会让 Host 半边随之加载。**之后修改 `lib/index.js` 需要重启一次 Host**，因为 Loader 在进程存活期间保留 Node 的模块缓存；`lib/client.js` 在行开关时会重新从磁盘读取（bundle 字节以 mtime、ctime、size 作为版本）。

## 测试

两套测试都离线运行、不需要浏览器：

```bash
node scripts/selftest.mjs        # 宿主路由与真实截图
node scripts/client-smoke.mjs    # 客户端 bundle、控件与附件流
```

`scripts/selftest.mjs` 用 Fetch `Request`/`Response` 驱动真实路由：capabilities、方法拒绝、通过 PowerShell 的**真实**窗口截图（PNG 签名、IHDR 尺寸、元数据头、content-length）、一次带尺寸上限的真实整屏截图、缺少截图 shell 时的失败映射，以及暂存目录裁剪。真实截图只在存在桌面会话与截图后端时执行；其它情况会标记为跳过，或用 `DSH_SCREENSHOT_SKIP_CAPTURE=1` 主动跳过。

`.github/workflows/test.yml` 在每次 push 与 PR 上带该标志跑两套测试，因此没有桌面的机器上仓库也能保持绿色。

`scripts/client-smoke.mjs` 用桩模块加载器、会执行 effect 的小型 React 桩与假的 composer 服务来评估 bundle：断言 `apply` 注册了什么，然后把 `captureInto` 依次跑过准入、输入框锁定、宿主拒绝、空图像与粘贴兜底，最后挂载控件并触发 `Ctrl+Shift+S` 组合键。

## 已知限制

- **窗口截图排除遮挡它的其它窗口，但也不含弹窗。** `PrintWindow` 渲染的是该窗口自身的内容；独立弹窗里画出的右键菜单不属于它。
- **按矩形读屏的兜底需要窗口在最上面。** 它只在 `PrintWindow` 返回纯色图时启用，且会先把目标窗口提到前台。
- **macOS 与 Linux 截的是整屏**，不是某个选定的窗口。
- **图片需要支持视觉的模型。** 纯文本模型会在发送时由 composer 自己的错误条拒绝该附件。
- **组合键是 Web 侧的。** 浏览器若保留了 `Ctrl+Shift+S`（另存为），它在页面看到之前就被吞掉；按钮始终可用。
- **Electron 桌面壳的页面由 `http://127.0.0.1:<port>` 提供**，因此 Client 半边在那里同样是同源请求 `/api/quick-screenshot`。
