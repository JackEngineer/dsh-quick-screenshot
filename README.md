# dsh-quick-screenshot

English | [中文](README.zh.md)

One-click screenshots of the DeepSeek Harness window, placed straight into the
composer draft.

It is one self-contained DSH bundle: a Host half that captures the DSH window (or
a window / the whole desktop) through the platform's own tooling and serves the
PNG over one authenticated Fetch route, and a hand-written Client half served as
the package's `./client` bundle.

## What it adds

| Seat | Result |
| --- | --- |
| `shell.overlay` | A **floating camera control** over the whole window, so a screenshot works on every page — not only where a composer happens to be mounted. Drag it anywhere; the anchor persists in `localStorage`. |
| `conversation.input.left` | The same control in the composer's left tool row, next to `+` |

| Gesture | Capture target |
| --- | --- |
| Click | The DeepSeek Harness window (largest visible window whose title contains `DeepSeek Harness`, falling back to the foreground window) |
| Shift+click | The whole desktop, every monitor |
| Alt+click | Whatever window is currently in the foreground |
| `Ctrl+Shift+S` | The same as a plain click, from anywhere on the page |

Where the image lands depends on what is on screen: a mounted composer's draft
takes it as an attachment, so the next message carries the image; with no
composer mounted the PNG goes to the clipboard, ready to paste into the
conversation the reader navigates to. A click never steals the keyboard —
`mousedown` is prevented, so the caret stays where it was.

The control reports what happened in place: a spinner while the Host captures,
`已放入输入框` with the captured pixel size for a few seconds afterwards, or the
Host's own refusal text when the capture failed. The tooltip carries the full
gesture list and the last result.

## Where the image goes

With a composer mounted, the Client half follows the path the composer's own
paste and drop intake take:

1. `POST /api/quick-screenshot` returns the PNG bytes (and a small metadata header).
2. `ctx.conversation.createDrafts(sessionId, [file])` registers the browser file
   and returns its draft id.
3. The `inputActions` standard prop admits those ids with
   `addAttachments(ids)` — the composer's rail then shows the thumbnail and the
   send serializes the image with the message.

With no composer mounted (the plugins page, Trajectory, Settings …) the same
capture is written to the system clipboard instead, and the result bubble says
so — paste it into a composer when the reader gets there. If the clipboard
refuses the write, the bubble names the staged PNG on disk instead.

When those services are unavailable, the client falls back to dispatching a
synthetic `paste` event carrying the file on `[data-composer-input="true"]`,
which is exactly what a manual paste does.

## Host route

`GET /api/quick-screenshot` describes what this Host can capture right now
(`supported`, `platform`, `tool`, `modes`, `directory`); `POST /api/quick-screenshot`
takes an optional JSON body and answers with the PNG:

```json
{ "mode": "window", "titlePattern": "DeepSeek Harness", "maxDimension": 0 }
```

| Field | Meaning |
| --- | --- |
| `mode` | `window` (default), `active`, or `screen` |
| `titlePattern` | Window title matched by `window` mode; defaults to `DeepSeek Harness` |
| `maxDimension` | Optional cap on the longest side; `0` keeps the native capture size |

The response is `image/png` with `Cache-Control: no-store` and one
`X-Screenshot` header carrying percent-encoded JSON metadata
(`mode`, `method`, `window`, `width`, `height`, `bytes`, `path`). Failures answer JSON
with a stable `code` (`CAPTURE_UNSUPPORTED`, `CAPTURE_TIMEOUT`, `CAPTURE_FAILED`,
`METHOD_NOT_ALLOWED`) and a message meant for the user. Both methods are
registered through `ctx.connection.fetch`, so the shared `/api` bridge applies
Host/Origin validation and browser-cookie authentication before the handler runs.

## Capture backends

