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
const PNG_PIXELS = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQktIDAAC0AGOKMzq7AAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQU7QDAADGAHaIpFxXAAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgN0kAAAD5AKSOJAluAAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMINmkGAAHoAQsgrtGYAAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQzfIHAAGuAOfPU6WmAAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOo91cBAAJDAPP6uqxqAAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOI0OcDAAF4AJbhFptlAAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYnGYJAALCATPZxX6YAAAAAElFTkSuQmCC",
];

function postProcessProject(json: Record<string, unknown>): Record<string, unknown> {
  const scenes = json.scenes as Array<Record<string, unknown>>;
  let shotNum = 0;

  for (const scene of scenes) {
    const tracks = scene.tracks as Array<Record<string, unknown>>;
    const newTracks: Array<Record<string, unknown>> = [];

    for (const track of tracks) {
      const tType = track.type as string;
      const elements = (track.elements || []) as Array<Record<string, unknown>>;

      if (tType === "video") {
        const imgElements = elements.map(el => {
          shotNum++;
          const png = PNG_PIXELS[shotNum % PNG_PIXELS.length];
          return {
            id: el.id, name: `Shot ${shotNum}`, duration: el.duration, startTime: el.startTime,
            trimStart: 0, trimEnd: 0, sourceDuration: el.duration,
            type: "image", sourceType: "library", sourceUrl: png,
            transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
            opacity: 1, blendMode: "normal", hidden: false, playbackRate: 1,
          };
        });
        newTracks.push({
          id: track.id, name: "Main Track", type: "video",
          elements: imgElements, isMain: true,
          muted: false, hidden: false, volume: 1,
        });
      } else if (tType === "audio") {
        for (const el of elements) {
          const mid = (el.mediaId as string) || "";
          if (mid.startsWith("media-tts-")) {
            (el as any).sourceType = "library";
            (el as any).sourceUrl = `${PLATFORM}/assets/audio/tts/${mid.replace("media-tts-", "")}.mp3`;
            delete (el as any).mediaId;
          }
        }
        newTracks.push(track);
      } else {
        newTracks.push(track);
      }
    }
    (scene as any).tracks = newTracks;
  }
  return json;
}

export default function Editor() {
  const params = useParams();
  const projectId = params.project_id as string;
  const searchParams = useSearchParams();
  const importUrl = searchParams.get("import");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!importUrl) return;
    (async () => {
      setImporting(true);
      try {
        const res = await fetch(importUrl);
        if (!res.ok) { window.location.replace(`/editor/${projectId}`); return; }
        const json = await res.json();
        if (!json.metadata?.id || !Array.isArray(json.scenes) || json.version !== 10) {
          window.location.replace(`/editor/${projectId}`); return;
        }
        const processed = postProcessProject(json);
        localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(processed));
        sessionStorage.setItem(PENDING_IMPORT_KEY, "1");
        window.location.replace(`/editor/${json.metadata.id}`);
      } catch { window.location.replace(`/editor/${projectId}`); }
    })();
  }, [importUrl, projectId]);

  if (importing) return <div className="flex h-screen items-center justify-center bg-background"><div className="text-center space-y-4"><div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto" /><p className="text-sm text-muted-foreground">Importing project...</p></div></div>;

  return (<MobileGate><EditorProvider projectId={projectId}><div className="bg-background flex h-screen w-screen flex-col overflow-hidden"><EditorHeader /><div className="min-h-0 min-w-0 flex-1"><EditorLayout /></div><AIPanelWrapper /><Onboarding /><MigrationDialog /><BackgroundTasksWidget /><CommandPalette /></div></EditorProvider></MobileGate>);
}

function EditorLayout() {
  usePasteMedia(); useTranscribePrompt();
  const { panels, setPanel } = usePanelStore();
  const ts = useTranscriptStore((s) => s.segments);
  const isT = useTranscriptStore((s) => s.isTranscribing);
  const editor = useEditor();
  const htc = editor.timeline.getTracks().some(t => t.elements.length > 0);
  const hm = editor.timeline.getTracks().some(t => (t.type === "video" || t.type === "audio"||t.type==="image") && t.elements.length > 0);
  const ht = hm && (ts.length > 0 || isT);
  const rr = useRef(false);
  useEffect(() => { if(rr.current)return;const s=useTranscriptStore.getState().segments;if(s.length>0)return;const tr=editor.timeline.getTracks();if(!tr.some(t=>(t.type==="video"||t.type==="audio"||t.type==="image")&&t.elements.length>0))return;const tt=tr.find(t=>t.type==="text"&&t.elements.length>0);if(!tt)return;const se=[...tt.elements].sort((a,b)=>a.startTime-b.startTime);if(se.length===0)return;const sg=se.map((el,i)=>{const te=el as TextElement;const tx=te.content||te.name||"";const sw=tx.trim().split(/\s+/).filter(Boolean);const sd=(el.startTime+el.duration)-el.startTime;const wd=sw.length>0?sd/sw.length:sd;return{id:i,text:tx,start:el.startTime,end:el.startTime+el.duration,words:sw.map((w,wi)=>({word:w,start:el.startTime+wi*wd,end:el.startTime+(wi+1)*wd,confidence:0.9}))}});if(sg.length>0){rr.current=true;useTranscriptStore.getState().setSegments(sg)}},[editor]);
  useEffect(()=>{return editor.timeline.subscribe(()=>{const{s}=useTranscriptStore.getState();if(s.length===0)return;if(!editor.timeline.getTracks().some(t=>(t.type==="video"||t.type==="audio"||t.type==="image")&&t.elements.length>0))useTranscriptStore.getState().reset()})},[editor]);
  return (<ResizablePanelGroup direction="vertical" className="size-full gap-[0.18rem]" onLayout={s=>{setPanel("mainContent",s[0]??panels.mainContent);setPanel("timeline",s[1]??panels.timeline)}}><ResizablePanel defaultSize={panels.mainContent} minSize={30} maxSize={85} className="min-h-0"><ResizablePanelGroup direction="horizontal" className="size-full gap-[0.19rem] px-3" onLayout={s=>{setPanel("tools",s[0]??panels.tools);setPanel("preview",s[1]??panels.preview);setPanel("properties",s[2]??panels.properties)}}><ResizablePanel defaultSize={panels.tools} minSize={15} maxSize={40} className="min-w-0"><AssetsPanel /></ResizablePanel><ResizableHandle withHandle /><ResizablePanel defaultSize={panels.preview} minSize={30} className="min-h-0 min-w-0 flex-1"><PreviewPanel /></ResizablePanel><ResizableHandle withHandle /><ResizablePanel defaultSize={panels.properties} minSize={15} maxSize={40} className="min-w-0">{ht||htc?<RightPanel className="size-full" />:<EmptyEditorGuide />}</ResizablePanel></ResizablePanelGroup></ResizablePanel>{ht&&<div className="flex justify-center px-3 py-1"><QuickActionsBar /></div>}<ResizableHandle withHandle /><ResizablePanel defaultSize={panels.timeline} minSize={15} maxSize={70} className="min-h-0 px-3 pb-3"><Timeline /></ResizablePanel></ResizablePanelGroup>);
}
