"use client";

import { useParams, useSearchParams } from "next/navigation";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
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
const COLORS = ["1a1a2e","16213e","0f3460","533483","2d6a4f","7f4f24","582f0e","936639"];

function svgDataUrl(color, label) {
  return "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#'+color+'"/><text x="960" y="540" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="60" fill="white" opacity="0.8">'+label+'</text></svg>'
  );
}

function postProcessProject(json) {
  var scenes = json.scenes;
  var shotNum = 0;
  for (var si = 0; si < scenes.length; si++) {
    var tracks = scenes[si].tracks;
    var newTracks = [];
    for (var ti = 0; ti < tracks.length; ti++) {
      var t = tracks[ti];
      var els = t.elements || [];
      if (t.type === "video") {
        var imgEls = [];
        for (var ei = 0; ei < els.length; ei++) {
          shotNum++;
          var c = COLORS[shotNum % COLORS.length];
          var label = "Shot " + shotNum;
          imgEls.push({
            id: els[ei].id, name: label, duration: els[ei].duration, startTime: els[ei].startTime,
            trimStart: 0, trimEnd: 0, sourceDuration: els[ei].duration,
            type: "image", sourceType: "library", sourceUrl: svgDataUrl(c, label),
            transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
            opacity: 1, blendMode: "normal", hidden: false, playbackRate: 1,
          });
        }
        newTracks.push({ id: t.id, name: "Main Track", type: "video", elements: imgEls, isMain: true, muted: false, hidden: false, volume: 1 });
      } else if (t.type === "audio") {
        for (var ai = 0; ai < els.length; ai++) {
          var mid = els[ai].mediaId || "";
          if (mid.indexOf("media-tts-") === 0) {
            els[ai].sourceType = "library";
            els[ai].sourceUrl = PLATFORM + "/assets/audio/tts/" + mid.replace("media-tts-", "") + ".mp3";
            delete els[ai].mediaId;
          }
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
        if (!res.ok) { window.location.replace("/editor/" + projectId); return; }
        var json = await res.json();
        if (!json.metadata || !json.metadata.id || !Array.isArray(json.scenes) || json.version !== 10) {
          window.location.replace("/editor/" + projectId); return;
        }
        var processed = postProcessProject(json);
        localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(processed));
        sessionStorage.setItem(PENDING_IMPORT_KEY, "1");
        window.location.replace("/editor/" + json.metadata.id);
      } catch (_e) { window.location.replace("/editor/" + projectId); }
    })();
  }, [importUrl, projectId]);

  if (importing) return <div className="flex h-screen items-center justify-center bg-background"><div className="text-center space-y-4"><div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto" /><p className="text-sm text-muted-foreground">Importing project...</p></div></div>;

  return (<MobileGate><EditorProvider projectId={projectId}><div className="bg-background flex h-screen w-screen flex-col overflow-hidden"><EditorHeader /><div className="min-h-0 min-w-0 flex-1"><EditorLayout /></div><AIPanelWrapper /><Onboarding /><MigrationDialog /><BackgroundTasksWidget /><CommandPalette /></div></EditorProvider></MobileGate>);
}

function EditorLayout() {
  usePasteMedia(); useTranscribePrompt();
  var _ps = usePanelStore(); var panels = _ps.panels; var setPanel = _ps.setPanel;
  var ts = useTranscriptStore(function(s) { return s.segments; });
  var isT = useTranscriptStore(function(s) { return s.isTranscribing; });
  var editor = useEditor();
  var htc = editor.timeline.getTracks().some(function(t) { return t.elements.length > 0; });
  var hm = editor.timeline.getTracks().some(function(t) { return (t.type === "video" || t.type === "audio"||t.type==="image") && t.elements.length > 0; });
  var ht = hm && (ts.length > 0 || isT);
  var rr = useRef(false);
  useEffect(function() { if(rr.current)return;var s=useTranscriptStore.getState().segments;if(s.length>0)return;var tr=editor.timeline.getTracks();if(!tr.some(function(t){return (t.type==="video"||t.type==="audio"||t.type==="image")&&t.elements.length>0;}))return;var tt=tr.find(function(t){return t.type==="text"&&t.elements.length>0;});if(!tt)return;var se=tt.elements.slice().sort(function(a,b){return a.startTime-b.startTime;});if(se.length===0)return;var sg=se.map(function(el,i){var te=el;var tx=te.content||te.name||"";var sw=tx.trim().split(/\s+/).filter(Boolean);var sd=(el.startTime+el.duration)-el.startTime;var wd=sw.length>0?sd/sw.length:sd;return{id:i,text:tx,start:el.startTime,end:el.startTime+el.duration,words:sw.map(function(w,wi){return{word:w,start:el.startTime+wi*wd,end:el.startTime+(wi+1)*wd,confidence:0.9};})};});if(sg.length>0){rr.current=true;useTranscriptStore.getState().setSegments(sg)}},[editor]);
  useEffect(function(){return editor.timeline.subscribe(function(){var s=useTranscriptStore.getState().segments;if(s.length===0)return;if(!editor.timeline.getTracks().some(function(t){return (t.type==="video"||t.type==="audio"||t.type==="image")&&t.elements.length>0;}))useTranscriptStore.getState().reset();});},[editor]);
  return <ResizablePanelGroup direction="vertical" className="size-full gap-[0.18rem]" onLayout={function(s){setPanel("mainContent",s[0]||panels.mainContent);setPanel("timeline",s[1]||panels.timeline);}}><ResizablePanel defaultSize={panels.mainContent} minSize={30} maxSize={85} className="min-h-0"><ResizablePanelGroup direction="horizontal" className="size-full gap-[0.19rem] px-3" onLayout={function(s){setPanel("tools",s[0]||panels.tools);setPanel("preview",s[1]||panels.preview);setPanel("properties",s[2]||panels.properties);}}><ResizablePanel defaultSize={panels.tools} minSize={15} maxSize={40} className="min-w-0"><AssetsPanel /></ResizablePanel><ResizableHandle withHandle /><ResizablePanel defaultSize={panels.preview} minSize={30} className="min-h-0 min-w-0 flex-1"><PreviewPanel /></ResizablePanel><ResizableHandle withHandle /><ResizablePanel defaultSize={panels.properties} minSize={15} maxSize={40} className="min-w-0">{ht||htc?<RightPanel className="size-full" />:<EmptyEditorGuide />}</ResizablePanel></ResizablePanelGroup></ResizablePanel>{ht&&<div className="flex justify-center px-3 py-1"><QuickActionsBar /></div>}<ResizableHandle withHandle /><ResizablePanel defaultSize={panels.timeline} minSize={15} maxSize={70} className="min-h-0 px-3 pb-3"><Timeline /></ResizablePanel></ResizablePanelGroup>;
}
