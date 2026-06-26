"use client";

import { useParams, useSearchParams } from "next/navigation";
import {
	ResizablePanelGroup, ResizablePanel, ResizableHandle,
} from "@/components/ui/resizable";
import { AssetsPanel } from "@/components/editor/panels/assets";
import { Timeline } from "@/components/editor/panels/timeline";
import { PreviewPanel } from "@/components/editor/panels/preview";
import { EditorHeader } from "@/components/editor/editor-header";
import { EditorProvider } from "@/components/providers/editor-provider";
import { Onboarding } from "@/components/editor/onboarding";
import { MigrationDialog } from "@/components/editor/dialogs/migration-dialog";
import { usePanelStore } from "@/stores/panel-store";
import { usePasteMedia } from "@/hooks/use-paste-media";
import { MobileGate } from "@/components/editor/mobile-gate";
import { AIPanelWrapper } from "@/components/editor/ai/ai-panel-wrapper";
import { QuickActionsBar } from "@/components/editor/ai/quick-actions-bar";
import { EmptyEditorGuide } from "@/components/editor/empty-editor-guide";
import { RightPanel } from "@/components/editor/panels/right-panel";
import { useTranscriptStore } from "@/stores/transcript-store";
import { useEditor } from "@/hooks/use-editor";
import { useTranscribePrompt } from "@/hooks/use-transcribe-prompt";
import { useEffect, useRef, useState } from "react";
import type { TextElement } from "@/types/timeline";
import { BackgroundTasksWidget } from "@/components/editor/background-tasks";
import { CommandPalette } from "@/components/editor/command-palette";

const PENDING_IMPORT_KEY = "opencut:pending-import";
const PLATFORM = "http://localhost:3000";

function imgDataUrl(r, g, b, label) {
	var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="100%" height="100%" fill="rgb('+r+','+g+','+b+')"/><text x="960" y="540" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="60" fill="white" opacity="0.7">'+label+'</text></svg>';
	return "data:image/svg+xml," + encodeURIComponent(svg);
}

function cleanImageEl(el, color, label) {
	return {
		id: el.id, name: label, duration: el.duration, startTime: el.startTime,
		trimStart: 0, trimEnd: 0, sourceDuration: el.duration,
		type: "image", sourceType: "library",
		sourceUrl: imgDataUrl(color[0], color[1], color[2], label),
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1, blendMode: "normal", hidden: false, playbackRate: 1,
	};
}

function fixAudioEl(el) {
	var mid = el.mediaId || '';
	if (mid.startsWith('media-tts-')) {
		el.sourceType = "library";
		el.sourceUrl = PLATFORM + '/assets/audio/tts/' + mid.replace('media-tts-', '') + '.mp3';
		delete el.mediaId;
	}
	return el;
}

function postProcess(json) {
	var scenes = json.scenes;
	var colors = [[26,26,46],[22,33,62],[15,52,96],[83,52,131],[45,106,79],[127,79,36],[88,47,14],[147,102,57]];
	var shotNum = 0;

	for (var si = 0; si < scenes.length; si++) {
		var tracks = scenes[si].tracks;
		var newTracks = [];
		for (var ti = 0; ti < tracks.length; ti++) {
			var t = tracks[ti];
			var els = t.elements || [];
			if (t.type === "video" && t.isMain) {
				var imgEls = [];
				for (var ei = 0; ei < els.length; ei++) {
					shotNum++;
					var c = colors[shotNum % colors.length];
					var label = 'Shot ' + shotNum;
					imgEls.push(cleanImageEl(els[ei], c, label));
				}
				newTracks.push({ id: t.id, name: "Main Track", type: "video", elements: imgEls, isMain: true, muted: false, hidden: false, volume: 1 });
			} else if (t.type === "audio") {
				for (var ai = 0; ai < els.length; ai++) {
					els[ai] = fixAudioEl(els[ai]);
				}
				newTracks.push(t);
			} else {
				newTracks.push(t);
			}
		}
		scenes[si].tracks = newTracks;
	}
	return json;
}

