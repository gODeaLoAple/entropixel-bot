let isEnabled = true;
const FILE_ID = null;

function logInternal(msg) {
	console.log(`File ${FILE_ID}. ${msg}`);
}

function wait(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function onCaptcha(token) {
	// @ts-ignore
	grecaptcha.reset();
}
window.onCaptcha = onCaptcha;

async function refreshCaptcha(worker, shouldStop) {
	await refreshCaptchaAsync(worker, shouldStop);
}

async function executeCaptcha() {
	// @ts-ignore
	return await grecaptcha.execute();
}

async function refreshCaptchaAsync(worker, shouldStop) {
	let token = null;
	while (token == null) {
		if (shouldStop !== undefined && shouldStop !== null && shouldStop()) return;
		let timeout = false;
		logInternal(`Worker ${worker.number} try get token.`);
		const tokenTask = executeCaptcha();
		const timeoutTask = wait(3000).then(() => {
			timeout = true;
		});

		await Promise.race([tokenTask, timeoutTask]);
		if (timeout) {
			logInternal(`Worker ${worker.number} get token timeout. Try repeat`);
		} else {
			token = await tokenTask;
			break;
		}
	}
	worker.token = token;
}

async function setPixel(x, y, color, worker) {
	const response = await fetch("https://entropixel.ru/api/pixel", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			x,
			y,
			a: x + y + 8,
			fingerprint: worker.fingerprint,
			color,
			token: worker.token,
		}),
	});

	if (response.status === 422) {
		return { waitSeconds: 5, success: false, tokenExpired: true };
	}

	if (response.status === 400) {
		return { waitSeconds: 10, success: false };
	}

	if (!response.ok) {
		return { waitSeconds: 5, success: false };
	}

	const { success, waitSeconds, errors } = await response.json();

	if (waitSeconds) return { waitSeconds, success };
	if (response.ok && success) {
		return { waitSeconds, success };
	}

	return { waitSeconds: 5, success };
}

const CHUNK_SIZE = 64;

function mod(n, m) {
	return ((n % m) + m) % m;
}

class Pixel {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}

	toChunk() {
		return new Pixel(Math.floor(this.x / CHUNK_SIZE), Math.floor(this.y / CHUNK_SIZE));
	}

	toInsideChunk() {
		return new Pixel(mod(this.x, CHUNK_SIZE), mod(this.y, CHUNK_SIZE));
	}
}

/**
 * @param {{ canvas: { chunks: any; }; }} state
 * @param {Pixel} pixel
 * @param {number} color
 */
function isSameColorIn(state, pixel, color) {
	const { chunks } = state.canvas;
	const chunkCoords = pixel.toChunk();
	const key = `${chunkCoords.x}:${chunkCoords.y}`;
	const chunk = chunks.get(key);
	if (!chunk) {
		// estrenamos chunk!
		return color === 0; // default color is white
	}

	// getColor
	let inChunk = pixel.toInsideChunk();
	return chunk.hasColorIn([inChunk.x, inChunk.y], color);
}

function popOrNull(arr) {
	return arr.length > 0 ? arr.pop() : null;
}

/**
 * @param {{ fingerprint?: string; token?: null; colorizedPoints: number; points: Array<{ x :number, y:number, color: number}>; number: number}} worker
 */
async function doWork(worker) {
	const workerPoints = worker.points;
	let waitSeconds = 0.5;
	if (workerPoints.length == 0) return;
	let currentPoint = workerPoints.pop();
	logInternal(`Worker ${worker.number} start`);
	const shouldStop = () => workerPoints.length == 0;
	while (!shouldStop()) {
		try {
			if (!isEnabled) {
				await wait(1000);
				continue;
			}
			let timeout = Math.max(0, waitSeconds) * 1000;
			// logInternal(`Worker ${worker.number} wait for ${timeout}`);
			if (timeout > 0) await wait(timeout);
			if (currentPoint === null || currentPoint === undefined) {
				currentPoint = popOrNull(workerPoints);
			}
			if (currentPoint === null || currentPoint === undefined) {
				continue;
			}
			const { x, y, color } = currentPoint;
			// @ts-ignore
			const state = store.getState();
			if (isSameColorIn(state, new Pixel(x, y), color)) {
				currentPoint = popOrNull(workerPoints);
				waitSeconds = 0;
				logInternal(`Worker ${worker.number} skip. ${workerPoints.length} points left`);
			} else {
				const result = await setPixel(x, y, color, worker);
				waitSeconds = result.waitSeconds;
				if (result.success) {
					worker.colorizedPoints++;
					logInternal(`Worker ${worker.number} print. ${workerPoints.length} points left`);
				} else if (result.tokenExpired) {
					currentPoint = undefined;
					await refreshCaptcha(worker, shouldStop);
				}
			}
		} catch (e) {
			console.error(`Worker ${worker.number} error: ${e}`);
		}
	}
	logInternal(`Worker ${worker.number} stop`);
}
async function run(fingerprint, parallelism, points, offset) {
	points = points.map((s) => {
		return { x: offset.x + s.x, y: offset.y + s.y, color: s.color };
	});
	let k = parallelism;
	let suffixLength = Math.ceil(Math.log10(k));
	let ten = Math.floor(Math.pow(10, suffixLength));
	let fingerpringPrefix = fingerprint
		.split("")
		.slice(0, fingerprint.length - suffixLength)
		.join("");
	let workers = [...new Array(k).keys()].map((i) => {
		return {
			number: i,
			fingerprint: fingerpringPrefix + (i % ten).toString().padStart(suffixLength, "0"),
			token: null,
			points: [],
			colorizedPoints: 0,
		};
	});

	const startAt = Date.now();

	for (let i = 0; i < points.length; i++) {
		let j = i % workers.length;
		workers[j].points = points;
	}

	let works = [];
	for (let j = 0; j < workers.length; j++) {
		if (points.length == 0) break;
		await refreshCaptcha(workers[j]);
		works.push(doWork(workers[j]));
	}

	await Promise.all(works);

	const elapsed = Date.now() - startAt;
	logInternal("All works done! Elapsed time: " + Math.floor(elapsed / 1000) + " seconds");

	return workers.reduce((s, worker) => s + worker.colorizedPoints, 0);
}

