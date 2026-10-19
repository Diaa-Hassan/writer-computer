import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
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
import { useSettingsStore } from "@/stores/settings-store";
import {
  cancelRun,
  closeRunStdin,
  runCode,
  type RunEvent,
  type RunOptions,
  writeRunStdin,
} from "@/lib/tauri";
import { type AnsiSegment, type AnsiStyle, parseAnsi, plainStyle, segmentCss } from "./ansi";
import "./code-run.css";

const runtimeByLang: Record<string, string> = runtimes;

/** Runtime id for a fence's language (first word of the info string, so
 *  aliases like `py` or `js` resolve), or null when it can't run. */
export function runnableLang(info: string): string | null {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return Object.prototype.hasOwnProperty.call(runtimeByLang, lang) ? runtimeByLang[lang] : null;
}

// ---------------------------------------------------------------------------
// Output cleanup and formatting
// ---------------------------------------------------------------------------

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
type RunStatus = "running" | "needs-trust" | "done" | "failed" | "stopped" | "timedout";

interface Chunk {
  /** `stdin`: what the user typed, echoed like a terminal would. */
  stream: Stream | "stdin";
  /** Plain text, for Copy. */
  text: string;
  /** The same text split by terminal style, for display. */
  segments: AnsiSegment[];
}

interface Session {
  id: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  chunks: Chunk[];
  held: Record<Stream, string>;
  /** Terminal style in effect at the end of each stream so far. */
  ansi: Record<Stream, AnsiStyle>;
  /** The user ended the program's input (⌃D / End input). */
  inputClosed: boolean;
  /** Called with a new chunk, or with nothing when the status changed. */
  listeners: Set<(chunk?: Chunk) => void>;
  /** Resolves with the final status once the run ends (or is dropped). */
  finished: Promise<RunStatus>;
  settle: (status: RunStatus) => void;
  /** While `needs-trust`: the folder to allow, and how to start once allowed. */
  trustFolder: string | null;
  launch: () => void;
}

/** Running, or waiting for the user to allow its folder. */
const isActive = (session: Session | undefined): boolean =>
  session?.status === "running" || session?.status === "needs-trust";

const sessions = new Map<string, Session>();
// Views that have been destroyed; a run finishing later must not dispatch.
const deadViews = new WeakSet<EditorView>();

function appendChunk(session: Session, stream: Stream, raw: string): void {
  const { segments, style, rest } = parseAnsi(session.held[stream] + raw, session.ansi[stream]);
  session.held[stream] = rest;
  session.ansi[stream] = style;
  const text = segments.map((segment) => segment.text).join("");
  if (!text) return;
  const chunk = { stream, text, segments };
  session.chunks.push(chunk);
  for (const listener of session.listeners) listener(chunk);
}

/** Show typed input in the output, as a terminal echoes it. */
function echoInput(session: Session, text: string): void {
  const chunk: Chunk = { stream: "stdin", text, segments: [{ text, style: plainStyle() }] };
  session.chunks.push(chunk);
  for (const listener of session.listeners) listener(chunk);
}

const PASSWORD_PROMPT = /pass(word|phrase)|\bpin\b|secret/i;

/** True when the output so far ends in what looks like a password prompt,
 *  so the input line should mask what is typed and not echo it. */
export function wantsSecretInput(chunks: readonly { stream: string; text: string }[]): boolean {
  const printed = chunks
    .filter((chunk) => chunk.stream !== "stdin")
    .map((chunk) => chunk.text)
    .join("");
  const lastLine = printed.replace(/\n+$/, "").split("\n").pop() ?? "";
  return PASSWORD_PROMPT.test(lastLine);
}

function finishSession(
  view: EditorView,
  session: Session,
  exit: Extract<RunEvent, { event: "exit" }>["data"],
): void {
  // An unfinished escape at the very end is never completed; drop it.
  session.held = { stdout: "", stderr: "" };
  if (exit.truncated) appendChunk(session, "stderr", "\n[output stopped at 1 MiB]\n");
  session.status = exit.timedOut
    ? "timedout"
    : exit.cancelled
      ? "stopped"
      : exit.code === 0
        ? "done"
        : "failed";
  session.exitCode = exit.code;
  session.endedAt = performance.now();
  session.settle(session.status);
  notify(view, session);
}

