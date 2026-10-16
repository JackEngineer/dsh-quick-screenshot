# 上架 DSH 插件市场：完整步骤（本插件已改到位）

市场的插件列表**不在市场仓库里**。`dshmarket` 每次打开都实时拉取
[awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json)，数据源是精选列表仓库
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)——
**一个插件一个 YAML 文件**。所以「发到市场」= 给自己的仓库提一个收录 PR，站点和市场通常一天内生效。
官方投稿指南：[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

> **当前状态（2026-10-16 21:15 +08:00）**
>
> 仓库已创建并推送：<https://github.com/JackEngineer/dsh-quick-screenshot>（public，已加 `dsh-plugin` topic）。
> 仓库 `createdAt` = `2026-10-16T13:15:04Z`，列表要求「创建满 1 天」（CI 里 `MIN_AGE_DAYS = 1`），
> 因此**最早可提收录 PR 的时间是 2026-10-17 21:15（+08:00）**。
> 投稿所需的其余部分已全部备好：已 fork `awesome-dsh-plugin/awesome-dsh-plugin` 到
> `JackEngineer/awesome-dsh-plugin`，分支 `add-dsh-quick-screenshot` 已从 upstream `main`
> 建好并放上 `data/plugins/JackEngineer__dsh-quick-screenshot.yml`（已完成 YAML 与列表
> `scripts/lib/entries.mjs` 的字段/文件名/slug 校验），PR 正文在 [market/PR-body.md](market/PR-body.md)。
> **剩下的只有到点执行下面第 4 步的那一条 `gh pr create`。**

### 已经用列表自己的检查脚本预跑过（2026-10-16）

把上游的 `scripts/check-submission.mjs` 与其依赖 `scripts/lib/entries.mjs` 原样拉到
`%TEMP%\dsh-gate` 跑了一遍（`--base` 用 upstream `main` 的 `44310b7`）：

- `validateEntries(readEntries('data/plugins'))` → `problems: []`：**条目本身零问题**
  （文件名 = URL 的 slug、`name` = `owner/repo`、`category` 属于固定集合、只含允许键、`description.en` 有值）；
- `check-submission.mjs` → 唯一失败项就是仓库年龄，脚本自己给的结论是
  `repository is 0.0 days old (needs 1) — the age bar is the only thing failing here`
  （即 `dsh.bundle`、仓库存在、未被归档、非 DSH 本身这几项都已通过）；
- 另外确认了 `pr-check.yml` 的形态要求：本 PR 是 **+1/-0 个条目文件、且不改生成的 README**，
  正是它明确支持的提交形态（stale-fork guard 只在删除 >2 条时失败；README 一步在未改动时
  会自动重新生成再放行）；
- 上游 `data/plugins/JackEngineer__dsh-quick-screenshot.yml` 目前不存在（404），目录快照里也没有
  `JackEngineer` 条目 —— 没有重名或重复收录的冲突。

## 已经为你改好的部分

| 项 | 状态 |
| --- | --- |
| 包名 / bundle id / 模块行名 | 统一为 **`dsh-quick-screenshot`**（原名 `dsh-plugin-screenshot` 已被他人在 npm 占用，且与市场里已有条目 `dsh-screenshot-plugin` 极易混淆） |
| Fetch 路由 | `/api/quick-screenshot`（避开与同类插件共用 `/api/screenshot` 的冲突；客户端已同步） |
| `package.json` | 已加 `repository` / `homepage` / `bugs` / `author`；`dsh.bundle` + `dsh.client` 齐备 |
| 商店截图 | 已加根目录 [screenshots.json](screenshots.json) → `docs/composer-button.png`（相对路径不跳出插件目录，1–8 张的规则满足） |
| 目录条目 | 已按列表格式写好，可直接复制：[market/JackEngineer__dsh-quick-screenshot.yml](market/JackEngineer__dsh-quick-screenshot.yml) |
| 依赖 | 零运行时依赖（只用 Node 内置模块 + 平台自带截图工具），无需 `allowBuilds` 构建授权 |
| 官方 `@deepseek-ai/*` 包 | 没有依赖，因此不涉及 peer range 的预发布坑 |

## 同类竞争（写描述时必须体现的差别）

市场里已有一条截图插件：[deepseekbluefish/dsh-screenshot-plugin](https://github.com/deepseekbluefish/dsh-screenshot-plugin)
（分类 `ui`，微信式**框选**截图、仅 Windows、只往输入框写一条 `[Shot N HH:mm]` 文本标记）。
收录规则是同类条目「谁更好谁上」，评审会拿代码核对描述。本插件的差别：

- **整体截取 DSH 窗口**（`PrintWindow`，被遮挡也能截），不是拖框选区；
- **点击即把图片作为附件放进草稿**（走 composer 自带的 `createDrafts` + `addAttachments`），不是写文本标记；
- 带 `Ctrl+Shift+S`；`Shift`/`Alt` 点击可截整屏或当前窗口；
- 除 Windows 外另有 macOS（`screencapture`）与 Linux 后端；
- 零依赖、无构建步骤。

## 第 1 步：建 GitHub 仓库

仓库名建议与包名一致：`JackEngineer/dsh-quick-screenshot`。根目录就是本插件目录
（`package.json` 与 `cordis.patch.yml` 必须在根）。

```sh
cd dsh-quick-screenshot
git init -b main
git add -A
git commit -m "dsh-quick-screenshot 1.0.0"
gh repo create JackEngineer/dsh-quick-screenshot --public --source . --remote origin --push
# 加列表要求的 topic
gh repo edit JackEngineer/dsh-quick-screenshot --add-topic dsh-plugin
```

两条硬门槛：

1. 仓库必须**创建满 1 天**才能提 PR（CI 自动检查）；
2. 仓库必须有 **`dsh-plugin`** topic。

本插件没有构建步骤（无 `prepare`/`build` 脚本），所以别人 `dsh plugin add github:JackEngineer/dsh-quick-screenshot`
直接从源码装，不会触发 `allowBuilds` 构建授权。

## 第 2 步（可选）：发 npm 或挂 tarball

**不发也能上架**（列表里大量条目的 `npm` 为 `null`）。发了的好处是市场能显示下载量并参与排序。

```sh
npm publish --access public        # 名称 dsh-quick-screenshot 已核实可用（未被占用）
```

- 已发布包的 `package.json` 里 `repository` **必须**指回被收录的仓库（已填好），否则两者不关联；
- 条目 YAML 里**不要**手写 `npm:` 字段，映射由 CI 从 registry 自动采集，手写会被校验拒绝。

不发 npm 的替代方案：把预构建 tgz 挂到 GitHub Release，并在条目里加一行
`tarball: https://github.com/JackEngineer/dsh-quick-screenshot/releases/latest/download/dsh-quick-screenshot.tgz`
（必须 https + GitHub Release 托管；资产名**不要带版本号**，否则下次发版 `latest/download/` 就 404）。

## 第 3 步：截图（已完成）

`package.json` 旁边的 [screenshots.json](screenshots.json) 列出仓库内的相对路径（1–8 张、不能以 `/` 开头、不能含 `..`）。
市场详情页按此顺序展示；以后换图只推自己的仓库即可，下一次构建生效，不用再来提 PR。

## 第 4 步：提收录 PR

在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 里**新增一个文件**：

```
data/plugins/JackEngineer__dsh-quick-screenshot.yml
```

**这一步已经替你做好**（fork、分支、文件都就位），到点只需要开 PR：

```sh
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --head JackEngineer:add-dsh-quick-screenshot \
  --title "Add dsh-quick-screenshot" \
  --body-file market/PR-body.md
```

开 PR 前若 upstream 的 `main` 已经前进，先同步 fork（GitHub 只做快进，不会动这个分支）：

```sh
gh api -X POST repos/JackEngineer/awesome-dsh-plugin/merge-upstream -f branch=main
```

内容就是仓库里已经写好的那份（[market/JackEngineer__dsh-quick-screenshot.yml](market/JackEngineer__dsh-quick-screenshot.yml)）：

```yaml
url: https://github.com/JackEngineer/dsh-quick-screenshot
name: JackEngineer/dsh-quick-screenshot
category: ui
description:
  en: 'One-click screenshot button in the composer tool row that captures the DeepSeek Harness window (or the whole desktop with a modifier) using the host capture tooling and drops the PNG straight into the composer draft as an attachment. Windows-verified, with macOS and Linux backends; no dependencies and no build step.'
  zh: '输入框工具行里的一键截图按钮：用宿主侧工具截取 DeepSeek Harness 窗口（按住修饰键可截整个桌面），PNG 直接作为附件落进输入框草稿。Windows 实测，另带 macOS/Linux 后端；零依赖、无构建步骤。'
```

字段与文件名已对齐列表的 `scripts/lib/entries.mjs`：文件名必须等于 URL 的 slug
（`owner__repo`）、`name` 必须是 `owner/repo`、`category` 必须取自固定集合、只允许
`url`/`name`/`category`/`description`/`tarball` 这几个键。

注意：

- 一个 PR **最多 3 条**；**不要手工改生成出来的 README**（`data/plugins/*.yml` 是唯一数据源）；
- 描述里出现「冒号 + 空格」必须加引号（英文描述已加），中文全角冒号无此问题；
- 描述会被当作对代码的声明逐条核对，**不要夸大**；
- 分类 `ui` 是输入框工具行控件最贴切的分类；选偏了维护者会直接改，不会打回。

## 第 5 步：CI 检查与合并

每个 PR 依次检查：条目数 ≤ 3 → 仓库 `package.json` 声明 **`dsh.bundle`**（已有）→ 仓库创建满 1 天 →
`awesome-lint` 与站点构建（双语一致性、分隔符、日期、截图）。失败会说明改什么，同一分支 push 修复即可。

合并后站点自动重建，`plugins.json` 由 CI 每日刷新，市场打开即实时拉到新条目；
用户看到的安装命令形如：

```sh
dsh plugin --profile web add github:JackEngineer/dsh-quick-screenshot
```

## 提交前自检清单

- [x] `package.json` 同时有 `dsh.bundle.patch` 和 `dsh.client`，根目录有 `cordis.patch.yml`
- [x] 仓库内有真实可用的代码（Host + Client，两套测试全绿）
- [x] `screenshots.json` 路径都在仓库内
- [x] `repository` 指回 `https://github.com/JackEngineer/dsh-quick-screenshot`
- [x] npm 包名 `dsh-quick-screenshot` 未被占用
- [x] 条目 YAML 已按列表格式写好（`market/` 目录）
- [x] 仓库已创建、已加 `dsh-plugin` topic（第 1 步，2026-10-16 21:15 +08:00）
- [ ] 仓库创建满 1 天后提 PR（第 4 步，最早 2026-10-17 21:15 +08:00）