function randomChar() {
	const alphabet = "abcdef0123456789";
	return alphabet[Math.floor(Math.random() * alphabet.length)];
}

function createRectangle(offset, a, b, color) {
	const result = [];
	for (let y = 0; y < b; y++) {
		for (let x = 0; x < a; x++) result.push({ x: offset.x + x, y: offset.y + y, color });
	}
	return result;
}

function strokeRectangle(start, end, color) {
	const result = [];
	const size = { x: end.x - start.x + 1, y: end.y - start.y + 1 };

	for (let i = 0; i < size.x; i++) {
		result.push({ x: start.x + i, y: start.y, color });
		result.push({ x: start.x + i, y: start.y + size.y - 1, color });
	}

	for (let i = 0; i < size.y; i++) {
		result.push({ x: start.x, y: start.y + i, color });
		result.push({ x: start.x + size.x - 1, y: start.y + i, color });
	}

	return result;
}

const prefix = [...new Array(4).keys()].map((x) => randomChar()).join("");

async function main(points) {
	for (let i = 0; i < 10; i++) {
		const colorized = await run(prefix + "a6cd4b387585d9f5df6ba2c69dc1", 128, points, { x: 0, y: 0 });
		if (colorized == 0) {
			logInternal("Colorized successfully");
			return;
		}
		logInternal("Did not colorize all points. Start again");
	}
	logInternal("All iterations failed!!!");
}

//PYTHON

//region COMMON

const maxScreenSize = Math.max(screen.width, screen.height);
const computedRadius = Math.ceil((maxScreenSize / CHUNK_SIZE - 1) / 2);
const CHUNK_RENDER_RADIUS = clamp(computedRadius, 4, 64) * 2;

function clamp(n, min, max) {
	return Math.max(min, Math.min(n, max));
}

class ChunkRGB {
	static getKey(x, y) {
		return `${x}:${y}`;
	}

	static getIndexFromCell([x, y]) {
		return x + CHUNK_SIZE * y;
	}
}

class Point {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}

	static toKey(x, y) {
		return x + ":" + y;
	}

	static fromKey(key) {
		const [x, y] = key.split(":").map((x) => Number.parseInt(x));
		return new Point(x, y);
	}
}

class ColoredPoint extends Point {
	constructor(x, y, color) {
		super(x, y);
		this.color = color;
	}
}

function colorToHex(color) {
	const [r, g, b] = [color[0], color[1], color[2]];
	return 0xff000000 + (b << 16) + (g << 8) + r;
}

const colors = [
	[34, 34, 34],
	[228, 228, 228],
	[136, 136, 136],
	[255, 255, 255],
	[255, 167, 209],
	[229, 0, 0],
	[229, 149, 0],
	[160, 106, 66],
	[229, 217, 0],
	[148, 224, 68],
	[2, 190, 1],
	[0, 211, 221],
	[0, 131, 199],
	[0, 0, 234],
	[207, 110, 228],
	[130, 0, 128],
];
const hexToColor = colors
	.map(colorToHex)
	.map((x, i) => ({ [x]: i }))
	.reduce(Object.assign, {});

function mod(n, m) {
	return ((n % m) + m) % m;
}

function getChunkOfPixel(pixel) {
	return pixel.map((x) => Math.floor(x / CHUNK_SIZE));
}

