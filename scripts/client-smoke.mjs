/**
 * Client-half smoke test for `dsh-quick-screenshot`.
 *
 * It wires the package's own Client bundle into Node without a browser:
 *
 *   1. a stub `window.__ModuleLoader__.load` captures the bundle definition;
 *   2. a small React stub supplies `createElement`, the hooks the controls use,
 *      and runs effects so mount/unmount behavior is observable;
 *   3. a fake plugin context records what `apply` registers — the composer
 *      control and the frame-wide floating control;
 *   4. the shared delivery path is driven for both destinations: a mounted
 *      composer's draft, and the clipboard when no composer is mounted;
 *   5. the floating control renders, drags (persisting its anchor), and answers
 *      the shared `Ctrl+Shift+S` chord.
 *
 * Usage:
 *   node scripts/client-smoke.mjs
 */

let failures = 0;

/** Assert one condition. */
function must(label, condition, detail) {
	if (condition) {
		console.log(`  ok   ${label}`);
		return true;
	}
	failures += 1;
	console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
	return false;
}

/** Assert deep equality. */
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) console.log(`  ok   ${label} = ${JSON.stringify(actual)}`);
	else {
		failures += 1;
		console.error(`  FAIL ${label} = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
	}
}

/* -------------------------------------------------------------------------- */
/* browser stubs                                                              */
/* -------------------------------------------------------------------------- */

const windowListeners = new Map();
const storage = new Map();
let pasteInto = null;

const editorStub = {
	dispatchEvent(event) {
		pasteInto = event;
		return true;
	},
};

const documentStub = {
	head: { appendChild() {} },
	activeElement: null,
	createElement: () => ({ setAttribute() {}, remove() {}, textContent: "" }),
	querySelector: (selector) => (selector === '[data-composer-input="true"]' ? editorStub : null),
	addEventListener() {},
	removeEventListener() {},
};

globalThis.document = documentStub;
globalThis.window = {
	__ModuleLoader__: { load() {} },
	innerWidth: 1280,
	innerHeight: 800,
	localStorage: {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
	},
	addEventListener(type, listener) {
		windowListeners.set(type, listener);
	},
	removeEventListener(type) {
		windowListeners.delete(type);
	},
};

globalThis.DataTransfer = class {
	constructor() {
		this.items = { list: [], add: (file) => this.items.list.push(file) };
	}
};
globalThis.ClipboardEvent = class {
	constructor(type, init) {
		this.type = type;
		Object.assign(this, init);
	}
};
globalThis.ClipboardItem = class {
	constructor(items) {
		this.items = items;
	}
};
const clipboard = { written: [], refuse: false, async write(items) {
	if (this.refuse) throw new Error('NotAllowedError: Document is not focused');
	this.written.push(...items);
} };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true });

/** Effects the React stub ran, in call order, with their cleanups. */
const effectCleanups = [];

const React = {
	createElement(type, props, ...children) {
		const flat = [];
		const push = (value) => {
			for (const child of Array.isArray(value) ? value : [value]) {
				if (child === null || child === undefined) continue;
				if (Array.isArray(child)) push(child);
				else flat.push(child);
			}
		};
		push(children);
		const merged = Object.assign({}, props);
		if (flat.length > 0) merged.children = flat;
		return { type, props: merged };
	},
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useRef: (initial) => ({ current: initial }),
	useCallback: (fn) => fn,
	useEffect: (fn) => {
		const cleanup = fn();
		if (typeof cleanup === 'function') effectCleanups.push(cleanup);
	},
};

/* -------------------------------------------------------------------------- */
/* loading the bundle                                                         */
/* -------------------------------------------------------------------------- */

let definition = null;
globalThis.window.__ModuleLoader__.load = (value) => {
	definition = value;
};

const { readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const bundlePath = join(import.meta.dirname, '..', 'lib', 'client.js');
new Function(readFileSync(bundlePath, 'utf8'))();

console.log('bundle');
must('the bundle registers itself with the module loader', definition !== null);
check('the bundle id matches the package', definition?.id, 'dsh-quick-screenshot');
must('the factory is callable', typeof definition?.factory === 'function');

const exportsOf = definition.factory((name) => {
	if (name === 'react') return React;
	throw new Error(`unexpected client module request: ${name}`);
});
const { ENDPOINT, ENTRY_ID, FLOAT_ID, deliver, captureShot, attachInto, composerTarget, text, copyShot } = exportsOf;

console.log('exports');
check('endpoint', ENDPOINT, '/api/quick-screenshot');
check('composer entry id', ENTRY_ID, 'screenshot.capture');
check('floating entry id', FLOAT_ID, 'screenshot.float');
check('required services', exportsOf.inject, ['slots', 'conversation', 'locale']);
must('exports apply', typeof exportsOf.apply === 'function');
must('exports both controls', typeof exportsOf.ScreenshotButton === 'function' && typeof exportsOf.FloatingShot === 'function');

/* -------------------------------------------------------------------------- */
/* apply registers both seats                                                 */
/* -------------------------------------------------------------------------- */

console.log('apply');
const registrations = [];
const ctx = {
	locale: { getLocale: () => ({ active: 'zh-CN' }) },
	conversation: { createDrafts: () => [] },
	effect(run) {
		const cleanup = run();
		if (typeof cleanup === 'function') effectCleanups.push(cleanup);
		return () => {};
	},
	slots: {
		inject(key, callback) {
			registrations.push({ key, registration: callback() });
			return () => {};
		},
		register(meta, component) {
			return { meta, component, dispose() {} };
		},
	},
};
exportsOf.apply(ctx);

check('two slot injections', registrations.length, 2);
check('frame-wide seat', registrations[0]?.key, 'shell.overlay');
check('frame-wide entry id', registrations[0]?.registration.meta.id, FLOAT_ID);
check('frame-wide occupant', registrations[0]?.registration.component, exportsOf.FloatingShot);
check('composer seat', registrations[1]?.key, 'conversation.input.left');
check('composer entry id', registrations[1]?.registration.meta.id, ENTRY_ID);
check('composer occupant', registrations[1]?.registration.component, exportsOf.ScreenshotButton);
const injectedProps = registrations[1]?.registration.meta.inject();
must('composer injection carries the conversation service', typeof injectedProps.conversation === 'object');
check('injection carries the locale service', typeof injectedProps.locale, 'object');
const floatProps = registrations[0]?.registration.meta.inject();
must('the floating control needs no conversation service', floatProps.conversation === undefined, JSON.stringify(floatProps));

/* -------------------------------------------------------------------------- */
/* captureShot                                                                */
/* -------------------------------------------------------------------------- */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const META = {
	ok: true,
	mode: 'window',
	method: 'printwindow',
	window: '会话 — DeepSeek Harness',
	width: 1282,
	height: 821,
	bytes: PNG.byteLength,
	path: 'C:\\Users\\x\\AppData\\Local\\Temp\\dsh-screenshot\\shot-1.png',
};

/** One fake Fetch response. */
function fakeResponse(options = {}) {
	const status = options.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name) => options.headers?.[String(name).toLowerCase()] ?? null },
		async blob() {
			return new Blob([PNG], { type: 'image/png' });
		},
		async json() {
			if (options.json === undefined) throw new Error('no body');
			return options.json;
		},
	};
}

/** One fake conversation service. */
function fakeConversation() {
	const record = { created: [], released: [] };
	const service = {
		createDrafts(sessionId, files) {
			record.created.push({ sessionId, files });
			return files.map((file, index) => ({ kind: 'image', id: `draft-${String(index)}`, file }));
		},
		releaseDraftAttachments(drafts) {
			record.released.push(...drafts.map((draft) => draft.id));
		},
	};
	return { service, record };
}

/** The zh copy the controls use. */
const ZH = text({ getLocale: () => ({ active: 'zh-CN' }) });

console.log('captureShot');
{
	const requests = [];
	const shot = await captureShot({
		mode: 'window',
		copy: ZH,
		fetch: async (url, init) => {
			requests.push({ url, init });
			return fakeResponse({ headers: { 'x-screenshot': encodeURIComponent(JSON.stringify(META)) } });
		},
	});
	must('a capture succeeds', shot.ok === true, JSON.stringify(shot));
	check('the Host route was called once', requests.length, 1);
	check('the request target', requests[0].url, ENDPOINT);
	check('the requested mode', JSON.parse(requests[0].init.body).mode, 'window');
	check('the file media type', shot.file.type, 'image/png');
	check('the file size', shot.file.size, PNG.byteLength);
	must('the file name is stamped', /^dsh-screenshot-\d{8}-\d{6}\.png$/u.test(shot.file.name), shot.file.name);
	check('the metadata survives', shot.meta.path, META.path);
}
{
	const refused = await captureShot({
		copy: ZH,
		fetch: async () => fakeResponse({ status: 501, json: { ok: false, error: 'capture shell not found', code: 'CAPTURE_UNSUPPORTED' } }),
	});
	must('a refusal is reported', refused.ok === false, JSON.stringify(refused));
	must('the unsupported copy is used', refused.message.includes('暂不支持'), refused.message);
	const generic = await captureShot({
		copy: ZH,
		fetch: async () => fakeResponse({ status: 500, json: { ok: false, error: 'no visible target window', code: 'CAPTURE_FAILED' } }),
	});
	must('the Host message reaches the user', generic.message.includes('no visible target window'), generic.message);
	const empty = await captureShot({
		copy: ZH,
		fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, blob: async () => new Blob([]) }),
	});
	must('an empty capture is reported', empty.ok === false, JSON.stringify(empty));
}

/* -------------------------------------------------------------------------- */
/* attachInto                                                                 */
/* -------------------------------------------------------------------------- */

console.log('attachInto: admit path');
{
	const { service, record } = fakeConversation();
	const admitted = [];
	const result = attachInto(
		{ conversation: service, sessionId: 'session-1', inputActions: { addAttachments: (ids) => { admitted.push(...ids); return true; } } },
		new File([new Blob([PNG], { type: 'image/png' })], 'shot.png', { type: 'image/png' }),
		META,
		ZH,
	);
	must('the capture is admitted', result.ok === true, JSON.stringify(result));
	check('the draft belongs to the current session', record.created[0].sessionId, 'session-1');
	check('the draft id was admitted', admitted, ['draft-0']);
	must('the result names the captured size', result.message.includes('1282×821'), result.message);
	check('the destination is the draft', result.where, 'draft');
	check('nothing was released', record.released, []);
}

console.log('attachInto: locked composer');
{
	const { service, record } = fakeConversation();
	const result = attachInto(
		{ conversation: service, sessionId: 'session-1', inputActions: { addAttachments: () => false } },
		new File([new Blob([PNG])], 'shot.png', { type: 'image/png' }),
		META,
		ZH,
	);
	must('a locked composer is reported', result.ok === false, JSON.stringify(result));
	check('the refused draft was released', record.released, ['draft-0']);
	must('the message explains the placement failure', result.message.includes('未能放入'), result.message);
}

console.log('attachInto: paste fallback');
{
	pasteInto = null;
	const result = attachInto(
		{ conversation: undefined, sessionId: undefined, inputActions: undefined },
		new File([new Blob([PNG])], 'shot.png', { type: 'image/png' }),
		META,
		ZH,
	);
	must('the fallback reports success', result.ok === true, JSON.stringify(result));
	must('a paste event reached the composer editor', pasteInto !== null && pasteInto.type === 'paste');
	const transferred = pasteInto?.clipboardData?.items?.list ?? [];
	check('the paste carried one file', transferred.length, 1);
	check('the destination is the paste intake', result.where, 'paste');
}

/* -------------------------------------------------------------------------- */
/* deliver: clipboard when no composer is mounted                             */
/* -------------------------------------------------------------------------- */

console.log('deliver: no composer');
{
	check('no composer is registered yet', composerTarget(), null);
	clipboard.refuse = false;
	clipboard.written.length = 0;
	const result = await deliver({
		mode: 'window',
		copy: ZH,
		fetch: async () => fakeResponse({ headers: { 'x-screenshot': encodeURIComponent(JSON.stringify(META)) } }),
	});
	must('the clipboard path succeeds', result.ok === true, JSON.stringify(result));
	check('the destination is the clipboard', result.where, 'clipboard');
	check('one image was written', clipboard.written.length, 1);
	must('the message names the clipboard', result.message.startsWith('已复制到剪贴板'), result.message);
	must('the hint tells the reader to paste', result.detail.includes('粘贴'), result.detail);
}

console.log('deliver: clipboard refused');
{
	clipboard.refuse = true;
	const result = await deliver({
		mode: 'window',
		copy: ZH,
		fetch: async () => fakeResponse({ headers: { 'x-screenshot': encodeURIComponent(JSON.stringify(META)) } }),
	});
	must('the refusal is reported', result.ok === false, JSON.stringify(result));
	must('the message names the clipboard problem', result.message.includes('无法写入剪贴板'), result.message);
	must('the staged path is shown', result.message.includes('shot-1.png'), result.message);
	clipboard.refuse = false;
}

/* -------------------------------------------------------------------------- */
/* the mounted controls                                                       */
/* -------------------------------------------------------------------------- */

console.log('composer control');
const composerControl = registrations[1].registration.component;
const composerRequests = [];
const composerAdmitted = [];
const tree = composerControl({
	sessionId: 'session-1',
	inputActions: { addAttachments: (ids) => { composerAdmitted.push(...ids); return true; } },
	conversation: fakeConversation().service,
	locale: { getLocale: () => ({ active: 'zh-CN' }) },
});
must('the composer control renders a wrapper', tree?.type === 'span', String(tree?.type));
const composerChildren = (tree.props.children ?? []).flat();
const composerButton = composerChildren.find((child) => child?.type === 'button');
must('the composer control renders one button', composerButton !== undefined);
check('it carries the composer entry id', composerButton.props['data-dsh-screenshot'], ENTRY_ID);
check('the button starts idle', composerButton.props['data-phase'], 'idle');
must('the tooltip lists the modifier gestures', composerButton.props.title.includes('Shift+点击'), composerButton.props.title);
must('the composer is now registered as a target', composerTarget() !== null);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	composerRequests.push({ url, init });
	return fakeResponse({ headers: { 'x-screenshot': encodeURIComponent(JSON.stringify(META)) } });
};
try {
	check('the copy names the composer action', composerButton.props['aria-label'], '截图并放入输入框');
	const clickEvent = { shiftKey: true };
	composerButton.props.onClick(clickEvent);
	await new Promise((resolve) => setTimeout(resolve, 20));
	check('a shift click captures the desktop', JSON.parse(composerRequests[0].init.body).mode, 'screen');
	check('the click capture admitted its draft', composerAdmitted, ['draft-0']);
	let defaultPrevented = false;
	composerButton.props.onMouseDown({ preventDefault: () => { defaultPrevented = true; } });
	must('mousedown keeps the composer focused', defaultPrevented);

	/* deliver() now prefers the mounted composer over the clipboard. */
	clipboard.written.length = 0;
	const delivered = await deliver({
		mode: 'window',
		copy: ZH,
		fetch: async () => fakeResponse({ headers: { 'x-screenshot': encodeURIComponent(JSON.stringify(META)) } }),
	});
	check('with a composer the draft wins', delivered.where, 'draft');
	check('the clipboard was left alone', clipboard.written.length, 0);

	console.log('floating control');
	const floatControl = registrations[0].registration.component;
	const floatTree = floatControl({ locale: { getLocale: () => ({ active: 'zh-CN' }) } });
	must('the floating control renders a container', floatTree?.type === 'div', String(floatTree?.type));
	check('it is positioned fixed by class', floatTree.props.className, 'dsh-shot-float');
	must('it carries an anchor', typeof floatTree.props.style.left === 'string' && typeof floatTree.props.style.top === 'string');
	const floatChildren = (floatTree.props.children ?? []).flat();
	const fab = floatChildren.find((child) => child?.type === 'button');
	must('the floating control renders one button', fab !== undefined);
	check('it carries the floating entry id', fab.props['data-dsh-screenshot'], FLOAT_ID);
	must('the tooltip says it works on every page', fab.props.title.includes('任意页面'), fab.props.title);
	must('the shared chord listener is installed', windowListeners.has('keydown'));

	/* drag: past the threshold the control moves and the click is suppressed */
	const captured = [];
	const pointerEvent = (x, y) => ({
		clientX: x,
		clientY: y,
		pointerId: 1,
		currentTarget: { setPointerCapture: (id) => captured.push(id) },
	});
	fab.props.onPointerDown(pointerEvent(1200, 400));
	check('pointer capture is requested', captured, [1]);
	fab.props.onPointerMove(pointerEvent(1202, 401));
	fab.props.onPointerUp();
	must('a sub-threshold move stays a click', storage.get('dsh-quick-screenshot.float.position') === undefined);
	fab.props.onPointerDown(pointerEvent(1200, 400));
	fab.props.onPointerMove(pointerEvent(1100, 360));
	fab.props.onPointerUp();
	const saved = JSON.parse(storage.get('dsh-quick-screenshot.float.position') ?? 'null');
	must('a drag past the threshold persists the anchor', saved !== null && saved.x < 1200 && saved.y < 400, JSON.stringify(saved));
	composerRequests.length = 0;
	fab.props.onClick({});
	await new Promise((resolve) => setTimeout(resolve, 10));
	check('the click that ended a drag is suppressed', composerRequests.length, 0);

	/* a plain press still captures */
	fab.props.onPointerDown(pointerEvent(1100, 360));
	fab.props.onPointerUp();
	fab.props.onClick({});
	await new Promise((resolve) => setTimeout(resolve, 20));
	check('a press captures once', composerRequests.length, 1);
	check('it used the window target', JSON.parse(composerRequests[0].init.body).mode, 'window');

	/* the chord drives the floating control */
	composerRequests.length = 0;
	const chord = {
		code: 'KeyS',
		ctrlKey: true,
		shiftKey: true,
		altKey: false,
		metaKey: false,
		repeat: false,
		defaultPrevented: false,
		isComposing: false,
		preventDefault() {
			this.prevented = true;
		},
	};
	windowListeners.get('keydown')(chord);
	await new Promise((resolve) => setTimeout(resolve, 20));
	must('the chord prevented the browser default', chord.prevented === true);
	check('the chord captured once', composerRequests.length, 1);
	const other = { ...chord, code: 'KeyP', preventDefault() { this.prevented = true; } };
	windowListeners.get('keydown')(other);
	await new Promise((resolve) => setTimeout(resolve, 10));
	check('an unrelated key is ignored', composerRequests.length, 1);
	const repeated = { ...chord, repeat: true, preventDefault() { this.prevented = true; } };
	windowListeners.get('keydown')(repeated);
	await new Promise((resolve) => setTimeout(resolve, 10));
	check('key repeat does not recapture', composerRequests.length, 1);
} finally {
	globalThis.fetch = originalFetch;
}

/* -------------------------------------------------------------------------- */
/* localized copy and clipboard helper                                        */
/* -------------------------------------------------------------------------- */

console.log('copy');
check('Chinese copy for a zh locale', text({ getLocale: () => ({ active: 'zh-CN' }) }).action, '截图并放入输入框');
check('English copy for an en locale', text({ getLocale: () => ({ active: 'en' }) }).floatAction, 'Screenshot');
check('Chinese copy without a locale service', text(undefined).action, '截图并放入输入框');
check('Chinese copy when the service throws', text({ getLocale: () => { throw new Error('nope'); } }).action, '截图并放入输入框');

console.log('copyShot');
{
	clipboard.written.length = 0;
	must('a PNG is accepted by the clipboard', (await copyShot(new File([new Blob([PNG])], 'shot.png', { type: 'image/png' }))) === true);
	check('one item was written', clipboard.written.length, 1);
}

/* -------------------------------------------------------------------------- */

console.log('');
if (failures === 0) console.log('client smoke test passed');
else console.error(`client smoke test FAILED: ${String(failures)} assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
