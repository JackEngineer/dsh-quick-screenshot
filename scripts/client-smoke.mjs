/**
 * Client-half smoke test for `dsh-quick-screenshot`.
 *
 * It wires the package's own Client bundle into Node without a browser:
 *
 *   1. a stub `window.__ModuleLoader__.load` captures the bundle definition;
 *   2. a small React stub supplies `createElement`, the hooks the control uses,
 *      and runs effects so mount/unmount behavior is observable;
 *   3. a fake plugin context records what `apply` registers;
 *   4. `captureInto` is driven against fake composer services and a fake
 *      `fetch`, covering the admit path, a locked composer, a Host refusal, and
 *      the synthetic-paste fallback;
 *   5. the mounted control renders, and the shared Ctrl+Shift+S chord fires it.
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
const { ENDPOINT, ENTRY_ID, captureInto, modeOf, text } = exportsOf;

console.log('exports');
check('endpoint', ENDPOINT, '/api/quick-screenshot');
check('entry id', ENTRY_ID, 'screenshot.capture');
check('required services', exportsOf.inject, ['slots', 'conversation', 'locale']);
must('exports apply', typeof exportsOf.apply === 'function');
must('exports the control', typeof exportsOf.ScreenshotButton === 'function');

/* -------------------------------------------------------------------------- */
/* apply registers the composer control                                       */
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

check('one slot injection', registrations.length, 1);
check('injected into the composer tool row', registrations[0]?.key, 'conversation.input.left');
check('registered entry id', registrations[0]?.registration.meta.id, ENTRY_ID);
check('registered slot name', registrations[0]?.registration.meta.name, 'conversation.input.left');
must('registered an order', typeof registrations[0]?.registration.meta.order === 'number');
check('registered the control component', registrations[0]?.registration.component, exportsOf.ScreenshotButton);
const injectedProps = registrations[0]?.registration.meta.inject();
must('injection carries the conversation service', typeof injectedProps.conversation === 'object');
check('injection carries Chinese copy', injectedProps.copy.action, '截图并放入输入框');

/* -------------------------------------------------------------------------- */
/* captureInto                                                                */
/* -------------------------------------------------------------------------- */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const META = { ok: true, mode: 'window', method: 'printwindow', window: '会话 — DeepSeek Harness', width: 1282, height: 821, bytes: PNG.byteLength };

/** One fake Fetch response. */
function fakeResponse(options = {}) {
	const status = options.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name) => options.headers?.[String(name).toLowerCase()] ?? null },
		async blob() {
			if (options.blobError === true) throw new Error('stream failed');
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

console.log('captureInto: admit path');
{
	const { service, record } = fakeConversation();
	const admitted = [];
	const requests = [];
	const result = await captureInto({
		conversation: service,
		sessionId: 'session-1',
		inputActions: { addAttachments: (ids) => { admitted.push(...ids); return true; } },
		mode: 'window',
		copy: text({ getLocale: () => ({ active: 'zh-CN' }) }),
		fetch: async (url, init) => {
			requests.push({ url, init });
			return fakeResponse({ headers: { 'x-screenshot': encodeURIComponent(JSON.stringify(META)) } });
		},
	});
	must('the capture is admitted', result.ok === true, JSON.stringify(result));
	check('the Host route was called once', requests.length, 1);
	check('the request target', requests[0].url, '/api/quick-screenshot');
	check('the request method', requests[0].init.method, 'POST');
	check('the requested mode', JSON.parse(requests[0].init.body).mode, 'window');
	check('one draft was created for the session', record.created.length, 1);
	check('the draft belongs to the current session', record.created[0].sessionId, 'session-1');
	const file = record.created[0].files[0];
	must('the draft carries one image file', file instanceof File, String(file));
	check('the file media type', file.type, 'image/png');
	check('the file size', file.size, PNG.byteLength);
	must('the file name is stamped', /^dsh-screenshot-\d{8}-\d{6}\.png$/u.test(file.name), file.name);
	check('the draft id was admitted', admitted, ['draft-0']);
	must('the result names the captured size', result.message.includes('1282×821'), result.message);
	must('the result confirms placement', result.message.startsWith('已放入输入框'), result.message);
	check('nothing was released', record.released, []);
}

console.log('captureInto: mode selection');
check('click captures the DSH window', modeOf({}), 'window');
check('shift+click captures the desktop', modeOf({ shiftKey: true }), 'screen');
check('alt+click captures the active window', modeOf({ altKey: true }), 'active');
check('shift wins over nothing else', modeOf({ shiftKey: true, ctrlKey: true }), 'screen');

console.log('captureInto: locked composer');
{
	const { service, record } = fakeConversation();
	const result = await captureInto({
		conversation: service,
		sessionId: 'session-1',
		inputActions: { addAttachments: () => false },
		fetch: async () => fakeResponse({ headers: { 'x-screenshot': encodeURIComponent(JSON.stringify(META)) } }),
	});
	must('a locked composer is reported', result.ok === false, JSON.stringify(result));
	check('the refused draft was released', record.released, ['draft-0']);
	must('the message explains the placement failure', result.message.includes('未能放入'), result.message);
}

console.log('captureInto: Host refusal');
{
	const result = await captureInto({
		conversation: fakeConversation().service,
		sessionId: 'session-1',
		inputActions: { addAttachments: () => true },
		fetch: async () => fakeResponse({ status: 501, json: { ok: false, error: 'capture shell not found', code: 'CAPTURE_UNSUPPORTED' } }),
	});
	must('the refusal is reported', result.ok === false, JSON.stringify(result));
	must('the unsupported copy is used', result.message.includes('暂不支持'), result.message);
	const generic = await captureInto({
		conversation: fakeConversation().service,
		sessionId: 'session-1',
		inputActions: { addAttachments: () => true },
		fetch: async () => fakeResponse({ status: 500, json: { ok: false, error: 'no visible target window', code: 'CAPTURE_FAILED' } }),
	});
	must('the Host message reaches the user', generic.message.includes('no visible target window'), generic.message);
}

console.log('captureInto: empty image');
{
	const result = await captureInto({
		conversation: fakeConversation().service,
		sessionId: 'session-1',
		inputActions: { addAttachments: () => true },
		fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, blob: async () => new Blob([]) }),
	});
	must('an empty capture is reported', result.ok === false, JSON.stringify(result));
}

