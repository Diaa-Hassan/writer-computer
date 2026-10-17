// @vitest-environment jsdom
// jsdom for DOMPurify (the renderer sanitises Pele's SVG) and for mounting
// the canvas. Pele itself runs for real: without a canvas it measures labels
// from its built-in width table, so layouts are deterministic here.
import { describe, expect, test, vi, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";

// Wrap Pele's `render` in a spy (same implementation) so tests can count
// renders and inject a renderer failure.
vi.mock("pele", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pele")>();
  return { ...actual, render: vi.fn(actual.render) };
});

const pele = await import("pele");
const { renderMermaid, clearMermaidCache, sanitizeSvg } =
  await import("../src/components/editor-area/mermaid-renderer");

// One small source per diagram type Pele supports that Writer's notes are
// likely to hold, keyed by the class Pele puts on the root `<svg>`.
const DIAGRAMS: Record<string, string> = {
  flowchart:
    "flowchart LR\n  A[Draft] --> B{Ready?}\n  B -- Yes --> C[Publish]\n  subgraph S\n    C\n  end",
  sequence: "sequenceDiagram\n  A->>B: Save\n  B-->>A: OK\n  Note over A,B: local",
  class:
    "classDiagram\n  class Note {\n    +String title\n    +save() bool\n  }\n  Note <|-- Daily",
  state: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Editing : key\n  Editing --> [*]",
  er: "erDiagram\n  NOTE ||--o{ TAG : has\n  NOTE {\n    string path PK\n  }",
  gantt:
    "gantt\n  dateFormat YYYY-MM-DD\n  section A\n    Task :done, a1, 2026-10-01, 3d\n    Next :crit, after a1, 1d",
  pie: 'pie\n  "A" : 3\n  "B" : 5',
  journey: "journey\n  title J\n  section S\n    Step: 5: Me",
  gitGraph: "gitGraph\n  commit\n  branch f\n  commit\n  checkout main\n  merge f",
  mindmap: "mindmap\n  root((W))\n    A\n    B",
  timeline: "timeline\n  2026 : One\n  2027 : Two",
  quadrantChart: "quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  P: [0.3, 0.8]",
  xychart: "xychart-beta\n  x-axis [a, b]\n  bar [1, 2]\n  line [2, 1]",
  sankey: "sankey-beta\nA,B,5\nA,C,3",
  block: "block-beta\n  columns 2\n  A B",
  architecture: "architecture-beta\n  service a(server)[A]\n  service b(disk)[B]\n  a:R --> L:b",
  kanban: "kanban\n  todo[To do]\n    t1[One]",
  requirement:
    "requirementDiagram\n  requirement r {\n    id: 1\n    text: t\n  }\n  element e {\n    type: lib\n  }\n  e - satisfies -> r",
  c4: 'C4Context\n  Person(p, "P")\n  System(s, "S")\n  Rel(p, s, "uses")',
  packet: 'packet-beta\n  0-15: "Source"\n  16-31: "Dest"',
  radar: 'radar-beta\n  axis a, b, c\n  curve x["X"]{1, 2, 3}',
  treemap: 'treemap-beta\n"Root"\n  "A": 1\n  "B": 2',
};

// Serialise markup through the DOM so attribute quoting and order compare
// equal for equivalent trees.
function normalise(markup: string): string {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.innerHTML;
}

// The result of a source that must render, narrowed to the success shape.
function rendered(source: string) {
  const result = renderMermaid(source);
  if (result.error !== undefined) throw new Error(result.error);
  return result;
}

