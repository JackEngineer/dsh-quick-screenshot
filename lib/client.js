/**
 * `dsh-quick-screenshot` — Client half.
 *
 * A hand-written module-loader bundle (no build step). It adds two controls that
 * share one capture path:
 *
 *   - `shell.overlay` — a **floating camera button** over the whole window, so a
 *     screenshot works on any page, not only where a composer happens to be;
 *   - `conversation.input.left` — the same control in the composer tool row.
 *
 * Where the image goes depends on what is on screen:
 *
 *   - a composer is mounted → its draft takes the PNG through the shipped
 *     `ctx.conversation.createDrafts` + `inputActions.addAttachments` path (the
 *     one paste and drop use), so the next message carries the image;
 *   - no composer is mounted → the PNG goes to the clipboard, ready to paste
 *     into whatever composer the reader navigates to.
 *
 * A click never steals the keyboard, and `Ctrl+Shift+S` is the same action from
 * the keyboard wherever the reader is.
 */
window.__ModuleLoader__.load({
	id: "dsh-quick-screenshot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** The route owned by this package's Host half. */
		const ENDPOINT = "/api/quick-screenshot";
		/** Composer tool-row entry id. */
		const ENTRY_ID = "screenshot.capture";
		/** Floating frame-wide entry id. */
		const FLOAT_ID = "screenshot.float";
		/** Order inside the composer's left tool row. */
		const ENTRY_ORDER = 6;
		/** Order inside the frame-wide overlay layer. */
		const FLOAT_ORDER = 60;
		/** The composer editor the fallback paste targets. */
		const EDITOR_SELECTOR = '[data-composer-input="true"]';
		/** The composer card an occurrence belongs to. */
		const CARD_SELECTOR = "[data-composer-card]";
		/** Surfaces the chord must never fire from. */
		const BLOCKED_SELECTOR = '[role="dialog"],[aria-modal="true"],iframe,.xterm,[inert]';
		/** Chord handled wherever the floating control is mounted. */
		const SHORTCUT = { code: "KeyS", control: true, shift: true };
		/** How long a result note stays on screen, in milliseconds. */
		const NOTE_MS = 2600;
		/** Pointer travel that turns a press on the floating control into a drag. */
		const DRAG_THRESHOLD = 4;
		/** Gap kept between the floating control and the viewport edges. */
		const EDGE_GAP = 10;
		/** Diameter of the floating control. */
		const FAB_SIZE = 36;
		/** Where the floating control remembers its position. */
		const FLOAT_POSITION_KEY = "dsh-quick-screenshot.float.position";
		/** Capture targets selected by the click modifier. */
		const MODE_WINDOW = "window";
		const MODE_ACTIVE = "active";
		const MODE_SCREEN = "screen";

		/** Copy for the two shipped UI languages. */
		const TEXT = {
			zh: {
				action: "截图并放入输入框",
				floatAction: "截图",
				hint: "点击：DSH 窗口 · Shift+点击：整个屏幕 · Alt+点击：当前窗口",
				floatHint:
					"任意页面可用：有输入框时直接放进草稿，没有输入框时放进剪贴板。\n点击：DSH 窗口 · Shift+点击：整个屏幕 · Alt+点击：当前窗口 · 拖动可移动",
				done: "已放入输入框",
				copied: "已复制到剪贴板",
				copiedHint: "到对话页直接粘贴即可",
				copyFailed: "已截图，但无法写入剪贴板",
				copyFailedHint: "请在对话页用输入框里的相机按钮或 Ctrl+Shift+S 重新截取",
				partial: "已截取，但未能放入输入框",
				unsupported: "此平台暂不支持截图",
				failed: "截图失败",
			},
			en: {
				action: "Screenshot into the composer",
				floatAction: "Screenshot",
				hint: "Click: the DSH window · Shift+click: the whole desktop · Alt+click: the active window",
				floatHint:
					"Works on every page: with a composer the shot lands in the draft, without one it goes to the clipboard.\nClick: the DSH window · Shift+click: the whole desktop · Alt+click: the active window · drag to move",
				done: "Added to the composer",
				copied: "Copied to the clipboard",
				copiedHint: "paste it into the conversation",
				copyFailed: "Captured, but the clipboard refused it",
				copyFailedHint: "take the shot again from the composer button or with Ctrl+Shift+S",
				partial: "Captured, but could not reach the composer",
				unsupported: "Screenshot capture is unavailable on this platform",
				failed: "Screenshot failed",
			},
		};

		const CSS = `
.dsh-shot-btn { appearance:none; display:inline-flex; align-items:center; justify-content:center;
  flex:none; width:26px; height:26px; padding:0; border:1px solid transparent; border-radius:6px;
  background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; font-family:inherit; }
.dsh-shot-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.dsh-shot-btn:disabled { cursor:progress; }
.dsh-shot-btn[data-phase="busy"] { opacity:.65; }
.dsh-shot-btn[data-phase="done"] { color:var(--dsw-alias-state-success-primary); }
.dsh-shot-btn[data-phase="error"] { color:var(--dsw-alias-state-error-primary); }
.dsh-shot-note { align-self:center; margin-left:6px; font-size:11px; line-height:16px; max-width:13em;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary); }
.dsh-shot-note[data-phase="done"] { color:var(--dsw-alias-state-success-primary); }
.dsh-shot-note[data-phase="error"] { color:var(--dsw-alias-state-error-primary); }
.dsh-shot-spin { animation:dsh-shot-rotate .9s linear infinite; transform-origin:50% 50%; }
@keyframes dsh-shot-rotate { to { transform:rotate(360deg); } }
.dsh-shot-float { position:fixed; z-index:9990; display:flex; align-items:center; gap:8px;
  -webkit-app-region:no-drag; }
.dsh-shot-fab { appearance:none; display:inline-flex; align-items:center; justify-content:center;
  flex:none; width:36px; height:36px; padding:0; border-radius:50%; cursor:pointer; font-family:inherit;
  color:var(--dsw-alias-label-secondary); background:var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1));
  border:1px solid var(--dsw-alias-border-l1); box-shadow:var(--dsw-elevation-soft); touch-action:none; }
.dsh-shot-fab:hover:not(:disabled) { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); }
.dsh-shot-fab:disabled { opacity:.65; cursor:progress; }
.dsh-shot-fab[data-phase="done"] { color:var(--dsw-alias-state-success-primary); }
.dsh-shot-fab[data-phase="error"] { color:var(--dsw-alias-state-error-primary); }
.dsh-shot-bubble { max-width:220px; padding:6px 10px; border-radius:8px; font-size:12px; line-height:18px;
  color:var(--dsw-alias-label-secondary); background:var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1));
  border:1px solid var(--dsw-alias-border-l1); box-shadow:var(--dsw-elevation-prominent);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-shot-bubble[data-phase="done"] { color:var(--dsw-alias-state-success-primary); }
.dsh-shot-bubble[data-phase="error"] { color:var(--dsw-alias-state-error-primary); }
`;

		/** The active language's copy, defaulting to Chinese when it cannot be read. */
		function text(locale) {
			try {
				const snapshot = locale === undefined || locale === null ? undefined : locale.getLocale();
				const active = snapshot === undefined ? undefined : snapshot.active;
				const id = typeof active === "string" ? active : active === undefined || active === null ? "" : String(active.id ?? "");
				if (id !== "" && !/^zh/iu.test(id)) return TEXT.en;
			} catch {
				/* an unreadable locale keeps the default copy */
			}
			return TEXT.zh;
		}

		/** Error text of an unknown thrown value. */
		function reasonOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/** `20261016-203045`, matching the Host's own staging stamp. */
		function stamp() {
			const now = new Date();
			const pad = (value) => String(value).padStart(2, "0");
			return [
				`${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
				`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
			].join("-");
		}

		/** The draft file name the model and the attachment rail both read. */
		function fileName() {
			return `dsh-screenshot-${stamp()}.png`;
		}

		/** Capture description carried by the response header, when present. */
		function readMeta(response) {
			try {
				const raw = response.headers.get("x-screenshot");
				if (raw === null) return null;
				const parsed = JSON.parse(decodeURIComponent(raw));
				return typeof parsed === "object" && parsed !== null ? parsed : null;
			} catch {
				return null;
			}
		}

		/** ` · 1282×821`, or empty when the Host reported no size. */
		function describe(meta) {
			if (meta === null || typeof meta.width !== "number" || typeof meta.height !== "number") return "";
			return ` · ${String(meta.width)}×${String(meta.height)}`;
		}

		/** The staged file path the Host reported, when it sent one. */
		function stagedPath(meta) {
			return meta !== null && typeof meta.path === "string" && meta.path !== "" ? meta.path : "";
		}

		/** One capture request against this package's Host route. */
		async function captureShot(options) {
			const copy = options.copy ?? TEXT.zh;
			const request = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
			if (request === undefined) return { ok: false, phase: "error", message: copy.partial };

			let response;
			try {
				response = await request(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						mode: options.mode ?? MODE_WINDOW,
						...(options.titlePattern === undefined ? {} : { titlePattern: options.titlePattern }),
					}),
				});
			} catch (error) {
				return { ok: false, phase: "error", message: `${copy.failed}：${reasonOf(error)}` };
			}

			if (response.ok !== true) {
				let detail = `HTTP ${String(response.status)}`;
				try {
					const body = await response.json();
					if (typeof body?.error === "string" && body.error !== "") detail = body.error;
					if (body?.code === "CAPTURE_UNSUPPORTED") detail = copy.unsupported;
				} catch {
					/* the status line is the whole answer */
				}
				return { ok: false, phase: "error", message: `${copy.failed}：${detail}` };
			}

			let blob;
			try {
				blob = await response.blob();
			} catch (error) {
				return { ok: false, phase: "error", message: `${copy.failed}：${reasonOf(error)}` };
			}
			if (blob.size === 0) return { ok: false, phase: "error", message: `${copy.failed}：空图像` };

			const meta = readMeta(response);
			const file = new File([blob], fileName(), { type: blob.type === "" ? "image/png" : blob.type });
			return { ok: true, file, meta };
		}

		/**
		 * Hand one browser file to the composer through the shipped paste intake.
		 * @param file - the captured PNG.
		 * @returns true when a composer editor accepted the synthetic paste.
		 */
		function pasteIntoComposer(file) {
			try {
				if (typeof document === "undefined" || typeof DataTransfer !== "function") return false;
				const editor = document.querySelector(EDITOR_SELECTOR);
				if (editor === null || typeof editor.dispatchEvent !== "function") return false;
				const transfer = new DataTransfer();
				transfer.items.add(file);
				editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
				return true;
			} catch {
				return false;
			}
		}

		/** Put the captured PNG on the system clipboard. */
		async function copyShot(file) {
			try {
				if (typeof navigator === "undefined" || navigator.clipboard === undefined || typeof ClipboardItem !== "function") return false;
				const type = file.type === "" ? "image/png" : file.type;
				await navigator.clipboard.write([new ClipboardItem({ [type]: file })]);
				return true;
			} catch {
				return false;
			}
		}

		/**
		 * Admit one captured file into a mounted composer's draft.
		 * @param record - the composer control's services.
		 * @param file - the captured PNG.
		 * @param meta - capture description from the Host.
		 * @param copy - active language's copy.
		 * @returns the result the control renders.
		 */
		function attachInto(record, file, meta, copy) {
			const conversation = record.conversation;
			const inputActions = record.inputActions;
			const canDraft =
				conversation !== undefined &&
				conversation !== null &&
				typeof conversation.createDrafts === "function" &&
				inputActions !== undefined &&
				inputActions !== null &&
				typeof inputActions.addAttachments === "function";
			if (canDraft) {
				let drafts;
				try {
					drafts = conversation.createDrafts(record.sessionId, [file]);
				} catch (error) {
					return { ok: false, phase: "error", message: `${copy.failed}：${reasonOf(error)}`, meta };
				}
				const ids = (Array.isArray(drafts) ? drafts : []).map((draft) => draft.id);
				if (ids.length === 0) return { ok: false, phase: "error", message: copy.partial, meta };
				let admitted = false;
				try {
					admitted = inputActions.addAttachments(ids) !== false;
				} catch (error) {
					return { ok: false, phase: "error", message: `${copy.failed}：${reasonOf(error)}`, meta };
				}
				if (!admitted) {
					try {
						if (typeof conversation.releaseDraftAttachments === "function") {
							conversation.releaseDraftAttachments(Array.isArray(drafts) ? drafts : []);
						}
					} catch {
						/* the draft is already unusable; nothing else to release */
					}
					return { ok: false, phase: "error", message: copy.partial, meta };
				}
				return { ok: true, phase: "done", message: `${copy.done}${describe(meta)}`, meta, where: "draft" };
			}
			if (pasteIntoComposer(file)) return { ok: true, phase: "done", message: `${copy.done}${describe(meta)}`, meta, where: "paste" };
			return { ok: false, phase: "error", message: copy.partial, meta };
		}

		/**
		 * Capture once and deliver the image where it can be used: the mounted
		 * composer's draft when there is one, the clipboard when there is not.
		 * @param options - capture mode, copy and an optional fetch for tests.
		 * @returns the result the calling control renders.
		 */
		async function deliver(options) {
			const copy = options.copy ?? TEXT.zh;
			const record = composerTarget();
			const shot = await captureShot({ mode: options.mode, titlePattern: options.titlePattern, copy, fetch: options.fetch });
			if (shot.ok !== true) return shot;
			if (record !== null) return attachInto(record, shot.file, shot.meta, copy);
			if (await copyShot(shot.file)) {
				return {
					ok: true,
					phase: "done",
					message: `${copy.copied}${describe(shot.meta)}`,
					detail: copy.copiedHint,
					meta: shot.meta,
					where: "clipboard",
				};
			}
			const path = stagedPath(shot.meta);
			return {
				ok: false,
				phase: "error",
				message: `${copy.copyFailed}${describe(shot.meta)}${path === "" ? "" : ` · ${path}`}`,
				detail: copy.copyFailedHint,
				meta: shot.meta,
			};
		}

		/** The click mode a pointer event selects. */
		function modeOf(event) {
			if (event !== undefined && event !== null) {
				if (event.altKey === true) return MODE_ACTIVE;
				if (event.shiftKey === true) return MODE_SCREEN;
			}
			return MODE_WINDOW;
		}

		/* ------------------------------------------------------------------ */
		/* composer registry, shared chord, and the floating control's position */
		/* ------------------------------------------------------------------ */

		/** Every mounted composer control, in mounting order. */
		const composers = new Set();
		/** The floating control's capture entry point, installed while it is mounted. */
		let floatUi = null;
		/** Whether the shared window listener is installed. */
		let listening = false;

		/** The composer card one mounted control lives in. */
		function cardOf(record) {
			const node = record.node();
			if (node === null) return null;
			try {
				return node.closest(CARD_SELECTOR);
			} catch {
				return null;
			}
		}

		/** Whether the focused element belongs to a dialog, terminal or frame. */
		function blocked() {
			if (typeof document === "undefined") return true;
			const active = document.activeElement;
			if (active === null || active === undefined || typeof active.closest !== "function") return false;
			try {
				return active.closest(BLOCKED_SELECTOR) !== null;
			} catch {
				return false;
			}
		}

		/**
		 * Pick the composer that should receive the image: the one whose card holds
		 * the keyboard focus, otherwise the first visible one, otherwise any.
		 * @returns the chosen record, or null when no composer is mounted.
		 */
		function composerTarget() {
			const active = typeof document === "undefined" ? null : document.activeElement;
			let firstVisible = null;
			for (const record of composers) {
				const node = record.node();
				if (node === null) continue;
				const card = cardOf(record);
				if (card !== null && active !== null && card.contains(active)) return record;
				if (firstVisible === null && node.isConnected !== false && node.offsetParent !== null) firstVisible = record;
			}
			return firstVisible ?? composers.values().next().value ?? null;
		}

		/** The shared keydown handler: the floating control's own action. */
		function onKeyDown(event) {
			if (event.code !== SHORTCUT.code || event.ctrlKey !== SHORTCUT.control || event.shiftKey !== SHORTCUT.shift) return;
			if (event.altKey === true || event.metaKey === true || event.repeat === true || event.defaultPrevented === true) return;
			if (event.isComposing === true || blocked() || floatUi === null) return;
			event.preventDefault();
			void floatUi.run(MODE_WINDOW);
		}

		/** Install the shared listener while the floating control is mounted. */
		function retainShortcutListener() {
			if (listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
			listening = true;
			window.addEventListener("keydown", onKeyDown, true);
		}

		/** Drop the shared listener once the floating control unmounts. */
		function releaseShortcutListener() {
			if (!listening || floatUi !== null || typeof window === "undefined") return;
			listening = false;
			window.removeEventListener("keydown", onKeyDown, true);
		}

		/** Viewport size with stub-friendly fallbacks. */
		function viewport() {
			const width = typeof window === "undefined" || !Number.isFinite(window.innerWidth) ? 1280 : window.innerWidth;
			const height = typeof window === "undefined" || !Number.isFinite(window.innerHeight) ? 800 : window.innerHeight;
			return { width, height };
		}

		/** Keep the floating control fully inside the viewport. */
		function clampPosition(position) {
			const { width, height } = viewport();
			const maxX = Math.max(EDGE_GAP, width - FAB_SIZE - EDGE_GAP);
			const maxY = Math.max(EDGE_GAP, height - FAB_SIZE - EDGE_GAP);
			const x = Number.isFinite(position?.x) ? position.x : maxX;
			const y = Number.isFinite(position?.y) ? position.y : Math.round(height * 0.45);
			return {
				x: Math.min(Math.max(EDGE_GAP, x), maxX),
				y: Math.min(Math.max(EDGE_GAP, y), maxY),
			};
		}

		/** The remembered anchor, or the default right-edge position. */
		function loadPosition() {
			let stored = null;
			try {
				const raw = typeof window === "undefined" ? null : window.localStorage?.getItem(FLOAT_POSITION_KEY);
				if (typeof raw === "string" && raw !== "") stored = JSON.parse(raw);
			} catch {
				/* an unreadable or corrupt anchor falls back to the default */
			}
			return clampPosition(stored);
		}

		/** Remember the floating control's anchor. */
		function savePosition(position) {
			try {
				if (typeof window !== "undefined") window.localStorage?.setItem(FLOAT_POSITION_KEY, JSON.stringify(position));
			} catch {
				/* persistence is a convenience, never a requirement */
			}
		}

		/** Camera glyph; the floating control asks for a slightly larger one. */
		function CameraIcon(props) {
			const size = Number.isFinite(props?.size) ? props.size : 16;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
				h("path", {
					d: "M3 8.6A2.6 2.6 0 0 1 5.6 6h1.5a1.6 1.6 0 0 0 1.3-.65l.6-.8A1.6 1.6 0 0 1 10.3 3.9h3.4a1.6 1.6 0 0 1 1.3.65l.6.8A1.6 1.6 0 0 0 16.9 6h1.5A2.6 2.6 0 0 1 21 8.6v7.8A2.6 2.6 0 0 1 18.4 19H5.6A2.6 2.6 0 0 1 3 16.4z",
					stroke: "currentColor",
					strokeWidth: 1.7,
					strokeLinejoin: "round",
				}),
				h("circle", { cx: 12, cy: 12.2, r: 3.2, stroke: "currentColor", strokeWidth: 1.7 }),
			);
		}

		/** Busy glyph: an arc that spins while the Host captures. */
		function BusyIcon(props) {
			const size = Number.isFinite(props?.size) ? props.size : 16;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", className: "dsh-shot-spin" },
				h("path", { d: "M12 3.5a8.5 8.5 0 1 1-6 2.5", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" }),
			);
		}

		/** One capture's in-flight and result state, shared by both controls. */
		function useCaptureState(copy) {
			const [state, setState] = React.useState({ phase: "idle", message: "", detail: "" });
			const timer = React.useRef(null);
			const busy = React.useRef(false);

			const clearTimer = () => {
				if (timer.current !== null) {
					clearTimeout(timer.current);
					timer.current = null;
				}
			};

			const run = React.useCallback(
				async (mode) => {
					if (busy.current === true) return;
					busy.current = true;
					clearTimer();
					setState({ phase: "busy", message: "", detail: "" });
					let result;
					try {
						result = await deliver({ mode, copy });
					} catch (error) {
						result = { ok: false, phase: "error", message: `${copy.failed}：${reasonOf(error)}` };
					} finally {
						busy.current = false;
					}
					setState({ phase: result.ok === true ? "done" : "error", message: result.message, detail: result.detail ?? "" });
					timer.current = setTimeout(() => {
						timer.current = null;
						setState({ phase: "idle", message: "", detail: "" });
					}, NOTE_MS);
				},
				[copy],
			);

			React.useEffect(() => () => clearTimer(), []);

			return { state, run };
		}

		/**
		 * The composer tool-row control: the original inline camera button.
		 * @param props - standard composer props (sessionId, inputActions) plus this
		 * plugin's own `conversation` and `locale` injection.
		 */
		function ScreenshotButton(props) {
			const copy = text(props.locale);
			const { state, run } = useCaptureState(copy);
			const button = React.useRef(null);

			React.useEffect(() => {
				const record = {
					node: () => button.current,
					conversation: props.conversation,
					sessionId: props.sessionId,
					inputActions: props.inputActions,
				};
				composers.add(record);
				return () => composers.delete(record);
			}, [props.conversation, props.sessionId, props.inputActions]);

			const tooltip = `${copy.action}\n${copy.hint}${state.message === "" ? "" : `\n${state.message}`}`;
			return h(
				"span",
				{ style: { display: "contents" } },
				h(
					"button",
					{
						ref: button,
						type: "button",
						className: "dsh-shot-btn",
						"data-phase": state.phase,
						"data-dsh-screenshot": ENTRY_ID,
						disabled: state.phase === "busy",
						title: tooltip,
						"aria-label": copy.action,
						onMouseDown: (event) => event.preventDefault(),
						onClick: (event) => void run(modeOf(event)),
					},
					state.phase === "busy" ? h(BusyIcon, null) : h(CameraIcon, null),
				),
				state.message === "" ? null : h("span", { className: "dsh-shot-note", "data-phase": state.phase }, state.message),
			);
		}

		/**
		 * The frame-wide floating control: camera button, drag-to-move, transient
		 * result bubble, and the shared `Ctrl+Shift+S` chord.
		 * @param props - this plugin's `locale` injection.
		 */
		function FloatingShot(props) {
			const copy = text(props.locale);
			const { state, run } = useCaptureState(copy);
			const button = React.useRef(null);
			const drag = React.useRef(null);
			const dragged = React.useRef(false);
			const [position, setPosition] = React.useState(loadPosition);
			/** The live anchor: handlers read this, so a drag never depends on a stale render. */
			const anchor = React.useRef(position);
			/** Move the control and mirror the anchor for the next handler call. */
			const moveTo = (next) => {
				anchor.current = next;
				setPosition(next);
			};

			React.useEffect(() => {
				floatUi = { run };
				retainShortcutListener();
				return () => {
					floatUi = null;
					releaseShortcutListener();
				};
			}, [run]);

			React.useEffect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				const onResize = () => moveTo(clampPosition(anchor.current));
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);

			const onPointerDown = (event) => {
				dragged.current = false;
				drag.current = { x: event.clientX, y: event.clientY, originX: anchor.current.x, originY: anchor.current.y };
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch {
					/* capture is an optimization; the listeners still see the move */
				}
			};
			const onPointerMove = (event) => {
				const record = drag.current;
				if (record === null) return;
				const dx = event.clientX - record.x;
				const dy = event.clientY - record.y;
				if (!dragged.current && Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;
				dragged.current = true;
				moveTo(clampPosition({ x: record.originX + dx, y: record.originY + dy }));
			};
			const onPointerUp = () => {
				if (drag.current !== null && dragged.current) savePosition(anchor.current);
				drag.current = null;
			};
			const onClick = (event) => {
				if (dragged.current) {
					dragged.current = false;
					return;
				}
				void run(modeOf(event));
			};

			const tooltip = `${copy.floatHint}${state.message === "" ? "" : `\n${state.message}`}${state.detail === "" ? "" : `（${state.detail}）`}`;
			return h(
				"div",
				{ className: "dsh-shot-float", style: { left: `${String(position.x)}px`, top: `${String(position.y)}px` } },
				state.message === "" ? null : h("span", { className: "dsh-shot-bubble", "data-phase": state.phase }, state.message),
				h(
					"button",
					{
						ref: button,
						type: "button",
						className: "dsh-shot-fab",
						"data-phase": state.phase,
						"data-dsh-screenshot": FLOAT_ID,
						disabled: state.phase === "busy",
						title: tooltip,
						"aria-label": copy.floatAction,
						onMouseDown: (event) => event.preventDefault(),
						onPointerDown,
						onPointerMove,
						onPointerUp,
						onPointerCancel: onPointerUp,
						onClick,
					},
					state.phase === "busy" ? h(BusyIcon, { size: 18 }) : h(CameraIcon, { size: 18 }),
				),
			);
		}

		/** Required client services. */
		const inject = ["slots", "conversation", "locale"];

		/**
		 * Install the two controls and the styles they need.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(
				() => {
					const style = document.createElement("style");
					style.setAttribute("data-dsh-plugin", "screenshot");
					style.textContent = CSS;
					document.head.appendChild(style);
					return () => style.remove();
				},
				"screenshot: styles",
			);

			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: FLOAT_ID,
						order: FLOAT_ORDER,
						label: () => text(ctx.locale).floatAction,
						inject: () => ({ locale: ctx.locale }),
					},
					FloatingShot,
				),
			);

			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: ENTRY_ID,
						order: ENTRY_ORDER,
						label: () => text(ctx.locale).action,
						inject: () => ({ conversation: ctx.conversation, locale: ctx.locale }),
					},
					ScreenshotButton,
				),
			);
		}

		exports.ENTRY_ID = ENTRY_ID;
		exports.FLOAT_ID = FLOAT_ID;
		exports.ENDPOINT = ENDPOINT;
		exports.ScreenshotButton = ScreenshotButton;
		exports.FloatingShot = FloatingShot;
		exports.captureShot = captureShot;
		exports.attachInto = attachInto;
		exports.deliver = deliver;
		exports.copyShot = copyShot;
		exports.composerTarget = composerTarget;
		exports.pasteIntoComposer = pasteIntoComposer;
		exports.modeOf = modeOf;
		exports.text = text;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
