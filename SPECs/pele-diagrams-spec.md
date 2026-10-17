# Pele Diagrams Spec

## Summary

Replace the Mermaid renderer, `beautiful-mermaid`, with [Pele](https://pele.run) (npm `pele`, MIT, zero dependencies, source at github.com/obsidianmd/pele). Pele renders Mermaid syntax to SVG synchronously and themes it with CSS variables. beautiful-mermaid drew six diagram types (flowchart, sequence, class, state, ER, XY chart) and showed "Invalid mermaid header" for everything else; Pele draws every type built into Mermaid 12.1.0.

The user-facing widget is unchanged: a fixed-height canvas with pan and zoom, the Edit code panel, fullscreen, and drag-selection that doesn't flip the widget mid-drag (see [`mermaid-canvas-widget-spec.md`](./mermaid-canvas-widget-spec.md), [`mermaid-fullscreen-diagram-spec.md`](./mermaid-fullscreen-diagram-spec.md), [`mermaid-drag-selection-edit-mode-flip-spec.md`](./mermaid-drag-selection-edit-mode-flip-spec.md)).

## Goals

- Every ` ```mermaid ` block renders through Pele. `beautiful-mermaid` (and its `elkjs` dependency) leave the catalog, `apps/desktop/package.json` and the lockfile. There was no `mermaid` package left to remove.
- Diagrams take their colours from the app theme in CSS, so switching light/dark, or changing the accent or Contrast setting, recolours them on screen without a re-render.
- Invalid source shows a clear error in the frame, never a blank widget or a crash.
- The SVG is still sanitised before it reaches `innerHTML`.

## Non-goals

- Pele's own zoom (`mount()`, `enableZoom()`) and adaptive layout (`maxWidth`, `autoDirection`). The canvas keeps its pan/zoom, see below.
- Diagram links, icon packs (`fa:fa-car`), custom diagram configuration from the app.
- Code-splitting Pele into a lazy chunk (`pele/lazy`). The renderer must stay synchronous for `toDOM` (docs/editor.md, "Synchronous render in `toDOM`"), and the bundle got smaller anyway.

## Design

### Renderer (`mermaid-renderer.ts`)

`renderMermaid(source)` returns `{ svg, width, height }` or `{ error }`; it is the only code that calls Pele.

- `render(source, { responsive: false, links: false, outputLimit: 1_000_000, fontFamily, fontFamilyMono, idPrefix })`.
  - `responsive: false`: a fixed pixel size; the canvas scales it. No `maxWidth`, so the layout never depends on the widget width.
  - `links: false`: a `click` link would navigate the app's webview away from the editor, and a click is how the canvas starts a pan.
  - `outputLimit` 1M (Pele default 4M): rendering is on the main thread, and a near-limit diagram took up to ~1 s and megabytes of cache. A plain flowchart at the 50,000-character source limit is ~600k characters of SVG, so only dense diagrams hit it.
  - Fonts come from the `--ui-font` / `--mono-font` settings, read from the root's inline style when rendering (no style recalc). Pele measures labels in that font and writes it into the SVG as the fallback of `var(--pele-font, …)`; `--pele-font` is left unset so the painted font is always the measured one.
  - `idPrefix` is a hash of the source, so the `<title>`/`<desc>` ids of two diagrams never collide.
- The result is sanitised with a private DOMPurify instance and cached (LRU, 50 entries) under font + source. Errors are cached too, so an invalid diagram is parsed once per source. Diagrams on screen keep their font after a font change until they re-render.
- `PeleError` → its message (syntax errors quote the line and mark the column). Anything else is a renderer bug: logged with `console.error`, shown as `Unexpected error: …`.

### Sanitisation: kept

Pele's security notes say it escapes label text, filters styles, links and images, and emits no scripts or event handlers; Writer's tests confirm HTML in a label is stripped. The sanitiser stays anyway:

- notes come from outside the app (vaults, repos), and the SVG goes straight into `innerHTML`;
- Pele is new (1.0 shipped on 2026-10-06; 1.6.0 on 2026-10-17), so its escaping has little history behind it;
- it costs nothing visible: it runs once per source, before the cache, and the tests show it leaves Pele's output for every diagram type unchanged (they compare the parsed trees).

DOMPurify runs as its own instance, so hooks registered on the shared one (the HTML block's `<a>` rewrite) don't apply, with the SVG profiles plus `ADD_ATTR: ["role"]`: across all 22 types tested, `role="graphics-document document"` on the root was the only thing it removed. The old regex pass in the renderer and the second DOMPurify pass in the canvas are gone; the cache is now the single producer of the markup the canvas inserts.

### Theme (`mermaid-canvas.css`)

Set on `.cm-mermaid-canvas`, which both the inline frame and the fullscreen overlay carry. One mapping covers both themes because it is built from the primaries that `[data-theme]` swaps. Every colour is opaque (a mix of `--fg-base` into `--bg-base`): Pele stacks shapes (nodes on subgraphs, label boxes on edges) and the app's translucent overlay tokens would double up.

| Pele variable        | Value                                                                                             | Used for                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--pele-bg`          | `--bg-base`                                                                                       | edge-label boxes, hollow shapes, text on series colours                                                             |
| `--pele-fg`          | `--fg-base`                                                                                       | text                                                                                                                |
| `--pele-muted`       | fg 62%                                                                                            | secondary text                                                                                                      |
| `--pele-line`        | fg 58%                                                                                            | edges, arrowheads                                                                                                   |
| `--pele-surface`     | fg `contrast × 14%`                                                                               | node fill                                                                                                           |
| `--pele-surface-alt` | fg `contrast × 26%`                                                                               | subgraph fill (drawn at 50% opacity)                                                                                |
| `--pele-border`      | fg `contrast × 75%`                                                                               | node and subgraph borders                                                                                           |
| `--pele-accent`      | `--accent`                                                                                        | highlights                                                                                                          |
| `--pele-critical`    | red mixed 15% toward fg                                                                           | critical Gantt tasks; the error title                                                                               |
| `--pele-series-1…8`  | accent, then blue, green, purple, yellow, teal, red, brown, each mixed 12–15% toward fg           | pie slices, branches, sections                                                                                      |
| XY chart series      | bars: accent 28% into bg with an accent outline and 4px corners; line: accent mixed 25% toward fg | bars and lines stay in one hue (as before); Pele fills bars solid, and full-strength accent bars dominated the note |

"fg N%" means `color-mix(in srgb, var(--fg-base) N%, var(--bg-base))`. `--contrast` is the Contrast setting (0.2–1.0), so node fills and borders follow it like the rest of the UI. Mixing the series colours toward `--fg-base` darkens them on the light theme and lightens them on the dark one, which keeps the `--pele-bg` text Pele draws on them readable in both.

Left at Pele's defaults: `--pele-font`, `--pele-font-mono` (see above), the weight variables, `--pele-radius`, `--pele-error` (only `mount()` uses it).

### Canvas (`mermaid-canvas.ts`)

- Takes the renderer's result (`diagram`) instead of an SVG string; natural size comes from Pele's `width`/`height` instead of reading the `viewBox`.
- Pele's pan/zoom isn't used: `mount()` re-lays the diagram out whenever the container width changes (opening the source panel would reshuffle it), and the canvas fits small diagrams up to fill its fixed-height frame alongside the edit, expand and zoom controls.
- Error state: "Can’t draw this diagram" plus the message in the code font, `role="status"` (polite: it rebuilds on every debounced edit), `textContent` only. The controls stay, so Edit code opens the source to fix it.
- Fit: Pele lays some diagrams out much taller than beautiful-mermaid did (the QA flowchart is 1039×2002). Fitting no longer stops at the 0.25× zoom floor: a diagram that only fits below it fits there, and zooming out stops at that fit.
- The source panel's highlighter knows the keywords of the diagram types Pele adds.

### Removed beautiful-mermaid workarounds

- `RENDER_OPTIONS` passing `bg: var(--bg-base)` / `fg: var(--fg-base)` / `transparent: true` into the renderer.
- The regex script/`on*=` stripper (DOMPurify covers it).
- The `svg[data-xychart-colors]` override of beautiful-mermaid's `--xychart-color-N` defaults.
- `measureNatural`'s viewBox/bounding-box probing and the comment about keeping beautiful-mermaid's inline style.

## Files

- `pnpm-workspace.yaml`, `apps/desktop/package.json`, `pnpm-lock.yaml` — `pele` in, `beautiful-mermaid` out; `jsdom` (dev) for the renderer tests.
- `apps/desktop/src/components/editor-area/mermaid-renderer.ts`, `mermaid-canvas.ts`, `mermaid-canvas.css`, `mermaid-decorations.ts`, `mermaid-fullscreen.ts`.
- `apps/desktop/tests/mermaid.test.ts` — runs under jsdom with real Pele and DOMPurify.
- `apps/playground` — the tokens the canvas reads, and `?dark`.
- `docs/editor.md` ("Mermaid diagrams render through Pele").

## Acceptance criteria

- No `beautiful-mermaid` or `mermaid` in any `package.json`, the catalog or the lockfile.
- Every diagram type in `SPECs/Agent/pele-qa-2026-10-17/diagrams.md` renders in the built app, in both themes.
- A theme switch recolours diagrams without a re-render.
- Invalid syntax and unknown diagram types show the error state.
- Inline widget, pan/zoom, fullscreen, Edit code, and drag-selection behave as before.
- `vp check`, `vp test` pass.

## Known gaps (Pele compatibility)

- Pele uses its own layout: node positions, spacing and edge routing differ from Mermaid and from beautiful-mermaid. Mermaid themes, `themeVariables` and `%%{init}%%` colours don't apply (CSS variables do). `style` / `classDef` colours are fixed and don't follow the theme.
- No HTML labels (HTML is stripped from labels); `click` callbacks are ignored, and links are off in Writer.
- ZenUML and other external Mermaid plugins are unsupported (they show the error state).
- Icons such as `fa:fa-car` need an `icons` resolver, which Writer doesn't supply; architecture's built-in symbols work.
- Images in diagrams load over `https:` only (the app CSP), like images in notes.
- Limits: 50,000 source characters and 5,000 flowchart edges (Pele's), 1,000,000 SVG characters (Writer's); larger diagrams show the error state. Rendering runs on the main thread: a diagram near the limits can take a few hundred milliseconds per edit. A worker would remove that (not done).

QA: [`Agent/pele-qa-2026-10-17/README.md`](./Agent/pele-qa-2026-10-17/README.md).