function getCellInsideChunk(pixel) {
	return pixel.map((x) => mod(x, CHUNK_SIZE));
}

function getState() {
	// @ts-ignore
	return store.getState();
}

function getChunks() {
	return getState().canvas.chunks;
}

/**
 *
 * @returns {HTMLCanvasElement}
 */
function getViewport() {
	// @ts-ignore
	return document.getElementById("gameWindow");
}

/**
 *
 * @returns {[number, number]}
 */
function screenToWorld([x, y]) {
	const { scale, view } = getState().canvas;
	const [viewX, viewY] = view;
	const { width, height } = getViewport();
	return [Math.floor((x - width / 2) / scale + viewX), Math.floor((y - height / 2) / scale + viewY)];
}

function worldToScreen([x, y]) {
	const { scale, view } = getState().canvas;
	const [viewX, viewY] = view;
	const { width, height } = getViewport();
	return [(x - viewX) * scale + width / 2, (y - viewY) * scale + height / 2];
}

class Chunks {
	constructor(chunks) {
		this.chunks = chunks;
	}

	static create() {
		return new Chunks(getChunks());
	}

	findChunkForCoordinates(coordinates) {
		const [cx, cy] = getChunkOfPixel(coordinates);
		const key = ChunkRGB.getKey(cx, cy);
		return this.chunks.get(key);
	}

	getColor(coordinates) {
		const chunk = this.findChunkForCoordinates(coordinates);
		if (!chunk) {
			return 0;
		}

		const index = ChunkRGB.getIndexFromCell(getCellInsideChunk(coordinates));
		return hexToColor[chunk.intView[index]];
	}

	setColor(coordinates, color) {
		const chunk = this.findChunkForCoordinates(coordinates);
		if (!chunk) {
			return;
		}

		return chunk.setColor(getCellInsideChunk(coordinates), color);
	}
}

function getColor(chunks, coordinates) {
	return new Chunks(chunks).getColor(coordinates);
}

function setColor(chunks, coordinates, color) {
	return new Chunks(chunks).setColor(coordinates, color);
}

//endregion

function getPoints(start, end) {
	const chunks = getChunks();

	const result = [];

	for (let y = start.y; y <= end.y; y++)
		for (let x = start.x; x <= end.x; x++) {
			result.push(new ColoredPoint(x, y, getColor(chunks, [x, y])));
		}

	return result;
}

function saveToFile(content) {
	const link = document.createElement("a");
	const file = new Blob([content], { type: "text/plain" });
	link.href = URL.createObjectURL(file);
	link.download = "sample" + randomChar() + randomChar() + ".json";
	link.click();
	URL.revokeObjectURL(link.href);
}

function move(rectangle, newPoint, clear = true) {
	const [start, end] = rectangle;
	const points = getPoints(start, end);
	const offset = new Point(newPoint.x - start.x, newPoint.y - start.y);
	const shiftedPoints = points.map((p) => new ColoredPoint(p.x + offset.x, p.y + offset.y, p.color));

	const pointsMap = new Map();
	if (clear) {
		for (let y = start.y; y <= end.y; y++)
			for (let x = start.x; x <= end.x; x++) {
				pointsMap.set(Point.toKey(x, y), 0);
			}
	}

	shiftedPoints.forEach((p) => pointsMap.set(Point.toKey(p.x, p.y), p.color));

	console.log(shiftedPoints);
	const result = [];
	for (let [key, value] of pointsMap) {
		const p = Point.fromKey(key);
		result.push(new ColoredPoint(p.x, p.y, value));
	}
	return result;
}

function randomChar() {
	const alphabet = "abcdef0123456789";
	return alphabet[Math.floor(Math.random() * alphabet.length)];
}

const editorState = {
	/** @type {[number, number] | null} */
	start: null,
	/** @type {[number, number] | null} */
	end: null,
	/** @type {[number, number] | null} */
	destination: null,
};

document.addEventListener("mousedown", (e) => {
	if (e.button === 1) {
		editorState.start = editorState.end = editorState.destination = null;
		return;
	}

	const worldPoint = screenToWorld([e.clientX, e.clientY]);

	if (!e.ctrlKey) {
		if (e.shiftKey && editorState.start && editorState.end) {
			editorState.destination = worldPoint;
		}
		return;
	}

	if (e.shiftKey) {
		editorState.end = worldPoint;
		return;
	}

	editorState.start = worldPoint;
});
const PLACEHOLDER_SIZE = 1.2;

class Animator {
	constructor(viewport) {
		this.viewport = viewport;
		this.currentColorIdx = 0;
		this.iteration = 0;
	}

