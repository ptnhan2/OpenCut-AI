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
import type { TProject } from "@/types/project";

const PENDING_IMPORT_KEY = "opencut:pending-import";

function buildTProject(json: Record<string, unknown>): TProject {
	return {
		version: json.version as number,
		metadata: {
			...json.metadata as Record<string, unknown>,
			createdAt: new Date((json.metadata as Record<string, string>).createdAt),
			updatedAt: new Date((json.metadata as Record<string, string>).updatedAt),
		},
		scenes: (json.scenes as Array<Record<string, unknown>>).map((scene) => ({
			...scene,
			createdAt: new Date(scene.createdAt as string),
			updatedAt: new Date(scene.updatedAt as string),
		})),
		currentSceneId: json.currentSceneId as string,
		settings: json.settings,
		timelineViewState: json.timelineViewState,
	} as TProject;
}

async function tryRestorePendingImport(editor: ReturnType<typeof useEditor>): Promise<string | null> {
	const stored = sessionStorage.getItem(PENDING_IMPORT_KEY);
	if (!stored) return null;

	sessionStorage.removeItem(PENDING_IMPORT_KEY);

	try {
		const json = JSON.parse(stored);
		if (!json.metadata?.id || json.version !== 10) return null;

		const project = buildTProject(json);
		await editor.storage.saveProject({ project });
		console.log("[EditorProvider] Import saved successfully:", project.metadata.id, project.metadata.name);
		return project.metadata.id;
	} catch (err) {
		console.error("[EditorProvider] Import restore failed:", err);
		return null;
	}
}

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

export function EditorProvider({ projectId, children }: EditorProviderProps) {
	const editor = useEditor();
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { disableKeybindings, enableKeybindings } = useKeybindingDisabler();
	const activeProject = editor.project.getActiveOrNull();

	useEffect(() => {
		if (isLoading) {
			disableKeybindings();
		} else {
			enableKeybindings();
		}
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

				const isNotFound =
					err instanceof Error &&
					(err.message.includes("not found") ||
						err.message.includes("does not exist"));

				if (isNotFound) {
					try {
						const importedId = await tryRestorePendingImport(editor);
						if (importedId) {
							// Force full page reload to ensure IndexedDB is committed
							window.location.replace(`/editor/${importedId}`);
							return;
						}

						const newProjectId = await editor.project.createNewProject({
							name: "Untitled Project",
						});
						router.replace(`/editor/${newProjectId}`);
					} catch (_createErr) {
						setError("Failed to create project");
						setIsLoading(false);
					}
				} else {
					setError(
						err instanceof Error ? err.message : "Failed to load project",
					);
					setIsLoading(false);
				}
			}
		};

		loadProject();

		return () => {
			cancelled = true;
		};
	}, [projectId, editor, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Loading project...</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Exiting project...</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings />
			{children}
		</>
	);
}

function EditorRuntimeBindings() {
	const editor = useEditor();

	useEffect(() => {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editor.save.getIsDirty()) return;
			event.preventDefault();
			(event as unknown as { returnValue: string }).returnValue = "";
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [editor]);

	useEditorActions();
	useKeybindingsListener();
	return null;
}
