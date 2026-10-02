import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeQuoteSelector, PROJECT_PATH } from "@redline/shared";
import type { AgentStatus, Annotation, Sidecar, TreeEntry } from "@redline/shared";
import { api, ApiError, STATIC_MODE, subscribeEvents, type SearchResult } from "./api.ts";
import { AgentControls } from "./components/AgentControls.tsx";
import { CommentPopover } from "./components/CommentPopover.tsx";
import { CommentSidebar } from "./components/CommentSidebar.tsx";
import { DiffView } from "./components/DiffView.tsx";
import { FileTree } from "./components/FileTree.tsx";
import { EditorPane, type EditorHandle, type SelectionInfo } from "./editor/EditorPane.tsx";

// the static build's copy/paste agent leg; daemon bundles never load the chunk
const HandoffControls = lazy(() => import("./components/HandoffControls.tsx"));

type SaveState = "saved" | "dirty" | "saving";
type Mode = "review" | "edit";
type View = "editor" | "diff";

interface FocusEntry {
  annotation: Annotation;
  isProject: boolean;
}

interface Draft {
  selection: SelectionInfo;
  text: string;
}

/** The redline app shell: file tree, document, comment sidebar. */
export function App() {
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [initialMarkdown, setInitialMarkdown] = useState<string>("");
  const [sidecar, setSidecar] = useState<Sidecar | null>(null);
  const [projectAnnotations, setProjectAnnotations] = useState<Annotation[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<Mode>("review");
  const [view, setView] = useState<View>("editor");
  const [changed, setChanged] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [focusEntryId, setFocusEntryId] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [showChanges, setShowChanges] = useState(true);
  const [changeCount, setChangeCount] = useState(0);
  const [spotLit, setSpotLit] = useState(false);
  const [baselineState, setBaselineState] = useState<"none" | "loading" | "ready" | "error">("none");
  const [commentsWithChanges, setCommentsWithChanges] = useState<string[]>([]);
  const focusPathRef = useRef<string | null>(null);

  const editorRef = useRef<EditorHandle>(null);
  const baseHashRef = useRef<string>("");
  const pathRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScroll = useRef<{ start: number; end: number } | null>(null);
  const saveStateRef = useRef<SaveState>("saved");
  const draftRef = useRef<Draft | null>(null);
  const modeRef = useRef<Mode>("review");
  pathRef.current = path;
  draftRef.current = draft;
  modeRef.current = mode;

  const dirtyEpoch = useRef(0); // bumped on every keystroke; guards save-state clobber
  const commentsSeq = useRef(0); // guards out-of-order comment refetches
  const submittingComment = useRef(false);
  const saveInFlight = useRef<Promise<void> | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // the ref must track synchronously — async flows (flush-before-switch,
  // single-flight save, resync deferral) read it before React re-renders
  const updateSaveState = useCallback((s: SaveState) => {
    saveStateRef.current = s;
    setSaveState(s);
  }, []);

  const showError = useCallback((message: string) => {
    setError(message);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 5000);
  }, []);

  const refreshTree = useCallback(() => {
    void api.tree().then(setTree).catch(() => {});
  }, []);

  const refreshProjectNotes = useCallback(() => {
    void api
      .getComments(PROJECT_PATH)
      .then((sc) => setProjectAnnotations(sc.annotations))
      .catch(() => {});
  }, []);

  const applyAnnotations = useCallback((sc: Sidecar) => {
    const hintsValid = sc.docHash === baseHashRef.current && saveStateRef.current === "saved";
    editorRef.current?.setRangesFromAnnotations(sc.annotations, hintsValid);
  }, []);

  const refreshComments = useCallback(
    async (p: string) => {
      const seq = ++commentsSeq.current;
      try {
        const sc = await api.getComments(p);
        if (pathRef.current !== p || seq !== commentsSeq.current) return; // stale response
        setSidecar(sc);
        applyAnnotations(sc);
      } catch (err) {
        showError(String(err));
      }
    },
    [applyAnnotations, showError],
  );

  /** Save the doc the edit belonged to; abort if the user has switched files. */
  const save = useCallback(
    async (forPath: string): Promise<void> => {
      // single-flight: a second PUT while one is in flight would 409 against
      // our own write — wait for it, then save again only if still dirty
      while (saveInFlight.current) {
        await saveInFlight.current;
        if (saveStateRef.current === "saved" || pathRef.current !== forPath) return;
      }
      const editor = editorRef.current;
      if (!editor || pathRef.current !== forPath) return;
      const markdown = editor.getMarkdown();
      if (markdown === null) return; // editor not ready — never save "" over a doc
      const epochAtSave = dirtyEpoch.current;
      updateSaveState("saving");
      const run = (async () => {
        try {
          const { hash } = await api.putDoc({
            path: forPath,
            markdown,
            baseHash: baseHashRef.current,
            anchors: editor.getAnchors(),
          });
          if (pathRef.current !== forPath) return;
          baseHashRef.current = hash;
          // keystrokes typed while the PUT was in flight keep the doc dirty
          if (dirtyEpoch.current === epochAtSave) {
            updateSaveState("saved");
            setChanged(false); // own edits advance the reviewed baseline
          }
        } catch (err) {
          if (pathRef.current !== forPath) return;
          const conflict = err instanceof ApiError && err.status === 409;
          if (conflict) {
            // the file changed on disk underneath us — external edits win
            const doc = await api.getDoc(forPath).catch(() => null);
            if (doc) {
              baseHashRef.current = doc.hash;
              editor.setContent(doc.markdown);
              updateSaveState("saved");
              setChanged(doc.changed);
              void refreshComments(forPath);
              showError("Document changed on disk — reloaded.");
              return;
            }
          }
          // anything else: keep the user's edits, retry on next change
          updateSaveState("dirty");
          showError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      saveInFlight.current = run;
      try {
        await run;
      } finally {
        saveInFlight.current = null;
      }
    },
    [refreshComments, showError, updateSaveState],
  );

  const openFile = useCallback(
    async (p: string) => {
      // a pending autosave for the PREVIOUS doc must never fire once the
      // path ref points at the new one
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      // flush unsaved edits while the previous editor is still mounted —
      // switching would otherwise silently discard them
      const prev = pathRef.current;
      if (prev && saveStateRef.current !== "saved") await save(prev);
      try {
        const doc = await api.getDoc(p);
        baseHashRef.current = doc.hash;
        setInitialMarkdown(doc.markdown);
        if (p !== pathRef.current) {
          setEditorReady(false);
          setChangeCount(0);
          setBaselineState(doc.changed ? "loading" : "none");
          setCommentsWithChanges([]);
        }
        setPath(p);
        setSidecar(null);
        setFocusedId(null);
        setDraft(null);
        setView("editor");
        setChanged(doc.changed);
        updateSaveState("saved");
      } catch (err) {
        pendingScroll.current = null; // never carry a scroll target to another doc
        showError(String(err));
      }
    },
    [save, showError, updateSaveState],
  );

  const openSearchResult = useCallback(
    (result: SearchResult) => {
      pendingScroll.current = { start: result.start, end: result.end };
      if (pathRef.current === result.path) {
        editorRef.current?.scrollToRange(result.start, result.end);
        pendingScroll.current = null;
      } else {
        void openFile(result.path);
      }
    },
    [openFile],
  );

  const onDirty = useCallback(() => {
    // the document is read-only in Review mode: any content change there is
    // programmatic (external reload) and must never echo back as a save
    if (modeRef.current === "review") return;
    dirtyEpoch.current++;
    updateSaveState("dirty");
    const p = pathRef.current;
    if (!p) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(p), 800);
  }, [save, updateSaveState]);

  // initial load + SSE
  useEffect(() => {
    refreshTree();
    refreshProjectNotes();
    const resyncCurrentDoc = () => {
      const p = pathRef.current;
      if (!p) return;
      // while our own PUT is in flight the disk hash legitimately differs
      // from baseHashRef — resyncing now would clobber the pending write
      if (saveStateRef.current === "saving") {
        void saveInFlight.current?.then(resyncCurrentDoc);
        return;
      }
      void api
        .getDoc(p)
        .then((doc) => {
          if (pathRef.current !== p) return;
          if (doc.hash !== baseHashRef.current) {
            baseHashRef.current = doc.hash;
            editorRef.current?.setContent(doc.markdown);
            updateSaveState("saved");
            // an external change invalidates any in-progress selection/draft
            setDraft(null);
            editorRef.current?.setDraft(null);
          }
          setChanged(doc.changed);
          void refreshComments(p);
        })
        .catch(() => showError(`${p} is no longer readable — was it deleted?`));
    };
    // a fetch that resolves after a pushed status is older than it
    let pushed = false;
    const refreshAgent = () => {
      pushed = false;
      api.agentStatus?.().then((status) => {
        if (!pushed) setAgentStatus(status);
      }, () => {});
    };
    refreshAgent();
    const unsubscribe = subscribeEvents({
      onEvent: (event) => {
        if (event.type === "agent:changed") {
          pushed = true;
          setAgentStatus(event.status);
        } else if (event.type === "comments:changed") {
          refreshTree();
          if (event.path === PROJECT_PATH) refreshProjectNotes();
          else if (event.path === pathRef.current) void refreshComments(event.path);
        } else if (event.type === "doc:changed" && event.source === "external") {
          refreshTree();
          if (event.path !== pathRef.current) return;
          if (event.hash === baseHashRef.current) return;
          resyncCurrentDoc();
        }
      },
      // events are lost while the connection is down (daemon restart, laptop
      // sleep) — resync everything on reconnect
      onReconnect: () => {
        refreshAgent();
        refreshTree();
        refreshProjectNotes();
        resyncCurrentDoc();
      },
    });
    return unsubscribe;
  }, [refreshTree, refreshComments, refreshProjectNotes, showError, updateSaveState]);

  // Import documents dragged onto the window or pasted outside any input.
  useEffect(() => {
    const looksLikeDoc = (f: File) =>
      /\.(md|markdown|txt)$/i.test(f.name) || f.type === "text/markdown" || f.type === "text/plain";
    const importFiles = async (files: File[]) => {
      let firstImported: string | null = null;
      for (const f of files) {
        try {
          const { path: p } = await api.importDoc({ name: f.name, markdown: await f.text() });
          firstImported = firstImported ?? p;
        } catch (err) {
          showError(String(err));
        }
      }
      if (firstImported) void openFile(firstImported);
    };
    let dragDepth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      dragDepth = 0;
      setDragging(false);
      if (!e.dataTransfer?.files.length) return;
      // always cancel a file drop — the browser's default is to navigate
      // the tab to the dropped file, replacing the app
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files).filter(looksLikeDoc);
      if (!files.length) {
        showError("Only markdown or plain-text files can be imported.");
        return;
      }
      void importFiles(files);
    };
    const onPaste = (e: ClipboardEvent) => {
      // a paste aimed at an input, textarea, or the editor is never an import
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable], .ProseMirror")) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      e.preventDefault();
      const heading = /^#{1,6}\s+(.{1,60})/m.exec(text)?.[1]?.trim();
      void api
        .importDoc({ name: heading ?? "pasted", markdown: text })
        .then(({ path: p }) => openFile(p))
        .catch((err) => showError(String(err)));
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [openFile, showError]);

  // closing or refreshing the tab inside the autosave debounce would
  // silently drop the pending edits — warn instead
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveStateRef.current === "saved") return;
      e.preventDefault();
      e.returnValue = ""; // some engines still require returnValue to prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const onSelectText = useCallback((info: SelectionInfo | null) => {
    if (modeRef.current === "edit") return;
    const current = draftRef.current;
    if (current?.text.trim()) return;
    if (info) {
      setDraft({ selection: info, text: "" });
      editorRef.current?.setDraft({ start: info.start, end: info.end });
    } else if (current) {
      setDraft(null);
      editorRef.current?.setDraft(null);
    }
  }, []);

  const cancelDraft = useCallback(() => {
    setDraft(null);
    editorRef.current?.setDraft(null);
  }, []);

  const addComment = useCallback(async () => {
    const p = pathRef.current;
    const editor = editorRef.current;
    const current = draftRef.current;
    if (!p || !editor || !current?.text.trim()) return;
    if (submittingComment.current) return; // double-Enter guard
    submittingComment.current = true;
    try {
    if (saveStateRef.current !== "saved") await save(p);
    const plain = editor.getPlainText();
    const start = Math.max(0, Math.min(current.selection.start, plain.length));
    const end = Math.max(start, Math.min(current.selection.end, plain.length));
    const quote = makeQuoteSelector(plain, start, end);
    try {
      const created = await api.createComment({
        path: p,
        body: current.text.trim(),
        baseHash: baseHashRef.current,
        selector: {
          quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix },
          position: { start, end },
        },
      });
      cancelDraft();
      setFocusedId(created.id);
    } catch (err) {
      showError(String(err));
    }
    } finally {
      submittingComment.current = false;
    }
  }, [save, showError, cancelDraft]);

  const addNote = useCallback(
    (scope: "document" | "project", text: string) => {
      const p = scope === "project" ? PROJECT_PATH : pathRef.current;
      if (!p) return;
      void api.createComment({ path: p, body: text }).catch((e) => showError(String(e)));
    },
    [showError],
  );

  // bumps on every focus call so re-focusing the SAME comment still
  // re-triggers the sidebar scroll (focusedId alone wouldn't change)
  const [focusTick, setFocusTick] = useState(0);
  const focusComment = useCallback((id: string) => {
    setFocusedId(id);
    setFocusTick((t) => t + 1);
    editorRef.current?.focusComment(id);
    editorRef.current?.scrollToComment(id);
  }, []);

  const commentPath = useCallback(
    (isProject: boolean) => (isProject ? PROJECT_PATH : pathRef.current),
    [],
  );

  const closeFile = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const p = pathRef.current;
    const flush = saveStateRef.current !== "saved" && p ? save(p) : Promise.resolve();
    void flush.finally(() => {
      setPath(null);
      setEditorReady(false);
      setInitialMarkdown("");
      setSidecar(null);
      setFocusedId(null);
      setDraft(null);
      setView("editor");
      setChanged(false);
      updateSaveState("saved");
      baseHashRef.current = "";
    });
  }, [save, updateSaveState]);

  const annotations = sidecar?.annotations ?? [];

  // focus mode walks the document: project notes, document notes, then
  // anchored comments in reading order — everything still needing attention,
  // plus whichever comment is on screen (accepting it mustn't yank it away
  // before the step forward lands)
  const needsAttention = (a: Annotation) => a.status !== "resolved";
  // where passages are now: stored offsets go stale for orphaned and
  // addressed comments once later text moves
  const { positions, live } = useMemo(
    () =>
      editorRef.current?.positionsOf(annotations) ?? {
        positions: new Map<string, number>(),
        live: new Map<string, string>(),
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sidecar, baselineState, changeCount, editorReady],
  );
  const scopeOrdered: FocusEntry[] = [
    ...projectAnnotations.map((a) => ({ annotation: a, isProject: true })),
    ...annotations.filter((a) => !a.target).map((a) => ({ annotation: a, isProject: false })),
    ...annotations
      .filter((a) => a.target)
      .map((a) => ({ a, at: positions.get(a.id) ?? a.target!.selector[1].start }))
      .sort((x, y) => x.at - y.at)
      .map(({ a }) => a)
      .map((a) => ({ annotation: a, isProject: false })),
  ];
  const focusQueue = scopeOrdered.filter(
    (e) => needsAttention(e.annotation) || (focusMode && e.annotation.id === focusEntryId),
  );
  const focusIdx = focusQueue.findIndex((e) => e.annotation.id === focusEntryId);
  const focusCurrent = focusIdx === -1 ? null : focusQueue[focusIdx];

  const focusOn = (entry: FocusEntry) => {
    setFocusEntryId(entry.annotation.id);
    setFocusedId(entry.annotation.id);
    setFocusTick((t) => t + 1);
    editorRef.current?.focusComment(entry.annotation.id);
    setSpotLit(editorRef.current?.spotlight(entry.annotation) ?? false);
  };
  const focusStep = (delta: number) => {
    if (!focusQueue.length) return;
    const from = focusIdx === -1 ? (delta > 0 ? -1 : 0) : focusIdx;
    focusOn(focusQueue[(from + delta + focusQueue.length) % focusQueue.length]);
  };
  const enterFocusMode = () => {
    const start = focusQueue.find((e) => e.annotation.id === focusedId) ?? focusQueue[0];
    if (!start) return;
    // Focus reviews: read-only, in the document, with the agent's changes drawn
    setView("editor");
    setMode("review");
    editorRef.current?.setEditable(false);
    focusPathRef.current = path;
    setFocusMode(true);
    // from raw diff the editor is hidden until the view switch renders
    // (claim the entry now, so the vanished-comment recovery stays quiet)
    if (view === "diff") {
      setFocusEntryId(start.annotation.id);
      setTimeout(() => focusOn(start), 0);
    } else focusOn(start);
  };
  const exitFocusMode = () => {
    setFocusMode(false);
    setSpotLit(false);
    editorRef.current?.spotlight(null);
  };
  /** after a verdict on (or deletion of) the current comment: on to the next one still open */
  const advanceFrom = (id: string) => {
    if (!focusMode || id !== focusEntryId) return;
    const i = focusQueue.findIndex((e) => e.annotation.id === id);
    for (let step = 1; step < focusQueue.length; step++) {
      const next = focusQueue[(i + step) % focusQueue.length];
      if (next.annotation.id !== id && needsAttention(next.annotation)) return focusOn(next);
    }
    exitFocusMode(); // that was the last one
  };
  // card clicks: in focus mode, step to that comment; otherwise just find
  // its passage
  const onCardFocus = (id: string) => {
    const entry = scopeOrdered.find((e) => e.annotation.id === id);
    if (focusMode && entry) focusOn(entry);
    else focusComment(id);
  };

  // focus walks one document: opening another, or emptying the queue, ends
  // the walk; a current comment that vanished hands over to the one that
  // took its place
  const lastFocusIdx = useRef(0);
  if (focusIdx !== -1) lastFocusIdx.current = focusIdx;
  useEffect(() => {
    if (!focusMode) return;
    if (path !== focusPathRef.current || focusQueue.length === 0) exitFocusMode();
    else if (focusIdx === -1) focusOn(focusQueue[Math.min(lastFocusIdx.current, focusQueue.length - 1)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMode, focusQueue.length, focusIdx, path]);

  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable=true]")) return;
      // modified arrows extend selections; an open menu or dialog owns the keys
      if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
      if (document.querySelector(".rl-menu, .rl-handoff-panel, .rl-popover")) return;
      if (e.key === "ArrowRight") (e.preventDefault(), focusStep(1));
      else if (e.key === "ArrowLeft") (e.preventDefault(), focusStep(-1));
      else if (e.key === "Escape") exitFocusMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // tracked changes: draw the agent's edits against the last-reviewed
  // baseline, right in the document
  useEffect(() => {
    if (changed) setShowChanges(true);
  }, [changed, path]);
  useEffect(() => {
    if (!path || !editorReady) return;
    // Edit mode draws no changes, so skip diffing on every keystroke
    if (!changed || mode !== "review") {
      editorRef.current?.setBaseline(null);
      setBaselineState("none");
      return;
    }
    let stale = false;
    setBaselineState("loading");
    void api
      .getBaseline(path)
      .then((b) => {
        if (stale) return;
        editorRef.current?.setBaseline(b.markdown);
        // no baseline despite `changed`: nothing to diff against
        setBaselineState(b.markdown === null ? "error" : "ready");
      })
      .catch(() => !stale && setBaselineState("error"));
    return () => {
      stale = true;
    };
  }, [path, changed, editorReady, mode]);
  useEffect(() => {
    editorRef.current?.setShowChanges(showChanges && mode === "review");
  }, [showChanges, mode, editorReady]);
  // re-anchoring moves passages and the baseline locates deleted ones:
  // re-light when either shifts, without scrolling. Declared after the
  // show/hide effect, since the spotlight reads what's drawn
  useEffect(() => {
    if (focusMode && focusCurrent) {
      setSpotLit(editorRef.current?.spotlight(focusCurrent.annotation, false) ?? false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidecar, baselineState, changeCount, showChanges]);
  const markReviewed = () => {
    if (!path) return;
    void api
      .markReviewed(path)
      .then(() => {
        setChanged(false);
        setView("editor");
      })
      .catch((e) => showError(String(e)));
  };
  const openRawDiff = () => {
    exitFocusMode(); // focus walks the rendered document, which raw diff hides
    // flush any pending edit so the diff reflects reality
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const p = pathRef.current;
    const flush = saveStateRef.current !== "saved" && p ? save(p) : Promise.resolve();
    void flush.then(() => setView("diff"));
  };

  // no counts in chrome — the tree badges and section headers already carry
  // them; the handoff verbs live in the header's top-right slot (both builds)
  const agentReady =
    tree.reduce((n, e) => n + e.agentReady, 0) +
    projectAnnotations.filter((a) => a.status === "open" || a.status === "orphaned").length;

  return (
    <div className={`rl-app${focusMode ? " rl-focusing" : ""}${spotLit ? " rl-spotlit" : ""}`}>
      <FileTree
        entries={tree}
        currentPath={path}
        onOpen={(p) => void openFile(p)}
        onOpenResult={openSearchResult}
        onRemove={
          STATIC_MODE && api.deleteDoc
            ? (p) => {
                if (pathRef.current === p) {
                  // removal discards the doc — a pending autosave must not
                  // race the delete and resurrect it
                  if (saveTimer.current) {
                    clearTimeout(saveTimer.current);
                    saveTimer.current = null;
                  }
                  updateSaveState("saved");
                  closeFile();
                }
                api
                  .deleteDoc!(p)
                  .then(refreshTree)
                  .catch((e) => showError(String(e)));
              }
            : undefined
        }
      />

      <main className="rl-main">
        {path ? (
          <>
            <header className="rl-header">
              <span className="rl-path">{path}</span>
              <div className="rl-header-right">
                {changed && view === "editor" && mode === "review" && baselineState !== "loading" && (
                  <button
                    className={`rl-changes-btn${showChanges ? " active" : ""}`}
                    onClick={() => setShowChanges((v) => !v)}
                    title={showChanges ? "Hide tracked changes" : "Show the changes since you last reviewed"}
                  >
                    {baselineState === "error"
                      ? "● changes"
                      : `● ${changeCount || "formatting"} change${changeCount === 1 ? "" : "s"}`}
                  </button>
                )}
                {!STATIC_MODE && (
                  <AgentControls status={agentStatus} readyCount={agentReady} onNotice={showError} />
                )}
                {STATIC_MODE && (
                  <Suspense fallback={null}>
                    <HandoffControls
                      currentPath={path}
                      readyCount={agentReady}
                      onNotice={showError}
                    />
                  </Suspense>
                )}
                <div className="rl-mode" role="group" aria-label="mode">
                  <button
                    className={!focusMode && mode === "review" ? "active" : ""}
                    onClick={() => {
                      exitFocusMode();
                      setMode("review");
                      editorRef.current?.setEditable(false);
                    }}
                    data-label="Review"
                  >
                    Review
                  </button>
                  <button
                    className={!focusMode && mode === "edit" ? "active" : ""}
                    onClick={() => {
                      exitFocusMode();
                      setMode("edit");
                      editorRef.current?.setEditable(true);
                      cancelDraft();
                    }}
                    data-label="Edit"
                  >
                    Edit
                  </button>
                  <button
                    className={focusMode ? "active" : ""}
                    disabled={focusQueue.length === 0}
                    onClick={() => (focusMode ? exitFocusMode() : enterFocusMode())}
                    title="Walk the document comment by comment (←/→ step, Esc exits)"
                    data-label="Focus"
                  >
                    Focus
                  </button>
                </div>
                {focusMode && (
                  <div className="rl-stepper" aria-label="comment navigation">
                    <button onClick={() => focusStep(-1)} title="Previous (←)">
                      ‹
                    </button>
                    <span>
                      {focusIdx === -1 ? "–" : focusIdx + 1} / {focusQueue.length}
                    </span>
                    <button onClick={() => focusStep(1)} title="Next (→)">
                      ›
                    </button>
                  </div>
                )}
                <span className={`rl-save rl-save-${saveState}`}>
                  {saveState === "saved" ? "saved" : saveState === "saving" ? "saving…" : "editing…"}
                </span>
                <button className="rl-close-doc" onClick={closeFile} title="Close document">
                  ✕
                </button>
              </div>
            </header>
            {view === "diff" ? (
              <DiffView
                path={path}
                onClose={() => setView("editor")}
                onMarkReviewed={markReviewed}
              />
            ) : null}
            {changed && view === "editor" && mode === "review" && baselineState !== "loading" && (
              <div className="rl-changes-bar">
                {baselineState === "error" ? (
                  <span>Couldn't load the last-reviewed version to compare against</span>
                ) : changeCount > 0 && !showChanges ? (
                  <span>Changes since you last reviewed are hidden</span>
                ) : changeCount > 0 ? (
                  <span>
                    <ins>added</ins> <del>removed</del> since you last reviewed
                  </span>
                ) : (
                  // links, heading levels, emphasis: invisible in the rendered text
                  <span>Only markdown formatting changed since you last reviewed</span>
                )}
                <span>
                  <button onClick={openRawDiff}>raw diff</button>{" "}
                  <button className="rl-primary" onClick={markReviewed}>
                    mark reviewed
                  </button>
                </span>
              </div>
            )}
            <div style={{ display: view === "diff" ? "none" : "contents" }}>
              <EditorPane
                key={path}
                ref={editorRef}
                docPath={path}
                initialMarkdown={initialMarkdown}
                onReady={() => {
                  setEditorReady(true);
                  editorRef.current?.setEditable(mode === "edit");
                  void refreshComments(path).then(() => {
                    if (pendingScroll.current) {
                      editorRef.current?.scrollToRange(
                        pendingScroll.current.start,
                        pendingScroll.current.end,
                      );
                      pendingScroll.current = null;
                    }
                  });
                }}
                onDirty={onDirty}
                onSelectText={onSelectText}
                onClickComment={onCardFocus}
                onChangeCount={setChangeCount}
                onCommentsWithChanges={setCommentsWithChanges}
              />
            </div>
          </>
        ) : (
          <div className="rl-welcome">
            <h2>redline</h2>
            <p>Pick a document on the left, highlight prose, and leave comments.</p>
            {!STATIC_MODE && (
              // project notes need no open document — the agent link is here too
              <div className="rl-welcome-agent">
                <AgentControls status={agentStatus} readyCount={agentReady} onNotice={showError} />
              </div>
            )}
            {STATIC_MODE ? (
              <p className="rl-welcome-hint">
                Drop a markdown file anywhere in this window, or paste markdown straight from
                your clipboard, to bring your own document in. When you've left comments,
                <em> copy for AI</em> hands them to any AI chat — and <em>paste reply</em>{" "}
                brings its revision back for your review. Everything stays in your browser.
              </p>
            ) : (
              <p className="rl-welcome-hint">
                You can also drop a markdown file anywhere in this window, or paste markdown
                straight from your clipboard — it's saved into the docs folder and opened.
              </p>
            )}
          </div>
        )}
      </main>

      <CommentSidebar
        annotations={annotations}
        projectAnnotations={projectAnnotations}
        docPath={path}
        hasOpenDoc={path !== null}
        focusedId={focusedId}
        focusTick={focusTick}
        commentsWithChanges={
          baselineState === "loading" ? null : new Set(view === "editor" ? commentsWithChanges : [])
        }
        liveQuotes={live}
        onAddNote={addNote}
        onFocus={onCardFocus}
        onDelete={(id, isProject) => {
          const p = commentPath(isProject);
          if (p) void api.deleteComment(id, p).catch((e) => showError(String(e)));
          advanceFrom(id);
        }}
        onReopen={(id, isProject) => {
          const p = commentPath(isProject);
          if (p) void api.patchComment(id, { path: p, status: "open" }).catch((e) => showError(String(e)));
        }}
        onMarkResolved={(id, isProject) => {
          const p = commentPath(isProject);
          if (p)
            void api.patchComment(id, { path: p, status: "resolved" }).catch((e) => showError(String(e)));
          advanceFrom(id);
        }}
        onReply={(id, isProject, text) => {
          const p = commentPath(isProject);
          if (p) void api.patchComment(id, { path: p, reply: text }).catch((e) => showError(String(e)));
          advanceFrom(id);
        }}
        onEdit={(id, isProject, text) => {
          const p = commentPath(isProject);
          if (p) void api.patchComment(id, { path: p, body: text }).catch((e) => showError(String(e)));
        }}
        onEditReply={(id, isProject, index, text) => {
          const p = commentPath(isProject);
          if (p)
            void api
              .patchComment(id, { path: p, editReply: { index, text } })
              .catch((e) => showError(String(e)));
        }}
      />

      {dragging && (
        <div className="rl-drop-overlay">
          <span>drop to import</span>
        </div>
      )}

      {draft && path && mode === "review" && view === "editor" && (
        <CommentPopover
          key={`${draft.selection.start}-${draft.selection.end}`}
          selection={draft.selection}
          text={draft.text}
          onText={(text) => setDraft((d) => (d ? { ...d, text } : d))}
          onSubmit={() => void addComment()}
          onCancel={cancelDraft}
        />
      )}

      {error && <div className="rl-toast">{error}</div>}
    </div>
  );
}
