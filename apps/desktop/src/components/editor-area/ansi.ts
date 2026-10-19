/**
 * Terminal output → styled segments, for the code-run output tray.
 *
 * SGR sequences (`ESC [ … m`: colours, bold, dim, italic, underline,
 * inverse) become styles; every other escape (cursor moves, line clears,
 * OSC titles and links) is dropped. Style carries across chunks, and an
 * escape cut off at the end of a chunk is handed back to prepend to the next.
 */

/** 0–15: the theme's terminal palette. Otherwise a CSS `rgb()` colour. */
export type AnsiColor = number | string;

export interface AnsiStyle {
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

export const plainStyle = (): AnsiStyle => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
});

// CSI (group 1: parameters, group 2: final byte), OSC, and two-byte escapes.
const ESCAPE_SOURCE =
  "\\x1b\\[([0-?]*)[ -/]*([@-~])|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[@-Z\\\\-_]";
const ESCAPE_AT_START = new RegExp(`^(?:${ESCAPE_SOURCE})`);
// A held-back tail longer than this isn't an escape sequence; let it through.
const MAX_HELD_ESCAPE = 256;

const CUBE = [0, 95, 135, 175, 215, 255];

/** xterm 256-colour index → palette slot (0–15) or `rgb()`. */
function color256(n: number): AnsiColor | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return n;
  if (n < 232) {
    const i = n - 16;
    return `rgb(${CUBE[Math.floor(i / 36)]}, ${CUBE[Math.floor(i / 6) % 6]}, ${CUBE[i % 6]})`;
  }
  const level = 8 + (n - 232) * 10;
  return `rgb(${level}, ${level}, ${level})`;
}

const channel = (n: number | undefined) =>
  Math.min(255, Math.max(0, Math.round(Number.isFinite(n) ? (n as number) : 0)));

/** Apply one SGR parameter list (`"1;38;5;208"`) to a style. */
export function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const next = { ...style };
  // `:` sub-parameters (`38:2::255:0:0`) are read like `;` ones, minus the
  // empty colour-space slot.
  const codes = (params === "" ? "0" : params)
    .replace(/:(?=:)/g, "")
    .split(/[;:]/)
    .map((p) => (p === "" ? 0 : Number(p)));
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) Object.assign(next, plainStyle());
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) next.bold = next.dim = false;
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      let color: AnsiColor | null = null;
      if (codes[i + 1] === 5) {
        color = color256(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2) {
        color = `rgb(${channel(codes[i + 2])}, ${channel(codes[i + 3])}, ${channel(codes[i + 4])})`;
        i += 4;
      }
      if (color !== null) next[code === 38 ? "fg" : "bg"] = color;
    }
  }
  return next;
}

const sameStyle = (a: AnsiStyle, b: AnsiStyle) =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  a.bold === b.bold &&
  a.dim === b.dim &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.inverse === b.inverse;

/**
 * Split `input` into styled segments, starting from `style`. Returns the style
 * in effect at the end (to continue from) and any trailing partial escape.
 */
export function parseAnsi(
  input: string,
  style: AnsiStyle,
): { segments: AnsiSegment[]; style: AnsiStyle; rest: string } {
  let text = input;
  let rest = "";
  const cut = text.lastIndexOf("\x1b");
  if (
    cut !== -1 &&
    text.length - cut <= MAX_HELD_ESCAPE &&
    !ESCAPE_AT_START.test(text.slice(cut))
  ) {
    rest = text.slice(cut);
    text = text.slice(0, cut);
  }

  const segments: AnsiSegment[] = [];
  const push = (raw: string, at: AnsiStyle) => {
    // An ESC that starts no recognised sequence would render as a stray
    // control character.
    const piece = raw.split("\x1b").join("");
    if (!piece) return;
    const last = segments[segments.length - 1];
    if (last && sameStyle(last.style, at)) last.text += piece;
    else segments.push({ text: piece, style: at });
  };

  let current = style;
  let from = 0;
  for (const match of text.matchAll(new RegExp(ESCAPE_SOURCE, "g"))) {
    push(text.slice(from, match.index), current);
    if (match[2] === "m") current = applySgr(current, match[1] ?? "");
    from = match.index + match[0].length;
  }
  push(text.slice(from), current);
  return { segments, style: current, rest };
}

const paletteVar = (color: AnsiColor) =>
  typeof color === "number" ? `var(--ansi-${color})` : color;

/** Class names and inline CSS for a segment's style. */
export function segmentCss(style: AnsiStyle): { className: string; css: string } {
  let fg = style.fg === null ? null : paletteVar(style.fg);
  let bg = style.bg === null ? null : paletteVar(style.bg);
  if (style.inverse) {
    [fg, bg] = [bg ?? "var(--ansi-inverse-fg)", fg ?? "var(--ansi-inverse-bg)"];
  }
  const classes = [
    style.bold && "cm-ansi-bold",
    style.dim && "cm-ansi-dim",
    style.italic && "cm-ansi-italic",
    style.underline && "cm-ansi-underline",
  ].filter(Boolean);
  const css = [fg && `color: ${fg}`, bg && `background-color: ${bg}`].filter(Boolean).join("; ");
  return { className: classes.join(" "), css };
}
