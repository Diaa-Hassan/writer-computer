import { describe, expect, test } from "vite-plus/test";
import { applySgr, parseAnsi, plainStyle, segmentCss } from "../src/components/editor-area/ansi";

const texts = (input: string) =>
  parseAnsi(input, plainStyle()).segments.map((s) => [s.text, s.style.fg, s.style.bold]);

describe("parseAnsi", () => {
  test("splits text by colour and resets", () => {
    expect(texts("plain \x1b[31mred\x1b[0m \x1b[1;92mbold green\x1b[m end")).toEqual([
      ["plain ", null, false],
      ["red", 1, false],
      [" ", null, false],
      ["bold green", 10, true],
      [" end", null, false],
    ]);
  });

  test("drops escapes that aren't SGR (cursor, line clear, OSC title and link)", () => {
    const { segments } = parseAnsi(
      "a\x1b[2K\x1b[1Gb\x1b]0;title\x07c\x1b]8;;https://x\x1b\\d",
      plainStyle(),
    );
    expect(segments.map((s) => s.text).join("")).toBe("abcd");
  });

  test("carries style and a cut-off escape across chunks", () => {
    const first = parseAnsi("ok \x1b[3", plainStyle());
    expect(first.rest).toBe("\x1b[3");
    expect(first.segments.map((s) => s.text)).toEqual(["ok "]);
    const second = parseAnsi(`${first.rest}4mblue`, first.style);
    expect(second.segments).toEqual([{ text: "blue", style: { ...plainStyle(), fg: 4 } }]);
    // Style left open at the end of a chunk applies to the next one.
    const third = parseAnsi("still blue", second.style);
    expect(third.segments[0].style.fg).toBe(4);
  });

  test("passes a long tail with a stray ESC through, minus the ESC", () => {
    const { segments, rest } = parseAnsi(`\x1b${"x".repeat(300)}`, plainStyle());
    expect(rest).toBe("");
    expect(segments.map((s) => s.text).join("")).toBe("x".repeat(300));
  });
});

describe("applySgr", () => {
  test("256-colour and truecolor", () => {
    expect(applySgr(plainStyle(), "38;5;9").fg).toBe(9);
    expect(applySgr(plainStyle(), "38;5;196").fg).toBe("rgb(255, 0, 0)");
    expect(applySgr(plainStyle(), "48;5;244").bg).toBe("rgb(128, 128, 128)");
    expect(applySgr(plainStyle(), "38;2;255;128;0").fg).toBe("rgb(255, 128, 0)");
    expect(applySgr(plainStyle(), "38:2::10:20:30").fg).toBe("rgb(10, 20, 30)");
    expect(applySgr(plainStyle(), "38;2;999;-5;x").fg).toBe("rgb(255, 0, 0)");
  });

  test("attributes turn on and off independently", () => {
    let style = applySgr(plainStyle(), "1;2;3;4;7");
    expect(style).toMatchObject({
      bold: true,
      dim: true,
      italic: true,
      underline: true,
      inverse: true,
    });
    style = applySgr(style, "22;23;24;27");
    expect(style).toEqual(plainStyle());
    expect(applySgr(applySgr(plainStyle(), "31;44"), "39;49")).toEqual(plainStyle());
  });
});

describe("segmentCss", () => {
  test("palette colours use theme variables, others go inline", () => {
    expect(segmentCss({ ...plainStyle(), fg: 2, bold: true })).toEqual({
      className: "cm-ansi-bold",
      css: "color: var(--ansi-2)",
    });
    expect(segmentCss({ ...plainStyle(), bg: "rgb(1, 2, 3)" }).css).toBe(
      "background-color: rgb(1, 2, 3)",
    );
  });

  test("inverse swaps colours, defaulting to the page's", () => {
    expect(segmentCss({ ...plainStyle(), inverse: true }).css).toBe(
      "color: var(--ansi-inverse-fg); background-color: var(--ansi-inverse-bg)",
    );
    expect(segmentCss({ ...plainStyle(), fg: 1, inverse: true }).css).toBe(
      "color: var(--ansi-inverse-fg); background-color: var(--ansi-1)",
    );
  });
});
