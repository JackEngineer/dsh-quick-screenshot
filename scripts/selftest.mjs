/**
 * Host-half self test for `dsh-quick-screenshot`.
 *
 * It exercises the real route contract with Fetch `Request`/`Response` objects
 * and, on a machine whose platform capture actually works, takes real shots
 * through the same code path the GUI uses:
 *
 *   1. the module's public surface (name, inject, route path);
 *   2. `GET` capabilities and method rejection;
 *   3. a real `POST` window capture: PNG signature, IHDR size, the metadata
 *      header, and the staged file on disk;
 *   4. a real `POST` screen capture with a size cap, proving the cap is applied;
 *   5. failure mapping, including that a malformed body still reaches capture;
 *   6. staging-directory pruning that keeps the newest shot.
 *
 * Usage:
 *   node scripts/selftest.mjs
 */

import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import * as host from '../lib/index.js';

let failures = 0;
let skipped = 0;

/**
 * Set `DSH_SCREENSHOT_SKIP_CAPTURE=1` to exercise the route contract without
 * taking real screenshots — the desktop session, the DSH window and the
 * platform capture tool are all absent on a build machine.
 */
const SKIP_CAPTURE = process.env.DSH_SCREENSHOT_SKIP_CAPTURE === '1';

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

/** Report one skipped case without failing the suite. */
function skip(label, why) {
	skipped += 1;
	console.log(`  skip ${label} — ${why}`);
}

/** Decode the metadata header the route returns. */
function metaOf(response) {
	const raw = response.headers.get('x-screenshot');
	if (raw === null) return null;
	try {
		return JSON.parse(decodeURIComponent(raw));
	} catch {
		return null;
	}
}

