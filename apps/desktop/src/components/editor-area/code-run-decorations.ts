import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  Prec,
  type Range,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import runtimes from "@shared/code-runtimes.json";
import { getParentDir } from "@/lib/paths";
import { cancelRun, runCode, type RunEvent } from "@/lib/tauri";
import "./code-run.css";

/** Fence language (first word of the info string) when it can run, else null. */
export function runnableLang(info: string): string | null {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return Object.prototype.hasOwnProperty.call(runtimes, lang) ? lang : null;
}

// ---------------------------------------------------------------------------
// Output cleanup and formatting
// ---------------------------------------------------------------------------

// CSI (colours, cursor moves), OSC (titles, links) and two-byte escapes.
const ANSI_SOURCE =
  "\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[@-Z\\\\-_]";
const ANSI_ALL = new RegExp(ANSI_SOURCE, "g");
const ANSI_AT_START = new RegExp(`^(?:${ANSI_SOURCE})`);
// A held-back tail longer than this isn't an escape sequence; let it through.
const MAX_HELD_ESCAPE = 256;

/**
 * Strip terminal escape codes from `text`. An escape sequence cut off by a
 * read boundary comes back as `rest`, to be prepended to the next chunk.
 */
export function stripAnsi(text: string): { text: string; rest: string } {
  const cut = text.lastIndexOf("\x1b");
  if (cut !== -1 && text.length - cut <= MAX_HELD_ESCAPE && !ANSI_AT_START.test(text.slice(cut))) {
    return { text: text.slice(0, cut).replace(ANSI_ALL, ""), rest: text.slice(cut) };
  }
  return { text: text.replace(ANSI_ALL, ""), rest: "" };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

// ---------------------------------------------------------------------------
// Run sessions (output lives here, outside the document and the DOM)
// ---------------------------------------------------------------------------

type Stream = "stdout" | "stderr";
type RunStatus = "running" | "done" | "failed" | "stopped";

interface Chunk {
  stream: Stream;
  text: string;
}

interface Session {
  id: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  chunks: Chunk[];
  held: Record<Stream, string>;
  /** Called with a new chunk, or with nothing when the status changed. */
  listeners: Set<(chunk?: Chunk) => void>;
}

const sessions = new Map<string, Session>();
// Views that have been destroyed; a run finishing later must not dispatch.
const deadViews = new WeakSet<EditorView>();

function appendChunk(session: Session, stream: Stream, raw: string): void {
  const { text, rest } = stripAnsi(session.held[stream] + raw);
  session.held[stream] = rest;
  if (!text) return;
  const chunk = { stream, text };
  session.chunks.push(chunk);
  for (const listener of session.listeners) listener(chunk);
}

function finishSession(
  view: EditorView,
  session: Session,
  exit: Extract<RunEvent, { event: "exit" }>["data"],
): void {
  // An unfinished escape at the very end is never completed; drop it.
  session.held = { stdout: "", stderr: "" };
  if (exit.truncated) appendChunk(session, "stderr", "\n[output stopped at 1 MiB]\n");
  session.status = exit.cancelled ? "stopped" : exit.code === 0 ? "done" : "failed";
  session.exitCode = exit.code;
  session.endedAt = performance.now();
  for (const listener of session.listeners) listener();
  if (!deadViews.has(view)) view.dispatch({ effects: sessionChanged.of(null) });
}

function dropSession(id: string): void {
  const session = sessions.get(id);
  if (session?.status === "running") void cancelRun(id);
  sessions.delete(id);
}

// ---------------------------------------------------------------------------
// Editor state: which fence owns which session
// ---------------------------------------------------------------------------

/** Marks a fence's start with the id of its latest run. Mapped through edits
 *  and dropped with the fence when it is deleted (or the document swapped),
 *  which is what stops a run whose block is gone. */
class RunMark extends RangeValue {
  constructor(readonly id: string) {
    super();
  }
  eq(other: RunMark): boolean {
    return other.id === this.id;
  }
}

const setRun = StateEffect.define<{ pos: number; id: string }>({
  map: (value, changes) => ({ pos: changes.mapPos(value.pos), id: value.id }),
});
const clearRun = StateEffect.define<string>();
const sessionChanged = StateEffect.define<null>();

const runsField = StateField.define<RangeSet<RunMark>>({
  create: () => RangeSet.empty,
  update(runs, tr) {
    let next = runs.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setRun)) {
        const { pos, id } = effect.value;
        next = next.update({
          filter: (from) => from !== pos,
          add: [new RunMark(id).range(pos)],
        });
      } else if (effect.is(clearRun)) {
        next = next.update({ filter: (_from, _to, mark) => mark.id !== effect.value });
      }
    }
    return next;
  },
});

function sessionAt(state: EditorState, pos: number): Session | undefined {
  let found: Session | undefined;
  state.field(runsField).between(pos, pos, (from, _to, mark) => {
    if (from !== pos) return;
    found = sessions.get(mark.id);
    return false;
  });
  return found;
}

