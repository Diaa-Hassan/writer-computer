import { describe, expect, test, vi } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { foldExtension } from "../src/lib/prosemark-core/main";
import { withFullParse } from "./helpers/parsed-state";

vi.mock("@/lib/tauri", () => ({ runCode: vi.fn(), cancelRun: vi.fn() }));

const { codeRunDecorations, runnableLang } =
  await import("../src/components/editor-area/code-run-decorations");

function runWidgets(doc: string): { pos: number; lang: string; source: string }[] {
  const state = withFullParse(
    EditorState.create({
      doc,
      extensions: [markdown({ extensions: [GFM] }), codeRunDecorations(() => "/notes/a.md")],
    }),
  );
  const found: { pos: number; lang: string; source: string }[] = [];
  state.field(foldExtension).between(0, doc.length, (from, _to, decoration) => {
    const widget = (decoration.spec as { widget?: { lang?: string; source?: string } }).widget;
    if (widget?.lang) found.push({ pos: from, lang: widget.lang, source: widget.source ?? "" });
  });
  return found;
}

describe("runnableLang", () => {
  test("uses the first word of the info string, case-insensitively", () => {
    expect(runnableLang("bash")).toBe("bash");
    expect(runnableLang(" Bash title=setup")).toBe("bash");
  });

  test("rejects languages without a runtime", () => {
    expect(runnableLang("python")).toBeNull();
    expect(runnableLang("")).toBeNull();
    expect(runnableLang("toString")).toBeNull();
  });
});

describe("codeRunDecorations", () => {
  test("puts a run widget after a closed bash fence", () => {
    const doc = "intro\n\n```bash\necho hi\n```\n\nafter";
    expect(runWidgets(doc)).toEqual([
      { pos: doc.indexOf("```\n\nafter") + 3, lang: "bash", source: "echo hi" },
    ]);
  });

  test("skips other languages, unclosed fences and empty fences", () => {
    expect(runWidgets("```python\nprint(1)\n```")).toEqual([]);
    expect(runWidgets("```bash\necho still typing")).toEqual([]);
    expect(runWidgets("```bash\n\n```")).toEqual([]);
  });
});