describe("renderMermaid", () => {
  beforeEach(() => {
    clearMermaidCache();
    vi.mocked(pele.render).mockClear();
  });

  test.each(Object.entries(DIAGRAMS))("renders a %s diagram through Pele", (type, source) => {
    const result = rendered(source);
    expect(result.svg).toMatch(new RegExp(`^<svg[^>]*class="pele pele-${type}"`));
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  test("asks for a fixed-size SVG the canvas can scale", () => {
    const result = rendered(DIAGRAMS.flowchart);
    const svg = normalise(result.svg);
    expect(svg).not.toContain("max-width:100%");
    expect(svg).toContain(`width="${result.width}"`);
    expect(svg).toContain(`viewBox="0 0 ${result.width} ${result.height}"`);
  });

  test("returns the cached result on a second call with the same source", () => {
    const first = renderMermaid(DIAGRAMS.flowchart);
    const second = renderMermaid(DIAGRAMS.flowchart);
    expect(second).toBe(first);
    expect(pele.render).toHaveBeenCalledTimes(1);
  });

  test("renders again when the UI font setting changes, in the new font", () => {
    const root = document.documentElement;
    root.style.setProperty("--ui-font", "Avenir, sans-serif");
    const avenir = renderMermaid(DIAGRAMS.flowchart);
    root.style.setProperty("--ui-font", "Georgia, serif");
    const georgia = renderMermaid(DIAGRAMS.flowchart);
    root.style.removeProperty("--ui-font");
    expect(pele.render).toHaveBeenCalledTimes(2);
    // Pele writes the measured font as the `--pele-font` fallback.
    expect(avenir.svg).toContain("font-family:var(--pele-font,Avenir, sans-serif)");
    expect(georgia.svg).toContain("font-family:var(--pele-font,Georgia, serif)");
  });

  test("returns Pele's message for a syntax error", () => {
    const result = renderMermaid("flowchart TD\n  A --> B -->\n  C[[[ broken");
    expect(result.svg).toBeUndefined();
    expect(result.error).toContain("Parse error on line 3");
    // The message quotes the line and marks the column.
    expect(result.error).toContain("C[[[ broken");
  });

  test("returns an error for a diagram type Pele doesn't know", () => {
    const result = renderMermaid("zenuml\n  Alice->Bob: hi");
    expect(result.error).toBe("No diagram type detected for the given text.");
  });

  test("reports a renderer bug as unexpected and logs it", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(pele.render).mockImplementationOnce(() => {
      throw new TypeError("x is undefined");
    });
    const result = renderMermaid("flowchart TD\n  A --> B");
    expect(result.error).toBe("Unexpected error: x is undefined");
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  test("reports a non-Error throw by its string value", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(pele.render).mockImplementationOnce(() => {
      throw "string error";
    });
    expect(renderMermaid(DIAGRAMS.pie).error).toBe("Unexpected error: string error");
  });

  test("caches errors, so an invalid diagram is parsed and logged once", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(pele.render).mockImplementationOnce(() => {
      throw new TypeError("boom");
    });
    const first = renderMermaid(DIAGRAMS.pie);
    expect(renderMermaid(DIAGRAMS.pie)).toBe(first);
    expect(pele.render).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledOnce();
  });

  test("returns an error for a diagram over Pele's size limit", () => {
    const huge = "flowchart TD\n" + "  A --> B\n".repeat(6000);
    expect(renderMermaid(huge).error).toMatch(/limit/);
  });

  test("leaves click links inert so the webview can't navigate away", () => {
    const result = renderMermaid(
      'flowchart LR\n  A --> B\n  click A "https://example.com" "Open"\n  click B "javascript:alert(1)"',
    );
    expect(result.svg).toBeDefined();
    expect(result.svg).not.toContain("<a");
    expect(result.svg).not.toContain("example.com");
    expect(result.svg).not.toContain("javascript:");
  });

  test("gives different diagrams different accessible-title ids", () => {
    const a = renderMermaid("flowchart LR\n  accTitle: First\n  A --> B");
    const b = renderMermaid("flowchart LR\n  accTitle: Second\n  A --> B");
    const ids = (svg: string) => [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids(a.svg!).length).toBeGreaterThan(0);
    expect(ids(a.svg!).filter((id) => ids(b.svg!).includes(id))).toEqual([]);
  });

  test("drops HTML from labels", () => {
    const result = renderMermaid('flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B');
    const stage = document.createElement("div");
    stage.innerHTML = result.svg!;
    expect(stage.querySelector("img")).toBeNull();
    expect(result.svg).not.toContain("onerror");
  });
});

describe("sanitizeSvg", () => {
  // The sanitiser must not cost a diagram anything: the root `style` holds
  // every `var(--pele-*)` colour and the canvas sizes the SVG from it.
  const EXTRAS: Record<string, string> = {
    "accessible title": "flowchart LR\n  accTitle: T\n  accDescr: D\n  A --> B",
    "rich label": 'flowchart LR\n  A["`**bold** _it_`"] --> B["line<br/>two"]',
    image: 'flowchart LR\n  A@{ img: "https://example.com/a.png", label: "I", w: 60, h: 60 } --> B',
  };

  test.each(Object.entries({ ...DIAGRAMS, ...EXTRAS }))(
    "keeps Pele's %s output intact",
    (_type, source) => {
      const raw = vi.mocked(pele.render).getMockImplementation()!(source, {
        responsive: false,
        links: false,
        idPrefix: "t",
      }).svg;
      expect(normalise(sanitizeSvg(raw))).toBe(normalise(raw));
    },
  );

  test("ignores hooks other code registers on the shared DOMPurify", async () => {
    const { default: shared } = await import("dompurify");
    shared.addHook("afterSanitizeAttributes", (node) => node.setAttribute("data-hooked", ""));
    try {
      expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).not.toContain(
        "data-hooked",
      );
    } finally {
      shared.removeHooks("afterSanitizeAttributes");
    }
  });

  test("strips scripts, event handlers and javascript: links", () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' +
        '<rect onclick="alert(2)" width="1" height="1"/>' +
        '<a href="javascript:alert(3)"><text>x</text></a>' +
        '<foreignObject><div onmouseover="alert(4)">y</div></foreignObject></svg>',
    );
    expect(clean).not.toMatch(/script|onclick|onmouseover|javascript:|foreignObject/i);
    expect(clean).toContain("<rect");
  });
});

