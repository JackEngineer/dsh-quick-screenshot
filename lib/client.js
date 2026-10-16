/**
 * `dsh-quick-screenshot` — Client half.
 *
 * A hand-written module-loader bundle (no build step). It adds one camera
 * control to the composer tool row (`conversation.input.left`) that asks this
 * package's Host half for a screenshot of the DeepSeek Harness window (or the
 * whole desktop) and drops the returned PNG straight into the composer draft,
 * so the next message carries the image without a detour through the clipboard
 * or the file dialog.
 *
 * The image is attached through the shipped composer APIs:
 * `ctx.conversation.createDrafts(sessionId, [file])` registers the browser file
 * and the `inputActions` standard prop admits the resulting ids into the
 * current draft — the same path the composer's own paste and drop intake take.
 * A synthetic `paste` event on the composer editor is the fallback when those
 * services are unavailable.
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
		/** Stable entry id inside the composer's left tool row. */
		const ENTRY_ID = "screenshot.capture";
		/** Where the button sits among the composer's left controls. */
		const ENTRY_ORDER = 6;
		/** The composer editor the fallback paste targets. */
		const EDITOR_SELECTOR = '[data-composer-input="true"]';
		/** The composer card an occurrence belongs to. */
		const CARD_SELECTOR = "[data-composer-card]";
		/** Chord handled while a composer control is mounted. */
		const SHORTCUT = { code: "KeyS", control: true, shift: true };
		/** How long a result note stays on screen, in milliseconds. */
		const NOTE_MS = 2400;
		/** Capture targets selected by the click modifier. */
		const MODE_WINDOW = "window";
		const MODE_ACTIVE = "active";
		const MODE_SCREEN = "screen";

		/** Copy for the two shipped UI languages. */
		const TEXT = {
			zh: {
				action: "截图并放入输入框",
				hint: "点击：DSH 窗口 · Shift+点击：整个屏幕 · Alt+点击：当前窗口",
				done: "已放入输入框",
				partial: "已截取，但未能放入输入框",
				unsupported: "此平台暂不支持截图",
				failed: "截图失败",
			},
			en: {
				action: "Screenshot into the composer",
				hint: "Click: the DSH window · Shift+click: the whole desktop · Alt+click: the active window",
				done: "Added to the composer",
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

		/** A short description of what was captured, for the button's tooltip. */
		function describe(meta) {
			if (meta === null || typeof meta.width !== "number" || typeof meta.height !== "number") return "";
			const where = typeof meta.window === "string" && meta.window !== "" ? ` · ${meta.window}` : "";
			return ` · ${String(meta.width)}×${String(meta.height)}${where}`;
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

		/**
		 * Capture one screenshot and put it into the composer draft.
		 * @param options - conversation service, session, admit actions and mode.
		 * @returns a result describing what happened, for the button's note.
		 */
		async function captureInto(options) {
			const copy = options.copy ?? TEXT.zh;
			const request = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
			if (request === undefined) return { ok: false, message: copy.partial, phase: "error" };

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
				return { ok: false, message: `${copy.failed}：${error instanceof Error ? error.message : String(error)}`, phase: "error" };
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
				return { ok: false, message: `${copy.failed}：${detail}`, phase: "error" };
			}

			let blob;
			try {
				blob = await response.blob();
			} catch (error) {
				return { ok: false, message: `${copy.failed}：${error instanceof Error ? error.message : String(error)}`, phase: "error" };
			}
			if (blob.size === 0) return { ok: false, message: `${copy.failed}：空图像`, phase: "error" };

			const meta = readMeta(response);
			const file = new File([blob], fileName(), { type: blob.type === "" ? "image/png" : blob.type });

			const conversation = options.conversation;
			const inputActions = options.inputActions;
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
					drafts = conversation.createDrafts(options.sessionId, [file]);
				} catch (error) {
					return { ok: false, message: `${copy.failed}：${error instanceof Error ? error.message : String(error)}`, phase: "error" };
				}
				const ids = (Array.isArray(drafts) ? drafts : []).map((draft) => draft.id);
				if (ids.length === 0) return { ok: false, message: copy.partial, phase: "error" };
				let admitted = false;
				try {
					admitted = inputActions.addAttachments(ids) !== false;
				} catch (error) {
					return { ok: false, message: `${copy.failed}：${error instanceof Error ? error.message : String(error)}`, phase: "error" };
				}
				if (!admitted) {
					try {
						if (typeof conversation.releaseDraftAttachments === "function") {
							conversation.releaseDraftAttachments(Array.isArray(drafts) ? drafts : []);
						}
					} catch {
						/* the draft is already unusable; nothing else to release */
					}
					return { ok: false, message: copy.partial, phase: "error" };
				}
				return { ok: true, message: `${copy.done}${describe(meta)}`, phase: "done", meta };
			}

			if (pasteIntoComposer(file)) return { ok: true, message: `${copy.done}${describe(meta)}`, phase: "done", meta };
			return { ok: false, message: copy.partial, phase: "error" };
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
		/* one chord, whichever composer occurrence currently owns the keyboard */
		/* ------------------------------------------------------------------ */

		/** Every mounted composer control, in document order of mounting. */
		const mounted = new Set();
		/** The single window listener the mounted controls share. */
		let listening = false;

		/** Surfaces the chord must never fire from. */
		const BLOCKED_SELECTOR = '[role="dialog"],[aria-modal="true"],iframe,.xterm,[inert]';

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
		 * Pick the control that should answer the chord: the one whose composer
		 * holds the keyboard focus, otherwise the first visible one.
		 * @returns the chosen record, or null when no control is mounted.
		 */
		function chooseShortcutTarget() {
			const active = typeof document === "undefined" ? null : document.activeElement;
			let firstVisible = null;
			for (const record of mounted) {
				const node = record.node();
				if (node === null) continue;
				const card = cardOf(record);
				if (card !== null && active !== null && card.contains(active)) return record;
				if (firstVisible === null && node.isConnected !== false && node.offsetParent !== null) firstVisible = record;
			}
			return firstVisible ?? mounted.values().next().value ?? null;
		}

		/** The shared keydown handler. */
		function onKeyDown(event) {
			if (event.code !== SHORTCUT.code || event.ctrlKey !== SHORTCUT.control || event.shiftKey !== SHORTCUT.shift) return;
			if (event.altKey === true || event.metaKey === true || event.repeat === true || event.defaultPrevented === true) return;
			if (event.isComposing === true || blocked()) return;
			const record = chooseShortcutTarget();
			if (record === null) return;
			event.preventDefault();
			void record.run(MODE_WINDOW);
		}

		/** Install the shared listener while at least one control is mounted. */
		function retainShortcutListener() {
			if (listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
			listening = true;
			window.addEventListener("keydown", onKeyDown, true);
		}

		/** Drop the shared listener once the last control unmounts. */
		function releaseShortcutListener() {
			if (!listening || mounted.size > 0 || typeof window === "undefined") return;
			listening = false;
			window.removeEventListener("keydown", onKeyDown, true);
		}

		/** Camera glyph for the idle and result states. */
		function CameraIcon() {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
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
		function BusyIcon() {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", className: "dsh-shot-spin" },
				h("path", { d: "M12 3.5a8.5 8.5 0 1 1-6 2.5", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" }),
			);
		}

		/**
		 * The composer tool-row control: one camera button plus a transient note.
		 * @param props - standard composer props (sessionId, inputActions) plus this
		 * plugin's own `conversation` and `copy` injection.
		 */
		function ScreenshotButton(props) {
			const sessionId = props.sessionId;
			const inputActions = props.inputActions;
			const conversation = props.conversation;
			const copy = props.copy ?? TEXT.zh;
			const [state, setState] = React.useState({ phase: "idle", message: "" });
			const button = React.useRef(null);
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
					setState({ phase: "busy", message: "" });
					let result;
					try {
						result = await captureInto({ conversation, sessionId, inputActions, mode, copy });
					} catch (error) {
						result = { ok: false, message: `${copy.failed}：${error instanceof Error ? error.message : String(error)}` };
					} finally {
						busy.current = false;
					}
					setState({ phase: result.ok === true ? "done" : "error", message: result.message });
					timer.current = setTimeout(() => {
						timer.current = null;
						setState({ phase: "idle", message: "" });
					}, NOTE_MS);
				},
				[conversation, sessionId, inputActions, copy],
			);

			React.useEffect(() => {
				const record = { node: () => button.current, run: (mode) => run(mode) };
				mounted.add(record);
				retainShortcutListener();
				return () => {
					mounted.delete(record);
					releaseShortcutListener();
				};
			}, [run]);

			React.useEffect(() => () => clearTimer(), []);

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

		/** Required client services. */
		const inject = ["slots", "conversation", "locale"];

		/**
		 * Install the composer control and the styles it needs.
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

			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: ENTRY_ID,
						order: ENTRY_ORDER,
						label: () => text(ctx.locale).action,
						inject: () => ({ conversation: ctx.conversation, copy: text(ctx.locale) }),
					},
					ScreenshotButton,
				),
			);
		}

		exports.ENTRY_ID = ENTRY_ID;
		exports.ENDPOINT = ENDPOINT;
		exports.ScreenshotButton = ScreenshotButton;
		exports.captureInto = captureInto;
		exports.modeOf = modeOf;
		exports.text = text;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
