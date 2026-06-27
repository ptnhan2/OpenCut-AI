"use client";

import { useEffect, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { formatTimeCode } from "@/lib/time";
import { invokeAction } from "@/lib/actions";
import { EditableTimecode } from "@/components/editable-timecode";
import { Button } from "@/components/ui/button";
import {
	FullScreenIcon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { OcSocialIcon } from "@opencut-ai/ui/icons";
import { Separator } from "@/components/ui/separator";

export function PreviewToolbar({
	isFullscreen,
	onToggleFullscreen,
}: {
	isFullscreen: boolean;
	onToggleFullscreen: () => void;
}) {
	const editor = useEditor();
	const isPlaying = editor.playback.getIsPlaying();
	const totalDuration = editor.timeline.getTotalDuration();
	const fps = editor.project.getActive().settings.fps;
	// timecode đọc time qua playback-update 60fps (state cục bộ) thay vì useEditor,
	// vì notify() đã ngắt khỏi continuous-play (xem playback-manager.ts). Chỉ
	// PreviewToolbar re-render 60fps — panel group + assets không bị kéo theo.
	const [currentTime, setCurrentTime] = useState(editor.playback.getCurrentTime());
	useEffect(() => {
		const onTick = (event: Event) => {
			const time = (event as CustomEvent<{ time: number }>).detail?.time;
			if (typeof time === "number") setCurrentTime(time);
		};
		window.addEventListener("playback-update", onTick);
		return () => window.removeEventListener("playback-update", onTick);
	}, []);

	return (
		<div className="grid grid-cols-[1fr_auto_1fr] items-center pb-3 pt-5 px-5">
			<div className="flex items-center">
				<EditableTimecode
					time={currentTime}
					duration={totalDuration}
					format="HH:MM:SS:FF"
					fps={fps}
					onTimeChange={({ time }) => editor.playback.seek({ time })}
					className="text-center"
				/>
				<span className="text-muted-foreground px-2 font-mono text-xs">/</span>
				<span className="text-muted-foreground font-mono text-xs">
					{formatTimeCode({
						timeInSeconds: totalDuration,
						format: "HH:MM:SS:FF",
						fps,
					})}
				</span>
			</div>

			<Button
				variant="text"
				size="icon"
				onClick={() => invokeAction("toggle-play")}
			>
				<HugeiconsIcon icon={isPlaying ? PauseIcon : PlayIcon} />
			</Button>

			<div className="justify-self-end flex items-center gap-2.5">
				<Button
					variant="secondary"
					size="sm"
					className="[&_svg]:size-auto px-1 h-7"
					onClick={onToggleFullscreen}
					title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
				>
					<OcSocialIcon size={20} />
				</Button>
				<Separator orientation="vertical" className="h-4" />
				<Button
					variant="text"
					onClick={onToggleFullscreen}
					title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
				>
					<HugeiconsIcon icon={FullScreenIcon} />
				</Button>
			</div>
		</div>
	);
}
