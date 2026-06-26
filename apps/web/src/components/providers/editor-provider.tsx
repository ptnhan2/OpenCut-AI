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

function saveProjectDirect(json: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open("video-editor-projects", 1);
		req.onsuccess = () => {
			const db = req.result;
			const tx = db.transaction("projects", "readwrite");
			const store = tx.objectStore("projects");
			const id = json.metadata?.id as string;
			const putReq = store.put({ id, ...json });
			putReq.onsuccess = () => { db.close(); resolve(); };
			putReq.onerror = () => { db.close(); reject(putReq.error); };
			tx.oncomplete = () => {};
		};
		req.onerror = () => reject(req.error);
		req.onupgradeneeded = () => {};
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

	useEffect(() => {
		if (isLoading) disableKeybindings(); else enableKeybindings();
	}, [isLoading, disableKeybindings, enableKeybindings]);

	useEffect(() => {
		let cancelled = false;

		const loadProject = async () => {
			try {
				setIsLoading(true);
				await editor.project.loadProject({ id: projectId });
				if (cancelled) return;
				setIsLoading(false);
				prefetchFontAtlas();
			} catch (err) {
				if (cancelled) return;
				const isNotFound = err instanceof Error && (err.message.includes("not found") || err.message.includes("does not exist"));
				if (!isNotFound) { setError(err instanceof Error ? err.message : "Failed"); setIsLoading(false); return; }

				try {
					const stored = localStorage.getItem(PENDING_IMPORT_KEY) || sessionStorage.getItem(PENDING_IMPORT_KEY);
					if (stored) {
						const json = JSON.parse(stored);
						if (json.metadata?.id && json.version === 10) {
							await saveProjectDirect(json);
							localStorage.removeItem(PENDING_IMPORT_KEY);
							sessionStorage.removeItem(PENDING_IMPORT_KEY);
							window.location.replace(`/editor/${json.metadata.id}`);
							return;
						}
					}
					const newProjectId = await editor.project.createNewProject({ name: "Untitled Project" });
					router.replace(`/editor/${newProjectId}`);
				} catch (_createErr) { setError("Failed to create project"); setIsLoading(false); }
			}
		};

		loadProject();
		return () => { cancelled = true; };
	}, [projectId, editor, router]);

	if (error) return <div className="bg-background flex h-screen w-screen items-center justify-center"><div className="flex flex-col items-center gap-4"><p className="text-destructive text-sm">{error}</p></div></div>;
	if (isLoading) return <div className="bg-background flex h-screen w-screen items-center justify-center"><div className="flex flex-col items-center gap-4"><Loader2 className="text-muted-foreground size-8 animate-spin" /><p className="text-muted-foreground text-sm">Loading project...</p></div></div>;
	if (!activeProject) return <div className="bg-background flex h-screen w-screen items-center justify-center"><div className="flex flex-col items-center gap-4"><Loader2 className="text-muted-foreground size-8 animate-spin" /><p className="text-muted-foreground text-sm">Exiting project...</p></div></div>;

	return (<><EditorRuntimeBindings />{children}</>);
}

function EditorRuntimeBindings() {
	const editor = useEditor();
	useEffect(() => {
		const h = (event: BeforeUnloadEvent) => { if (!editor.save.getIsDirty()) return; event.preventDefault(); (event as unknown as { returnValue: string }).returnValue = ""; };
		window.addEventListener("beforeunload", h);
		return () => window.removeEventListener("beforeunload", h);
	}, [editor]);
	useEditorActions();
	useKeybindingsListener();
	return null;
}
