import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { EditorCore } from "@/core";
import { AudioManager } from "../audio-manager";

/**
 * Test suite cho audio playback rewrite (Issue #237).
 *
 * Bối cảnh: mediabunny streaming chunk loop (`for await` + demux + per-chunk node
 * creation) block main thread → audio ngắt quãng + RAF ~1fps. Fix: native
 * `decodeAudioData` (off-main-thread) decode toàn bộ clip → cache AudioBuffer →
 * schedule 1 `AudioBufferSourceNode`/clip với absolute Web Audio clock
 * (`node.start(when, offset, duration)`) trên audio thread.
 *
 * Các test drive qua public surface (playback subscription → startPlayback) với
 * FakeAudioContext record calls. AudioContext phải fake (không có audio thật trong
 * headless test) — đây là mock unavoidable theo TDD skill.
 */

// ── Fake Web Audio nodes ────────────────────────────────────────────────

interface RecordedStart {
	when: number;
	offset?: number;
	duration?: number;
}

class FakeBufferSourceNode {
	buffer: AudioBuffer | null = null;
	playbackRate = { value: 1 };
	started: RecordedStart | null = null;
	addEventListener = (_type: string, _cb: (e: unknown) => void) => {};
	removeEventListener = () => {};
	connect = (_node: unknown) => {};
	disconnect = () => {};
	start = (when: number, offset?: number, duration?: number): void => {
		this.started = { when, offset, duration };
	};
	stop = (): void => {};
}

class FakeGainNode {
	gain = { value: 1 };
	connect = () => {};
	disconnect = () => {};
}

class FakeAnalyserNode {
	fftSize = 256;
	smoothingTimeConstant = 0.8;
	connect = () => {};
	disconnect = () => {};
	getFloatTimeDomainData = (_a: Float32Array) => {};
}

class FakeStereoPannerNode {
	pan = { value: 0 };
	connect = () => {};
	disconnect = () => {};
}

function fakeAudioBuffer(duration: number): AudioBuffer {
	return {
		duration,
		sampleRate: 44100,
		numberOfChannels: 2,
		length: Math.ceil(duration * 44100),
		getChannelData: () => new Float32Array(1),
		copyFromChannel: () => {},
		copyToChannel: () => {},
	} as unknown as AudioBuffer;
}

// Context thật do AudioManager tạo (qua createAudioContext → window.AudioContext).
// Mỗi instance tự push vào createdContexts để test đọc được decode/start calls.
const createdContexts: FakeAudioContext[] = [];

// State mô phỏng playhead advance trong lúc decode (sync fix test, Issue #237):
// playback timer chạy trong ~0.5s decode → playhead advance. Hook advanceTime
// được decodeAudioData gọi trước khi resolve để fake điều này.
const audioTestState: {
	decodeAdvance: number;
	advanceTime: ((delta: number) => void) | null;
} = { decodeAdvance: 0, advanceTime: null };

class FakeAudioContext {
	currentTime = 0;
	state: AudioContextState = "running";
	destination = {} as AudioNode;
	decodeAudioDataCalls = 0;
	closed = false;
	sources: FakeBufferSourceNode[] = [];

	constructor(_opts?: unknown) {
		createdContexts.push(this);
	}

	createBufferSource = (): FakeBufferSourceNode => {
		const s = new FakeBufferSourceNode();
		this.sources.push(s);
		return s;
	};
	createGain = (): FakeGainNode => new FakeGainNode();
	createAnalyser = (): FakeAnalyserNode => new FakeAnalyserNode();
	createStereoPanner = (): FakeStereoPannerNode => new FakeStereoPannerNode();
	createBuffer = (_ch: number, length: number, _rate: number): AudioBuffer =>
		fakeAudioBuffer(length / 44100);
	decodeAudioData = async (_ab: ArrayBuffer): Promise<AudioBuffer> => {
		this.decodeAudioDataCalls++;
		// Mô phỏng playhead advance trong lúc decode (sync fix test)
		if (audioTestState.decodeAdvance > 0 && audioTestState.advanceTime) {
			audioTestState.advanceTime(audioTestState.decodeAdvance);
		}
		return fakeAudioBuffer(5);
	};
	resume = async (): Promise<void> => {
		this.state = "running";
	};
	close = async (): Promise<void> => {
		this.closed = true;
	};
}

// ── Fake editor ─────────────────────────────────────────────────────────

interface FakeEditor {
	playback: {
		subscribe: (cb: () => void) => () => void;
		getIsPlaying: () => boolean;
		getCurrentTime: () => number;
		getVolume: () => number;
		getIsScrubbing: () => boolean;
	};
	timeline: {
		subscribe: (cb: () => void) => () => void;
		getTracks: () => unknown[];
		getTotalDuration: () => number;
	};
	media: {
		subscribe: (cb: () => void) => () => void;
		getAssets: () => unknown[];
	};
}

// State holders — test mutate rồi trigger subscription callback.
let isPlaying = false;
let currentTime = 0;
let playbackCb: (() => void) | null = null;
let tracks: unknown[] = [];
let assets: unknown[] = [];