const filePathFacet = Facet.define<() => string, () => string>({
  combine: (values) => values[0] ?? (() => ""),
});

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

interface RunnableFence {
  node: SyntaxNode;
  lang: string;
  source: string;
}

function runnableFence(state: EditorState, node: SyntaxNode): RunnableFence | null {
  if (node.name !== "FencedCode") return null;
  let info = "";
  let source = "";
  let marks = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeInfo") info = state.doc.sliceString(child.from, child.to);
    else if (child.name === "CodeText") source += state.doc.sliceString(child.from, child.to);
    else if (child.name === "CodeMark") marks++;
  }
  const lang = runnableLang(info);
  // An unclosed fence is still being typed and runs to the end of the doc.
  if (!lang || marks < 2 || !source.trim()) return null;
  return { node, lang, source };
}

/** The runnable fence containing `pos`, trying both sides of a boundary
 *  (see docs/editor.md "posAtDOM boundaries"). */
function runnableFenceAt(state: EditorState, pos: number): RunnableFence | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side);
    while (node && node.name !== "FencedCode") node = node.parent;
    if (node) return runnableFence(state, node);
  }
  return null;
}

function toggleRun(view: EditorView, fence: RunnableFence): void {
  const existing = sessionAt(view.state, fence.node.from);
  if (existing?.status === "running") {
    void cancelRun(existing.id);
    return;
  }

  const id = crypto.randomUUID();
  const session: Session = {
    id,
    status: "running",
    exitCode: null,
    startedAt: performance.now(),
    endedAt: null,
    chunks: [],
    held: { stdout: "", stderr: "" },
    listeners: new Set(),
  };
  sessions.set(id, session);
  // Replacing the fence's mark retires its previous session (see runLifecycle).
  view.dispatch({ effects: setRun.of({ pos: fence.node.from, id }) });

  const filePath = view.state.facet(filePathFacet)();
  const cwd = filePath ? getParentDir(filePath) : null;
  const onEvent = (event: RunEvent) => {
    if (sessions.get(id) !== session || session.status !== "running") return;
    if (event.event === "exit") finishSession(view, session, event.data);
    else appendChunk(session, event.event, event.data);
  };
  runCode(id, fence.lang, fence.source, cwd, onEvent).catch((err: unknown) => {
    if (session.status !== "running") return;
    appendChunk(session, "stderr", `${String(err)}\n`);
    finishSession(view, session, { code: null, cancelled: false, truncated: false });
  });
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

const ICONS = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  rerun:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
} as const;

const SHORTCUT_HINT = "⌥↵";

function iconButton(
  className: string,
  icon: keyof typeof ICONS,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = ICONS[icon];
  // Keep the editor focused; see docs/editor.md "Buttons inside widgets".
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  button.addEventListener("click", onClick);
  return button;
}

function fenceAtDOM(view: EditorView, el: HTMLElement): RunnableFence | null {
  return runnableFenceAt(view.state, view.posAtDOM(el));
}

/** ▶ Run / ■ Stop in the fence's top-right corner. */
class RunToggleWidget extends WidgetType {
  constructor(readonly running: boolean) {
    super();
  }

  eq(other: RunToggleWidget): boolean {
    return other.running === this.running;
  }

