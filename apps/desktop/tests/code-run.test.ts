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
const { useSettingsStore } = await import("../src/stores/settings-store");
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
      trustFolder: null,
      launch: () => {},
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
        onEvent({
          event: "exit",
          data: { code: exit, cancelled: false, truncated: false, timedOut: false },
        }),
      );
      return { status: "started" };
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

  // Wait for conditions, not a fixed time: a loaded test runner can take
  // longer than any sleep. `flush` lets a wrongly-continuing run show up.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("finds every runnable fence in order", () => {
    expect(runnableFenceStarts(EditorState.create({ doc, extensions: [markdown()] }))).toHaveLength(
      4,
    );
  });

  test("runs top to bottom and stops at the first failure", async () => {
    const ran = fakeRuns([0, 0, 1, 0]);
    const view = makeView();
    expect(runCodeBlocks(view, "all")).toBe(true);
    await vi.waitFor(() => expect(ran).toHaveLength(3));
    await vi.waitFor(() =>
      expect(view.dom.querySelectorAll(".cm-code-run-tray")[2]?.getAttribute("data-status")).toBe(
        "failed",
      ),
    );
    await flush();
    expect(ran).toEqual(["echo one", "print('skip me? no, I run')", "exit 1"]);
    view.destroy();
  });

  test("above runs only the blocks that end before the caret", async () => {
    const ran = fakeRuns([0, 0, 0, 0]);
    const view = makeView(doc.indexOf("exit 1"));
    expect(runCodeBlocks(view, "above")).toBe(true);
    await vi.waitFor(() => expect(ran).toHaveLength(2));
    await vi.waitFor(() =>
      expect(view.dom.querySelectorAll(".cm-code-run-tray")[1]?.getAttribute("data-status")).toBe(
        "done",
      ),
    );
    await flush();
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

describe("Run Code Blocks setting", () => {
  const doc = "```bash\necho hi\n```";
  const setEnabled = (enabled: boolean) =>
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, "code.run-enabled": enabled },
    }));

  test("off: no Run buttons, nothing for Run All", () => {
    setEnabled(false);
    const state = makeState(doc);
    expect(widgets(state)).toEqual([]);
    expect(runnableFenceStarts(state)).toEqual([]);
    setEnabled(true);
  });

  test("turning it off removes the buttons from an open editor", () => {
    setEnabled(true);
    const view = new EditorView({
      parent: document.body,
      state: makeState(doc),
    });
    expect(widgets(view.state)).toHaveLength(1);
    setEnabled(false);
    expect(widgets(view.state)).toEqual([]);
    setEnabled(true);
    expect(widgets(view.state)).toHaveLength(1);
    view.destroy();
  });
});

describe("Trusted Folders", () => {
  const doc = ["```bash\necho one\n```", "```bash\necho two\n```"].join("\n\n");
  const folder = "/notes";

  /** Fake backend that refuses until `folder` is trusted. */
  function fakeTrustingBackend(): string[] {
    const ran: string[] = [];
    vi.mocked(tauri.runCode).mockReset();
    vi.mocked(tauri.runCode).mockImplementation(async (_id, _lang, code, _cwd, onEvent) => {
      const trusted = useSettingsStore.getState().settings["code.trusted-folders"];
      if (!(Array.isArray(trusted) && trusted.includes(folder))) {
        return { status: "needsTrust", folder };
      }
      ran.push(code.trim());
      setTimeout(() =>
        onEvent({
          event: "exit",
          data: { code: 0, cancelled: false, truncated: false, timedOut: false },
        }),
      );
      return { status: "started" };
    });
    return ran;
  }

  function useFakeSettings(): ReturnType<typeof vi.fn> {
    const setSetting = vi.fn(async (key: string, value: unknown) => {
      useSettingsStore.setState((state) => ({ settings: { ...state.settings, [key]: value } }));
    });
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, "code.trusted-folders": [] },
      setSetting,
    }));
    return setSetting;
  }

  function makeView(): EditorView {
    return new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        extensions: [markdown({ extensions: [GFM] }), codeRunExtension(() => `${folder}/a.md`)],
      }),
    });
  }

  // Wait for conditions, not a fixed time: a loaded test runner can take
  // longer than any sleep. `flush` lets a wrongly-continuing run show up.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const trayStatus = (view: EditorView) =>
    view.dom.querySelector<HTMLElement>(".cm-code-run-tray")?.dataset.status;
  const click = (view: EditorView, selector: string) =>
    view.dom.querySelector<HTMLButtonElement>(selector)!.click();

  test("asks before running in an untrusted folder; Allow saves it and runs", async () => {
    const ran = fakeTrustingBackend();
    const setSetting = useFakeSettings();
    const view = makeView();

    runCodeBlocks(view, "all");
    await vi.waitFor(() => expect(trayStatus(view)).toBe("needs-trust"));
    expect(ran).toEqual([]);
    const tray = view.dom.querySelector<HTMLElement>(".cm-code-run-tray")!;
    expect(tray.dataset.status).toBe("needs-trust");
    expect(tray.querySelector(".cm-code-run-trust-folder")!.textContent).toBe(folder);

    click(view, ".cm-code-run-trust-allow");
    // Run All carried on once the folder was allowed.
    await vi.waitFor(() => expect(ran).toEqual(["echo one", "echo two"]));
    expect(setSetting).toHaveBeenCalledWith("code.trusted-folders", [folder], "global");
    view.destroy();
  });

  test("Allow saves the folder even when a stale store already lists it", async () => {
    const ran: string[] = [];
    let backendTrusts = false;
    vi.mocked(tauri.runCode).mockReset();
    vi.mocked(tauri.runCode).mockImplementation(async (_id, _lang, code, _cwd, onEvent) => {
      if (!backendTrusts) return { status: "needsTrust", folder };
      ran.push(code.trim());
      setTimeout(() =>
        onEvent({
          event: "exit",
          data: { code: 0, cancelled: false, truncated: false, timedOut: false },
        }),
      );
      return { status: "started" };
    });
    const setSetting = vi.fn(async () => {
      backendTrusts = true;
    });
    // The store thinks the folder is trusted; the backend disagrees.
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, "code.trusted-folders": [folder] },
      setSetting,
    }));
    const view = makeView();

    runCodeBlocks(view, "all");
    await vi.waitFor(() => expect(trayStatus(view)).toBe("needs-trust"));
    click(view, ".cm-code-run-trust-allow");
    await vi.waitFor(() => expect(ran).toEqual(["echo one", "echo two"]));
    expect(setSetting).toHaveBeenCalledWith("code.trusted-folders", [folder], "global");
    view.destroy();
  });

  test("Cancel stops the block and the Run All it belongs to", async () => {
    const ran = fakeTrustingBackend();
    const setSetting = useFakeSettings();
    const view = makeView();

    runCodeBlocks(view, "all");
    await vi.waitFor(() => expect(trayStatus(view)).toBe("needs-trust"));
    click(view, ".cm-code-run-trust-cancel");
    await vi.waitFor(() => expect(trayStatus(view)).toBe("stopped"));
    await flush();
    expect(setSetting).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
    expect(view.dom.querySelectorAll(".cm-code-run-tray")).toHaveLength(1);
    expect(view.dom.querySelector<HTMLElement>(".cm-code-run-tray")!.dataset.status).toBe(
      "stopped",
    );
    view.destroy();
  });
});
