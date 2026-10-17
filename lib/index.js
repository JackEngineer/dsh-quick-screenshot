/**
 * `dsh-quick-screenshot` — Host half.
 *
 * Captures the DeepSeek Harness window (or a window / the whole desktop) on the
 * Host machine and serves the PNG over one exact Fetch route, `/api/quick-screenshot`,
 * registered through `ctx.connection.fetch` so the shared `/api` bridge applies
 * Host/Origin validation and browser-cookie authentication before the handler
 * runs.
 *
 * Capture is delegated to the platform's own tooling — Windows PowerShell with
 * `System.Drawing` (`PrintWindow`, then a screen read when the compositor
 * refuses), `screencapture` on macOS, and the first available screenshot tool on
 * Linux. Every shot is written to `<tmpdir>/dsh-screenshot/` and the directory
 * keeps only its newest `MAX_KEEP` files, so the plugin owns no durable state.
 *
 * `capture`, `respond`, and `capabilities` are exported so the route contract and
 * a real capture can be exercised without mounting the plugin:
 *
 *   node -e "import('file:///…/lib/index.js').then(async m => {
 *     const shot = await m.capture({ mode: 'window' });
 *     console.log(shot.meta, shot.bytes.byteLength);
 *   })"
 *
 * @module dsh-quick-screenshot
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Promise-returning `execFile`, used for every platform capture tool. */
const run = promisify(execFile);

/** Stable Cordis plugin name. */
export const name = "screenshot";

/** Services required before the route can be installed. */
export const inject = ["connection"];

/** The exact Fetch route this plugin owns. */
export const ROUTE_PATH = "/api/quick-screenshot";

/** Where captures are staged; the plugin prunes this to its newest files. */
export const CAPTURE_DIR = join(tmpdir(), "dsh-screenshot");

/** Supported capture targets. */
const MODES = ["window", "active", "screen"];

/** Window title matched by the default `window` mode (the desktop app's title suffix). */
const DEFAULT_TITLE_PATTERN = "DeepSeek Harness";

/** A request may not widen the title match beyond this many characters. */
const MAX_TITLE_PATTERN = 200;

/** Wall-clock bound for one capture subprocess. */
const CAPTURE_TIMEOUT_MS = 25000;

/** Largest stdout a capture worker may produce (the JSON result line). */
const CAPTURE_MAX_OUTPUT = 1024 * 1024;

/** How many staged PNGs the capture directory retains. */
const MAX_KEEP = 24;

/** Default cap on the longest image side; 0 keeps the native capture size. */
const DEFAULT_MAX_DIMENSION = 0;

/** Absolute path of the Windows capture worker shipped with this package. */
const WINDOWS_SCRIPT = fileURLToPath(new URL("../assets/capture-windows.ps1", import.meta.url));

/** Linux screenshot tools, in preference order. */
const LINUX_TOOLS = [
	["gnome-screenshot", (out) => ["-f", out]],
	["spectacle", (out) => ["-b", "-n", "-o", out]],
	["grim", (out) => [out]],
	["import", (out) => ["-window", "root", out]],
	["scrot", (out) => ["-o", out]],
];

/** A capture request that cannot be satisfied; `status` is the HTTP status to answer with. */
export class CaptureFailure extends Error {
	/**
	 * @param message - operator-facing explanation.
	 * @param status - HTTP status for the route response.
	 * @param code - stable machine-readable reason.
	 */
	constructor(message, status = 500, code = "CAPTURE_FAILED") {
		super(message);
		this.name = "CaptureFailure";
		this.status = status;
		this.code = code;
	}
}

/** Serializes capture subprocesses so concurrent clicks queue instead of racing. */
let queue = Promise.resolve();

/**
 * Run one task after every previously enqueued task settled.
 * @param task - closure producing the next result.
 * @returns the task's own result.
 */
function enqueue(task) {
	const result = queue.then(task, task);
	queue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/** Local-time file stamp (`20261016-203045-123`). */
function stamp() {
	const now = new Date();
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	return [
		`${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
		`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
		pad(now.getMilliseconds(), 3),
	].join("-");
}

/** One staged capture path. */
function capturePath() {
	return join(CAPTURE_DIR, `shot-${stamp()}.png`);
}

/** Keep only the newest `MAX_KEEP` captures in the staging directory. */
export async function pruneCaptures() {
	let names;
	try {
		names = await readdir(CAPTURE_DIR);
	} catch {
		return 0;
	}
	const shots = [];
	for (const entry of names) {
		if (!entry.startsWith("shot-") || !entry.endsWith(".png")) continue;
		const path = join(CAPTURE_DIR, entry);
		try {
			const info = await stat(path);
			shots.push({ path, at: info.mtimeMs });
		} catch {
			/* a shot removed underneath us needs no further work */
		}
	}
	shots.sort((left, right) => right.at - left.at);
	let removed = 0;
	for (const shot of shots.slice(MAX_KEEP)) {
		try {
			await unlink(shot.path);
			removed += 1;
		} catch {
			/* already gone */
		}
	}
	return removed;
}

/** Trim a client-supplied title pattern into the accepted form. */
function normalizeTitlePattern(value) {
	if (typeof value !== "string") return DEFAULT_TITLE_PATTERN;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.length > MAX_TITLE_PATTERN) return DEFAULT_TITLE_PATTERN;
	return trimmed;
}

