/**
 * @local/linux-computer-use — Linux computer-use tools for the DeepSeek Harness.
 *
 * Registers model-facing tools that see and drive the local desktop:
 *   linux_screenshot  — capture the screen (grim → niri+wl-paste → ImageMagick import)
 *   linux_click       — pointer move + click (ydotool → wlrctl → xdotool/XWayland)
 *   linux_type        — type text (wtype → xdotool)
 *   linux_key         — press key combos (wtype → xdotool)
 *   linux_scroll      — scroll (ydotool → wlrctl → xdotool)
 *   linux_window      — list / focus windows (niri msg)
 *
 * Host-only plugin; no build step. Images ride the `attachments` service as
 * durable references, exactly like the built-in read_image tool.
 */
import { execFile } from 'node:child_process';

/** Run a command, never throwing; resolve { err, stdout, stderr }. */
function run(file, args, options = {}) {
	return new Promise(resolve => {
		const child = execFile(file, args, {
			timeout: options.timeoutMs ?? 8000,
			encoding: 'buffer',
			env: options.env,
			...options.execOptions,
		}, (err, stdout, stderr) => resolve({
			err,
			stdout,
			stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
		}));
		if (options.input !== undefined) {
			child.stdin?.end(options.input);
		}
	});
}

/** Resolve an executable name against the session PATH. */
async function which(name, env) {
	const r = await run('sh', ['-c', `command -v -- ${JSON.stringify(name)} 2>/dev/null`], { env });
	if (r.err) return undefined;
	return r.stdout.toString().trim().split('\n')[0] || undefined;
}

