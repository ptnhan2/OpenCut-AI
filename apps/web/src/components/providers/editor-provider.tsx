"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEditor } from "@/hooks/use-editor";
import { useKeybindingsListener, useKeybindingDisabler } from "@/hooks/use-keybindings";
import { useEditorActions } from "@/hooks/actions/use-editor-actions";
import { prefetchFontAtlas } from "@/lib/fonts/google-fonts";

var PENDING_IMPORT_KEY = "opencut:pending-import";
var PENDING_MEDIA_KEY = "opencut:pending-media";

function genPNGBlob(r, g, b) {
  var c = document.createElement('canvas'); c.width = 640; c.height = 360;
  var ctx = c.getContext('2d'); ctx.fillStyle = 'rgb('+r+','+g+','+b+')'; ctx.fillRect(0,0,640,360);
  return new Promise(function(resolve) { c.toBlob(resolve, 'image/png'); });
}

async function importProjectPhase1(json) {
  var projectId = json.metadata.id;
  var COLORS = [[26,26,46],[22,33,62],[15,52,96],[83,52,131],[45,106,79],[127,79,36],[88,47,14],[147,102,57]];
  var shotNum = 0;
  var mediaInfo = [];

  for (var si = 0; si < (json.scenes||[]).length; si++) {
    var tracks = json.scenes[si].tracks || [];
    for (var ti = 0; ti < tracks.length; ti++) {
      var t = tracks[ti];
      if (t.type !== "video") continue;
      var els = t.elements || [];
      for (var ei = 0; ei < els.length; ei++) {
        shotNum++;
        var el = els[ei];
        var cIdx = (shotNum - 1) % COLORS.length;
        var mediaId = "media-import-" + el.id;
        el.mediaId = mediaId;
        el.type = "image";
        el.sourceType = "upload";
        delete el.sourceUrl;
        delete el.muted;
        mediaInfo.push({ mediaId: mediaId, color: COLORS[cIdx], label: "Shot " + shotNum });
      }
    }
  }

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

  sessionStorage.setItem(PENDING_MEDIA_KEY, JSON.stringify(mediaInfo));
  return projectId;
}

/**
 * Import media phase 2: tạo PNG blobs từ color palette, lưu vào storage qua addMediaAsset,
 * rồi cập nhật mediaId + chuẩn hóa startTime trong TẤT CẢ scenes.
 *
 * 1. mediaId: addMediaAsset tạo UUID mới → map old→new cho tất cả scenes qua setScenes
 * 2. startTime: pipeline absolute timestamps → normalize per-scene về 0
 * 3. fontSize: pipeline px → OpenCut-AI units (px * 90 / canvasHeight)
 * 4. text position: absolute coords → center-relative
 * 5. audio: upload+mediaId → library+sourceUrl (TTS from Platform)
 *
 * @param editor - EditorCore singleton instance
 * @param projectId - Project ID to associate media with
 * @returns Promise<void>
 * @sideEffect Saves media assets to IndexedDB/OPFS, normalizes scenes, persists project
 */
export async function importMediaPhase2(editor, projectId) {
  var stored = sessionStorage.getItem(PENDING_MEDIA_KEY);
  if (!stored) return;

  // Parse mediaInfo — guard against corrupt sessionStorage
  var mediaInfo;
  try {
    mediaInfo = JSON.parse(stored);
    if (!Array.isArray(mediaInfo)) return;
  } catch (_parseErr) { return; }

  var idMap = {}; // old mediaId → new UUID
  var blobUrls = []; // track blob URLs for cleanup

  // Step 1: tạo PNG blobs và dùng addMediaAsset để lưu vào storage
  for (var i = 0; i < mediaInfo.length; i++) {
    var e = mediaInfo[i];
    if (!e || !e.color || !e.mediaId || !e.label) continue;
    try {
      var blob = await genPNGBlob(e.color[0], e.color[1], e.color[2]);
      var file = new File([blob], 'shot.png', { type: 'image/png' });
      var url = URL.createObjectURL(file);
      blobUrls.push(url);
      var newId = await editor.media.addMediaAsset({
        projectId: projectId,
        asset: {
          name: e.label,
          type: "image",
          file: file,
          url: url,
          width: 640,
          height: 360,
          label: e.label,
        },
      });
      idMap[e.mediaId] = newId;
    } catch (_assetErr) {
      // single asset failure shouldn't block others
    } finally {
      // Revoke blob URL after addMediaAsset save (file is now in OPFS)
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
  }

  // Step 2: cập nhật scenes — normalize startTime, fontSize, position, audio
  var scenes = editor.scenes.getScenes();
  var cs = editor.project.getActiveOrNull()?.settings?.canvasSize;
  var canvasHeight = cs?.height || 1080;
  var canvasWidth = cs?.width || 1920;
  var u = new URL(window.location.origin);
  u.port = '3000';
  var platformOrigin = u.origin;
  var updatedScenes = [];
  for (var si = 0; si < scenes.length; si++) {
    var scene = scenes[si];

    var minStart = Infinity;
    for (var t0 = 0; t0 < (scene.tracks || []).length; t0++) {
      var trk0 = scene.tracks[t0];
      for (var e0 = 0; e0 < (trk0.elements || []).length; e0++) {
        var st0 = trk0.elements[e0].startTime;
        if (typeof st0 === "number" && st0 < minStart) minStart = st0;
      }
    }
    if (minStart === Infinity) minStart = 0;

    var newTracks = [];
    for (var ti = 0; ti < (scene.tracks || []).length; ti++) {
      var track = scene.tracks[ti];
      var newEls = [];
      for (var ei = 0; ei < (track.elements || []).length; ei++) {
        var el = track.elements[ei];
        var patch = { startTime: (el.startTime ?? 0) - minStart };

        if (el.mediaId && idMap[el.mediaId]) {
          patch.mediaId = idMap[el.mediaId];
        }
        if (el.type === "text" && el.fontSize) {
          patch.fontSize = el.fontSize * 90 / canvasHeight;
        }
        if (el.type === "text" && el.transform && el.transform.position) {
          patch.transform = Object.assign({}, el.transform, {
            position: {
              x: el.transform.position.x - canvasWidth / 2,
              y: el.transform.position.y - canvasHeight / 2,
            },
          });
        }
        if (el.type === "audio" && el.sourceType === "upload" && el.mediaId && el.mediaId.indexOf("media-tts-") === 0) {
          var audioId = el.mediaId.replace("media-tts-", "");
          patch.sourceType = "library";
          patch.sourceUrl = platformOrigin + "/assets/audio/tts/" + audioId + ".mp3";
        }

        newEls.push(Object.assign({}, el, patch));
      }
      newTracks.push(Object.assign({}, track, { elements: newEls }));
    }
    updatedScenes.push(Object.assign({}, scene, { tracks: newTracks }));
  }
  editor.scenes.setScenes({ scenes: updatedScenes });

  // Persist — only clear PENDING_MEDIA_KEY after save succeeds
  await editor.project.saveCurrentProject();
  sessionStorage.removeItem(PENDING_MEDIA_KEY);
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
              await importProjectPhase1(json);
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

  useEffect(function() {
    if (isLoading || error) return;
    importMediaPhase2(editor, projectId);
  }, [isLoading, error, projectId, editor]);

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
