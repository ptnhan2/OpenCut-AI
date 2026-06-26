"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEditor } from "@/hooks/use-editor";
import {
	useKeybindingsListener,
	useKeybindingDisabler,
} from "@/hooks/use-keybindings";
import { useEditorActions } from "@/hooks/actions/use-editor-actions";
import { prefetchFontAtlas } from "@/lib/fonts/google-fonts";

const PENDING_IMPORT_KEY = "opencut:pending-import";

function generateColoredPNGDataUrl(r, g, b) {
  var c = document.createElement('canvas');
  c.width = 1920; c.height = 1080;
  var ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb('+r+','+g+','+b+')';
  ctx.fillRect(0, 0, 1920, 1080);
  return c.toDataURL('image/png');
}

function createMediaAssetsForProject(json, projectId) {
  var colors = [[26,26,46],[22,33,62],[15,52,96],[83,52,131],[45,106,79],[127,79,36],[88,47,14],[147,102,57]];
  var mediaEntries = [];
  var shotNum = 0;
  var scenes = json.scenes || [];

  for (var si = 0; si < scenes.length; si++) {
    var tracks = scenes[si].tracks || [];
    for (var ti = 0; ti < tracks.length; ti++) {
      var t = tracks[ti];
      if (t.type !== "video") continue;
      var els = t.elements || [];
      for (var ei = 0; ei < els.length; ei++) {
        shotNum++;
        var el = els[ei];
        var colorIdx = (shotNum - 1) % colors.length;
        var dataUrl = generateColoredPNGDataUrl(colors[colorIdx][0], colors[colorIdx][1], colors[colorIdx][2]);
        var mediaId = "media-import-" + el.id;
        el.mediaId = mediaId;
        el.type = "image";
        el.sourceType = "upload";
        delete el.sourceUrl;
        delete el.muted;
        mediaEntries.push({ id: mediaId, name: "Shot " + shotNum, type: "image", dataUrl: dataUrl });
      }
    }
  }
  return { json: json, mediaEntries: mediaEntries, projectId: projectId };
}

function saveMediaEntries(projectId, entries) {
  return new Promise(function(resolve, reject) {
    try {
      var dbName = 'video-editor-media-' + projectId;
      var dbr = indexedDB.open(dbName, 1);
      dbr.onupgradeneeded = function() {
        dbr.result.createObjectStore('media-metadata', { keyPath: 'id' });
      };
      dbr.onsuccess = function() {
        var db = dbr.result;
        var tx = db.transaction('media-metadata', 'readwrite');
        var store = tx.objectStore('media-metadata');
        var done = 0;
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          var req = store.put({
            id: e.id, name: e.name, type: e.type,
            size: e.dataUrl.length, lastModified: Date.now(),
            width: 1920, height: 1080, thumbnailUrl: e.dataUrl
          });
          req.onsuccess = function() { done++; if (done === entries.length) { db.close(); resolve(); } };
          req.onerror = function(ev) { reject(ev.target.error); };
        }
        if (entries.length === 0) { db.close(); resolve(); }
      };
      dbr.onerror = function() { reject(dbr.error); };
    } catch(e) { reject(e); }
  });
}

function saveProjectDirect(json) {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open("video-editor-projects", 1);
    req.onsuccess = function() {
      var db = req.result;
      var tx = db.transaction("projects", "readwrite");
      var store = tx.objectStore("projects");
      var id = json.metadata ? json.metadata.id : "";
      var pr = store.put({ id: id, metadata: json.metadata, scenes: json.scenes, currentSceneId: json.currentSceneId, settings: json.settings, version: json.version, timelineViewState: json.timelineViewState });
      pr.onsuccess = function() { db.close(); resolve(); };
      pr.onerror = function() { db.close(); reject(pr.error); };
    };
    req.onerror = function() { reject(req.error); };
    req.onupgradeneeded = function() {};
  });
}

interface EditorProviderProps { projectId: string; children: React.ReactNode; }

export function EditorProvider({ projectId, children }: EditorProviderProps) {
  const editor = useEditor();
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { disableKeybindings, enableKeybindings } = useKeybindingDisabler();
  const activeProject = editor.project.getActiveOrNull();

  useEffect(function() {
    if (isLoading) disableKeybindings(); else enableKeybindings();
  }, [isLoading, disableKeybindings, enableKeybindings]);

  useEffect(function() {
    var cancelled = false;

    var loadProject = async function() {
      try {
        setIsLoading(true);
        await editor.project.loadProject({ id: projectId });
        if (cancelled) return;
        setIsLoading(false);
        prefetchFontAtlas();
      } catch (err) {
        if (cancelled) return;
        var isNotFound = err instanceof Error && (err.message.indexOf("not found") >= 0 || err.message.indexOf("does not exist") >= 0);
        if (!isNotFound) { setError(err instanceof Error ? err.message : "Failed"); setIsLoading(false); return; }

        try {
          var stored = localStorage.getItem(PENDING_IMPORT_KEY) || sessionStorage.getItem(PENDING_IMPORT_KEY);
          if (stored) {
            var json = JSON.parse(stored);
            if (json.metadata && json.metadata.id && json.version === 10) {
              var result = createMediaAssetsForProject(json, json.metadata.id);
              await saveMediaEntries(result.projectId, result.mediaEntries);
              await saveProjectDirect(result.json);
              localStorage.removeItem(PENDING_IMPORT_KEY);
              sessionStorage.removeItem(PENDING_IMPORT_KEY);
              window.location.replace("/editor/" + json.metadata.id);
              return;
            }
          }
          var newProjectId = await editor.project.createNewProject({ name: "Untitled Project" });
          router.replace("/editor/" + newProjectId);
        } catch (_createErr) { setError("Failed to create project"); setIsLoading(false); }
      }
    };

    loadProject();
    return function() { cancelled = true; };
  }, [projectId, editor, router]);

  if (error) return <div className="bg-background flex h-screen w-screen items-center justify-center"><div className="flex flex-col items-center gap-4"><p className="text-destructive text-sm">{error}</p></div></div>;
  if (isLoading) return <div className="bg-background flex h-screen w-screen items-center justify-center"><div className="flex flex-col items-center gap-4"><Loader2 className="text-muted-foreground size-8 animate-spin" /><p className="text-muted-foreground text-sm">Loading project...</p></div></div>;
  if (!activeProject) return <div className="bg-background flex h-screen w-screen items-center justify-center"><div className="flex flex-col items-center gap-4"><Loader2 className="text-muted-foreground size-8 animate-spin" /><p className="text-muted-foreground text-sm">Exiting project...</p></div></div>;

  return (<><EditorRuntimeBindings />{children}</>);
}

function EditorRuntimeBindings() {
  var editor = useEditor();
  useEffect(function() {
    var h = function(event) { if (!editor.save.getIsDirty()) return; event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return function() { window.removeEventListener("beforeunload", h); };
  }, [editor]);
  useEditorActions();
  useKeybindingsListener();
  return null;
}
