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
