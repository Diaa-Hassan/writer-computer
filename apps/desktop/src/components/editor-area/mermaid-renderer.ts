import { PeleError, render } from "pele";
import DOMPurify from "dompurify";
import { LruCache } from "@/lib/lru";

export interface RenderResult {
  // Sanitised `<svg class="pele …">` markup, safe for `innerHTML`.
  svg: string;
  // Natural size of the diagram in CSS pixels.
  width: number;
  height: number;
  error?: undefined;
}

export interface RenderError {
  svg?: undefined;
  // Plain text (it can contain diagram source): display with `textContent`.
  error: string;
}

const svgCache = new LruCache<RenderResult>(50);

// Pele measures labels with a canvas in the font it is given and writes that
// font into the SVG as the fallback of `font-family: var(--pele-font, …)`.
// The theme leaves `--pele-font` unset, so a diagram always paints in the font
// it was measured in. Diagrams use the UI font settings (`--ui-font`,
// `--mono-font`), read when rendering and part of the cache key: after a font
// change, new renders use the new font and SVGs already on screen keep a
// consistent old one until they re-render.
function diagramFonts(): { fontFamily?: string; fontFamilyMono?: string } {
  if (typeof document === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  return {
    fontFamily: style.getPropertyValue("--ui-font").trim() || undefined,
    fontFamilyMono: style.getPropertyValue("--mono-font").trim() || undefined,
  };
}

const RENDER_OPTIONS = {
  // The canvas sizes the SVG itself for pan/zoom, so ask for the fixed pixel
  // size instead of `max-width: 100%` and keep the layout independent of the
  // widget width (no `maxWidth`, so no automatic switch to a vertical layout).
  responsive: false,
  // A link in the SVG would navigate the app's webview away from the editor,
  // and a click is how the canvas starts a pan. Diagram links stay inert text.
  links: false,
} as const;

// Pele escapes label text, strips HTML from labels, filters styles, links and
// images, and its SVG carries no scripts or event handlers. Notes still come
// from outside the app (vaults, repos) and the library only reached 1.0 in
// October 2026, so the SVG also passes through DOMPurify before it is cached:
// the cache is the only producer of the markup the canvas puts in
// `innerHTML`, and sanitising once per source keeps it off the scroll path.
// `tests/mermaid.test.ts` checks the sanitiser leaves Pele's output for every
// diagram type unchanged.
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // In DOMPurify's HTML list, not its SVG one. Pele's root carries
    // `role="graphics-document document"` for assistive tech.
    ADD_ATTR: ["role"],
  });
}

// Unique per source so two diagrams on a page never share the `id`s Pele
// gives an accessible title and description (`accTitle` / `accDescr`).
function idPrefix(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `pele-${(hash >>> 0).toString(36)}`;
}

// Synchronous on purpose: Pele renders synchronously and the cache makes
// repeat renders O(map lookup). Calling this from `toDOM` lets the widget
// paint with its rendered SVG in the same frame the wrapper enters the DOM —
// there's no async gap that can leave the user stuck on a placeholder.
export function renderMermaid(source: string): RenderResult | RenderError {
  const fonts = diagramFonts();
  const key = `${fonts.fontFamily}\0${fonts.fontFamilyMono}\0${source}`;
  const cached = svgCache.get(key);
  if (cached !== undefined) return cached;

  let rendered: ReturnType<typeof render>;
  try {
    rendered = render(source, { ...RENDER_OPTIONS, ...fonts, idPrefix: idPrefix(source) });
  } catch (err) {
    if (err instanceof PeleError) return { error: err.message };
    // Not a problem with the diagram: a bug in the renderer. Surface it in
    // the console as well as in the widget, which must not take the editor
    // down with it.
    console.error("Mermaid diagram failed to render", err);
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Unexpected error: ${message}` };
  }

  const result: RenderResult = {
    svg: sanitizeSvg(rendered.svg),
    width: rendered.width,
    height: rendered.height,
  };
  svgCache.set(key, result);
  return result;
}

export function clearMermaidCache() {
  svgCache.clear();
}
