import type { EditorCore } from "@/core";
import type { AudioClipSource } from "@/lib/media/audio";
import { createAudioContext, collectAudioClips } from "@/lib/media/audio";

export class AudioManager {
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private masterAnalyser: AnalyserNode | null = null;
	private trackNodes = new Map<
		string,
		{
			gain: GainNode;
			panner: StereoPannerNode;
			analyser: AnalyserNode;
		}
	>();
	private playbackStartTime = 0;
	private playbackStartContextTime = 0;
	private scheduleTimer: number | null = null;
	private lookaheadSeconds = 2;
	private scheduleIntervalMs = 500;
	private clips: AudioClipSource[] = [];
	private activeClipIds = new Set<string>();
	private clipBuffers = new Map<string, AudioBuffer>();
	private activeSources = new Set<AudioBufferSourceNode>();
	private playbackSessionId = 0;
	private lastIsPlaying = false;
	private lastVolume = 1;
	private unsubscribers: Array<() => void> = [];

	constructor(private editor: EditorCore) {
		this.lastVolume = this.editor.playback.getVolume();

		this.unsubscribers.push(
			this.editor.playback.subscribe(this.handlePlaybackChange),
			this.editor.timeline.subscribe(this.handleTimelineChange),
			this.editor.media.subscribe(this.handleTimelineChange),
		);
		if (typeof window !== "undefined") {
			window.addEventListener("playback-seek", this.handleSeek);
		}
	}

