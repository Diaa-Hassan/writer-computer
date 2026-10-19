import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { parse as parseYaml } from "yaml";

/**
 * Note variables: declared in ```vars blocks (`port = 8080`) and in the
 * frontmatter's `vars:` map, sent with every code run (environment variables
 * everywhere, typed values in Python sessions) and shown inline as `{{name}}`.
 */

export type VarValue = string | number | boolean | null | VarValue[] | { [key: string]: VarValue };

export const VARS_LANG = "vars";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INT = /^-?\d+$/;
const FLOAT = /^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

export const isVarName = (name: string) => NAME.test(name);

/** A raw value, typed: `name:type = value` hints win (str, int, float, bool,
 *  json); otherwise numbers, true/false, null, quoted strings and JSON lists
 *  or objects are recognised, and anything else is the text itself. */
export function parseVarValue(raw: string, hint?: string): VarValue {
  const text = raw.trim();
  const unquoted = () => {
    if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return JSON.parse(text) as string;
    if (/^'.*'$/.test(text)) return text.slice(1, -1);
    return text;
  };
  switch (hint) {
    case "str":
      return unquoted();
    case "int": {
      if (!INT.test(text)) throw new Error(`"${text}" isn't a whole number`);
      return Number(text);
    }
    case "float": {
      if (!FLOAT.test(text)) throw new Error(`"${text}" isn't a number`);
      return Number(text);
    }
    case "bool": {
      if (/^(true|yes|1)$/i.test(text)) return true;
      if (/^(false|no|0)$/i.test(text)) return false;
      throw new Error(`"${text}" isn't true or false`);
    }
    case "json":
      return JSON.parse(text) as VarValue;
    case undefined:
      break;
    default:
      throw new Error(`unknown type "${hint}" (use str, int, float, bool or json)`);
  }
  if (INT.test(text) || FLOAT.test(text)) return Number(text);
  if (text === "true" || text === "false") return text === "true";
  if (text === "null") return null;
  if (/^[[{]/.test(text)) {
    try {
      return JSON.parse(text) as VarValue;
    } catch {
      return text;
    }
  }
  return unquoted();
}

/** Parse a vars block: one `name = value` (or `name:type = value`) per line;
 *  blank lines and `#` comments are skipped. Bad lines are reported, the rest
 *  still count. */
export function parseVarsBlock(source: string): {
  vars: Record<string, VarValue>;
  errors: string[];
} {
  const vars: Record<string, VarValue> = {};
  const errors: string[] = [];
  source.split("\n").forEach((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([a-z]+))?\s*=\s*(.*)$/.exec(text);
    if (!match) {
      errors.push(`line ${index + 1}: expected name = value`);
      return;
    }
    const [, name, hint, raw] = match;
    try {
      vars[name] = parseVarValue(raw, hint);
    } catch (err) {
      errors.push(
        `line ${index + 1}: ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  return { vars, errors };
}

/** The frontmatter's `vars:` map (invalid names and unparsable YAML ignored). */
export function varsFromFrontmatter(frontmatter: string | null): Record<string, VarValue> {
  if (!frontmatter) return {};
  let data: unknown;
  try {
    data = parseYaml(frontmatter);
  } catch {
    return {};
  }
  const declared = (data as { vars?: unknown } | null)?.vars;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return {};
  return Object.fromEntries(
    Object.entries(declared as Record<string, VarValue>).filter(([name]) => isVarName(name)),
  );
}

/** Every variable the note declares: frontmatter first, then each vars block
 *  from top to bottom (a later one overrides). */
export function noteVars(state: EditorState, frontmatter: string | null): Record<string, VarValue> {
  const vars = { ...varsFromFrontmatter(frontmatter) };
  const tree = ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state);
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== "FencedCode") return;
      const info = ref.node.getChild("CodeInfo");
      const lang = info ? state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] : "";
      if (lang?.toLowerCase() !== VARS_LANG) return false;
      let source = "";
      for (let child = ref.node.firstChild; child; child = child.nextSibling) {
        if (child.name === "CodeText") source += state.doc.sliceString(child.from, child.to);
      }
      Object.assign(vars, parseVarsBlock(source).vars);
      return false;
    },
  });
  return vars;
}

/** How a value reads inline: strings bare, everything else as JSON. */
export function formatVarValue(value: VarValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