function dropSession(id: string): void {
  const session = sessions.get(id);
  if (isActive(session) && session) {
    if (session.status === "running") void cancelRun(id);
    // Its exit event will be ignored (the session is gone), so settle now.
    session.settle("stopped");
  }
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

// ---------------------------------------------------------------------------
// The "Run Code Blocks" setting
// ---------------------------------------------------------------------------

const ENABLED_SETTING = "code.run-enabled";
const settingEnabled = () => useSettingsStore.getState().settings[ENABLED_SETTING] !== false;

const setEnabled = StateEffect.define<boolean>();

/** Mirrors the setting into editor state, so turning it off removes every
 *  Run button and tray in the same rebuild (see `runSettingSync`). */
const enabledField = StateField.define<boolean>({
  create: settingEnabled,
  update(enabled, tr) {
    for (const effect of tr.effects) if (effect.is(setEnabled)) enabled = effect.value;
    return enabled;
  },
});

const filePathFacet = Facet.define<() => string, () => string>({
  combine: (values) => values[0] ?? (() => ""),
});

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

/** Options after the language in a fence's info string:
 *  ` ```bash cwd=../app timeout=30 color skip `. */
export interface FenceOptions extends RunOptions {
  /** Run All passes this block by (its own Run button still works). */
  skip: boolean;
}

const OPTION_PATTERN = /([A-Za-z][\w-]*)(?:=("[^"]*"|'[^']*'|\S+))?/g;

/** Read the options; unknown words are ignored, since other tools put titles
 *  and flags in the info string too. */
export function parseFenceOptions(info: string): FenceOptions {
  const options: FenceOptions = { color: false, skip: false };
  const afterLang = info.trim().replace(/^\S+/, "");
  for (const [, rawKey, rawValue] of afterLang.matchAll(OPTION_PATTERN)) {
    const key = rawKey.toLowerCase();
    const value = rawValue?.replace(/^(["'])(.*)\1$/, "$2");
    if ((key === "cwd" || key === "dir") && value) {
      options.dir = value;
    } else if (key === "timeout" && value !== undefined) {
      const seconds = Number(value.replace(/s$/, ""));
      if (Number.isFinite(seconds) && seconds >= 0) options.timeoutSeconds = seconds;
    } else if ((key === "color" || key === "colour") && value === undefined) {
      options.color = true;
    } else if (key === "skip" && value === undefined) {
      options.skip = true;
    }
  }
  return options;
}

interface RunnableFence {
  node: SyntaxNode;
  lang: string;
  source: string;
  options: FenceOptions;
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
  return { node, lang, source, options: parseFenceOptions(info) };
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

function stopSession(view: EditorView, session: Session): void {
  if (session.status === "running") void cancelRun(session.id);
  else if (session.status === "needs-trust") declineTrust(view, session);
}

function toggleRun(view: EditorView, fence: RunnableFence): void {
  const existing = sessionAt(view.state, fence.node.from);
  if (existing && isActive(existing)) stopSession(view, existing);
  else startRun(view, fence);
}

// ---------------------------------------------------------------------------
// Trusted Folders: the backend refuses to run outside them and says which
// folder to ask about; the tray asks, and Allow adds it to the setting.
// ---------------------------------------------------------------------------

const TRUSTED_SETTING = "code.trusted-folders";

function notify(view: EditorView, session: Session): void {
  for (const listener of session.listeners) listener();
  if (!deadViews.has(view)) view.dispatch({ effects: sessionChanged.of(null) });
}

function declineTrust(view: EditorView, session: Session): void {
  session.trustFolder = null;
  finishSession(view, session, { code: null, cancelled: true, truncated: false, timedOut: false });
}

async function allowTrust(view: EditorView, session: Session): Promise<void> {
  const folder = session.trustFolder;
  if (session.status !== "needs-trust" || !folder) return;
  const store = useSettingsStore.getState();
  const current = store.settings[TRUSTED_SETTING];
  const trusted = Array.isArray(current) ? (current as string[]) : [];
  try {
    // Always write, even if the store already lists the folder: the store
    // can be behind the backend (whose answer just said "not trusted"), and
    // skipping the write would leave the block asking forever.
    await store.setSetting(TRUSTED_SETTING, [...new Set([...trusted, folder])], "global");
  } catch (err) {
    session.trustFolder = null;
    appendChunk(session, "stderr", `Couldn't save Trusted Folders: ${String(err)}\n`);
    finishSession(view, session, {
      code: null,
      cancelled: false,
      truncated: false,
      timedOut: false,
    });
    return;
  }
  // Every block waiting on this folder can go now, not just the one clicked.
  for (const waiting of sessions.values()) {
    if (waiting.status !== "needs-trust" || waiting.trustFolder !== folder) continue;
    waiting.status = "running";
    waiting.trustFolder = null;
    waiting.startedAt = performance.now();
    waiting.launch();
  }
  notify(view, session);
}

function startRun(view: EditorView, fence: RunnableFence): Session {
  const id = crypto.randomUUID();
  let settle!: (status: RunStatus) => void;
  const finished = new Promise<RunStatus>((resolve) => (settle = resolve));
  const session: Session = {
    id,
    status: "running",
    exitCode: null,
    startedAt: performance.now(),
    endedAt: null,
    chunks: [],
    held: { stdout: "", stderr: "" },
    ansi: { stdout: plainStyle(), stderr: plainStyle() },
    inputClosed: false,
    listeners: new Set(),
    finished,
    settle,
    trustFolder: null,
    launch: () => {},
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
  session.launch = () => {
    const { dir, timeoutSeconds, color } = fence.options;
    runCode(id, fence.lang, fence.source, cwd, { dir, timeoutSeconds, color }, onEvent)
      .then((start) => {
        if (start.status !== "needsTrust" || session.status !== "running") return;
        session.status = "needs-trust";
        session.trustFolder = start.folder;
        notify(view, session);
      })
      .catch(onLaunchError);
  };
  const onLaunchError = (err: unknown) => {
    if (session.status !== "running") return;
    appendChunk(session, "stderr", `${String(err)}\n`);
    finishSession(view, session, {
      code: null,
      cancelled: false,
      truncated: false,
      timedOut: false,
    });
  };
  session.launch();
  return session;
}

// ---------------------------------------------------------------------------
// Run All
// ---------------------------------------------------------------------------

/** A Run All in progress: the fence starts still to run, kept current through
 *  edits by `runLifecycle`, so typing above a block doesn't derail it. */
interface Batch {
  positions: number[];
  cancelled: boolean;
}

const batches = new WeakMap<EditorView, Set<Batch>>();

/** Start positions of every runnable fence, in document order; with `before`,
 *  only fences that end before it. Parses the whole document first, since the
 *  editor otherwise only parses what is on screen. */
export function runnableFenceStarts(state: EditorState, before?: number): number[] {
  // `false` only when the extension is present and running is turned off.
  if (state.field(enabledField, false) === false) return [];
  const tree = ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state);
  const starts: number[] = [];
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== "FencedCode") return;
      if ((before === undefined || ref.to < before) && runnableFence(state, ref.node)) {
        starts.push(ref.from);
      }
      return false;
    },
  });
  return starts;
}

/** Run fences one after another, top to bottom, stopping at the first that
 *  fails or is stopped. A block already running is waited for, not restarted. */
async function runSequence(view: EditorView, positions: number[]): Promise<void> {
  const batch: Batch = { positions, cancelled: false };
  let running = batches.get(view);
  if (!running) batches.set(view, (running = new Set()));
  running.add(batch);
  try {
    for (let i = 0; i < batch.positions.length; i++) {
      if (batch.cancelled || deadViews.has(view)) return;
      const pos = batch.positions[i];
      const fence = runnableFenceAt(view.state, pos);
      // Deleted, no longer runnable, or marked `skip` since Run All started.
      if (!fence || fence.node.from !== pos || fence.options.skip) continue;
      const existing = sessionAt(view.state, pos);
      let status: RunStatus;
      if (existing && isActive(existing)) {
        status = await existing.finished;
      } else {
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "nearest", yMargin: 48 }) });
        status = await startRun(view, fence).finished;
      }
      if (status !== "done") return;
    }
  } finally {
    running.delete(batch);
  }
}

