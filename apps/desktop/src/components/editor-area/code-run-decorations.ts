import { Decoration, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import runtimes from "@shared/code-runtimes.json";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import { getParentDir } from "@/lib/paths";
import { cancelRun, runCode, type RunEvent } from "@/lib/tauri";
import "./code-run.css";

/** Fence language (first word of the info string) when it can run, else null. */
export function runnableLang(info: string): string | null {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return Object.prototype.hasOwnProperty.call(runtimes, lang) ? lang : null;
}

interface RunPanel {
  lang: string;
  source: string;
  runId: string | null;
  button: HTMLButtonElement;
  status: HTMLSpanElement;
  output: HTMLPreElement;
}

// Keyed by the widget's DOM so `updateDOM` and `destroy` reach the live panel.
const panels = new WeakMap<HTMLElement, RunPanel>();

function append(panel: RunPanel, text: string, stream: "stdout" | "stderr"): void {
  const span = document.createElement("span");
  span.className = `cm-code-run-${stream}`;
  span.textContent = text;
  panel.output.append(span);
  panel.output.hidden = false;
}

function setRunning(panel: RunPanel, running: boolean): void {
  panel.button.textContent = running ? "Stop" : "Run";
  panel.button.setAttribute("aria-label", running ? "Stop code" : "Run code");
  panel.status.textContent = running ? "Running…" : panel.status.textContent;
}

function finish(panel: RunPanel, event: Extract<RunEvent, { event: "exit" }>["data"]): void {
  panel.runId = null;
  setRunning(panel, false);
  if (event.truncated) append(panel, "\n[output stopped at 1 MiB]\n", "stderr");
  panel.status.textContent = event.cancelled
    ? "Stopped"
    : event.code === 0
      ? "Done"
      : `Exit ${event.code ?? "signal"}`;
  panel.status.dataset.failed = String(!event.cancelled && event.code !== 0);
}

function start(panel: RunPanel, cwd: string | null): void {
  const runId = crypto.randomUUID();
  panel.runId = runId;
  panel.output.replaceChildren();
  panel.output.hidden = true;
  delete panel.status.dataset.failed;
  setRunning(panel, true);

  // Events from a superseded run (Stop, then Run again) are dropped.
  const onEvent = (event: RunEvent) => {
    if (panel.runId !== runId) return;
    if (event.event === "exit") finish(panel, event.data);
    else append(panel, event.data, event.event);
  };
  runCode(runId, panel.lang, panel.source, cwd, onEvent).catch((err: unknown) => {
    if (panel.runId !== runId) return;
    append(panel, `${String(err)}\n`, "stderr");
    finish(panel, { code: null, cancelled: false, truncated: false });
  });
}

/**
 * Run bar + output panel under a runnable fence. Identity is the fence's
 * language and code; output lives only in the widget (never in the document)
 * and survives edits because `updateDOM` keeps the DOM.
 */
class CodeRunWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly source: string,
    readonly getFilePath: () => string,
  ) {
    super();
  }

  eq(other: CodeRunWidget): boolean {
    return this.lang === other.lang && this.source === other.source;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-code-run";
    wrapper.contentEditable = "false";

    const bar = wrapper.appendChild(document.createElement("div"));
    bar.className = "cm-code-run-bar";
    const button = bar.appendChild(document.createElement("button"));
    button.type = "button";
    button.className = "cm-code-run-button";
    const status = bar.appendChild(document.createElement("span"));
    status.className = "cm-code-run-status";
    status.setAttribute("aria-live", "polite");
    const output = wrapper.appendChild(document.createElement("pre"));
    output.className = "cm-code-run-output";
    output.hidden = true;

    const panel: RunPanel = {
      lang: this.lang,
      source: this.source,
      runId: null,
      button,
      status,
      output,
    };
    setRunning(panel, false);
    panels.set(wrapper, panel);

    // Keep the editor focused; see docs/editor.md "Buttons inside widgets".
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener("click", () => {
      if (panel.runId) {
        void cancelRun(panel.runId);
        return;
      }
      const filePath = this.getFilePath();
      start(panel, filePath ? getParentDir(filePath) : null);
    });

    return wrapper;
  }

  updateDOM(dom: HTMLElement): boolean {
    const panel = panels.get(dom);
    if (!panel) return false;
    // A run in flight keeps going with the code it started with; the next
    // Run picks up the edit.
    panel.lang = this.lang;
    panel.source = this.source;
    return true;
  }

  destroy(dom: HTMLElement): void {
    const panel = panels.get(dom);
    if (panel?.runId) void cancelRun(panel.runId);
    panels.delete(dom);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function fenceParts(
  doc: { sliceString(from: number, to: number): string },
  node: SyntaxNodeRef,
): { info: string; source: string; closed: boolean } {
  let info = "";
  let source = "";
  let marks = 0;
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeInfo") info = doc.sliceString(child.from, child.to);
    else if (child.name === "CodeText") source += doc.sliceString(child.from, child.to);
    else if (child.name === "CodeMark") marks++;
  }
  return { info, source, closed: marks >= 2 };
}

export function codeRunDecorations(getFilePath: () => string) {
  return foldableSyntaxFacet.of({
    nodePath: "FencedCode",
    // The fence stays plain editable source; the widget sits below it whether
    // or not the caret is inside.
    keepDecorationOnUnfold: true,
    buildDecorations: (state, node) => {
      const { info, source, closed } = fenceParts(state.doc, node);
      const lang = runnableLang(info);
      // An unclosed fence is still being typed and runs to the end of the doc.
      if (!lang || !closed || !source.trim()) return undefined;
      const widget = new CodeRunWidget(lang, source, getFilePath);
      return Decoration.widget({ widget, block: true, side: 1 }).range(node.to);
    },
  });
}
