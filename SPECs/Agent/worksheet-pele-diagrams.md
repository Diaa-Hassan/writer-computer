# Worksheet: Pele diagrams

- TODO: "Render Mermaid diagrams with Pele instead of beautiful-mermaid" (TODOS.md, Done).
- Spec: [`SPECs/pele-diagrams-spec.md`](../pele-diagrams-spec.md). QA: [`pele-qa-2026-10-17/README.md`](./pele-qa-2026-10-17/README.md).
- Branch `feature/pele-diagrams` from master `6ca6d21`.

## Read

- docs/editor.md, docs/consolidation.md, docs/vite-plus.md, docs/workflows/agent-loop.md, agent-review.md.
- Mermaid stack: `mermaid-renderer.ts`, `mermaid-decorations.ts`, `mermaid-canvas.ts` / `.css`, `mermaid-fullscreen.ts`, `drag-selection-gate.ts` (unchanged: it keys on `.cm-mermaid-widget`), `editor-extensions.ts` (unchanged), `lib/lru.ts`, `tests/mermaid.test.ts`.
- `lib/theme.ts` and `shared/settings.schema.json`: `--ui-font` / `--mono-font` are settings pushed onto the root's inline style, which is why the renderer reads them there.
- `html-block-decorations.ts`: registers a global DOMPurify hook; the renderer uses its own instance.
- Pele docs: pele.run api, theming, compatibility, security (`.md` variants); Pele's dist for the measurer and SVG shape.
- No `mermaid` npm package was left anywhere; README and website copy say "Mermaid" but never named beautiful-mermaid.

## Findings that shaped the design

- Pele's SVG root carries `--_x: var(--pele-x, default)` in an inline style and no `<style>` element, so CSS variables on an ancestor recolour it with no re-render.
- `fontFamily` becomes the fallback in `font-family: var(--pele-font, …)`: leave `--pele-font` unset so painted = measured.
- `responsive: true` adds `max-width:100%`; the canvas needs the fixed size.
- DOMPurify's SVG profile drops only `role` from Pele output across all 22 types (checked by walking the parsed trees).
- `PeleError` has `code` / `line` / `column`, and its message already includes the snippet.
- master renders 6 of 22 types; its "invalid" flowchart draws a wrong diagram silently.

## Steps and results

1. `93cde62`: Pele renderer, CSS theme mapping, canvas takes renderer result, error state, fit below the zoom floor, keywords, jsdom tests, playground tokens and `?dark`.
2. Reviews (Editor, QA/security; fresh-context sub-agents): no P0/P1. P2 style recalc and output limit, P3 error caching, alert role, fit floor, DOMPurify hook coupling, coverage gaps: all addressed in `a78608b`.
3. VM QA of the built app (flows A–E), comparison with master in the playground: the XY chart regression fixed in `f5b7783`. Harness problems recorded in the QA report.
4. Validation: `vp check` (0 errors; the 1 warning is in untouched `e2e/wdio.conf.js`), `vp test` 766 passed. No Rust changed.
