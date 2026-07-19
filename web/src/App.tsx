import { useCallback, useEffect, useRef, useState } from "react";
import { makeQuoteSelector, PROJECT_PATH } from "@redline/shared";
import type { Annotation, Sidecar, TreeEntry } from "@redline/shared";
import { api, ApiError, subscribeEvents, type SearchResult } from "./api.ts";
import { CommentPopover } from "./components/CommentPopover.tsx";
import { CommentSidebar } from "./components/CommentSidebar.tsx";
import { DiffView } from "./components/DiffView.tsx";
import { FileTree } from "./components/FileTree.tsx";
import { FocusPanel, type FocusEntry } from "./components/FocusPanel.tsx";
import { EditorPane, type EditorHandle, type SelectionInfo } from "./editor/EditorPane.tsx";

type SaveState = "saved" | "dirty" | "saving";
type Mode = "review" | "edit";
type View = "editor" | "diff";

interface Draft {
  selection: SelectionInfo;
  text: string;
}

export function App() {
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [initialMarkdown, setInitialMarkdown] = useState<string>("");
  const [sidecar, setSidecar] = useState<Sidecar | null>(null);
  const [projectAnnotations, setProjectAnnotations] = useState<Annotation[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<Mode>("review");
  const [view, setView] = useState<View>("editor");
  const [changed, setChanged] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);

  const editorRef = useRef<EditorHandle>(null);
  const baseHashRef = useRef<string>("");
  const pathRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScroll = useRef<{ start: number; end: number } | null>(null);
  const saveStateRef = useRef<SaveState>("saved");
  const draftRef = useRef<Draft | null>(null);
  const modeRef = useRef<Mode>("review");
  saveStateRef.current = saveState;
  pathRef.current = path;
  draftRef.current = draft;
  modeRef.current = mode;

  const dirtyEpoch = useRef(0); // bumped on every keystroke; guards save-state clobber
  const commentsSeq = useRef(0); // guards out-of-order comment refetches
  const submittingComment = useRef(false);

  const showError = useCallback((message: string) => {
    setError(message);
    setTimeout(() => setError(null), 5000);
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

  const openFile = useCallback(
    async (p: string) => {
      // a pending autosave for the PREVIOUS doc must never fire once the
      // path ref points at the new one
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      try {
        const doc = await api.getDoc(p);
        baseHashRef.current = doc.hash;
        setInitialMarkdown(doc.markdown);
        setPath(p);
        setSidecar(null);
        setFocusedId(null);
        setDraft(null);
        setView("editor");
        setChanged(doc.changed);
        setSaveState("saved");
      } catch (err) {
        pendingScroll.current = null; // never carry a scroll target to another doc
        showError(String(err));
      }
    },
    [showError],
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

  /** Save the doc the edit belonged to; abort if the user has switched files. */
  const save = useCallback(
    async (forPath: string) => {
      const editor = editorRef.current;
      if (!editor || pathRef.current !== forPath) return;
      const markdown = editor.getMarkdown();
      if (markdown === null) return; // editor not ready — never save "" over a doc
      const epochAtSave = dirtyEpoch.current;
      setSaveState("saving");
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
          setSaveState("saved");
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
            setSaveState("saved");
            setChanged(doc.changed);
            void refreshComments(forPath);
            showError("Document changed on disk — reloaded.");
            return;
          }
        }
        // anything else: keep the user's edits, retry on next change
        setSaveState("dirty");
        showError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [refreshComments, showError],
  );

  const onDirty = useCallback(() => {
    // the document is read-only in Review mode: any content change there is
    // programmatic (external reload) and must never echo back as a save
    if (modeRef.current === "review") return;
    dirtyEpoch.current++;
    setSaveState("dirty");
    const p = pathRef.current;
    if (!p) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(p), 800);
  }, [save]);

  // initial load + SSE
  useEffect(() => {
    refreshTree();
    refreshProjectNotes();
    const resyncCurrentDoc = () => {
      const p = pathRef.current;
      if (!p) return;
      void api
        .getDoc(p)
        .then((doc) => {
          if (pathRef.current !== p) return;
          if (doc.hash !== baseHashRef.current) {
            baseHashRef.current = doc.hash;
            editorRef.current?.setContent(doc.markdown);
            setSaveState("saved");
            // an external change invalidates any in-progress selection/draft
            setDraft(null);
            editorRef.current?.setDraft(null);
          }
          setChanged(doc.changed);
          void refreshComments(p);
        })
        .catch(() => showError(`${p} is no longer readable — was it deleted?`));
    };
    const unsubscribe = subscribeEvents({
      onEvent: (event) => {
        if (event.type === "comments:changed") {
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
        refreshTree();
        refreshProjectNotes();
        resyncCurrentDoc();
      },
    });
    return unsubscribe;
  }, [refreshTree, refreshComments, refreshProjectNotes, showError]);

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
      const files = Array.from(e.dataTransfer?.files ?? []).filter(looksLikeDoc);
      if (!files.length) return;
      e.preventDefault();
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
      setInitialMarkdown("");
      setSidecar(null);
      setFocusedId(null);
      setDraft(null);
      setView("editor");
      setChanged(false);
      setSaveState("saved");
      baseHashRef.current = "";
    });
  }, [save]);

  const annotations = sidecar?.annotations ?? [];

  // click-through order for anchored, still-actionable comments: document order
  const stepList = annotations
    .filter((a) => a.target && (a.status === "open" || a.status === "addressed"))
    .sort((a, b) => a.target!.selector[1].start - b.target!.selector[1].start);
  const stepTo = (dir: 1 | -1) => {
    if (!stepList.length) return;
    const idx = stepList.findIndex((a) => a.id === focusedId);
    const next = idx === -1 ? (dir === 1 ? 0 : stepList.length - 1) : (idx + dir + stepList.length) % stepList.length;
    focusComment(stepList[next].id);
  };

  // focus mode walks EVERYTHING still needing attention: project notes,
  // document notes, then anchored comments in document order
  const needsAttention = (a: Annotation) => a.status !== "resolved";
  const focusEntries: FocusEntry[] = [
    ...projectAnnotations.filter(needsAttention).map((a) => ({ annotation: a, isProject: true })),
    ...annotations
      .filter((a) => !a.target && needsAttention(a))
      .map((a) => ({ annotation: a, isProject: false })),
    ...annotations
      .filter((a) => a.target && needsAttention(a))
      .sort((a, b) => a.target!.selector[1].start - b.target!.selector[1].start)
      .map((a) => ({ annotation: a, isProject: false })),
  ];
  const focusNavigate = (next: number) => {
    setFocusIdx(next);
    const entry = focusEntries[next];
    if (!entry) return;
    if (entry.annotation.target && entry.annotation.status !== "orphaned") {
      focusComment(entry.annotation.id);
    } else {
      setFocusedId(entry.annotation.id);
    }
  };
  const enterFocusMode = () => {
    setFocusMode(true);
    const idx = focusEntries.findIndex((e) => e.annotation.id === focusedId);
    focusNavigate(idx === -1 ? 0 : idx);
  };

  // an emptied review queue must actually EXIT focus mode — otherwise the
  // mode stays silently armed and the panel springs open, uninvited, the
  // moment the next comment is created
  useEffect(() => {
    if (focusMode && focusEntries.length === 0) setFocusMode(false);
  }, [focusMode, focusEntries.length]);

  return (
    <div className="rl-app">
      <FileTree
        entries={tree}
        currentPath={path}
        onOpen={(p) => void openFile(p)}
        onOpenResult={openSearchResult}
      />

      <main className="rl-main">
        {path ? (
          <>
            <header className="rl-header">
              <span className="rl-path">{path}</span>
              <div className="rl-header-right">
                {changed && view === "editor" && (
                  <button
                    className="rl-changes-btn"
                    onClick={() => {
                      // flush any pending edit so the diff reflects reality
                      if (saveTimer.current) {
                        clearTimeout(saveTimer.current);
                        saveTimer.current = null;
                      }
                      const p = pathRef.current;
                      const flush = saveStateRef.current !== "saved" && p ? save(p) : Promise.resolve();
                      void flush.then(() => setView("diff"));
                    }}
                  >
                    ● changes
                  </button>
                )}
                <div className="rl-mode" role="group" aria-label="mode">
                  <button
                    className={mode === "review" ? "active" : ""}
                    onClick={() => {
                      setMode("review");
                      editorRef.current?.setEditable(false);
                    }}
                  >
                    Review
                  </button>
                  <button
                    className={mode === "edit" ? "active" : ""}
                    onClick={() => {
                      setMode("edit");
                      editorRef.current?.setEditable(true);
                      cancelDraft();
                    }}
                  >
                    Edit
                  </button>
                </div>
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
                onMarkReviewed={() => {
                  void api.markReviewed(path).then(() => {
                    setChanged(false);
                    setView("editor");
                  });
                }}
              />
            ) : null}
            <div style={{ display: view === "diff" ? "none" : "contents" }}>
              <EditorPane
                key={path}
                ref={editorRef}
                docPath={path}
                initialMarkdown={initialMarkdown}
                onReady={() => {
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
                onClickComment={focusComment}
              />
            </div>
          </>
        ) : (
          <div className="rl-welcome">
            <h2>redline</h2>
            <p>Pick a document on the left, highlight prose, and leave comments.</p>
            <p className="rl-welcome-hint">
              You can also drop a markdown file anywhere in this window, or paste markdown
              straight from your clipboard — it's saved into the docs folder and opened.
            </p>
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
        onAddNote={addNote}
        onFocus={focusComment}
        onDelete={(id, isProject) => {
          const p = commentPath(isProject);
          if (p) void api.deleteComment(id, p).catch((e) => showError(String(e)));
        }}
        onReopen={(id, isProject) => {
          const p = commentPath(isProject);
          if (p) void api.patchComment(id, { path: p, status: "open" }).catch((e) => showError(String(e)));
        }}
        onMarkResolved={(id, isProject) => {
          const p = commentPath(isProject);
          if (p)
            void api.patchComment(id, { path: p, status: "resolved" }).catch((e) => showError(String(e)));
        }}
        onReply={(id, isProject, text) => {
          const p = commentPath(isProject);
          if (p) void api.patchComment(id, { path: p, reply: text }).catch((e) => showError(String(e)));
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

      {focusMode && focusEntries.length > 0 && (
        <FocusPanel
          entries={focusEntries}
          index={focusIdx}
          onNavigate={focusNavigate}
          onClose={() => setFocusMode(false)}
          onAccept={(id, isProject) => {
            const p = commentPath(isProject);
            if (p)
              void api
                .patchComment(id, { path: p, status: "resolved" })
                .catch((e) => showError(String(e)));
          }}
          onReply={(id, isProject, text) => {
            const p = commentPath(isProject);
            if (p)
              void api.patchComment(id, { path: p, reply: text }).catch((e) => showError(String(e)));
          }}
          onEditReply={(id, isProject, index, text) => {
            const p = commentPath(isProject);
            if (p)
              void api
                .patchComment(id, { path: p, editReply: { index, text } })
                .catch((e) => showError(String(e)));
          }}
        />
      )}

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
      {focusEntries.length > 0 && (
        <div className="rl-statusbar">
          {path && stepList.length > 0 && (
            <button className="rl-step" onClick={() => stepTo(-1)} title="Previous comment">
              ‹
            </button>
          )}
          <span
            title={`${focusEntries.filter((e) => !e.isProject).length} in this document · ${
              focusEntries.filter((e) => e.isProject).length
            } project-wide`}
          >
            {focusEntries.length} to review
          </span>
          {path && stepList.length > 0 && (
            <button className="rl-step" onClick={() => stepTo(1)} title="Next comment">
              ›
            </button>
          )}
          {!focusMode && (
            <button
              className="rl-focus-btn"
              onClick={enterFocusMode}
              title="Review the open comments one at a time (Esc exits)"
            >
              focus mode
            </button>
          )}
        </div>
      )}
    </div>
  );
}
