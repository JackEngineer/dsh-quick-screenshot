## What this adds

`dsh-quick-screenshot` — one camera control in the composer tool row that captures the **DeepSeek Harness window** (Shift+click: the whole desktop, Alt+click: the active window, or `Ctrl+Shift+S`) with the host's own capture tooling and drops the PNG **straight into the composer draft as an attachment**.

- Repository: <https://github.com/JackEngineer/dsh-quick-screenshot>
- Category: `ui`
- Entry: `data/plugins/JackEngineer__dsh-quick-screenshot.yml`

## Why it is not a duplicate

`deepseekbluefish/dsh-screenshot-plugin` is a WeChat-style **drag-a-region** picker (Windows only) that writes a `[Shot N HH:mm]` **text marker** into the composer. This plugin instead captures the whole window with `PrintWindow` (an occluded window still captures), attaches the image itself through the composer's own `createDrafts` + `addAttachments` path (the same path paste and drop use), and ships macOS (`screencapture`) and Linux backends as well.

## Requirements checked

- [x] `dsh.bundle` in `package.json` plus a root `cordis.patch.yml` (one row)
- [x] Real, working code: a Host half (one authenticated Fetch route plus the capture backends) and a Client half (the composer control), each with an offline test suite
- [x] Repository created more than 1 day before this pull request
- [x] `dsh-plugin` topic set on the repository
- [x] `screenshots.json` inside the repository (`docs/composer-button.png`)
- [x] No dependencies and no build step, so nothing needs install-time approval

## How it was verified

- `node scripts/selftest.mjs` — real captures through the route (PNG signature, IHDR size, metadata header, content length), the failure mapping for a missing capture shell, and staging-directory pruning
- `node scripts/client-smoke.mjs` — bundle registration, the admit path, a locked composer, a Host refusal, the paste fallback, and the shared `Ctrl+Shift+S` chord
- Live on DeepSeek Harness 0.2.0-rc.2 (desktop): `POST /api/quick-screenshot` returns a real PNG, the composer control registers as an active occupant of `conversation.input.left`, and one click on it puts the captured image into the draft as an attachment — verified in the running app, not only in the suites (`docs/composer-attached.png` is that result)