export type RunScope = "all" | "above";

/** Run every runnable block in the note (`all`), or those above the caret. */
export function runCodeBlocks(view: EditorView, scope: RunScope): boolean {
  const before = scope === "above" ? view.state.selection.main.head : undefined;
  const positions = runnableFenceStarts(view.state, before).filter(
    (pos) => !runnableFenceAt(view.state, pos)?.options.skip,
  );
  if (positions.length === 0) return false;
  void runSequence(view, positions);
  return true;
}

/** Stop every run in the note, and any Run All driving them. */
export function stopCodeRuns(view: EditorView): boolean {
  let stopped = false;
  for (const batch of batches.get(view) ?? []) {
    batch.cancelled = true;
    stopped = true;
  }
  view.state.field(runsField).between(0, view.state.doc.length, (_from, _to, mark) => {
    const session = sessions.get(mark.id);
    if (!session || !isActive(session)) return;
    stopSession(view, session);
    stopped = true;
  });
  return stopped;
}

export function hasRunningCode(view: EditorView): boolean {
  let running = (batches.get(view)?.size ?? 0) > 0;
  view.state.field(runsField).between(0, view.state.doc.length, (_from, _to, mark) => {
    if (isActive(sessions.get(mark.id))) running = true;
  });
  return running;
}