describe("Pele theme mapping", () => {
  // Every colour variable Pele reads must be mapped onto the app's tokens,
  // or that part of a diagram keeps Pele's light-theme default in dark mode.
  // Fonts are deliberately unset (see `diagramFonts`); weights, radius and
  // the `mount()`-only error colour keep Pele's defaults.
  const UNMAPPED = new Set([
    "--pele-font",
    "--pele-font-mono",
    "--pele-title-weight",
    "--pele-heading-weight",
    "--pele-bold-weight",
    "--pele-radius",
    "--pele-error",
  ]);

  test("mermaid-canvas.css sets every colour variable the diagrams use", () => {
    const used = new Set<string>();
    for (const source of Object.values(DIAGRAMS)) {
      const svg = vi.mocked(pele.render).getMockImplementation()!(source, {}).svg;
      for (const m of svg.matchAll(/var\((--pele-[a-z0-9-]+)/g)) used.add(m[1]);
    }
    const canvasCss = fs.readFileSync(
      path.join(import.meta.dirname, "../src/components/editor-area/mermaid-canvas.css"),
      "utf8",
    );
    // Declarations inside the `.cm-mermaid-canvas { … }` rule that maps the
    // theme, not mentions in comments or other rules.
    const rule = canvasCss.match(/^\.cm-mermaid-canvas \{([\s\S]*?)^\}/m)?.[1] ?? "";
    const declared = new Set([...rule.matchAll(/^\s*(--pele-[a-z0-9-]+):/gm)].map((m) => m[1]));
    const missing = [...used].filter((v) => !UNMAPPED.has(v) && !declared.has(v));
    expect(used.size).toBeGreaterThan(8);
    expect(missing).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const { MERMAID_CANVAS_HEIGHT, mountMermaidCanvas } =
  await import("../src/components/editor-area/mermaid-canvas");

describe("mermaid canvas frame", () => {
  test("MERMAID_CANVAS_HEIGHT is a positive fixed integer height", () => {
    expect(MERMAID_CANVAS_HEIGHT).toBeGreaterThan(0);
    expect(Number.isInteger(MERMAID_CANVAS_HEIGHT)).toBe(true);
  });

  // jsdom has no layout: give the viewport a size and run frames at once so
  // the fit on first paint happens inside the test.
  function withLayout(width: number, height: number) {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const size = (el: HTMLElement, value: number) =>
      el.classList.contains("cm-mermaid-canvas-viewport") ? value : 0;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return size(this, width);
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return size(this, height);
      },
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("shows an error as text, never as markup", () => {
    const host = document.createElement("div");
    mountMermaidCanvas(host, {
      diagram: { error: 'Parse error: <img src=x onerror="alert(1)">' },
      ariaLabel: "Mermaid diagram",
    });
    const error = host.querySelector(".cm-mermaid-canvas-error");
    expect(error?.getAttribute("role")).toBe("status");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".cm-mermaid-canvas-error-msg")?.textContent).toBe(
      'Parse error: <img src=x onerror="alert(1)">',
    );
  });

  test("mounts the SVG and labels it", () => {
    const host = document.createElement("div");
    mountMermaidCanvas(host, { diagram: renderMermaid(DIAGRAMS.pie), ariaLabel: "Mermaid: pie" });
    const svg = host.querySelector(".cm-mermaid-canvas-stage svg");
    expect(svg?.classList.contains("pele-pie")).toBe(true);
    expect(svg?.getAttribute("aria-label")).toBe("Mermaid: pie");
    expect(host.querySelector(".cm-mermaid-canvas-error")).toBeNull();
  });

  test("keeps a diagram's own accessible title", () => {
    const host = document.createElement("div");
    const diagram = renderMermaid("flowchart LR\n  accTitle: Pipeline\n  A --> B");
    mountMermaidCanvas(host, { diagram, ariaLabel: "Mermaid: flowchart" });
    const svg = host.querySelector("svg")!;
    expect(svg.hasAttribute("aria-label")).toBe(false);
    expect(svg.getAttribute("aria-labelledby")).toMatch(/title/);
  });

  test("switches between an error and a diagram as the source is fixed", () => {
    const host = document.createElement("div");
    const handle = mountMermaidCanvas(host, {
      diagram: renderMermaid("flowchart TD\n  A -->"),
      ariaLabel: "Mermaid diagram",
    });
    expect(host.querySelector(".cm-mermaid-canvas-error")).not.toBeNull();
    handle.updateSource(renderMermaid(DIAGRAMS.flowchart), DIAGRAMS.flowchart);
    expect(host.querySelector(".cm-mermaid-canvas-error")).toBeNull();
    expect(host.querySelector("svg.pele")).not.toBeNull();
    handle.destroy();
  });

  test("fits a diagram too big for the minimum zoom entirely into view", () => {
    withLayout(640, 480);
    const host = document.createElement("div");
    // 0.1 is well below the canvas's minimum zoom (0.25).
    const diagram = { svg: '<svg class="pele"></svg>', width: 4000, height: 4000 };
    mountMermaidCanvas(host, { diagram, ariaLabel: "big" });
    const svg = host.querySelector<SVGSVGElement>("svg")!;
    const shown = parseFloat(svg.style.height);
    expect(shown).toBeLessThanOrEqual(480);
    expect(shown).toBeCloseTo(480 - 32);
  });

  test("scales a small diagram up to fill the frame", () => {
    withLayout(640, 480);
    const host = document.createElement("div");
    const diagram = { svg: '<svg class="pele"></svg>', width: 200, height: 100 };
    mountMermaidCanvas(host, { diagram, ariaLabel: "small" });
    const svg = host.querySelector<SVGSVGElement>("svg")!;
    expect(parseFloat(svg.style.width)).toBeCloseTo(640 - 32);
  });
});

const { EditorState, EditorSelection } = await import("@codemirror/state");
const { markdown } = await import("@codemirror/lang-markdown");
const { GFM } = await import("@lezer/markdown");
const { foldExtension } = await import("../src/lib/prosemark-core/main");
const { mermaidDecorations } = await import("../src/components/editor-area/mermaid-decorations");
const { withFullParse } = await import("./helpers/parsed-state");
const {
  DRAG_END_USER_EVENT,
  buildEndDragDispatch,
  dragFrozenSelectionField,
  startDragEffect,
  endDragEffect,
  rangesTouchInclusive,
  shouldStartDragGate,
} = await import("../src/components/editor-area/drag-selection-gate");

describe("rangesTouchInclusive", () => {
  test("returns true for an overlap with shared boundary", () => {
    expect(rangesTouchInclusive([EditorSelection.range(5, 10)], { from: 10, to: 20 })).toBe(true);
  });

  test("returns true when range fully contains the node", () => {
    expect(rangesTouchInclusive([EditorSelection.range(0, 100)], { from: 10, to: 20 })).toBe(true);
  });

  test("returns false when range is fully before the node", () => {
    expect(rangesTouchInclusive([EditorSelection.range(0, 9)], { from: 10, to: 20 })).toBe(false);
  });

  test("returns false when range is fully after the node", () => {
    expect(rangesTouchInclusive([EditorSelection.range(21, 30)], { from: 10, to: 20 })).toBe(false);
  });

  test("scans every range, returning true if any touches", () => {
    expect(
      rangesTouchInclusive([EditorSelection.range(0, 5), EditorSelection.range(15, 16)], {
        from: 10,
        to: 20,
      }),
    ).toBe(true);
  });
});

describe("dragFrozenSelectionField", () => {
  function makeState() {
    return EditorState.create({
      doc: "hello world",
      extensions: [dragFrozenSelectionField],
    });
  }

  test("starts as null", () => {
    expect(makeState().field(dragFrozenSelectionField)).toBeNull();
  });

  test("startDragEffect snapshots the provided ranges", () => {
    const s0 = makeState();
    const ranges = [EditorSelection.range(2, 5)];
    const s1 = s0.update({ effects: startDragEffect.of(ranges) }).state;
    expect(s1.field(dragFrozenSelectionField)).toEqual(ranges);
  });

  test("endDragEffect clears the snapshot", () => {
    const s0 = makeState();
    const s1 = s0.update({
      effects: startDragEffect.of([EditorSelection.range(2, 5)]),
    }).state;
    const s2 = s1.update({ effects: endDragEffect.of(null) }).state;
    expect(s2.field(dragFrozenSelectionField)).toBeNull();
  });

  test("snapshot maps through doc changes mid-drag", () => {
    const s0 = makeState();
    const s1 = s0.update({
      effects: startDragEffect.of([EditorSelection.range(2, 5)]),
    }).state;
    // Insert 3 chars at offset 0 — frozen ranges should shift forward.
    const s2 = s1.update({ changes: { from: 0, insert: "XXX" } }).state;
    const frozen = s2.field(dragFrozenSelectionField);
    expect(frozen).not.toBeNull();
    expect(frozen![0].from).toBe(5);
    expect(frozen![0].to).toBe(8);
  });

  test("non-effect transactions leave the snapshot unchanged", () => {
    const s0 = makeState();
    const ranges = [EditorSelection.range(2, 5)];
    const s1 = s0.update({ effects: startDragEffect.of(ranges) }).state;
    const s2 = s1.update({ selection: EditorSelection.single(8) }).state;
    expect(s2.field(dragFrozenSelectionField)).toEqual(ranges);
  });
});

// The mermaid canvas now always replaces the entire fence with the rendered
// widget, regardless of selection. Editing happens in a nested CodeMirror
// instance inside the widget, not via selection-driven mode flipping — so
// the decoration kind no longer depends on drag-gate or selection state.
describe("mermaidDecorations always replaces the fence", () => {
  const before = "before\n";
  const fence = "```mermaid\ngraph TD;\n  A-->B;\n```";
  const after = "\nafter";
  const doc = before + fence + after;
  const fenceFrom = before.length;
  const fenceTo = fenceFrom + fence.length;

  function makeState(selection: { anchor: number; head?: number }) {
    return withFullParse(
      EditorState.create({
        doc,
        extensions: [markdown({ extensions: [GFM] }), mermaidDecorations()],
        selection: EditorSelection.single(selection.anchor, selection.head),
      }),
    );
  }

  function fenceDecorationKind(state: ReturnType<typeof makeState>): "replace" | "widget" | "none" {
    const set = state.field(foldExtension);
    let kind: "replace" | "widget" | "none" = "none";
    set.between(0, doc.length, (from, to, deco) => {
      const spec = (deco as unknown as { spec?: { widget?: unknown } }).spec ?? {};
      if (!spec.widget) return undefined;
      if (from === fenceFrom && to === fenceTo) {
        kind = "replace";
        return false;
      }
      if (from === fenceTo && to === fenceTo) {
        kind = "widget";
        return false;
      }
      return undefined;
    });
    return kind;
  }

  test("caret outside fence → replace", () => {
    expect(fenceDecorationKind(makeState({ anchor: 0 }))).toBe("replace");
  });

  test("selection overlapping fence → still replace (no mode flip)", () => {
    expect(fenceDecorationKind(makeState({ anchor: fenceFrom + 5 }))).toBe("replace");
  });

  test("range selection covering whole fence → still replace", () => {
    expect(fenceDecorationKind(makeState({ anchor: fenceTo, head: fenceFrom }))).toBe("replace");
  });

  test("an unclosed fence being typed stays source", () => {
    const typing = "before\n```mermaid\ng";
    const state = withFullParse(
      EditorState.create({
        doc: typing,
        extensions: [markdown({ extensions: [GFM] }), mermaidDecorations()],
        selection: EditorSelection.single(typing.length),
      }),
    );
    let widgets = 0;
    state.field(foldExtension).between(0, typing.length, (_from, _to, deco) => {
      if ((deco as unknown as { spec?: { widget?: unknown } }).spec?.widget) widgets++;
    });
    expect(widgets).toBe(0);
  });
});

describe("Mermaid widget in a live editor", () => {
  async function mount(doc: string) {
    const { EditorView } = await import("@codemirror/view");
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: withFullParse(
        EditorState.create({
          doc,
          extensions: [markdown({ extensions: [GFM] }), mermaidDecorations()],
        }),
      ),
    });
    return { view, cleanup: () => (view.destroy(), parent.remove()) };
  }

  test("renders the fence through Pele and reuses its DOM when the source changes", async () => {
    const fence = "```mermaid\nflowchart LR\n  A --> B\n```";
    const { view, cleanup } = await mount(`intro\n${fence}\noutro`);
    const widget = view.dom.querySelector(".cm-mermaid-widget");
    expect(widget?.querySelector("svg.pele-flowchart")).not.toBeNull();

    // An outside edit to the body (undo, another cursor): the widget isn't
    // `eq` any more, `updateDOM` keeps the wrapper and swaps the diagram.
    const bodyFrom = view.state.doc.toString().indexOf("flowchart");
    view.dispatch({
      changes: {
        from: bodyFrom,
        to: bodyFrom + "flowchart LR\n  A --> B".length,
        insert: 'pie\n  "A" : 1',
      },
    });
    const after = view.dom.querySelector(".cm-mermaid-widget");
    expect(after).toBe(widget);
    expect(after?.querySelector("svg.pele-pie")).not.toBeNull();

    // Breaking the diagram shows the error in the same frame.
    const pieFrom = view.state.doc.toString().indexOf("pie");
    view.dispatch({ changes: { from: pieFrom, to: pieFrom + 3, insert: "nonsense" } });
    expect(after?.querySelector(".cm-mermaid-canvas-error")).not.toBeNull();
    cleanup();
  });
});

describe("openMermaidFullscreen", () => {
  test("opens on an invalid diagram with the error, and Escape closes it", async () => {
    const { openMermaidFullscreen } =
      await import("../src/components/editor-area/mermaid-fullscreen");
    openMermaidFullscreen("flowchart TD\n  A -->", "Mermaid diagram");
    const overlay = document.querySelector(".cm-mermaid-fullscreen");
    expect(overlay?.querySelector(".cm-mermaid-canvas-error")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(overlay?.classList.contains("is-open")).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(document.querySelector(".cm-mermaid-fullscreen")).toBeNull();
  });
});

describe("shouldStartDragGate", () => {
  function makeState() {
    return EditorState.create({
      doc: "hello world",
      extensions: [dragFrozenSelectionField],
    });
  }

  // Minimal stand-in for a non-widget click target. We don't need a full DOM —
  // shouldStartDragGate only calls `closest()` which we can stub.
  const NON_WIDGET_TARGET = {
    closest: (sel: string) => (sel === ".cm-mermaid-widget" ? null : null),
  } as unknown as Element;

  // Element-like with closest('.cm-mermaid-widget') returning a truthy node —
  // simulates a click that originated inside a mermaid widget (canvas pan,
  // Edit-code button, Preview button).
  const WIDGET_TARGET = {
    closest: (sel: string) => (sel === ".cm-mermaid-widget" ? ({} as Element) : null),
  } as unknown as Element;

  test("returns dispatch with startDragEffect for primary button + non-widget target", () => {
    const dispatch = shouldStartDragGate(makeState(), {
      isPrimary: true,
      button: 0,
      target: NON_WIDGET_TARGET,
    });
    expect(dispatch).not.toBeNull();
    expect(dispatch!.effects).toBeDefined();
  });

  test("skips non-primary pointer (isPrimary=false)", () => {
    expect(
      shouldStartDragGate(makeState(), {
        isPrimary: false,
        button: 0,
        target: NON_WIDGET_TARGET,
      }),
    ).toBeNull();
  });

  test("skips non-left button (button=2 right click)", () => {
    expect(
      shouldStartDragGate(makeState(), {
        isPrimary: true,
        button: 2,
        target: NON_WIDGET_TARGET,
      }),
    ).toBeNull();
  });

  test("skips middle-click (button=1 — autoscroll path)", () => {
    expect(
      shouldStartDragGate(makeState(), {
        isPrimary: true,
        button: 1,
        target: NON_WIDGET_TARGET,
      }),
    ).toBeNull();
  });

  test("skips when target is inside .cm-mermaid-widget (canvas pan / button click)", () => {
    expect(
      shouldStartDragGate(makeState(), {
        isPrimary: true,
        button: 0,
        target: WIDGET_TARGET,
      }),
    ).toBeNull();
  });

  test("skips when gate is already active (idempotent re-entry)", () => {
    const s0 = makeState();
    const s1 = s0.update({
      effects: startDragEffect.of([EditorSelection.range(0, 0)]),
    }).state;
    expect(
      shouldStartDragGate(s1, { isPrimary: true, button: 0, target: NON_WIDGET_TARGET }),
    ).toBeNull();
  });

  test("handles non-Element target gracefully (e.g., text node)", () => {
    // PointerEvent.target can be any EventTarget; only Elements have closest().
    // The instanceof check should let a non-Element through to the gate-active
    // check rather than throwing.
    const dispatch = shouldStartDragGate(makeState(), {
      isPrimary: true,
      button: 0,
      target: {
        /* not an Element */
      } as EventTarget,
    });
    expect(dispatch).not.toBeNull();
  });
});

describe("buildEndDragDispatch", () => {
  function makeState() {
    return EditorState.create({
      doc: "hello world",
      extensions: [dragFrozenSelectionField],
    });
  }

  test("returns null when gate is inactive (idempotent — pointerup/cancel/blur all fire)", () => {
    expect(buildEndDragDispatch(makeState())).toBeNull();
  });

  test("returns dispatch with endDragEffect + selection nudge + userEvent tag when gate active", () => {
    const s0 = makeState();
    const s1 = s0.update({
      effects: startDragEffect.of([EditorSelection.range(0, 0)]),
    }).state;
    const dispatch = buildEndDragDispatch(s1);
    expect(dispatch).not.toBeNull();
    expect(dispatch!.selection).toBe(s1.selection);
    expect(dispatch!.userEvent).toBe(DRAG_END_USER_EVENT);
  });

  test("DRAG_END_USER_EVENT is a 'select' sub-event (consumers can opt out)", () => {
    // The tag is hierarchical: tr.isUserEvent("select") matches it (so
    // generic select-listeners still fire), but tr.isUserEvent("select.pointer.drag-end")
    // distinguishes the no-op nudge from a real user-driven select.
    expect(DRAG_END_USER_EVENT.startsWith("select.")).toBe(true);
  });
});

describe("end-drag dispatch is one-shot (no loop)", () => {
  test("buildEndDragDispatch returns null on the state produced by a prior endDrag", () => {
    const s0 = EditorState.create({
      doc: "hello world",
      extensions: [dragFrozenSelectionField],
    });
    const s1 = s0.update({
      effects: startDragEffect.of([EditorSelection.range(0, 0)]),
    }).state;
    const first = buildEndDragDispatch(s1);
    expect(first).not.toBeNull();

    // Apply the dispatch; the field is now null.
    const s2 = s1.update({
      selection: first!.selection,
      effects: first!.effects,
    }).state;
    expect(s2.field(dragFrozenSelectionField)).toBeNull();

    // Re-running the builder against s2 must short-circuit. This is what
    // protects pointerup → endDrag dispatch → (would-be) pointerup loop.
    expect(buildEndDragDispatch(s2)).toBeNull();
  });
});
