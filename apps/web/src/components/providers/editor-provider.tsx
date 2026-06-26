"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEditor } from "@/hooks/use-editor";
import { useKeybindingsListener, useKeybindingDisabler } from "@/hooks/use-keybindings";
import { useEditorActions } from "@/hooks/actions/use-editor-actions";
import { prefetchFontAtlas } from "@/lib/fonts/google-fonts";

const PENDING_IMPORT_KEY = "opencut:pending-import";
var COLORS = [[26,26,46],[22,33,62],[15,52,96],[83,52,131],[45,106,79],[127,79,36],[88,47,14],[147,102,57]];

function genPNG(r, g, b) {
  var c = document.createElement('canvas'); c.width = 640; c.height = 360;
  var ctx = c.getContext('2d'); ctx.fillStyle = 'rgb('+r+','+g+','+b+')'; ctx.fillRect(0,0,640,360);
  return c.toDataURL('image/png');
}

async function processImport(json) {
  var projectId = json.metadata.id;
  var mediaDBName = 'video-editor-media-' + projectId;
  var entries = [];
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
        var cIdx = (shotNum - 1) % COLORS.length;
        var dataUrl = genPNG(COLORS[cIdx][0], COLORS[cIdx][1], COLORS[cIdx][2]);
        var mediaId = "media-import-" + el.id;
        el.mediaId = mediaId;
        el.type = "image";
        el.sourceType = "upload";
        delete el.sourceUrl;
        delete el.muted;
        var label = "Shot " + shotNum;
        entries.push({ id: mediaId, name: label, type: "image", dataUrl: dataUrl, w: 640, h: 360 });
      }
    }
  }

  // Save media entries to IndexedDB
  if (entries.length > 0) {
    await new Promise(function(resolve, reject) {
      var dbr = indexedDB.open(mediaDBName, 1);
      dbr.onupgradeneeded = function() { dbr.result.createObjectStore('media-metadata', { keyPath: 'id' }); };
      dbr.onsuccess = function() {
        var db = dbr.result;
        var tx = db.transaction('media-metadata', 'readwrite');
        var store = tx.objectStore('media-metadata');
        var done = 0;
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          store.put({ id: e.id, name: e.name, type: e.type, size: e.dataUrl.length, lastModified: Date.now(), width: e.w, height: e.h, thumbnailUrl: e.dataUrl }).onsuccess = function() {
            done++;
            if (done >= entries.length) { db.close(); resolve(); }
          };
        }
        if (entries.length === 0) resolve();
      };
      dbr.onerror = function() { reject(dbr.error); };
    });
  }

  // Save project
  await new Promise(function(resolve, reject) {
    var dbr = indexedDB.open("video-editor-projects", 1);
    dbr.onupgradeneeded = function() {};
    dbr.onsuccess = function() {
      var db = dbr.result;
      var tx = db.transaction("projects", "readwrite");
      var store = tx.objectStore("projects");
      store.put({ id: projectId, metadata: json.metadata, scenes: json.scenes, currentSceneId: json.currentSceneId, settings: json.settings, version: json.version, timelineViewState: json.timelineViewState }).onsuccess = function() { db.close(); resolve(); };
    };
    dbr.onerror = function() { reject(dbr.error); };
  });

  return projectId;
}

interface EditorProviderProps { projectId: string; children: React.ReactNode; }

export function EditorProvider({ projectId, children }: EditorProviderProps) {
  var editor = useEditor();
  var router = useRouter();
  var _s = useState(true), isLoading = _s[0], setIsLoading = _s[1];
  var _e = useState(null), error = _e[0], setError = _e[1];
  var _dk = useKeybindingDisabler(), disableKeybindings = _dk.disableKeybindings, enableKeybindings = _dk.enableKeybindings;
  var activeProject = editor.project.getActiveOrNull();

  useEffect(function() { if (isLoading) disableKeybindings(); else enableKeybindings(); }, [isLoading, disableKeybindings, enableKeybindings]);

  useEffect(function() {
    var cancelled = false;
    (async function() {
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
              await processImport(json);
              localStorage.removeItem(PENDING_IMPORT_KEY);
              sessionStorage.removeItem(PENDING_IMPORT_KEY);
              window.location.replace("/editor/" + json.metadata.id);
              return;
            }
          }
          var newId = await editor.project.createNewProject({ name: "Untitled Project" });
          router.replace("/editor/" + newId);
        } catch (_e2) { setError("Failed to create project"); setIsLoading(false); }
      }
    })();
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
    var h = function(event) { if (!editor.save.getIsDirty()) return; event.preventDefault(); (event as any).returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return function() { window.removeEventListener("beforeunload", h); };
  }, [editor]);
  useEditorActions();
  useKeybindingsListener();
  return null;
}
