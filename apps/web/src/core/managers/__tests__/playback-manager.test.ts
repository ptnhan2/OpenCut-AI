import { describe, expect, test, beforeEach } from "bun:test";
import type { EditorCore } from "@/core";
import { PlaybackManager } from "../playback-manager";

/**
 * Test suite cho việc tách continuous-play time-tick ra khỏi React re-render.
 *
 * Bối cảnh: Issue #235 — playback.notify() re-render toàn bộ React tree (gồm
 * ResizablePanelGroup) gây UI lag. Fix: trong nhánh continuous-play của updateTime,
 * KHÔNG gọi notify() mỗi frame; canvas + playhead + timecode đọc time qua
 * playback-update event 60fps. notify() chỉ còn ở play/pause/seek/boundary.
 */

// Fake editor tối giản: PlaybackManager chỉ cần timeline.getTotalDuration() khi play.
interface FakeEditor {
	timeline: { getTotalDuration: () => number };
}

// Biến môi trường test được stub qua object typed (tránh `any` rải rác).
interface StubbedGlobals {
	requestAnimationFrame: (cb: (time: number) => void) => number;
	cancelAnimationFrame: (id: number) => void;
	performance: { now: () => number };
	CustomEvent: new (
		type: string,
		opts?: { detail?: unknown },
	) => { type: string; detail?: unknown };
	window: { dispatchEvent: (ev: { type: string; detail?: unknown }) => void };
}

const g = globalThis as unknown as StubbedGlobals;

describe("PlaybackManager — continuous-play decoupled from React notify", () => {
	let now: number;
	let rafQueue: Array<() => void>;
	let dispatched: Array<{ type: string; time?: number }>;

	beforeEach(() => {
		now = 1000;
		rafQueue = [];
		dispatched = [];

		g.requestAnimationFrame = (cb: (time: number) => void) => {
			rafQueue.push(() => cb(now));
			return rafQueue.length;
		};
		g.cancelAnimationFrame = () => {
			/* no-op for test */
		};
		g.performance = { now: () => now };
		g.CustomEvent = class {
			type: string;
			detail: unknown;
			constructor(type: string, opts: { detail?: unknown } = {}) {
				this.type = type;
				this.detail = opts.detail;
			}
		};
		g.window = {
			dispatchEvent: (ev: { type: string; detail?: { time?: number } }) => {
				dispatched.push({ type: ev.type, time: ev.detail?.time });
			},
		};
	});

	/** Chạy 1 frame RAF: tăng performance.now() thêm deltaMs rồi chạy callback kế tiếp. */
	function tickFrame(deltaMs: number): void {
		now += deltaMs;
		const cb = rafQueue.pop();
		if (cb) cb();
	}

	test("không gọi notify() trong các frame continuous-play (dù vượt threshold throttle)", () => {
		const editor = { timeline: { getTotalDuration: () => 10 } } as FakeEditor;
		const pm = new PlaybackManager(editor as unknown as EditorCore);
		const notifyCount = { value: 0 };
		pm.subscribe(() => {
			notifyCount.value++;
		});

		// seek + play: 2 lần notify (state changes — đúng, phải giữ)
		pm.seek({ time: 2 });
		pm.play();

		// Bắt đầu đếm từ sau play() (state notifies đã xong)
		const baseline = notifyCount.value;

		// Mỗi frame tiến 600ms (vượt threshold throttle 500ms của code cũ)
		// Code CŨ sẽ notify mỗi frame này → baseline tăng. Code MỚI không notify.
		tickFrame(600);
		tickFrame(600);
		tickFrame(600);

		expect(notifyCount.value).toBe(baseline);
	});

	test("vẫn dispatch playback-update event mỗi frame continuous-play", () => {
		const editor = { timeline: { getTotalDuration: () => 10 } } as FakeEditor;
		const pm = new PlaybackManager(editor as unknown as EditorCore);
		pm.seek({ time: 2 });
		pm.play();

		const before = dispatched.filter((e) => e.type === "playback-update").length;
		tickFrame(16);
		tickFrame(16);
		const after = dispatched.filter((e) => e.type === "playback-update").length;

		// Event 60fps phải vẫn dispatch (canvas + playhead + timecode phụ thuộc nó)
		expect(after - before).toBe(2);
	});

	test("vẫn gọi notify() khi pause (state change)", () => {
		const editor = { timeline: { getTotalDuration: () => 10 } } as FakeEditor;
		const pm = new PlaybackManager(editor as unknown as EditorCore);
		const notifyCount = { value: 0 };
		pm.subscribe(() => {
			notifyCount.value++;
		});
		pm.seek({ time: 2 });
		pm.play();
		const before = notifyCount.value;

		pm.pause();

		expect(notifyCount.value).toBe(before + 1);
	});

	test("vẫn gọi notify() khi seek (state change)", () => {
		const editor = { timeline: { getTotalDuration: () => 10 } } as FakeEditor;
		const pm = new PlaybackManager(editor as unknown as EditorCore);
		const notifyCount = { value: 0 };
		pm.subscribe(() => {
			notifyCount.value++;
		});
		const before = notifyCount.value;

		pm.seek({ time: 5 });

		expect(notifyCount.value).toBe(before + 1);
	});
});