export default function Editor() {
	var params = useParams();
	var projectId = params.project_id;
	var searchParams = useSearchParams();
	var importUrl = searchParams.get("import");
	var _s = useState(false);
	var importing = _s[0];
	var setImporting = _s[1];

	useEffect(function() {
		if (!importUrl) return;
		(async function() {
			setImporting(true);
			try {
				var res = await fetch(importUrl);
				if (!res.ok) { window.location.replace('/editor/' + projectId); return; }
				var json = await res.json();
				if (!json.metadata || !json.metadata.id || !Array.isArray(json.scenes) || json.version !== 10) {
					window.location.replace('/editor/' + projectId); return;
				}
				var processed = postProcess(json);
				localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(processed));
				sessionStorage.setItem(PENDING_IMPORT_KEY, "1");
				window.location.replace('/editor/' + json.metadata.id);
			} catch (e) { window.location.replace('/editor/' + projectId); }
		})();
	}, [importUrl, projectId]);

	if (importing) return React.createElement('div', { className: "flex h-screen items-center justify-center bg-background" }, React.createElement('div', { className: "text-center space-y-4" }, React.createElement('div', { className: "animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto" }), React.createElement('p', { className: "text-sm text-muted-foreground" }, "Importing project...")));

	return React.createElement(MobileGate, null, React.createElement(EditorProvider, { projectId: projectId }, React.createElement('div', { className: "bg-background flex h-screen w-screen flex-col overflow-hidden" }, React.createElement(EditorHeader), React.createElement('div', { className: "min-h-0 min-w-0 flex-1" }, React.createElement(EditorLayout)), React.createElement(AIPanelWrapper), React.createElement(Onboarding), React.createElement(MigrationDialog), React.createElement(BackgroundTasksWidget), React.createElement(CommandPalette))));
}

function EditorLayout() {
	usePasteMedia(); useTranscribePrompt();
	var _ps = usePanelStore(); var panels = _ps.panels; var setPanel = _ps.setPanel;
	var _ts = useTranscriptStore(); var ts = _ts.segments; var isT = _ts.isTranscribing;
	var editor = useEditor();
	var htc = editor.timeline.getTracks().some(function(t) { return t.elements.length > 0; });
	var hm = editor.timeline.getTracks().some(function(t) { return (t.type === "video" || t.type === "audio" || t.type === "image") && t.elements.length > 0; });
	var ht = hm && (ts.length > 0 || isT);
	return React.createElement(ResizablePanelGroup, { direction: "vertical", className: "size-full gap-[0.18rem]", onLayout: function(s) { setPanel("mainContent", s[0] || panels.mainContent); setPanel("timeline", s[1] || panels.timeline); } },
		React.createElement(ResizablePanel, { defaultSize: panels.mainContent, minSize: 30, maxSize: 85, className: "min-h-0" },
			React.createElement(ResizablePanelGroup, { direction: "horizontal", className: "size-full gap-[0.19rem] px-3", onLayout: function(s) { setPanel("tools", s[0] || panels.tools); setPanel("preview", s[1] || panels.preview); setPanel("properties", s[2] || panels.properties); } },
				React.createElement(ResizablePanel, { defaultSize: panels.tools, minSize: 15, maxSize: 40, className: "min-w-0" }, React.createElement(AssetsPanel)),
				React.createElement(ResizableHandle, { withHandle: true }),
				React.createElement(ResizablePanel, { defaultSize: panels.preview, minSize: 30, className: "min-h-0 min-w-0 flex-1" }, React.createElement(PreviewPanel)),
				React.createElement(ResizableHandle, { withHandle: true }),
				React.createElement(ResizablePanel, { defaultSize: panels.properties, minSize: 15, maxSize: 40, className: "min-w-0" }, ht || htc ? React.createElement(RightPanel, { className: "size-full" }) : React.createElement(EmptyEditorGuide))
			)
		),
		ht ? React.createElement('div', { className: "flex justify-center px-3 py-1" }, React.createElement(QuickActionsBar)) : null,
		React.createElement(ResizableHandle, { withHandle: true }),
		React.createElement(ResizablePanel, { defaultSize: panels.timeline, minSize: 15, maxSize: 70, className: "min-h-0 px-3 pb-3" }, React.createElement(Timeline))
	);
}