console.log('captureInto: paste fallback');
{
	pasteInto = null;
	const result = await captureInto({
		conversation: undefined,
		inputActions: undefined,
		fetch: async () => fakeResponse({ headers: {} }),
	});
	must('the fallback reports success', result.ok === true, JSON.stringify(result));
	must('a paste event reached the composer editor', pasteInto !== null && pasteInto.type === 'paste');
	const transferred = pasteInto?.clipboardData?.items?.list ?? [];
	check('the paste carried one file', transferred.length, 1);
	must('the pasted item is a PNG file', transferred[0] instanceof File && transferred[0].type === 'image/png');
	must('the paste bubbles', pasteInto?.bubbles === true);
}

/* -------------------------------------------------------------------------- */
/* localized copy                                                             */
/* -------------------------------------------------------------------------- */

console.log('copy');
check('Chinese copy for a zh locale', text({ getLocale: () => ({ active: 'zh-CN' }) }).action, '截图并放入输入框');
check('English copy for an en locale', text({ getLocale: () => ({ active: 'en' }) }).action, 'Screenshot into the composer');
check('Chinese copy without a locale service', text(undefined).action, '截图并放入输入框');
check('Chinese copy when the service throws', text({ getLocale: () => { throw new Error('nope'); } }).action, '截图并放入输入框');

/* -------------------------------------------------------------------------- */
/* the mounted control                                                        */
/* -------------------------------------------------------------------------- */

console.log('control');
const control = registrations[0].registration.component;
const requests = [];
const admitted = [];
const tree = control({
	sessionId: 'session-1',
	inputActions: { addAttachments: (ids) => { admitted.push(...ids); return true; } },
	conversation: fakeConversation().service,
	copy: text({ getLocale: () => ({ active: 'zh-CN' }) }),
});
must('the control renders a wrapper', tree?.type === 'span', String(tree?.type));
const children = (tree.props.children ?? []).flat();
const button = children.find((child) => child?.type === 'button');
must('the control renders one button', button !== undefined);
check('the button names itself for assistive technology', button.props['aria-label'], '截图并放入输入框');
check('the button starts idle', button.props['data-phase'], 'idle');
check('the button carries a stable test id', button.props['data-dsh-screenshot'], ENTRY_ID);
must('the tooltip lists the modifier gestures', button.props.title.includes('Shift+点击'), button.props.title);
must('no note is shown while idle', children.some((child) => child?.props?.className === 'dsh-shot-note') === false);
must('the chord listener is installed while mounted', windowListeners.has('keydown'));

const keydown = windowListeners.get('keydown');
const chord = { code: 'KeyS', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false, defaultPrevented: false, isComposing: false, preventDefault() { this.prevented = true; } };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	requests.push({ url, init });
	return fakeResponse({ headers: { 'x-screenshot': encodeURIComponent(JSON.stringify(META)) } });
};
try {
	keydown(chord);
	await new Promise((resolve) => setTimeout(resolve, 20));
	must('the chord prevented the browser default', chord.prevented === true);
	check('the chord captured once', requests.length, 1);
	check('the chord used the window target', JSON.parse(requests[0].init.body).mode, 'window');
	check('the chord admitted the draft', admitted, ['draft-0']);

	const other = { ...chord, code: 'KeyP', preventDefault() { this.prevented = true; } };
	keydown(other);
	await new Promise((resolve) => setTimeout(resolve, 10));
	check('an unrelated key is ignored', requests.length, 1);
	const repeated = { ...chord, repeat: true, preventDefault() { this.prevented = true; } };
	keydown(repeated);
	await new Promise((resolve) => setTimeout(resolve, 10));
	check('key repeat does not recapture', requests.length, 1);

	const clickEvent = { shiftKey: true };
	button.props.onClick(clickEvent);
	await new Promise((resolve) => setTimeout(resolve, 20));
	check('a shift click captures the desktop', JSON.parse(requests[1].init.body).mode, 'screen');
	check('the click capture admitted its draft', admitted, ['draft-0', 'draft-0']);
	let defaultPrevented = false;
	button.props.onMouseDown({ preventDefault: () => { defaultPrevented = true; } });
	must('mousedown keeps the composer focused', defaultPrevented);
} finally {
	globalThis.fetch = originalFetch;
}

/* -------------------------------------------------------------------------- */

console.log('');
if (failures === 0) console.log('client smoke test passed');
else console.error(`client smoke test FAILED: ${String(failures)} assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