function buildEditor(): FakeEditor {
	return {
		playback: {
			subscribe: (cb: () => void) => {
				playbackCb = cb;
				return () => {};
			},
			getIsPlaying: () => isPlaying,
			getCurrentTime: () => currentTime,
			getVolume: () => 1,
			getIsScrubbing: () => false,
		},
		timeline: {
			subscribe: () => () => {},
			getTracks: () => tracks,
			getTotalDuration: () => 30,
		},
		media: {
			subscribe: () => () => {},
			getAssets: () => assets,
		},
	};
}

// Tạo 1 audio element upload + mediaAsset tương ứng.
function makeAudioClip({
	elementId,
	mediaId,
	startTime,
	duration,
	trimStart,
}: {
	elementId: string;
	mediaId: string;
	startTime: number;
	duration: number;
	trimStart: number;
}): void {
	const file = new File([new Uint8Array([0, 1, 2])], `${mediaId}.mp3`, {
		type: "audio/mpeg",
	});
	assets = [
		...assets,
		{ id: mediaId, type: "audio", file } as unknown,
	];
	tracks = [
		{
			id: "track-1",
			type: "audio",
			muted: false,
			elements: [
				{
					id: elementId,
					type: "audio",
					sourceType: "upload",
					mediaId,
					startTime,
					duration,
					trimStart,
					trimEnd: trimStart + duration,
					muted: false,
					volume: 1,
				},
			],
		},
	];
}

// ── Test env stub ───────────────────────────────────────────────────────

interface StubbedWindow {
	addEventListener: () => void;
	removeEventListener: () => void;
	setInterval: () => number;
	clearInterval: () => void;
	dispatchEvent: () => boolean;
	AudioContext: typeof FakeAudioContext;
}

const g = globalThis as unknown as {
	window?: StubbedWindow;
	AudioContext?: typeof FakeAudioContext;
};
let savedWindow: StubbedWindow | undefined;
let savedAudioContext: typeof FakeAudioContext | undefined;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
	isPlaying = false;
	currentTime = 0;
	playbackCb = null;
	tracks = [];
	assets = [];
	createdContexts.length = 0;
	audioTestState.decodeAdvance = 0;
	audioTestState.advanceTime = (delta: number) => {
		currentTime += delta;
	};

	savedWindow = g.window;
	savedAudioContext = g.AudioContext;
	g.window = {
		addEventListener: () => {},
		removeEventListener: () => {},
		setInterval: () => 0, // no-op: chỉ initial scheduleUpcomingClips chạy
		clearInterval: () => {},
		dispatchEvent: () => false,
		AudioContext: FakeAudioContext,
	};
	g.AudioContext = FakeAudioContext;
});

afterEach(() => {
	if (savedWindow === undefined) delete g.window;
	else g.window = savedWindow;
	if (savedAudioContext === undefined) delete g.AudioContext;
	else g.AudioContext = savedAudioContext;
});

// Trigger play: set state + gọi subscription callback (handlePlaybackChange).
async function triggerPlay(): Promise<void> {
	isPlaying = true;
	playbackCb?.();
	await flush();
}

