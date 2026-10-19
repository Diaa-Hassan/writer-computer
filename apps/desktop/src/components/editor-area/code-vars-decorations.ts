import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { useEditorStore } from "@/stores/editor-store";
import { formatVarValue, noteVars, type VarValue } from "./code-vars";

/**
 * `{{name}}` in prose shows the declared variable's value as a chip (only
 * for names the note declares, never inside code, math, links or HTML). The
 * caret on a chip shows the `{{name}}` source again. Not `$name`: Writer's
 * inline math is `$…$`, and its lenient parser would read two `$name`s on a
 * line as a formula.
 */

// Text that `$name` must not be replaced in.
const SKIP_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "CodeText",
  "Math",
  "InlineMath",
  "BlockMath",
  "URL",
  "Autolink",
  "HTMLBlock",
  "HTMLTag",
  "Comment",
  "CommentBlock",
  "LinkLabel",
]);

// `{{ name }}`; the character before is captured (older WebKit has no
// lookbehind) so a backslash can escape it: `\{{name}}` stays as typed.
const VAR_REF = /(^|[^\\])\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const frontmatterFacet = Facet.define<() => string | null, () => string | null>({
  combine: (values) => values[0] ?? (() => null),
});

const varsRefresh = StateEffect.define<null>();

class VarChipWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly display: string,
  ) {
    super();
  }

  eq(other: VarChipWidget): boolean {
    return other.name === this.name && other.display === this.display;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "cm-code-var";
    chip.textContent = this.display;
    chip.title = `{{${this.name}}} = ${this.display}`;
    chip.setAttribute("aria-label", `${this.name}: ${this.display}`);
    return chip;
  }
}

function insideSkipped(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent!) {
    if (SKIP_NODES.has(node.name)) return true;
    if (!node.parent) break;
  }
  return false;
}

/** Ranges of `{{name}}` references to declared variables, with values. */
export function varReferences(
  state: EditorState,
  vars: Record<string, VarValue>,
): { from: number; to: number; name: string; value: VarValue }[] {
  if (Object.keys(vars).length === 0) return [];
  const text = state.doc.toString();
  const found = [];
  for (const match of text.matchAll(VAR_REF)) {
    const name = match[2];
    if (!Object.prototype.hasOwnProperty.call(vars, name)) continue;
    const from = match.index + match[1].length;
    const to = match.index + match[0].length;
    if (insideSkipped(state, from)) continue;
    found.push({ from, to, name, value: vars[name] });
  }
  return found;
}

type VarRef = ReturnType<typeof varReferences>[number];

interface Chips {
  refs: VarRef[];
  decorations: DecorationSet;
}

/** Hide the references the caret isn't on behind chips. */
function decorate(state: EditorState, refs: VarRef[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const ref of refs) {
    // Caret on or next to it: show the source so it can be edited.
    const touched = state.selection.ranges.some((r) => r.from <= ref.to && r.to >= ref.from);
    if (touched) continue;
    const widget = new VarChipWidget(ref.name, formatVarValue(ref.value));
    ranges.push(Decoration.replace({ widget }).range(ref.from, ref.to));
  }
  return Decoration.set(ranges, true);
}

function build(state: EditorState): Chips {
  const refs = varReferences(state, noteVars(state, state.facet(frontmatterFacet)()));
  return { refs, decorations: decorate(state, refs) };
}

// References are found again only when the text, parse or frontmatter
// changes; a caret move just re-decides which chips to show.
const chipsField = StateField.define<Chips>({
  create: build,
  update(chips, tr) {
    if (
      tr.docChanged ||
      tr.effects.some((e) => e.is(varsRefresh)) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    ) {
      return build(tr.state);
    }
    if (tr.selection) return { refs: chips.refs, decorations: decorate(tr.state, chips.refs) };
    return chips;
  },
  provide: (field) => EditorView.decorations.from(field, (chips) => chips.decorations),
});

/** Frontmatter lives in the editor store, not the document: refresh the
 *  chips when this note's frontmatter changes. */
function frontmatterSync(getFilePath: () => string) {
  return ViewPlugin.define((view) => {
    const unsubscribe = useEditorStore.subscribe((state, prev) => {
      const path = getFilePath();
      if (state.openFiles.get(path)?.frontmatter === prev.openFiles.get(path)?.frontmatter) return;
      view.dispatch({ effects: varsRefresh.of(null) });
    });
    return { destroy: unsubscribe };
  });
}

export function noteFrontmatter(getFilePath: () => string): string | null {
  return useEditorStore.getState().openFiles.get(getFilePath())?.frontmatter ?? null;
}

export function codeVarsExtension(getFilePath: () => string): Extension {
  return [
    frontmatterFacet.of(() => noteFrontmatter(getFilePath)),
    chipsField,
    frontmatterSync(getFilePath),
  ];
}