/** Session environment for desktop commands; falls back to common defaults. */
function desktopEnv(config) {
	const env = { ...process.env };
	// Tools commonly land in ~/.local/bin (e.g. a user-built ydotool); the
	// Host process PATH does not always include it.
	const localBin = `${process.env.HOME}/.local/bin`;
	if (env.HOME && !env.PATH.split(':').includes(localBin)) env.PATH = `${env.PATH}:${localBin}`;
	if (config.display && !env.DISPLAY) env.DISPLAY = config.display;
	if (config.waylandDisplay && !env.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = config.waylandDisplay;
	if (!env.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = 'wayland-0';
	if (!env.DISPLAY) env.DISPLAY = ':0';
	if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid?.() ?? 1000}`;
	return env;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
function isPng(data) {
	return data.length > 8 && data.subarray(0, 4).equals(PNG_MAGIC);
}

/**
 * Capture a screenshot; returns { backend, data: Buffer } or throws with a
 * backend-by-backend diagnosis.
 */
async function captureScreen(env) {
	if (await which('grim', env)) {
		const target = `/tmp/dsh-linux-computer-use-${Date.now()}.png`;
		const r = await run('grim', [target], { env });
		if (!r.err) {
			const { readFile } = await import('node:fs/promises');
			const data = await readFile(target);
			await import('node:fs/promises').then(fs => fs.rm(target, { force: true }));
			if (isPng(data)) return { backend: 'grim', data };
		}
	}
	if (await which('niri', env) && await which('wl-paste', env)) {
		await run('niri', ['msg', 'action', 'screenshot-screen'], { env, timeoutMs: 10000 });
		await new Promise(resolve => setTimeout(resolve, 500));
		const r = await run('wl-paste', ['--type', 'image/png'], { env, timeoutMs: 5000 });
		if (!r.err && isPng(r.stdout)) return { backend: 'niri+wl-paste', data: r.stdout };
	}
	if (await which('import', env)) {
		const target = `/tmp/dsh-linux-computer-use-${Date.now()}.png`;
		const r = await run('import', ['-window', 'root', target], { env, timeoutMs: 15000 });
		if (!r.err) {
			const { readFile } = await import('node:fs/promises');
			const data = await readFile(target).catch(() => undefined);
			await import('node:fs/promises').then(fs => fs.rm(target, { force: true }));
			if (data && isPng(data)) return { backend: 'import(XWayland)', data };
		}
	}
	throw new Error('no screenshot backend succeeded; install grim (Wayland, recommended) or ensure niri + wl-clipboard, or ImageMagick import under XWayland');
}

/** Current pointer position via xdotool when available. */
async function pointerLocation(env) {
	const xdotool = await which('xdotool', env);
	if (!xdotool) return undefined;
	const r = await run(xdotool, ['getmouselocation'], { env });
	if (r.err) return undefined;
	const x = /(?:^|\s)x:(\d+)/.exec(r.stdout.toString());
	const y = /(?:^|\s)y:(\d+)/.exec(r.stdout.toString());
	if (!x || !y) return undefined;
	return { x: Number(x[1]), y: Number(y[1]) };
}

/** Move the pointer, trying backends in order; returns the backend that worked. */
async function movePointer(env, x, y) {
	const ydotool = await which('ydotool', env);
	if (ydotool) {
		const r = await run(ydotool, ['mousemove', '-a', '--', String(x), String(y)], { env });
		if (!r.err) return 'ydotool';
	}
	const wlrctl = await which('wlrctl', env);
	if (wlrctl) {
		const at = await pointerLocation(env);
		if (at) {
			const moved = await run(wlrctl, ['pointer', 'move', String(x - at.x), String(y - at.y)], { env });
			if (!moved.err) return 'wlrctl';
		}
	}
	const xdotool = await which('xdotool', env);
	if (xdotool) {
		const r = await run(xdotool, ['mousemove', '--sync', String(x), String(y)], { env });
		if (!r.err) return 'xdotool (XWayland only)';
	}
	throw new Error('no pointer backend succeeded; install ydotool (with ydotoold running, recommended) or wlrctl for native-Wayland pointer control');
}

const CLICK_CODE = { left: '0xC0', right: '0xC1', middle: '0xC2' };
const CLICK_XDOTOOL = { left: '1', middle: '2', right: '3' };

/** Click the current pointer position, trying backends in order. */
async function clickButton(env, button) {
	const ydotool = await which('ydotool', env);
	if (ydotool) {
		const r = await run(ydotool, ['click', CLICK_CODE[button]], { env });
		if (!r.err) return 'ydotool';
	}
	const wlrctl = await which('wlrctl', env);
	if (wlrctl) {
		const r = await run(wlrctl, ['pointer', 'click', button], { env });
		if (!r.err) return 'wlrctl';
	}
	const xdotool = await which('xdotool', env);
	if (xdotool) {
		const r = await run(xdotool, ['click', CLICK_XDOTOOL[button]], { env });
		if (!r.err) return 'xdotool (XWayland only)';
	}
	throw new Error(`no backend could click the ${button} button; install ydotool or wlrctl for native-Wayland clicks`);
}

/** Keyboard input via wtype, falling back to xdotool for XWayland focus. */
async function typeText(env, text) {
	const wtype = await which('wtype', env);
	if (wtype) {
		const r = await run(wtype, ['--', text], { env, input: '' });
		if (!r.err) return 'wtype';
	}
	const xdotool = await which('xdotool', env);
	if (xdotool) {
		const r = await run(xdotool, ['type', '--delay', '20', '--', text], { env, timeoutMs: 60000 });
		if (!r.err) return 'xdotool (XWayland only)';
	}
	throw new Error('no typing backend succeeded; install wtype (recommended on wlroots compositors such as niri)');
}

/** A combo like "ctrl+s" or "Return"; wtype modifiers first, xdotool fallback. */
async function pressKey(env, combo) {
	const parts = combo.split('+').map(part => part.trim()).filter(part => part.length > 0);
	const key = parts[parts.length - 1];
	const mods = parts.slice(0, -1);
	const wtype = await which('wtype', env);
	if (wtype) {
		const args = [];
		for (const mod of mods) args.push('-M', mod);
		// -p = press, -P = release. The key must be released before wtype
		// exits; a key left pressed keeps auto-repeating on niri/wlroots.
		args.push('-p', key, '-P', key);
		for (const mod of mods) args.push('-m', mod);
		const r = await run(wtype, args, { env });
		if (!r.err) return 'wtype';
	}
	const xdotool = await which('xdotool', env);
	if (xdotool) {
		const r = await run(xdotool, ['key', '--', combo], { env });
		if (!r.err) return 'xdotool (XWayland only)';
	}
	throw new Error(`no backend could press "${combo}"; install wtype (recommended) or use X11 keysym names under XWayland`);
}

/** Scroll by pixels; positive dx right, positive dy down. */
async function scrollPointer(env, dx, dy) {
	const ydotool = await which('ydotool', env);
	if (ydotool) {
		let axis = 'v', amount = Math.max(1, Math.round(Math.abs(dy) / 10));
		if (Math.abs(dx) > Math.abs(dy)) { axis = 'h'; amount = Math.max(1, Math.round(Math.abs(dx) / 10)); }
		const direction = axis === 'v' ? (dy >= 0 ? 1 : -1) : (dx >= 0 ? 1 : -1);
		const r = await run(ydotool, ['click', `${direction > 0 ? '4' : '5'}C`], { env });
		if (!r.err) return 'ydotool';
	}
	const wlrctl = await which('wlrctl', env);
	if (wlrctl && (dx !== 0 || dy !== 0)) {
		const r = await run(wlrctl, ['pointer', 'scroll', String(dx), String(dy)], { env });
		if (!r.err) return 'wlrctl';
	}
	const xdotool = await which('xdotool', env);
	if (xdotool) {
		const steps = Math.max(1, Math.min(20, Math.round(Math.abs(dy === 0 ? dx : dy) / 120)));
		const button = dy >= 0 ? '5' : '4';
		const r = await run(xdotool, ['click', '--repeat', String(steps), button], { env });
		if (!r.err) return 'xdotool (XWayland only)';
	}
	throw new Error('no scroll backend succeeded; install ydotool or wlrctl for native-Wayland scrolling');
}

/** Durable-image refs stashed by execute for render; keyed by attachmentId. */
const refStore = new Map();

function scaleAdvice(ref) {
	if (!ref.originalDimensions) return '';
	const x = (ref.originalDimensions.width / ref.width).toFixed(2);
	const y = (ref.originalDimensions.height / ref.height).toFixed(2);
	return x === y
		? ` Screenshot stored ${ref.originalDimensions.width}x${ref.originalDimensions.height}px, attached at ${ref.width}x${ref.height}px; multiply coordinates by ${x}.`
		: ` Screenshot stored ${ref.originalDimensions.width}x${ref.originalDimensions.height}px, attached at ${ref.width}x${ref.height}px; multiply x by ${x} and y by ${y}.`;
}

/** Shared image output schema for the screenshot tool. */
const IMAGE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['backend', 'image'],
	properties: {
		backend: { type: 'string' },
		image: {
			type: 'object',
			additionalProperties: false,
			required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
			properties: {
				attachmentId: { type: 'string' },
				mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
				bytes: { type: 'number' },
				width: { type: 'number' },
				height: { type: 'number' },
				name: { type: 'string' },
				originalDimensions: {
					type: 'object',
					additionalProperties: false,
					required: ['width', 'height'],
					properties: { width: { type: 'number' }, height: { type: 'number' } },
				},
			},
		},
	},
};

async function saveScreenshot(ctx, env) {
	const attachments = ctx.get('attachments');
	if (!attachments) throw new Error('no attachment service is mounted in this profile; a screenshot cannot be attached');
	const { backend, data } = await captureScreen(env);
	const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: 'linux-screenshot.png' });
	refStore.set(ref.attachmentId, ref);
	return { backend, image: {
		attachmentId: ref.attachmentId,
		mediaType: ref.mediaType,
		bytes: ref.bytes,
		width: ref.width,
		height: ref.height,
		...(ref.name === undefined ? {} : { name: ref.name }),
		...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
	} };
}

function numberArg(value, name) {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new Error(`invalid ${name}: expected a finite number`);
	return Math.round(n);
}

/** Register every tool on the plugin context; returns a cleanup disposer. */
export const inject = ['tools'];

export function apply(ctx, config) {
	const env = desktopEnv(config ?? {});
	const disposers = [
		ctx.tools.register({
			name: 'linux_screenshot',
			description: 'Capture the current Linux desktop screen and return the image so you can inspect it. Take a screenshot before and after any pointer or keyboard action. Measure coordinates on the attached image.',
			parameters: {
				type: 'object',
				properties: {},
			},
			output: {
				schema: IMAGE_SCHEMA,
				render: (_args, value) => [{
					type: 'text',
					text: `<backend>${value.backend}</backend>\n${value.image.mediaType} screenshot, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes.${scaleAdvice(value.image)}`,
				}, {
					type: 'image',
					attachment: refStore.get(value.image.attachmentId) ?? value.image,
				}],
			},
			async execute() {
				return await saveScreenshot(ctx, env);
			},
		}),
		ctx.tools.register({
			name: 'linux_click',
			description: 'Move the Linux pointer to pixel coordinates measured on a fresh linux_screenshot, then click a mouse button. Wayland-native control needs ydotool (with ydotoold) or wlrctl; without them only XWayland windows respond.',
			parameters: {
				type: 'object',
				properties: {
					x: { type: 'number', description: 'Target pixel x on the real screen (apply the screenshot scale factor if one was reported).' },
					y: { type: 'number', description: 'Target pixel y on the real screen.' },
					button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; default left.' },
				},
				required: ['x', 'y'],
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					required: ['moved', 'clicked'],
					properties: { moved: { type: 'string' }, clicked: { type: 'string' } },
				},
				render: (_args, value) => [{ type: 'text', text: `Pointer moved via ${value.moved}; ${value.clicked} click done.` }],
			},
			async execute(args) {
				const x = numberArg(args.x, 'x');
				const y = numberArg(args.y, 'y');
				const button = args.button ?? 'left';
				const moved = await movePointer(env, x, y);
				const clicked = await clickButton(env, button);
				return { moved, clicked };
			},
		}),
		ctx.tools.register({
			name: 'linux_type',
			description: 'Type UTF-8 text into the currently focused Linux window (wtype on Wayland, xdotool under XWayland). Focus the right window first, for example with linux_window.',
			parameters: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'Text to type; newline characters press Enter.' },
				},
				required: ['text'],
			},
			output: {
				schema: { type: 'object', additionalProperties: false, required: ['backend'], properties: { backend: { type: 'string' } } },
				render: (_args, value) => [{ type: 'text', text: `Typed via ${value.backend}.` }],
			},
			async execute(args) {
				if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('invalid text: expected a non-empty string');
				return { backend: await typeText(env, args.text) };
			},
		}),
		ctx.tools.register({
			name: 'linux_key',
			description: 'Press a key combination in the focused Linux window. Use XKB keysym names, for example "Return", "Escape", "ctrl+s", "alt+F4", "super".',
			parameters: {
				type: 'object',
				properties: {
					combo: { type: 'string', description: 'Key combo, modifiers joined with +, e.g. "ctrl+s" or "Return".' },
				},
				required: ['combo'],
			},
			output: {
				schema: { type: 'object', additionalProperties: false, required: ['backend'], properties: { backend: { type: 'string' } } },
				render: (_args, value) => [{ type: 'text', text: `Pressed via ${value.backend}.` }],
			},
			async execute(args) {
				if (typeof args.combo !== 'string' || args.combo.trim().length === 0) throw new Error('invalid combo: expected a non-empty string like "ctrl+s"');
				return { backend: await pressKey(env, args.combo.trim()) };
			},
		}),
		ctx.tools.register({
			name: 'linux_scroll',
			description: 'Scroll the Linux desktop under the pointer. dx is pixels right, dy is pixels down (negative dy scrolls up).',
			parameters: {
				type: 'object',
				properties: {
					dx: { type: 'number', description: 'Horizontal pixels; default 0.' },
					dy: { type: 'number', description: 'Vertical pixels; default 360 (about 3 wheel ticks down).' },
				},
			},
			output: {
				schema: { type: 'object', additionalProperties: false, required: ['backend'], properties: { backend: { type: 'string' } } },
				render: (_args, value) => [{ type: 'text', text: `Scrolled via ${value.backend}.` }],
			},
			async execute(args) {
				const dx = args.dx === undefined ? 0 : numberArg(args.dx, 'dx');
				const dy = args.dy === undefined ? 360 : numberArg(args.dy, 'dy');
				if (dx === 0 && dy === 0) throw new Error('nothing to scroll: dx and dy are both 0');
				return { backend: await scrollPointer(env, dx, dy) };
			},
		}),
		ctx.tools.register({
			name: 'linux_window',
			description: 'List open windows of the niri compositor with their ids, or focus one window by id before typing or key presses. Requires niri.',
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['list', 'focus'], description: 'list: enumerate windows. focus: raise and focus the window with the given id.' },
					id: { type: 'number', description: 'Window id from linux_window list (required for focus).' },
				},
				required: ['action'],
			},
			output: {
				schema: { type: 'object', additionalProperties: false, required: ['result'], properties: { result: { type: 'string' } } },
				render: (_args, value) => [{ type: 'text', text: value.result }],
			},
			async execute(args, exec) {
				const niri = await which('niri', env);
				if (!niri) throw new Error('niri is not available; linux_window only supports the niri compositor');
				if (args.action === 'list') {
					const r = await run(niri, ['msg', 'windows'], { env, timeoutMs: 5000 });
					if (r.err) throw new Error(`niri msg windows failed: ${r.stderr.trim() || r.err.message}`);
					return { result: r.stdout.toString().trim() || '(no open windows)' };
				}
				const id = numberArg(args.id, 'id');
				const r = await run(niri, ['msg', 'action', 'focus-window', '--id', String(id)], { env, timeoutMs: 5000 });
				if (r.err) throw new Error(`focus-window --id ${id} failed: ${r.stderr.trim() || r.err.message}`);
				return { result: `Focused window ${id}.` };
			},
		}),
	];
	return async () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}