	render() {
		const state = getState();
		/** @type {CanvasRenderingContext2D} */
		const viewportCtx = this.viewport.getContext("2d");
		if (!viewportCtx) return;
		if (!editorState.start) return;
		const scale = state.canvas.scale;
		viewportCtx.save();
		viewportCtx.translate(scale / 2, scale / 2);

		if (editorState.end) {
			this.drawRect(viewportCtx, scale, editorState.start, editorState.end);
			if (editorState.destination) this.drawDestination(viewportCtx, scale, editorState.destination, editorState.start, editorState.end);
		} else {
			this.drawPoint(viewportCtx, scale, editorState.start);
		}

		viewportCtx.restore();

		this.iteration++;
		if (this.iteration >= 50) {
			this.iteration = 0;
			this.currentColorIdx = (this.currentColorIdx + 1) % colors.length;
		}
	}

	drawDestination(viewportCtx, scale, dest, start, end) {
		const [x, y] = dest;
		const [sx, sy] = start;
		const [ex, ey] = end;
		/**
		 * @type {[number, number]}
		 */
		const destEnd = [x + (ex - sx), y + (ey - sy)];
		this.drawRect(viewportCtx, scale, dest, destEnd);

		const color = "rgb(255, 0, 0)";
		this.drawPoint(viewportCtx, scale, dest, color);
		this.drawPoint(viewportCtx, scale, destEnd, color);
	}

	drawRect(viewportCtx, scale, start, end) {
		const [sx, sy] = worldToScreen(start);
		const [ex, ey] = worldToScreen(end);

		viewportCtx.fillStyle = this.getRgbColor();

		viewportCtx.fillRect(sx + -scale * (PLACEHOLDER_SIZE / 2), sy + -scale * (PLACEHOLDER_SIZE / 2), ex - sx, scale * PLACEHOLDER_SIZE);

		viewportCtx.fillRect(sx + -scale * (PLACEHOLDER_SIZE / 2), ey + -scale * (PLACEHOLDER_SIZE / 2), ex - sx, scale * PLACEHOLDER_SIZE);

		viewportCtx.fillRect(sx + -scale * (PLACEHOLDER_SIZE / 2), sy + -scale * (PLACEHOLDER_SIZE / 2), scale * PLACEHOLDER_SIZE, ey - sy);

		viewportCtx.fillRect(ex + -scale * (PLACEHOLDER_SIZE / 2), sy + -scale * (PLACEHOLDER_SIZE / 2), scale * PLACEHOLDER_SIZE, ey - sy);

		this.drawPoint(viewportCtx, scale, end);
	}

	/**
	 * @param {CanvasRenderingContext2D} viewportCtx
	 * @param {number} scale
	 * @param {[number, number]} point
	 * @param {string | null} color
	 */
	drawPoint(viewportCtx, scale, point, color = null) {
		const [sx, sy] = worldToScreen(point);
		viewportCtx.fillStyle = color ? color : this.getRgbColor();
		viewportCtx.fillRect(
			sx + -scale * (PLACEHOLDER_SIZE / 2),
			sy + -scale * (PLACEHOLDER_SIZE / 2),
			scale * PLACEHOLDER_SIZE,
			scale * PLACEHOLDER_SIZE
		);
	}

	getRgbColor() {
		return `rgb(${colors[this.currentColorIdx].join(",")})`;
	}
}
const animator = new Animator(getViewport());

function render() {
	requestAnimationFrame(render);
	animator.render();
}

function toPoint(coords) {
	return new Point(coords[0], coords[1]);
}

function save(clear) {
	if (!editorState.start) throw new Error("Start is null");
	if (!editorState.end) throw new Error("End is null");
	if (!editorState.destination) throw new Error("Destination is null");
	const moveResult = move([toPoint(editorState.start), toPoint(editorState.end)], toPoint(editorState.destination), clear);
	saveToFile(JSON.stringify(moveResult));
}

let currentDrawTask = null;
function draw() {
	if (currentDrawTask != null) return;
	if (!editorState.start) throw new Error("Start is null");
	if (!editorState.end) throw new Error("End is null");

	const points = [];

	const color = getState().gui.selectedColor;
	const [xStart, yStart] = editorState.start;
	const [xEnd, yEnd] = editorState.end;
	for (let y = yStart; y <= yEnd; y++) {
		for (let x = xStart; x <= xEnd; x++) {
			points.push({ x, y, color });
		}
	}

	currentDrawTask = main(points).finally(() => (currentDrawTask = null));
}

setInterval(() => {
	const data = {
		start: editorState.start,
		end: editorState.end,
		destination: editorState.destination,
	};

	if (data.start && data.end) {
		data.width = data.end[0] - data.start[0];
		data.height = data.end[1] - data.start[1];
	}

	console.log(data);
}, 3000);

document.addEventListener("keyup", (e) => {
	if (e.key === "s") {
		save(true);
	} else if (e.key === "w") {
		save(false);
	} else if (e.key === "d") {
		draw();
	}
});
requestAnimationFrame(render);