  toDOM(view: EditorView): HTMLElement {
    const corner = document.createElement("span");
    corner.className = "cm-code-run-corner";
    corner.contentEditable = "false";
    const label = this.running ? "Stop" : "Run";
    const button = iconButton(
      "cm-code-run-toggle",
      this.running ? "stop" : "play",
      `${label} (${SHORTCUT_HINT})`,
      () => {
        const fence = fenceAtDOM(view, corner);
        if (fence) toggleRun(view, fence);
      },
    );
    button.dataset.running = String(this.running);
    button.append(label);
    corner.append(button);
    return corner;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function statusText(session: Session, now: number): string {
  const elapsed = formatDuration((session.endedAt ?? now) - session.startedAt);
  switch (session.status) {
    case "running":
      return `Running · ${elapsed}`;
    case "done":
      return `Done · ${elapsed}`;
    case "stopped":
      return `Stopped · ${elapsed}`;
    case "failed":
      return `Exit ${session.exitCode ?? "signal"} · ${elapsed}`;
  }
}

const trayCleanups = new WeakMap<HTMLElement, () => void>();

/** Output tray attached under the fence, shown once the fence has been run. */
class RunTrayWidget extends WidgetType {
  constructor(readonly sessionId: string) {
    super();
  }

  eq(other: RunTrayWidget): boolean {
    return other.sessionId === this.sessionId;
  }

  toDOM(view: EditorView): HTMLElement {
    const tray = document.createElement("div");
    tray.className = "cm-code-run-tray";
    tray.contentEditable = "false";
    const session = sessions.get(this.sessionId);
    if (!session) return tray;

    const header = tray.appendChild(document.createElement("div"));
    header.className = "cm-code-run-header";
    const status = header.appendChild(document.createElement("span"));
    status.className = "cm-code-run-status";
    status.setAttribute("aria-live", "polite");
    const dot = status.appendChild(document.createElement("span"));
    dot.className = "cm-code-run-dot";
    const statusLabel = status.appendChild(document.createElement("span"));

    const actions = header.appendChild(document.createElement("span"));
    actions.className = "cm-code-run-actions";
    const copy = iconButton("cm-code-run-action", "copy", "Copy output", () => {
      void writeText(session.chunks.map((c) => c.text).join("")).then(() => {
        copy.innerHTML = ICONS.check;
        window.setTimeout(() => (copy.innerHTML = ICONS.copy), 1200);
      });
    });
    const rerun = iconButton("cm-code-run-action", "rerun", `Run again (${SHORTCUT_HINT})`, () => {
      const fence = fenceAtDOM(view, tray);
      if (fence) toggleRun(view, fence);
    });
    const clear = iconButton("cm-code-run-action", "close", "Clear output", () => {
      view.dispatch({ effects: clearRun.of(session.id) });
    });
    actions.append(copy, rerun, clear);

    const output = tray.appendChild(document.createElement("pre"));
    output.className = "cm-code-run-output";
    const empty = document.createElement("span");
    empty.className = "cm-code-run-empty";
    empty.textContent = "No output";

    let timer: number | undefined;
    const renderStatus = () => {
      tray.dataset.status = session.status;
      statusLabel.textContent = statusText(session, performance.now());
      rerun.hidden = session.status === "running";
      copy.hidden = session.chunks.length === 0;
      if (session.status !== "running" && session.chunks.length === 0 && !empty.isConnected) {
        output.append(empty);
      }
      if (session.status === "running") {
        timer ??= window.setInterval(renderStatus, 100);
      } else if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const appendOutput = (chunk: Chunk) => {
      // Follow the output only while the reader is already at the bottom.
      const pinned = output.scrollTop + output.clientHeight >= output.scrollHeight - 4;
      const span = document.createElement("span");
      span.className = `cm-code-run-${chunk.stream}`;
      span.textContent = chunk.text;
      output.append(span);
      if (pinned) output.scrollTop = output.scrollHeight;
    };

    for (const chunk of session.chunks) appendOutput(chunk);
    renderStatus();
    const listener = (chunk?: Chunk) => {
      if (chunk) appendOutput(chunk);
      renderStatus();
    };
    session.listeners.add(listener);
    trayCleanups.set(tray, () => {
      session.listeners.delete(listener);
      if (timer !== undefined) window.clearInterval(timer);
    });
    return tray;
  }

  destroy(dom: HTMLElement): void {
    trayCleanups.get(dom)?.();
    trayCleanups.delete(dom);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name !== "FencedCode") return;
      const fence = runnableFence(state, ref.node);
      if (!fence) return false;
      const session = sessionAt(state, ref.from);
      // side -1: before the hidden ``` marker, so the decoration that hides
      // the marker doesn't swallow the button.
      ranges.push(
        Decoration.widget({
          widget: new RunToggleWidget(session?.status === "running"),
          side: -1,
        }).range(ref.from),
      );
      if (session) {
        ranges.push(
          Decoration.line({ class: "cm-code-run-attached" }).range(state.doc.lineAt(ref.to).from),
          Decoration.widget({
            widget: new RunTrayWidget(session.id),
            block: true,
            side: 1,
          }).range(ref.to),
        );
      }
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

const decorationsField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(decorations, tr) {
    const runEffect = tr.effects.some(
      (e) => e.is(setRun) || e.is(clearRun) || e.is(sessionChanged),
    );
    if (tr.docChanged || runEffect || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Retires sessions whose fence mark is gone (fence deleted, output cleared,
 *  re-run, document swapped) and stops them if they are still running. */
const runLifecycle = ViewPlugin.define((view) => ({
  update(update) {
    const before = update.startState.field(runsField);
    const after = update.state.field(runsField);
    if (before === after) return;
    const live = new Set<string>();
    after.between(0, update.state.doc.length, (_from, _to, mark) => void live.add(mark.id));
    before.between(0, update.startState.doc.length, (_from, _to, mark) => {
      if (!live.has(mark.id)) dropSession(mark.id);
    });
  },
  destroy() {
    deadViews.add(view);
    view.state.field(runsField).between(0, view.state.doc.length, (_from, _to, mark) => {
      dropSession(mark.id);
    });
  },
}));

const runKeymap = Prec.high(
  keymap.of([
    {
      key: "Alt-Enter",
      run: (view) => {
        const fence = runnableFenceAt(view.state, view.state.selection.main.head);
        if (!fence) return false;
        toggleRun(view, fence);
        return true;
      },
    },
  ]),
);

export function codeRunExtension(getFilePath: () => string): Extension {
  return [filePathFacet.of(getFilePath), runsField, decorationsField, runLifecycle, runKeymap];
}

export const __testCodeRun = { decorationsField, runsField, setRun, clearRun, sessions };