/** The editor of the visible tab (inactive panes stay mounted, hidden). A
 *  compact single-file window has no panes, just its one editor. */
export function activeEditorView(): EditorView | null {
  const panes = document.querySelectorAll<HTMLElement>("[data-pane]");
  const candidates =
    panes.length > 0
      ? Array.from(panes, (pane) =>
          pane.classList.contains("invisible")
            ? null
            : pane.querySelector<HTMLElement>(".cm-editor"),
        )
      : [document.querySelector<HTMLElement>(".cm-editor")];
  for (const dom of candidates) {
    const view = dom ? EditorView.findFromDOM(dom) : null;
    if (view) return view;
  }
  return null;
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

function textButton(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
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
    case "needs-trust":
      return "Waiting for permission";
    case "timedout":
      return `Time limit reached · ${elapsed}`;
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

    // Shown instead of output while the folder waits for permission.
    const trust = tray.appendChild(document.createElement("div"));
    trust.className = "cm-code-run-trust";
    const question = trust.appendChild(document.createElement("p"));
    question.textContent =
      "Code hasn't run in this folder before. It runs as you, with access to your files, so only allow folders whose code you trust.";
    const folder = trust.appendChild(document.createElement("code"));
    folder.className = "cm-code-run-trust-folder";
    const choices = trust.appendChild(document.createElement("div"));
    choices.className = "cm-code-run-trust-actions";
    choices.append(
      textButton(
        "cm-code-run-trust-allow",
        "Allow this folder",
        () => void allowTrust(view, session),
      ),
      textButton("cm-code-run-trust-cancel", "Cancel", () => declineTrust(view, session)),
    );

    const output = tray.appendChild(document.createElement("pre"));
    output.className = "cm-code-run-output";

    // Input line, shown while the program runs: Enter sends a line, ⌃D ends
    // input. Masked (and not echoed) after a password-looking prompt.
    const inputRow = tray.appendChild(document.createElement("div"));
    inputRow.className = "cm-code-run-input";
    const promptMark = inputRow.appendChild(document.createElement("span"));
    promptMark.className = "cm-code-run-input-mark";
    promptMark.textContent = "›";
    const input = inputRow.appendChild(document.createElement("input"));
    input.className = "cm-code-run-input-field";
    input.setAttribute("aria-label", "Input for the running program");
    input.autocomplete = "off";
    input.spellcheck = false;
    const endInput = () => {
      if (session.inputClosed || session.status !== "running") return;
      session.inputClosed = true;
      void closeRunStdin(session.id);
      for (const listener of session.listeners) listener();
    };
    inputRow.append(textButton("cm-code-run-input-end", "End input", endInput));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        const secret = input.type === "password";
        const line = `${input.value}\n`;
        input.value = "";
        // A terminal shows typed text but not a typed password.
        echoInput(session, secret ? "\n" : line);
        writeRunStdin(session.id, line).catch((err: unknown) => {
          appendChunk(session, "stderr", `${String(err)}\n`);
        });
      } else if (event.key === "d" && event.ctrlKey) {
        event.preventDefault();
        endInput();
      }
    });
    const empty = document.createElement("span");
    empty.className = "cm-code-run-empty";
    empty.textContent = "No output";

    let timer: number | undefined;
    const renderStatus = () => {
      tray.dataset.status = session.status;
      statusLabel.textContent = statusText(session, performance.now());
      const waiting = session.status === "needs-trust";
      trust.hidden = !waiting;
      output.hidden = waiting;
      folder.textContent = session.trustFolder ?? "";
      rerun.hidden = isActive(session);
      copy.hidden = session.chunks.length === 0;
      inputRow.hidden = session.status !== "running" || session.inputClosed;
      const inputType = wantsSecretInput(session.chunks) ? "password" : "text";
      if (input.type !== inputType) input.type = inputType;
      input.placeholder =
        inputType === "password"
          ? "Password (hidden)"
          : "Input · Enter sends a line, ⌃D ends input";
      if (!isActive(session) && session.chunks.length === 0 && !empty.isConnected) {
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
      for (const segment of chunk.segments) {
        const span = document.createElement("span");
        const { className, css } = segmentCss(segment.style);
        span.className = `cm-code-run-${chunk.stream} ${className}`.trim();
        if (css) span.style.cssText = css;
        span.textContent = segment.text;
        output.append(span);
      }
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
  if (!state.field(enabledField)) return Decoration.none;
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
          widget: new RunToggleWidget(isActive(session)),
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
      (e) => e.is(setRun) || e.is(clearRun) || e.is(sessionChanged) || e.is(setEnabled),
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
    if (update.docChanged) {
      for (const batch of batches.get(view) ?? []) {
        // assoc 1: text typed right before a fence keeps pointing at the fence.
        batch.positions = batch.positions.map((pos) => update.changes.mapPos(pos, 1));
      }
    }
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
    for (const batch of batches.get(view) ?? []) batch.cancelled = true;
    view.state.field(runsField).between(0, view.state.doc.length, (_from, _to, mark) => {
      dropSession(mark.id);
    });
  },
}));

