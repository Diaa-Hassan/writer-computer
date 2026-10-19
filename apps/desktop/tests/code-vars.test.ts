import { describe, expect, test } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { prosemarkMarkdownSyntaxExtensions } from "../src/lib/prosemark-core/main";
import { withFullParse } from "./helpers/parsed-state";
import {
  formatVarValue,
  noteVars,
  parseVarValue,
  parseVarsBlock,
  varsFromFrontmatter,
} from "../src/components/editor-area/code-vars";
import { varReferences } from "../src/components/editor-area/code-vars-decorations";

const state = (doc: string) =>
  withFullParse(
    EditorState.create({
      doc,
      extensions: [markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] })],
    }),
  );

describe("parseVarValue", () => {
  test("infers numbers, booleans, null, quoted strings and JSON", () => {
    expect(parseVarValue("8080")).toBe(8080);
    expect(parseVarValue("-2.5e3")).toBe(-2500);
    expect(parseVarValue("true")).toBe(true);
    expect(parseVarValue("null")).toBeNull();
    expect(parseVarValue('"a \\"b\\""')).toBe('a "b"');
    expect(parseVarValue("'single'")).toBe("single");
    expect(parseVarValue('["a", 1]')).toEqual(["a", 1]);
    expect(parseVarValue("{not json")).toBe("{not json");
    expect(parseVarValue("  https://api.example.com  ")).toBe("https://api.example.com");
  });

  test("type hints win and say what's wrong", () => {
    expect(parseVarValue("8080", "str")).toBe("8080");
    expect(parseVarValue("yes", "bool")).toBe(true);
    expect(parseVarValue("1.5", "float")).toBe(1.5);
    expect(() => parseVarValue("1.5", "int")).toThrow("isn't a whole number");
    expect(() => parseVarValue("x", "date")).toThrow('unknown type "date"');
  });
});

describe("parseVarsBlock", () => {
  test("reads name = value lines, skips comments, reports bad lines", () => {
    const { vars, errors } = parseVarsBlock(
      "# service\nport = 8080\nhost:str = localhost\n\nbad line\nretries:int = many\n",
    );
    expect(vars).toEqual({ port: 8080, host: "localhost" });
    expect(errors).toEqual([
      "line 5: expected name = value",
      'line 6: retries: "many" isn\'t a whole number',
    ]);
  });
});

describe("varsFromFrontmatter", () => {
  test("takes the vars map, keeps YAML types, drops invalid names", () => {
    expect(
      varsFromFrontmatter("title: X\nvars:\n  port: 8080\n  env: prod\n  bad-name: 1"),
    ).toEqual({
      port: 8080,
      env: "prod",
    });
    expect(varsFromFrontmatter("title: X")).toEqual({});
    expect(varsFromFrontmatter("vars: [1, 2]")).toEqual({});
    expect(varsFromFrontmatter(": : :")).toEqual({});
    expect(varsFromFrontmatter(null)).toEqual({});
  });
});

describe("noteVars", () => {
  test("frontmatter first, then vars blocks top to bottom", () => {
    const doc = "```vars\nport = 1\nhost = a\n```\n\ntext\n\n```vars\nport = 2\n```";
    expect(noteVars(state(doc), "vars:\n  port: 0\n  env: prod")).toEqual({
      port: 2,
      host: "a",
      env: "prod",
    });
  });
});

describe("varReferences", () => {
  const vars = { port: 8080, host: "api" };
  const names = (doc: string) => varReferences(state(doc), vars).map((r) => [r.name, r.from, r.to]);

  test("finds declared {{names}} in prose, spaces allowed inside", () => {
    expect(names("Serve on {{port}} at {{ host }}.")).toEqual([
      ["port", 9, 17],
      ["host", 21, 31],
    ]);
  });

  test("two references on a line aren't taken for math", () => {
    expect(names("Deploy to {{host}} on port {{port}} ($5 each).").map((n) => n[0])).toEqual([
      "host",
      "port",
    ]);
  });

  test("leaves undeclared names, escapes, $name, code and math alone", () => {
    expect(names("{{unknown}} and \\{{port}} and $port")).toEqual([]);
    expect(names("`{{port}}` and\n\n```bash\necho {{port}}\n```")).toEqual([]);
    expect(names("Math $x + {{port}}$ here")).toEqual([]);
  });

  test("formatVarValue shows strings bare and the rest as JSON", () => {
    expect(formatVarValue("api")).toBe("api");
    expect(formatVarValue([1, "a"])).toBe('[1,"a"]');
    expect(formatVarValue(true)).toBe("true");
  });
});