/** Trim a client-supplied mode into the accepted form. */
function normalizeMode(value) {
	return typeof value === "string" && MODES.includes(value) ? value : "window";
}

/** Trim a client-supplied size cap into the accepted form. */
function normalizeMaxDimension(value) {
	if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_MAX_DIMENSION;
	return Math.min(value, 8192);
}

/** Read one `-Mode screen -MaxDimension 0` JSON result from the Windows worker. */
function parseWorkerResult(stdout, stderr, code) {
	const lines = String(stdout).split(/\r?\n/u).filter((line) => line.trim() !== "");
	let result = null;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (!line.startsWith("{")) continue;
		try {
			result = JSON.parse(line);
			break;
		} catch {
			/* keep looking for the JSON line */
		}
	}
	if (result === null) {
		const detail = String(stderr).trim() || `capture worker exited with code ${String(code)}`;
		throw new CaptureFailure(detail, 500, "CAPTURE_WORKER_FAILED");
	}
	if (result.ok !== true) {
		const message = typeof result.error === "string" && result.error !== "" ? result.error : "capture failed";
		throw new CaptureFailure(message, 500, "CAPTURE_FAILED");
	}
	return result;
}

/** Capture through the shipped PowerShell worker. */
async function captureWindows(options) {
	const args = [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		WINDOWS_SCRIPT,
		"-Out",
		options.path,
		"-Mode",
		options.mode,
		"-TitlePattern",
		options.titlePattern,
		"-MaxDimension",
		String(options.maxDimension),
	];
	const shell = process.env.DSH_SCREENSHOT_POWERSHELL ?? "powershell.exe";
	let stdout;
	let stderr;
	let code = 0;
	try {
		const result = await run(shell, args, {
			windowsHide: true,
			timeout: CAPTURE_TIMEOUT_MS,
			maxBuffer: CAPTURE_MAX_OUTPUT,
			encoding: "utf8",
		});
		stdout = result.stdout;
		stderr = result.stderr;
	} catch (error) {
		stdout = error.stdout ?? "";
		stderr = error.stderr ?? "";
		code = typeof error.code === "number" ? error.code : 1;
		if (error.killed === true) throw new CaptureFailure("capture timed out", 504, "CAPTURE_TIMEOUT");
		if (error.code === "ENOENT") throw new CaptureFailure(`capture shell not found: ${shell}`, 501, "CAPTURE_UNSUPPORTED");
	}
	return parseWorkerResult(stdout, stderr, code);
}

/** First installed Linux screenshot tool, or `undefined`. */
async function linuxTool() {
	for (const [tool, args] of LINUX_TOOLS) {
		try {
			await run("sh", ["-c", `command -v ${tool}`], { timeout: 4000 });
			return { tool, args };
		} catch {
			/* try the next candidate */
		}
	}
	return undefined;
}

/** Capture through the platform's own screenshot tool (macOS and Linux). */
async function capturePosix(options) {
	if (process.platform === "darwin") {
		await run("screencapture", ["-x", "-o", options.path], { timeout: CAPTURE_TIMEOUT_MS });
		return { method: "screencapture", window: options.mode === "screen" ? "display" : "active-display", width: 0, height: 0 };
	}
	const candidate = await linuxTool();
	if (candidate === undefined) {
		throw new CaptureFailure(
			`no screenshot tool found; install one of ${LINUX_TOOLS.map(([tool]) => tool).join(", ")}`,
			501,
			"CAPTURE_UNSUPPORTED",
		);
	}
	await run(candidate.tool, candidate.args(options.path), { timeout: CAPTURE_TIMEOUT_MS });
	return { method: candidate.tool, window: "display", width: 0, height: 0 };
}