async function triggerStop(): Promise<void> {
	isPlaying = false;
	playbackCb?.();
	await flush();
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("AudioManager — native decodeAudioData + single AudioBufferSourceNode (#237)", () => {
	test("decode clip 1 lần duy nhất, cache theo sourceKey (không decode lại khi replay)", async () => {
		makeAudioClip({
			elementId: "el-1",
			mediaId: "asset-1",
			startTime: 0,
			duration: 5,
			trimStart: 0.5,
		});
		const editor = buildEditor();
		new AudioManager(editor as unknown as EditorCore);

		await triggerPlay();
		const ctx = createdContexts[0];
		const decodesAfterPlay1 = ctx.decodeAudioDataCalls;
		expect(decodesAfterPlay1).toBe(1);

		// stop — cache phải survived (stopPlayback không clear clipBuffers)
		await triggerStop();

		// replay — cache hit, không decode thêm
		await triggerPlay();
		expect(ctx.decodeAudioDataCalls).toBe(decodesAfterPlay1);
	});

	test("scheduleClip future-start: node.start(when, offset, duration) với absolute timing", async () => {
		makeAudioClip({
			elementId: "el-1",
			mediaId: "asset-1",
			startTime: 0,
			duration: 5,
			trimStart: 0.5,
		});
		currentTime = 0;
		const editor = buildEditor();
		new AudioManager(editor as unknown as EditorCore);

		await triggerPlay();
		const ctx = createdContexts[0];

		// 1 source tạo, 1 start call với when=0, offset=trimStart, duration=5
		const started = ctx.sources.filter((s) => s.started !== null);
		expect(started.length).toBe(1);
		expect(started[0].started).toEqual({
			when: 0,
			offset: 0.5,
			duration: 5,
		});
	});

	test("scheduleClip late-start (seek vào giữa clip): offset + lateBy, duration - lateBy", async () => {
		makeAudioClip({
			elementId: "el-1",
			mediaId: "asset-1",
			startTime: 0,
			duration: 5,
			trimStart: 0.5,
		});
		// Seek vào giữa clip: playback start tại timeline time=2 (clip bắt đầu ở 0)
		currentTime = 2;
		const editor = buildEditor();
		new AudioManager(editor as unknown as EditorCore);

		await triggerPlay();
		const ctx = createdContexts[0];

		// when = ctxStart(0) + (clipStart(0) - playStart(2)) = -2 → đã quá
		// lateBy = ctx.currentTime(0) - when(-2) = 2
		// → start(0, trimStart(0.5)+2, duration(5)-2) = start(0, 2.5, 3)
		const started = ctx.sources.filter((s) => s.started !== null);
		expect(started.length).toBe(1);
		expect(started[0].started).toEqual({
			when: 0,
			offset: 2.5,
			duration: 3,
		});
	});

	test("ensureClipsDecoded decode mọi clip song song (2 asset khác nhau → 2 decode)", async () => {
		makeAudioClip({
			elementId: "el-1",
			mediaId: "asset-1",
			startTime: 0,
			duration: 5,
			trimStart: 0,
		});
		// Thêm clip thứ 2 với asset khác (sourceKey khác)
		assets = [
			...assets,
			{
				id: "asset-2",
				type: "audio",
				file: new File([new Uint8Array([3, 4])], "asset-2.mp3", {
					type: "audio/mpeg",
				}),
			} as unknown,
		];
		tracks = [
			...tracks,
			{
				id: "track-2",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "el-2",
						type: "audio",
						sourceType: "upload",
						mediaId: "asset-2",
						startTime: 0,
						duration: 4,
						trimStart: 0,
						trimEnd: 4,
						muted: false,
						volume: 1,
					},
				],
			},
		];
		const editor = buildEditor();
		new AudioManager(editor as unknown as EditorCore);

		await triggerPlay();
		const ctx = createdContexts[0];

		expect(ctx.decodeAudioDataCalls).toBe(2);
		// Cả 2 clip đều được schedule (cùng startTime=0, trong lookahead window)
		const started = ctx.sources.filter((s) => s.started !== null);
		expect(started.length).toBe(2);
	});

	test("clip đã kết thúc (lateBy >= duration) không được schedule", async () => {
		makeAudioClip({
			elementId: "el-1",
			mediaId: "asset-1",
			startTime: 0,
			duration: 5,
			trimStart: 0,
		});
		// Seek PAST clip end: playback tại time=10 (clip 0..5 đã hết)
		currentTime = 10;
		const editor = buildEditor();
		new AudioManager(editor as unknown as EditorCore);

		await triggerPlay();
		const ctx = createdContexts[0];

		// Decode vẫn chạy (ensureClipsDecoded decode tất cả), nhưng clip không schedule
		expect(ctx.decodeAudioDataCalls).toBe(1);
		const started = ctx.sources.filter((s) => s.started !== null);
		expect(started.length).toBe(0);
	});

	test("dispose dọn sạch tài nguyên: close AudioContext + clear cache + disconnect trackNodes", async () => {
		makeAudioClip({
			elementId: "el-1",
			mediaId: "asset-1",
			startTime: 0,
			duration: 5,
			trimStart: 0,
		});
		const editor = buildEditor();
		const am = new AudioManager(editor as unknown as EditorCore);
		await triggerPlay();
		const ctx = createdContexts[0];
		expect(ctx.decodeAudioDataCalls).toBe(1);

		// dispose → stopPlayback (activeSources stop) + disposeSinks (clear cache,
		// disconnect trackNodes) + audioContext.close()
		am.dispose();
		await flush();

		expect(ctx.closed).toBe(true);
	});

	test("sync fix: audio schedule theo playhead THỰC TẾ sau decode, không dùng time cũ", async () => {
		makeAudioClip({
			elementId: "el-1",
			mediaId: "asset-1",
			startTime: 0,
			duration: 5,
			trimStart: 0.5,
		});
		currentTime = 0;
		// Mô phỏng playback timer advance 0.5s trong lúc ensureClipsDecoded chạy.
		// Không có sync fix, playbackStartTime = time(0) cũ → audio schedule ở
		// timeline 0 trong khi playhead ở 0.5 → playhead chạy trước audio (bug).
		audioTestState.decodeAdvance = 0.5;
		const editor = buildEditor();
		new AudioManager(editor as unknown as EditorCore);

		await triggerPlay();
		const ctx = createdContexts[0];

		const started = ctx.sources.filter((s) => s.started !== null);
		expect(started.length).toBe(1);
		// Sync fix: playbackStartTime = getCurrentTime() = 0.5 (sau decode).
		// when = ctxStart(0) + (clipStart(0) - playStart(0.5)) = -0.5 → late-start.
		// lateBy = 0 - (-0.5) = 0.5 → offset = trimStart(0.5)+0.5 = 1.0, duration = 4.5.
		// → audio chơi từ 1.0s của source, khớp playhead ở 0.5s timeline (sync ✅).
		expect(started[0].started).toEqual({ when: 0, offset: 1.0, duration: 4.5 });
	});
});