| Platform | Tool | Notes |
| --- | --- | --- |
| Windows | `powershell.exe` + `System.Drawing` | `PrintWindow(PW_RENDERFULLCONTENT)` first, so an occluded window still captures; a flat result falls back to reading the same rectangle off the screen after raising the window. Per-monitor-v2 DPI aware. |
| macOS | `screencapture -x -o` | Display capture; `window`/`active` both resolve to the active display. |
| Linux | first of `gnome-screenshot`, `spectacle`, `grim`, `import`, `scrot` | Display capture. |

`DSH_SCREENSHOT_POWERSHELL` overrides the Windows shell (useful when only
PowerShell 7 is installed).

Captures are staged in `<tmpdir>/dsh-screenshot/`, and the directory keeps only
its newest 24 files, so the plugin owns no durable state and never grows
unbounded. One capture at a time: concurrent clicks queue instead of racing.

## Install

Run the DSH Plugin Manager's `install_bundle` against this directory (a local
path spec), or add it to the profile's `dsh.profile.bundles` after installing it
with pnpm. The bundle's patch inserts one row, `id: screenshot`, naming this
package.

From a GitHub checkout, no build step is involved:

```sh
dsh plugin --profile web add github:JackEngineer/dsh-quick-screenshot
```

## Publishing to the plugin market

The market lists plugins from the curated
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
list, not from its own repository — publishing means opening one entry-file PR
there. [`PUBLISHING.md`](PUBLISHING.md) has the whole path (naming conflicts, the
required `dsh.bundle` manifest, the `dsh-plugin` topic, the 1-day repository age
rule, the entry YAML, npm/tarball options, and the CI checklist).
[`screenshots.json`](screenshots.json) already declares this plugin's storefront
screenshots from inside the repository.

The Host half loads with the new Loader row. **Changing `lib/index.js` afterwards
needs a Host restart**, because the Loader keeps Node's module cache for the life
of the process; `lib/client.js` re-reads from disk on a row toggle (bundle bytes
are revisioned by mtime, ctime and size).

## Tests

Both suites run offline and need no browser:

```bash
node scripts/selftest.mjs        # the Host route and real captures
node scripts/client-smoke.mjs    # the Client bundle, control and attach flow
```

`scripts/selftest.mjs` drives the real route with Fetch `Request`/`Response`
objects: capabilities, method rejection, a **real** window capture through
PowerShell (PNG signature, IHDR size, metadata header, content length), a real
capped screen capture, the failure mapping for a missing capture shell, and
staging-directory pruning. Real captures run where a desktop session and a
capture backend exist; elsewhere they are reported as skipped, or skipped on
purpose with `DSH_SCREENSHOT_SKIP_CAPTURE=1`.

`.github/workflows/test.yml` runs both suites on every push and pull request with
that flag set, so the repository keeps a green check on a machine that has no
desktop.

`scripts/client-smoke.mjs` evaluates the bundle against a stub module loader, a
small React stub that runs effects, and fake composer services: it asserts what
`apply` registers (both seats), then drives the shared delivery path through the
admit path, a locked composer, a Host refusal, an empty image, and the paste
fallback, plus the no-composer clipboard path and a refused clipboard. Finally it
mounts both controls: the composer button captures on click and keeps focus, the
floating control drags past its threshold (persisting the anchor) and suppresses
the click that ended a drag, and the shared `Ctrl+Shift+S` chord fires it.

## Known limitations

- **Window capture excludes overlapping windows but not popups.** `PrintWindow`
  renders the window's own content; an open context menu drawn in a separate
  popup window is not part of it.
- **The screen rectangle fallback needs the window on top.** It is only used when
  `PrintWindow` returns a flat image, and it raises the target window first.
- **macOS and Linux capture the display**, not one chosen window.
- **Images need an image-capable model.** A text-only model refuses the
  attachment at send time with the composer's own error banner.
- **The chord is a web chord.** A browser that reserves `Ctrl+Shift+S` (Save as)
  absorbs it before the page sees it; the button always works.
- **The Electron desktop shell is served over `http://127.0.0.1:<port>`**, so the
  Client half reaches `/api/quick-screenshot` as a same-origin request there as well.