	dispose(): void {
		this.stopPlayback();
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		if (typeof window !== "undefined") {
			window.removeEventListener("playback-seek", this.handleSeek);
		}
		this.disposeSinks();
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
			this.masterGain = null;
		}
	}

	private handlePlaybackChange = (): void => {
		const isPlaying = this.editor.playback.getIsPlaying();
		const volume = this.editor.playback.getVolume();

		if (volume !== this.lastVolume) {
			this.lastVolume = volume;
			this.updateGain();
		}

		if (isPlaying !== this.lastIsPlaying) {
			this.lastIsPlaying = isPlaying;
			if (isPlaying) {
				void this.startPlayback({
					time: this.editor.playback.getCurrentTime(),
				});
			} else {
				this.stopPlayback();
			}
		}
	};

	private handleSeek = (event: Event): void => {
		const detail = (event as CustomEvent<{ time: number }>).detail;
		if (!detail) return;

		if (this.editor.playback.getIsScrubbing()) {
			this.stopPlayback();
			return;
		}

		if (this.editor.playback.getIsPlaying()) {
			void this.startPlayback({ time: detail.time });
			return;
		}

		this.stopPlayback();
	};

	private handleTimelineChange = (): void => {
		void this.ensureClipsDecoded();

		if (!this.editor.playback.getIsPlaying()) return;

		void this.startPlayback({ time: this.editor.playback.getCurrentTime() });
	};

	private ensureAudioContext(): AudioContext | null {
		if (this.audioContext) return this.audioContext;
		if (typeof window === "undefined") return null;

		this.audioContext = createAudioContext();
		this.masterGain = this.audioContext.createGain();
		this.masterGain.gain.value = this.lastVolume;
		this.masterAnalyser = this.audioContext.createAnalyser();
		this.masterAnalyser.fftSize = 256;
		this.masterAnalyser.smoothingTimeConstant = 0.8;
		this.masterGain.connect(this.masterAnalyser);
		this.masterAnalyser.connect(this.audioContext.destination);
		return this.audioContext;
	}

	private updateGain(): void {
		if (!this.masterGain) return;
		this.masterGain.gain.value = this.lastVolume;
	}

	private getOrCreateTrackNodes(trackId: string): {
		gain: GainNode;
		panner: StereoPannerNode;
		analyser: AnalyserNode;
	} | null {
		const ctx = this.audioContext;
		if (!ctx || !this.masterGain) return null;

		const existing = this.trackNodes.get(trackId);
		if (existing) return existing;

		const tracks = this.editor.timeline.getTracks();
		const track = tracks.find((t) => t.id === trackId);
		const trackVolume =
			(track && ("volume" in track ? track.volume : undefined)) ?? 1;
		const trackPan =
			(track && ("pan" in track ? track.pan : undefined)) ?? 0;

		const gain = ctx.createGain();
		gain.gain.value = trackVolume;

		const panner = ctx.createStereoPanner();
		panner.pan.value = trackPan;

		const analyser = ctx.createAnalyser();
		analyser.fftSize = 256;
		analyser.smoothingTimeConstant = 0.8;

		gain.connect(panner);
		panner.connect(analyser);
		analyser.connect(this.masterGain);

		const nodes = { gain, panner, analyser };
		this.trackNodes.set(trackId, nodes);
		return nodes;
	}

	private rebuildTrackNodes(): void {
		for (const [, nodes] of this.trackNodes) {
			try {
				nodes.gain.disconnect();
				nodes.panner.disconnect();
				nodes.analyser.disconnect();
			} catch {}
		}
		this.trackNodes.clear();
	}

	getTrackLevels(trackId: string): { peak: number; rms: number } {
		const nodes = this.trackNodes.get(trackId);
		if (!nodes) return { peak: 0, rms: 0 };
		return this.readAnalyserLevels(nodes.analyser);
	}

	getMasterLevels(): { peak: number; rms: number } {
		if (!this.masterAnalyser) return { peak: 0, rms: 0 };
		return this.readAnalyserLevels(this.masterAnalyser);
	}

	private readAnalyserLevels(analyser: AnalyserNode): {
		peak: number;
		rms: number;
	} {
		const bufferLength = analyser.fftSize;
		const dataArray = new Float32Array(bufferLength);
		analyser.getFloatTimeDomainData(dataArray);

		let peak = 0;
		let sumSquares = 0;
		for (let i = 0; i < bufferLength; i++) {
			const abs = Math.abs(dataArray[i]);
			if (abs > peak) peak = abs;
			sumSquares += dataArray[i] * dataArray[i];
		}
		const rms = Math.sqrt(sumSquares / bufferLength);
		return { peak, rms };
	}

	updateTrackVolume(trackId: string, volume: number): void {
		const nodes = this.trackNodes.get(trackId);
		if (nodes) {
			nodes.gain.gain.value = volume;
		}
	}

	updateTrackPan(trackId: string, pan: number): void {
		const nodes = this.trackNodes.get(trackId);
		if (nodes) {
			nodes.panner.pan.value = pan;
		}
	}

	private getTrackDestination(clipId: string): AudioNode {
		const ctx = this.audioContext;
		if (!ctx || !this.masterGain) return ctx?.destination ?? this.masterGain!;

		const tracks = this.editor.timeline.getTracks();
		const trackWithClip = tracks.find((t) =>
			t.elements.some((el) => el.id === clipId),
		);

		if (!trackWithClip) return this.masterGain;

		const trackNodes = this.getOrCreateTrackNodes(trackWithClip.id);
		if (!trackNodes) return this.masterGain;

		const isSoloMode = tracks.some(
			(t) => "solo" in t && t.solo,
		);
		const trackSolo = "solo" in trackWithClip ? trackWithClip.solo : false;

		if (isSoloMode && !trackSolo) {
			const silentGain = ctx.createGain();
			silentGain.gain.value = 0;
			silentGain.connect(this.masterGain);
			return silentGain;
		}

		return trackNodes.gain;
	}

	private getPlaybackTime(): number {
		if (!this.audioContext) return this.playbackStartTime;
		const elapsed =
			this.audioContext.currentTime - this.playbackStartContextTime;
		return this.playbackStartTime + elapsed;
	}

	private async startPlayback({ time }: { time: number }): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		this.stopPlayback();
		this.rebuildTrackNodes();
		this.playbackSessionId++;

		const duration = this.editor.timeline.getTotalDuration();

		if (duration <= 0) return;

		if (audioContext.state === "suspended") {
			await audioContext.resume();
		}

		// Eager pre-decode: decode toàn bộ clip off-main-thread TRƯỚC khi schedule
		// (Issue #237 — chuẩn industry). Cache persistent → seek/replay instant.
		await this.ensureClipsDecoded();
		if (!this.editor.playback.getIsPlaying()) return;

		this.playbackStartTime = time;
		this.playbackStartContextTime = audioContext.currentTime;

		this.scheduleUpcomingClips();

		if (typeof window !== "undefined") {
			this.scheduleTimer = window.setInterval(() => {
				this.scheduleUpcomingClips();
			}, this.scheduleIntervalMs);
		}
	}

	private scheduleUpcomingClips(): void {
		if (!this.editor.playback.getIsPlaying()) return;

		const currentTime = this.getPlaybackTime();
		const windowEnd = currentTime + this.lookaheadSeconds;

		for (const clip of this.clips) {
			if (clip.muted) continue;
			if (this.activeClipIds.has(clip.id)) continue;

			const clipEnd = clip.startTime + clip.duration;
			if (clipEnd <= currentTime) continue;
			if (clip.startTime > windowEnd) continue;

			this.activeClipIds.add(clip.id);
			void this.scheduleClip({
				clip,
				sessionId: this.playbackSessionId,
			});
		}
	}

	private stopPlayback(): void {
		if (this.scheduleTimer && typeof window !== "undefined") {
			window.clearInterval(this.scheduleTimer);
		}
		this.scheduleTimer = null;

		for (const source of this.activeSources) {
			try {
				source.stop();
			} catch {}
			source.disconnect();
		}
		this.activeSources.clear();
		this.activeClipIds.clear();
		// KHÔNG clear clipBuffers — cache persistent cho seek/replay (Issue #237).
	}

	/**
	 * Eager decode toàn bộ clip hiện tại sang AudioBuffer (off-main-thread native).
	 * Pre-process TRƯỚC khi play + khi timeline/media thay đổi — chuẩn industry
	 * (Issue #237). Cache persistent theo sourceKey → seek/replay instant.
	 *
	 * @sideEffect Gán this.clips, populate this.clipBuffers (decode off-main-thread).
	 */
	private async ensureClipsDecoded(): Promise<void> {
		const tracks = this.editor.timeline.getTracks();
		const mediaAssets = this.editor.media.getAssets();
		this.clips = await collectAudioClips({ tracks, mediaAssets });
		await Promise.all(
			this.clips.map((clip) => this.decodeClipBuffer({ clip })),
		);
	}

	/**
	 * Decode toàn bộ 1 clip thành AudioBuffer bằng native decodeAudioData (off-main-
	 * thread), cache theo sourceKey. Thay thế mediabunny AudioBufferSink streaming
	 * (chunk loop trên main thread — thủ phạm block RAF, Issue #237).
	 *
	 * @param clip - Audio clip source (file đã resolve: upload local hoặc library fetch).
	 * @returns Decoded AudioBuffer, hoặc null nếu decode fail. Trả cache nếu đã decode.
	 * @sideEffect Ghi this.clipBuffers[sourceKey] khi decode lần đầu.
	 */
	private async decodeClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const cached = this.clipBuffers.get(clip.sourceKey);
		if (cached) return cached;

		const audioContext = this.ensureAudioContext();
		if (!audioContext) return null;

		try {
			const arrayBuffer = await clip.file.arrayBuffer();
			const buffer = await audioContext.decodeAudioData(arrayBuffer);
			this.clipBuffers.set(clip.sourceKey, buffer);
			return buffer;
		} catch (error) {
			console.warn("decodeClipBuffer failed:", clip.sourceKey, error);
			return null;
		}
	}

	/**
	 * Schedule 1 AudioBufferSourceNode/clip với absolute Web Audio clock
	 * (node.start(when, offset, duration)) — sample-accurate, chạy trên audio thread.
	 * Thay thế runClipIterator (for-await chunk loop + per-chunk node creation trên
	 * main thread — Issue #237). Xử lý seek-into-middle (late-start) bằng offset.
	 *
	 * @param clip - Audio clip cần schedule.
	 * @param sessionId - Playback session id (bỏ qua nếu session đã đổi).
	 * @sideEffect Tạo + connect AudioBufferSourceNode, add vào this.activeSources.
	 */
	private async scheduleClip({
		clip,
		sessionId,
	}: {
		clip: AudioClipSource;
		sessionId: number;
	}): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;
		if (sessionId !== this.playbackSessionId) return;

		const buffer = await this.decodeClipBuffer({ clip });
		if (!buffer) return;
		if (!this.editor.playback.getIsPlaying()) return;
		if (sessionId !== this.playbackSessionId) return;

		const node = audioContext.createBufferSource();
		node.buffer = buffer;

		// Apply per-clip playback rate (speed control)
		const clipRate = (clip as unknown as { playbackRate?: number }).playbackRate;
		if (typeof clipRate === "number" && clipRate !== 1.0) {
			node.playbackRate.value = clipRate;
		}

		const destinationNode = this.getTrackDestination(clip.id);

		const clipVolume = clip.volume ?? 1;
		if (clipVolume < 1) {
			const clipGain = audioContext.createGain();
			clipGain.gain.value = clipVolume;
			node.connect(clipGain);
			clipGain.connect(destinationNode);
		} else {
			node.connect(destinationNode);
		}

		// Absolute Web Audio clock: when = contextStart + (clipStart - playStart)
		const when =
			this.playbackStartContextTime +
			(clip.startTime - this.playbackStartTime);

		if (when >= audioContext.currentTime) {
			// Clip bắt đầu ở tương lai — schedule chính xác
			node.start(when, clip.trimStart, clip.duration);
		} else {
			// Seek vào giữa clip — offset vào buffer theo thời gian đã trôi qua
			const lateBy = audioContext.currentTime - when;
			if (lateBy >= clip.duration) {
				// Clip đã kết thúc — không schedule
				node.disconnect();
				return;
			}
			node.start(
				audioContext.currentTime,
				clip.trimStart + lateBy,
				clip.duration - lateBy,
			);
		}

		this.activeSources.add(node);
		node.addEventListener("ended", () => {
			node.disconnect();
			this.activeSources.delete(node);
		});
	}

	private disposeSinks(): void {
		for (const source of this.activeSources) {
			try {
				source.stop();
			} catch {}
			source.disconnect();
		}
		this.activeSources.clear();
		this.activeClipIds.clear();
		this.clipBuffers.clear();

		for (const [, nodes] of this.trackNodes) {
			try {
				nodes.gain.disconnect();
				nodes.panner.disconnect();
				nodes.analyser.disconnect();
			} catch {}
		}
		this.trackNodes.clear();
	}
}