/** What this Host can capture right now. */
export async function capabilities() {
	const platform = process.platform;
	const common = {
		ok: true,
		route: ROUTE_PATH,
		platform,
		modes: [...MODES],
		defaultTitlePattern: DEFAULT_TITLE_PATTERN,
		maxTitlePattern: MAX_TITLE_PATTERN,
		directory: CAPTURE_DIR,
		keep: MAX_KEEP,
	};
	if (platform === "win32") {
		return { ...common, supported: true, tool: process.env.DSH_SCREENSHOT_POWERSHELL ?? "powershell.exe" };
	}
	if (platform === "darwin") return { ...common, supported: true, tool: "screencapture" };
	const candidate = await linuxTool();
	return candidate === undefined
		? { ...common, supported: false, tool: null, reason: `no screenshot tool found; install one of ${LINUX_TOOLS.map(([tool]) => tool).join(", ")}` }
		: { ...common, supported: true, tool: candidate.tool };
}

/**
 * Capture one image and return its bytes with the worker's own description.
 * @param options - requested mode, title pattern and size cap.
 * @returns the staged path, the PNG bytes, and the capture description.
 */
export async function capture(options = {}) {
	const request = {
		mode: normalizeMode(options.mode),
		titlePattern: normalizeTitlePattern(options.titlePattern),
		maxDimension: normalizeMaxDimension(options.maxDimension),
		path: options.path ?? capturePath(),
	};
	return enqueue(async () => {
		await mkdir(CAPTURE_DIR, { recursive: true });
		let meta;
		if (process.platform === "win32") {
			const result = await captureWindows(request);
			meta = { method: result.method, window: result.window, width: result.width, height: result.height, flat: result.flat };
		} else {
			meta = await capturePosix(request);
		}
		let bytes;
		try {
			bytes = await readFile(request.path);
		} catch (error) {
			throw new CaptureFailure(`capture produced no readable file: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (bytes.byteLength === 0) throw new CaptureFailure("capture produced an empty file");
		if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
			throw new CaptureFailure("capture did not produce a PNG");
		}
		let width = Number(meta.width) || 0;
		let height = Number(meta.height) || 0;
		if (width === 0 || height === 0) {
			/* PNG IHDR: width and height are the first two big-endian u32 after the 8-byte signature and 4-byte length. */
			width = bytes.readUInt32BE(16);
			height = bytes.readUInt32BE(20);
		}
		await pruneCaptures();
		return {
			path: request.path,
			bytes,
			meta: {
				ok: true,
				mode: request.mode,
				method: typeof meta.method === "string" ? meta.method : "unknown",
				window: typeof meta.window === "string" ? meta.window : "",
				width,
				height,
				bytes: bytes.byteLength,
				/* The staged file, so a client with nowhere to put the image can still name it. */
				path: request.path,
			},
		};
	});
}

/** Percent-encoded JSON metadata, small enough for one response header. */
function metaHeader(meta) {
	const text = JSON.stringify({ ...meta, window: meta.window.slice(0, MAX_TITLE_PATTERN) });
	return encodeURIComponent(text);
}

/** One PNG response. */
function pngResponse(bytes, meta) {
	return new Response(bytes, {
		headers: {
			"content-type": "image/png",
			"content-length": String(bytes.byteLength),
			"cache-control": "no-store",
			"x-screenshot": metaHeader(meta),
		},
	});
}

/** One JSON response. */
function jsonResponse(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/**
 * Answer one screenshot request: capabilities on `GET`, a PNG on `POST`.
 * @param request - the admitted Fetch request.
 * @returns the Fetch response for this route.
 */
export async function respond(request) {
	if (request.method === "GET" || request.method === "HEAD") return jsonResponse(await capabilities());
	if (request.method !== "POST") {
		return jsonResponse({ ok: false, error: "method not allowed", code: "METHOD_NOT_ALLOWED" }, 405);
	}
	let body = null;
	try {
		body = await request.json();
	} catch {
		/* an absent or malformed body means "capture the default target" */
	}
	const options = body !== null && typeof body === "object" ? body : {};
	try {
		const shot = await capture({
			mode: options.mode,
			titlePattern: options.titlePattern,
			maxDimension: options.maxDimension,
		});
		return pngResponse(shot.bytes, shot.meta);
	} catch (error) {
		if (error instanceof CaptureFailure) return jsonResponse({ ok: false, error: error.message, code: error.code }, error.status);
		return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error), code: "CAPTURE_FAILED" }, 500);
	}
}

/**
 * Install the screenshot route.
 * @param ctx - plugin context carrying the Connection service.
 */
export function apply(ctx) {
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: ROUTE_PATH,
				methods: ["GET", "POST"],
				requestBody: "buffered",
				fetch: (request) => respond(request),
			}),
		`screenshot: ${ROUTE_PATH}`,
	);
}