/** One PNG request. */
function shotRequest(body, raw = false) {
	return new Request(`http://127.0.0.1${host.ROUTE_PATH}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: raw ? body : JSON.stringify(body ?? {}),
	});
}

/** Run `task` with a capture shell that cannot exist. */
async function withMissingShell(task) {
	const previous = process.env.DSH_SCREENSHOT_POWERSHELL;
	process.env.DSH_SCREENSHOT_POWERSHELL = 'dsh-no-such-capture-shell.exe';
	try {
		return await task();
	} finally {
		if (previous === undefined) delete process.env.DSH_SCREENSHOT_POWERSHELL;
		else process.env.DSH_SCREENSHOT_POWERSHELL = previous;
	}
}

/* -------------------------------------------------------------------------- */
/* 1. public surface                                                          */
/* -------------------------------------------------------------------------- */

console.log('module surface');
check('plugin name', host.name, 'screenshot');
check('required services', host.inject, ['connection']);
check('route path', host.ROUTE_PATH, '/api/quick-screenshot');
must('exports apply', typeof host.apply === 'function');
must('exports capture', typeof host.capture === 'function');
must('exports respond', typeof host.respond === 'function');
must('exports capabilities', typeof host.capabilities === 'function');

/* -------------------------------------------------------------------------- */
/* 2. capabilities and request validation                                     */
/* -------------------------------------------------------------------------- */

console.log('capabilities');
const capabilityResponse = await host.respond(new Request(`http://127.0.0.1${host.ROUTE_PATH}`, { method: 'GET' }));
check('GET status', capabilityResponse.status, 200);
check('GET content type', capabilityResponse.headers.get('content-type'), 'application/json; charset=utf-8');
const capability = await capabilityResponse.json();
check('capability platform', capability.platform, process.platform);
check('capability modes', capability.modes, ['window', 'active', 'screen']);
check('capability staging directory', capability.directory, host.CAPTURE_DIR);
check('capability title pattern', capability.defaultTitlePattern, 'DeepSeek Harness');
if (capability.supported === true) console.log(`  ok   capture is supported through ${String(capability.tool)}`);
else skip('capture availability', `this platform has no backend — ${String(capability.reason ?? 'no tool found')}`);
if (SKIP_CAPTURE) skip('real captures', 'DSH_SCREENSHOT_SKIP_CAPTURE=1');

const putResponse = await host.respond(new Request(`http://127.0.0.1${host.ROUTE_PATH}`, { method: 'PUT' }));
check('PUT is rejected', putResponse.status, 405);
const putBody = await putResponse.json();
check('method rejection code', putBody.code, 'METHOD_NOT_ALLOWED');

/** Real captures run only where a backend exists and the caller did not opt out. */
const canCapture = capability.supported === true && !SKIP_CAPTURE;

/* -------------------------------------------------------------------------- */
/* 3. a real window capture                                                   */
/* -------------------------------------------------------------------------- */

let windowShot = null;
if (canCapture) {
	console.log('window capture');
	const response = await host.respond(shotRequest({ mode: 'window' }));
	must('window capture succeeds', response.status === 200, `${String(response.status)} ${await response.clone().text()}`);
	if (response.status === 200) {
		check('window capture content type', response.headers.get('content-type'), 'image/png');
		check('cache-control', response.headers.get('cache-control'), 'no-store');
		const meta = metaOf(response);
		must('metadata header decodes', meta !== null, response.headers.get('x-screenshot') ?? '(missing)');
		const bytes = new Uint8Array(await response.arrayBuffer());
		must('response is a PNG', bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47);
		must('response is not empty', bytes.byteLength > 4096, `${String(bytes.byteLength)} bytes`);
		check('content-length matches the body', Number(response.headers.get('content-length')), bytes.byteLength);
		if (meta !== null) {
			check('metadata mode', meta.mode, 'window');
			must('metadata reports a size', meta.width > 200 && meta.height > 150, `${String(meta.width)}x${String(meta.height)}`);
			must('metadata reports a window title', typeof meta.window === 'string' && meta.window.length > 0, JSON.stringify(meta.window));
			must('metadata byte count matches the body', meta.bytes === bytes.byteLength, `${String(meta.bytes)} vs ${String(bytes.byteLength)}`);
			must('metadata names a capture method', typeof meta.method === 'string' && meta.method.length > 0, meta.method);
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			must(
				'the PNG IHDR size matches the metadata',
				view.getUint32(16) === meta.width && view.getUint32(20) === meta.height,
				`${String(view.getUint32(16))}x${String(view.getUint32(20))} vs ${String(meta.width)}x${String(meta.height)}`,
			);
			console.log(`       window: ${meta.window} (${String(meta.width)}x${String(meta.height)}, ${meta.method})`);
			windowShot = meta;
		}
	}
} else {
	skip('window capture', 'platform unsupported');
}

/* -------------------------------------------------------------------------- */
/* 4. a real screen capture with a size cap                                   */
/* -------------------------------------------------------------------------- */

if (canCapture) {
	console.log('screen capture with a size cap');
	const response = await host.respond(shotRequest({ mode: 'screen', maxDimension: 640 }));
	must('screen capture succeeds', response.status === 200, String(response.status));
	if (response.status === 200) {
		const meta = metaOf(response);
		const bytes = new Uint8Array(await response.arrayBuffer());
		must('capped capture is a PNG', bytes[0] === 0x89 && bytes[1] === 0x50);
		if (meta !== null) {
			check('capped mode', meta.mode, 'screen');
			const longest = Math.max(meta.width, meta.height);
			must('the cap bounds the longest side', longest <= 640 && longest >= 620, `${String(meta.width)}x${String(meta.height)}`);
			console.log(`       screen: ${String(meta.width)}x${String(meta.height)} (${meta.method})`);
		}
	}
} else {
	skip('screen capture', 'platform unsupported');
}

/* -------------------------------------------------------------------------- */
/* 5. failure mapping                                                         */
/* -------------------------------------------------------------------------- */

if (process.platform === 'win32') {
	console.log('failure mapping');
	const valid = await withMissingShell(() => host.respond(shotRequest({ mode: 'window' })));
	check('a missing capture shell answers 501', valid.status, 501);
	const validBody = await valid.json();
	check('failure code', validBody.code, 'CAPTURE_UNSUPPORTED');
	must('failure explains itself', typeof validBody.error === 'string' && validBody.error.length > 0, JSON.stringify(validBody));

	const malformed = await withMissingShell(() => host.respond(shotRequest('not json', true)));
	check('a malformed body still reaches capture', malformed.status, 501);
	const malformedBody = await malformed.json();
	check('malformed-body code', malformedBody.code, 'CAPTURE_UNSUPPORTED');
} else {
	skip('failure mapping', 'Windows-only case');
}

/* -------------------------------------------------------------------------- */
/* 6. staging pruning                                                         */
/* -------------------------------------------------------------------------- */

console.log('staging directory');
await mkdir(host.CAPTURE_DIR, { recursive: true });
/* The capture itself prunes, so the fresh shot is taken first and the overflow
 * is planted afterwards — this section then tests the prune in isolation. */
const fresh = canCapture ? await host.capture({ mode: 'window', maxDimension: 480 }) : null;
const planted = [];
for (let index = 0; index < 30; index += 1) {
	const path = join(host.CAPTURE_DIR, `shot-19990101-000000-${String(index).padStart(3, '0')}.png`);
	await writeFile(path, 'png');
	await utimes(path, 0, 0);
	planted.push(path);
}
const removed = await host.pruneCaptures();
const remaining = (await readdir(host.CAPTURE_DIR)).filter((name) => name.startsWith('shot-') && name.endsWith('.png'));
must('pruning removed the overflow', removed >= 6, `removed ${String(removed)}`);
must('staging keeps a bounded number of shots', remaining.length <= 24, `${String(remaining.length)} files`);
if (fresh !== null) {
	must('pruning kept the newest capture', remaining.includes(basename(fresh.path)), basename(fresh.path));
	check('the newest capture is a PNG', fresh.bytes[0], 0x89);
	check('the newest capture honours its smaller cap', Math.max(fresh.meta.width, fresh.meta.height) <= 480, true);
} else {
	skip('newest-capture retention', 'platform unsupported');
}
for (const path of planted) await rm(path, { force: true });

/* -------------------------------------------------------------------------- */

console.log('');
if (failures === 0) console.log(`host selftest passed${skipped === 0 ? '' : ` (${String(skipped)} skipped)`}`);
else console.error(`host selftest FAILED: ${String(failures)} assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
