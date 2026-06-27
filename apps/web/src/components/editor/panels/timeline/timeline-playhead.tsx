"use client";

import { useEffect, useRef } from "react";
import {
	getCenteredLineLeft,
	TIMELINE_INDICATOR_LINE_WIDTH_PX,
	timelineTimeToSnappedPixels,
} from "@/lib/timeline";
import { useTimelinePlayhead } from "@/hooks/timeline/use-timeline-playhead";
import { useEditor } from "@/hooks/use-editor";

interface TimelinePlayheadProps {
	zoomLevel: number;
	rulerRef: React.RefObject<HTMLDivElement | null>;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	timelineRef: React.RefObject<HTMLDivElement | null>;
	playheadRef?: React.RefObject<HTMLDivElement | null>;
	isSnappingToPlayhead?: boolean;
}

export function TimelinePlayhead({
	zoomLevel,
	rulerRef,
	rulerScrollRef,
	tracksScrollRef,
	timelineRef,
	playheadRef: externalPlayheadRef,
	isSnappingToPlayhead = false,
}: TimelinePlayheadProps) {
	const editor = useEditor();
	const duration = editor.timeline.getTotalDuration();
	const internalPlayheadRef = useRef<HTMLDivElement>(null);
	const playheadRef = externalPlayheadRef || internalPlayheadRef;

	const { playheadPosition, handlePlayheadMouseDown } = useTimelinePlayhead({
		zoomLevel,
		rulerRef,
		rulerScrollRef,
		tracksScrollRef,
		playheadRef,
	});

	// Use scrollHeight (total content) so the playhead extends through all tracks,
	// not just the visible viewport
	const timelineContainerHeight = Math.max(
		tracksScrollRef.current?.scrollHeight ?? 0,
		tracksScrollRef.current?.clientHeight ?? 0,
		timelineRef.current?.clientHeight ?? 400,
	);
	const totalHeight = Math.max(0, timelineContainerHeight - 4);

	const centerPosition = timelineTimeToSnappedPixels({
		time: playheadPosition,
		zoomLevel,
	});
	const leftPosition = getCenteredLineLeft({ centerPixel: centerPosition });

	// Khi đang play, đè vị trí playhead qua sự kiện playback-update (imperative,
	// bypass React) để playhead chạy mượt. Dùng transform: translateX (GPU-composited,
	// không trigger layout/reflow như `left`). useEditor không re-render khi play (xem
	// playback-manager.ts) nên transform do event gán được giữ giữa các frame. Khi
	// pause/seek, React re-render và set inline transform trở lại từ leftPosition.
	useEffect(() => {
		const el = playheadRef.current;
		if (!el) return;
		const onTick = (event: Event) => {
			const time = (event as CustomEvent<{ time: number }>).detail?.time;
			if (typeof time !== "number") return;
			const center = timelineTimeToSnappedPixels({ time, zoomLevel });
			el.style.transform = `translateX(${getCenteredLineLeft({
				centerPixel: center,
			})}px)`;
		};
		window.addEventListener("playback-update", onTick);
		return () => window.removeEventListener("playback-update", onTick);
	}, [zoomLevel, playheadRef]);

	const handlePlayheadKeyDown = (
		event: React.KeyboardEvent<HTMLDivElement>,
	) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

		event.preventDefault();
		const step = 1 / Math.max(1, editor.project.getActive().settings.fps);
		const direction = event.key === "ArrowRight" ? 1 : -1;
		const nextTime = Math.max(
			0,
			Math.min(duration, playheadPosition + direction * step),
		);

		editor.playback.seek({ time: nextTime });
	};

	return (
		<div
			ref={playheadRef}
			role="slider"
			aria-label="Timeline playhead"
			aria-valuemin={0}
			aria-valuemax={duration}
			aria-valuenow={playheadPosition}
			tabIndex={0}
			className="pointer-events-none absolute z-5"
			style={{
				left: 0,
				top: 0,
				height: `${totalHeight}px`,
				width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
				transform: `translateX(${leftPosition}px)`,
				willChange: "transform",
			}}
			onKeyDown={handlePlayheadKeyDown}
		>
			<div className="bg-foreground pointer-events-none absolute left-0 h-full w-0.5" />

			<button
				type="button"
				aria-label="Drag playhead"
				className={`pointer-events-auto absolute top-1 left-1/2 size-3 -translate-x-1/2 transform cursor-col-resize rounded-full border-2 shadow-xs ${isSnappingToPlayhead ? "bg-foreground border-foreground" : "bg-foreground border-foreground/50"}`}
				onMouseDown={handlePlayheadMouseDown}
			/>
		</div>
	);
}