/** Follows the setting: pushes changes into `enabledField` and, when running
 *  is turned off, stops whatever is running in this editor. */
const runSettingSync = ViewPlugin.define((view) => {
  const unsubscribe = useSettingsStore.subscribe((state, prev) => {
    const enabled = state.settings[ENABLED_SETTING] !== false;
    if (enabled === (prev.settings[ENABLED_SETTING] !== false)) return;
    if (!enabled) stopCodeRuns(view);
    view.dispatch({ effects: setEnabled.of(enabled) });
  });
  return { destroy: unsubscribe };
});

const runKeymap = Prec.high(
  keymap.of([
    {
      key: "Alt-Enter",
      run: (view) => {
        if (!view.state.field(enabledField)) return false;
        const fence = runnableFenceAt(view.state, view.state.selection.main.head);
        if (!fence) return false;
        toggleRun(view, fence);
        return true;
      },
    },
    { key: "Alt-Shift-Enter", run: (view) => runCodeBlocks(view, "all") },
  ]),
);

export function codeRunExtension(getFilePath: () => string): Extension {
  return [
    filePathFacet.of(getFilePath),
    enabledField,
    runsField,
    decorationsField,
    runLifecycle,
    runSettingSync,
    runKeymap,
  ];
}

export const __testCodeRun = { decorationsField, runsField, setRun, clearRun, sessions };
