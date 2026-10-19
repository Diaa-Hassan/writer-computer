// @vitest-environment jsdom
// jsdom for the Run All tests, which drive a real EditorView.
import { describe, expect, test, vi } from "vite-plus/test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { withFullParse } from "./helpers/parsed-state";

vi.mock("@/lib/tauri", () => ({ runCode: vi.fn(), cancelRun: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

// jsdom has no layout; CodeMirror measures text ranges when scrolling a block
// into view, so give ranges an empty rect list.
if (!("getClientRects" in Range.prototype)) {
  Object.assign(Range.prototype, {
    getClientRects: () => [],
    getBoundingClientRect: () => new DOMRect(),
  });
}

const tauri = await import("../src/lib/tauri");
const {
  __testCodeRun,
  codeRunExtension,
  formatDuration,
  runCodeBlocks,
  runnableFenceStarts,
  runnableLang,
  stripAnsi,
} = await import("../src/components/editor-area/code-run-decorations");

function makeState(doc: string): EditorState {
  return withFullParse(
    EditorState.create({
      doc,
      extensions: [markdown({ extensions: [GFM] }), codeRunExtension(() => "/notes/a.md")],
    }),
  );
}

/** Widgets by kind (constructor name) with their document position. */
function widgets(state: EditorState): { pos: number; kind: string }[] {
  const found: { pos: number; kind: string }[] = [];
  state.field(__testCodeRun.decorationsField).between(0, state.doc.length, (from, _to, deco) => {
    const widget = (deco.spec as { widget?: object }).widget;
    if (widget) found.push({ pos: from, kind: widget.constructor.name });
  });
  return found;
}

describe("runnableLang", () => {
  test("uses the first word of the info string, case-insensitively", () => {
    expect(runnableLang("bash")).toBe("bash");
    expect(runnableLang(" Bash title=setup")).toBe("bash");
  });

  test("resolves aliases to their runtime", () => {
    expect(runnableLang("py")).toBe("python");
    expect(runnableLang("JS")).toBe("javascript");
    expect(runnableLang("ts")).toBe("typescript");
    expect(runnableLang("shell")).toBe("sh");
  });

  test("rejects languages without a runtime", () => {
    expect(runnableLang("rust")).toBeNull();
    expect(runnableLang("")).toBeNull();
    expect(runnableLang("toString")).toBeNull();
  });
});

describe("code run decorations", () => {
  const doc = "intro\n\n```bash\necho hi\n```\n\nafter";
  const fenceFrom = doc.indexOf("```bash");
  const fenceTo = doc.indexOf("```\n\nafter") + 3;

  test("a runnable fence gets a Run button at its start and no tray before it runs", () => {
    expect(widgets(makeState(doc))).toEqual([{ pos: fenceFrom, kind: "RunToggleWidget" }]);
  });

  test("other languages, unclosed fences and empty fences get nothing", () => {
    expect(widgets(makeState("```rust\nfn main() {}\n```"))).toEqual([]);
    expect(widgets(makeState("```bash\necho still typing"))).toEqual([]);
    expect(widgets(makeState("```bash\n\n```"))).toEqual([]);
  });

  test("a run attaches the output tray under the fence; clearing removes it", () => {
    const { setRun, clearRun, sessions } = __testCodeRun;
    sessions.set("r1", {
      id: "r1",
      status: "done",
      exitCode: 0,
      startedAt: 0,
      endedAt: 5,
      chunks: [],
      held: { stdout: "", stderr: "" },
      listeners: new Set(),
      finished: Promise.resolve("done"),
      settle: () => {},
    });
    let state = makeState(doc);
    state = state.update({ effects: setRun.of({ pos: fenceFrom, id: "r1" }) }).state;
    expect(widgets(state)).toEqual([
      { pos: fenceFrom, kind: "RunToggleWidget" },
      { pos: fenceTo, kind: "RunTrayWidget" },
    ]);

    // Text typed above the fence moves the run with it.
    state = state.update({ changes: { from: 0, insert: "new " } }).state;
    expect(widgets(state).map((w) => w.kind)).toEqual(["RunToggleWidget", "RunTrayWidget"]);

    state = state.update({ effects: clearRun.of("r1") }).state;
    expect(widgets(state).map((w) => w.kind)).toEqual(["RunToggleWidget"]);
    sessions.clear();
  });
});

describe("stripAnsi", () => {
  test("removes colour and OSC sequences", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m \x1b]0;title\x07done")).toEqual({
      text: "ok done",
      rest: "",
    });
  });

  test("holds back an escape cut off by a read boundary", () => {
    const first = stripAnsi("plain \x1b[3");
    expect(first).toEqual({ text: "plain ", rest: "\x1b[3" });
    expect(stripAnsi(`${first.rest}1mred\x1b[0m`)).toEqual({ text: "red", rest: "" });
  });
});

describe("formatDuration", () => {
  test("picks ms, seconds or minutes", () => {
    expect(formatDuration(42.4)).toBe("42ms");
    expect(formatDuration(3210)).toBe("3.2s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});

describe("Run All", () => {
  const doc = [
    "```bash\necho one\n```",
    "```python\nprint('skip me? no, I run')\n```",
    "```bash\nexit 1\n```",
    "```bash\necho never\n```",
  ].join("\n\n");

  /** Fake backend: each run exits with the next code, after a tick. */
  function fakeRuns(exitCodes: number[]): string[] {
    const ran: string[] = [];
    vi.mocked(tauri.runCode).mockReset();
    vi.mocked(tauri.runCode).mockImplementation(async (_id, _lang, code, _cwd, onEvent) => {
      ran.push(code.trim());
      const exit = exitCodes.shift() ?? 0;
      setTimeout(() =>
        onEvent({ event: "exit", data: { code: exit, cancelled: false, truncated: false } }),
      );
    });
    return ran;
  }

  function makeView(anchor = 0): EditorView {
    return new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: EditorSelection.single(anchor),
        extensions: [markdown({ extensions: [GFM] }), codeRunExtension(() => "/notes/a.md")],
      }),
    });
  }

  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("finds every runnable fence in order", () => {
    expect(runnableFenceStarts(EditorState.create({ doc, extensions: [markdown()] }))).toHaveLength(
      4,
    );
  });

  test("runs top to bottom and stops at the first failure", async () => {
    const ran = fakeRuns([0, 0, 1, 0]);
    const view = makeView();
    expect(runCodeBlocks(view, "all")).toBe(true);
    await settled();
    expect(ran).toEqual(["echo one", "print('skip me? no, I run')", "exit 1"]);
    view.destroy();
  });

  test("above runs only the blocks that end before the caret", async () => {
    const ran = fakeRuns([0, 0, 0, 0]);
    const view = makeView(doc.indexOf("exit 1"));
    expect(runCodeBlocks(view, "above")).toBe(true);
    await settled();
    expect(ran).toEqual(["echo one", "print('skip me? no, I run')"]);
    view.destroy();
  });

  test("does nothing in a note without runnable blocks", () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "just prose", extensions: [codeRunExtension(() => "")] }),
    });
    expect(runCodeBlocks(view, "all")).toBe(false);
    view.destroy();
  });
});
