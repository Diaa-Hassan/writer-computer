# Editor Notes

Patterns and gotchas for the CodeMirror editor in `apps/desktop/src/components/editor-area/`. Each rule earned its place by costing real time. Apply them when extending or reviewing editor code.

## Use the layout model, not the rendered DOM, for positions

Prefer:

- `view.lineBlockAt(pos)` → `BlockInfo` with `top`/`bottom`/`height` in document coordinates.
- `view.documentTop` → screen y of the first line.

Over:

- `view.coordsAtPos(pos)` → can return `null` for positions outside the rendered viewport. CodeMirror only measures lines that are currently virtualized into the DOM; matches further down the document have no `Rect` until they scroll into view.
- `view.contentDOM.getBoundingClientRect()` → affected by virtualization padding and async layout.

Match screen position, valid for any document position:

```ts
const block = view.lineBlockAt(pos);
const matchScreenY = view.documentTop + block.top;
```

`coordsAtPos` returning `null` is a silent failure: a `scrollHandler` that returns `false` falls back to CodeMirror's default scroll, which doesn't know about app-level fades, masks, or other ancestor overlays. If you only test in-viewport cases, the bug ships.

## Choose the right scroll API for who owns the scroll container

CodeMirror's built-in scroll APIs assume the editor owns its scroll container (`view.scrollDOM`, by default `.cm-scroller`):

- `search()` config's `scrollToMatch` — customize the scroll effect for findNext/findPrevious.
- `EditorView.scrollMargins` facet — declare top/bottom/left/right regions of the scroll container that should be treated as off-screen (e.g. for a fixed gutter or fade).

These are correct when `view.scrollDOM` is the actual scrolling element.

In Writer's editor, `.cm-scroller` has `overflow: visible !important` (see `prosemark-theme.css`) and the surrounding `EditorScrollContainer` is the real scroller. CodeMirror's default scroll walks up to scroll ancestors generically, but `scrollMargins` only applies to `view.scrollDOM`'s computation — so the match can still land under the outer container's fade.

When the scrollable element is an ancestor:

- Use `EditorView.scrollHandler.of(...)` to take over scrolling.
- Find the ancestor scroller by walking `view.dom.parentElement` for the first element with `overflowY: auto | scroll`.
- Scroll it yourself with `scroller.scrollTo({ top, behavior: "auto" })`. `behavior: "smooth"` is async and gets interrupted by rapid keystrokes (e.g. Cmd+G held down).
- Account for `clientTop` if the ancestor has a border (Writer's container has a 12px transparent border-top to give the mask gradient room).

Reference: `EditorView.scrollHandler.of((view, range) => …)` in `apps/desktop/src/components/editor-area/editor-search-extensions.ts`.

Every element between `view.dom` and the real scroller must grow with the content (`min-h-full`, never `h-full`). CodeMirror's `scrollRectIntoView` treats any ancestor whose `scrollHeight > clientHeight` as a scroller and clips the target rect to its bounds, even when it is `overflow: visible`. A viewport-high wrapper around a long note therefore clips the caret rect before it reaches `EditorScrollContainer`, and held arrow keys walk the caret off-screen while the scroll position stays put (issue #125, `e2e/specs/keyboard-scroll.spec.js`).

## Block widgets: pick the decoration shape

Common shapes for widgets that own a block region:

- **Replace-only.** Always `Decoration.replace`. Use when the widget doesn't need to expose source for editing and interaction lives inside the widget itself. Canonical example: `mermaid-decorations.ts` — the fence is always replaced by the canvas, and editing happens in the canvas's nested editor, which writes the whole fence back via `writeFenceText`.
- **Conditional replace ↔ widget.** `Decoration.replace` over `[node.from, node.to]` when the selection doesn't overlap the node; `Decoration.widget(...).range(node.to)` (anchored at the end) when it does, so the source becomes editable next to the rendered widget. Canonical example: `fold/image.ts`. Driven by `selectionTouchesRange`, the third arg passed to `foldableSyntaxFacet`'s `buildDecorations`.
- **Conditional replace ↔ source-line styling.** `Decoration.replace` when the selection is outside the block; line decorations when selection touches the block and the source should stay editable in the main editor. Canonical example: `table-decorations.ts`, which renders a folded table preview with safe inline markdown inside cells, then unfolds a touched table into codeblock-styled markdown source lines rather than a nested editor.

Don't invent a parallel "edit mode" flag that isn't wired through `selectionTouchesRange`. The fold extension already manages that state — duplicating it produces drift between the two sources of truth.

## Enter edit mode by range-selecting the fence, not by placing a caret

`selectionTouchesRange` from `@prosemark/core` is overlap-based with inclusive bounds (`a.from <= b.to && b.from <= a.to`, see `node_modules/@prosemark/core/dist/main.js:30`). A range selection covering the whole fence reliably flips it true regardless of where the head lands.

```ts
view.dispatch({
  selection: EditorSelection.single(fenceTo, fenceFrom), // reverse-anchor convention
  effects: view.scrollSnapshot(),
});
```

Caret-placement at a single point inside the fence is fragile: empty fences, boundary positions, multi-line content, and stale offsets all break it. Mirror what `selectAllDecorationsOnSelectExtension` (`@prosemark/core`) does — it's the canonical pattern.

## Don't store document positions on widget instances

Widget identity is its visual state — `source`, `editMode`, etc. — never positions. Positions are derived state owned by the syntax tree.

- Don't capture `node.from`/`node.to` on the widget at construction. Above-fence edits shift them and the widget lives across rebuilds.
- Don't try to keep them current via an `eq()` side-effect (mutating the kept instance from `other`). It looks like it works in isolation and silently fails across multi-fence diffs and decoration-shape transitions.
- Look up positions live at click time:

```ts
const pos = view.posAtDOM(host);
const tree = syntaxTree(view.state);
let node = tree.resolveInner(pos, side);
while (node.name !== "FencedCode" && node.parent) node = node.parent;
```

`eq()` should compare only the visual identity. Let CM rebuild when that changes; don't mutate kept instances to compensate.

## `posAtDOM` boundaries: try `resolveInner` with both sides

A `Decoration.widget(...).range(node.to)` returns `posAtDOM(host) === node.to`. `resolveInner(node.to, 1)` resolves to the node _starting_ at `node.to` — the next sibling, not the FencedCode that ends there. The walk up never finds the fence.

For widgets anchored at boundary positions, try `side = -1` first (prefers the node ending at the boundary), fall back to `side = 1`:

```ts
for (const side of [-1, 1] as const) {
  let node = tree.resolveInner(pos, side);
  while (node.name !== target && node.parent) node = node.parent;
  if (node.name === target) return node;
}
return null;
```

## Buttons inside widgets: `mousedown.preventDefault()`

A button inside the widget that dispatches a transaction will race the editor's focus state. Default browser behavior on mousedown:

1. Browser focuses the button → editor blurs.
2. Click handler runs → `view.dispatch(...)`.
3. Decoration rebuilds → button DOM destroyed → focus reverts to body.
4. Our `view.contentDOM.focus({preventScroll: true})` runs.

Steps 1–4 race with CM's own focus tracking; the visible result is the caret landing at click coordinates instead of the dispatched selection, or focus landing nowhere useful.

Add to every in-widget button:

```ts
b.addEventListener("mousedown", (e) => {
  e.preventDefault(); // keep the editor focused
  e.stopPropagation(); // keep CM's pointerdown handlers from competing
});
```

Combine with `ignoreEvent: true` on the widget so CM skips its own pointer/click handling for events inside the widget DOM.

**Gotcha: `mousedown.stopPropagation` does not stop `pointerdown`.** They're separate event types — the browser dispatches both for a click, and stopping one doesn't filter the other. If you wire an editor-level handler on `pointerdown` (e.g., a drag-selection gate that listens on `view.contentDOM`), the in-widget button's `mousedown` stop won't suppress it. Filter inside the editor-level handler instead — typically `event.target instanceof Element && event.target.closest('.cm-your-widget')`. See `mermaid-decorations.ts`'s `shouldStartDragGate` for the canonical filter.

## Heightmap-shifting transitions: include `view.scrollSnapshot()`

Any decoration switch that changes block heights (replace ↔ widget, fold/unfold, widget appearing/disappearing) shifts the heightmap. Without compensation the viewport jumps.

```ts
view.dispatch({
  selection: ...,
  effects: view.scrollSnapshot(),
});
```

`scrollSnapshot` captures the viewport-top doc anchor and its screen offset; CM applies the resulting `StateEffect` after the heightmap rebuild and re-scrolls so the same anchor lands at the same screen Y. Don't roll your own `coordsAtPos`-delta scroll math — it depends on layout being flushed and is brittle.

**Caveat: `scrollSnapshot` only affects `view.scrollDOM`, not ancestor scrollers** (per CM's own doc comment; both capture and apply use `scrollDOM.scrollTop`). In Writer, `.cm-scroller` doesn't scroll — the outer `EditorScrollContainer` does — so the snapshot is close to a no-op here. What actually keeps the viewport stable across height changes is CM's measure-loop scroll anchoring, which does adjust the discovered ancestor scroller — but only while the editor has focus or a wheel/touch event happened in the last 100ms. Corollary: widgets whose DOM changes height after insertion (async image decode, deferred renders) must keep `estimatedHeight` truthful and call `view.requestMeasure()` when their height settles, so the anchoring runs while the user is still interacting. `fold/image.ts` does this with a module-level measured-height cache keyed by image URL, reserving the cached height on the `<img>` until it (re)loads.

## Line-height estimates: keep `@codemirror/view` at 6.42.1 or later

CodeMirror estimates the height of every line outside the viewport from one text-size sample: the first viewport line of at most 20 plain ASCII characters whose children are all bare text (no marks, no widgets), or, when no line qualifies, a dummy `.cm-line` in the body font. In Writer almost no prose line qualifies (headings, list markers, links and highlighting all add marks or widgets), so the sample is normally the dummy line, until a fenced code block scrolls into the viewport: its short lines do qualify and measure in the monospace font (9.4px per character against 6.65px for the dummy).

Before 6.42.1, `HeightOracle.refresh` counted a char-width change over 0.1px as a font change and re-estimated **every** line outside the viewport with `force`, discarding measured heights. Each pass through a code block rewrote the height of every table row, heading and wrapped paragraph above the viewport and moved the scroll position by hundreds of pixels (966px on a planning note with a wide table, two code blocks and nested lists). From 6.42.1 only a line-height change refreshes, and the lines that qualify for the sample share the 28.8px body line box, so measured heights survive. Don't pin the view package below that, and move `@codemirror/state` with it: when the view package wants a newer state than the catalog pins, pnpm nests a second copy and facets from the two copies don't match (`state.facet(...).filter is not a function` on mount).

What still shifts: a line is rebuilt with a fresh estimate when its height-relevant static decorations (replace ranges, block widgets) change. Content above the visible area then moves by the estimate error. CodeMirror's measure-loop anchoring re-scrolls the ancestor scroller to hide that, but only while the editor has focus or within 100ms of a wheel or touch event; a scrollbar drag in a blurred editor shows the shift. To diagnose height churn, diff `view.lineBlockAt(line.from).height` for every line across a scroll step: lines far above the viewport changing height is the tell, and the playground exposes the view as `window.__view` (and the class as `window.__EditorView`, for `view.state.facet(EditorView.decorations)`) for exactly this.

## Decorate what CodeMirror renders, not `view.visibleRanges`

CodeMirror renders more than the viewport: `ViewState.updateForViewport` keeps the main selection's anchor and head lines in the DOM wherever the viewport is (that's what `.cm-gap` separates), and the measure loop writes what those lines measure at into the height map like any viewport line. `view.visibleRanges` covers the main viewport only. A plugin that decorates `visibleRanges` leaves the caret's line bare once it scrolls out: an H1 holding the caret rendered as a plain `.cm-line` measured 28.8px against 92.1px in the viewport, the height map took the 28.8px, and the note above the viewport moved up 63px, then back down when the heading scrolled in again. Code block lines (mono font, first/last padding), blockquote lines and paragraphs whose marks change the wrap have the same problem. See `SPECs/offscreen-selection-line-height-spec.md`.

Rules:

- Build decorations from `renderedRanges(view)` (`prosemark-core/utils.ts`): the visible ranges plus the selection's off-viewport lines, sorted and disjoint. Never iterate `view.visibleRanges` in a decoration plugin.
- Guard the rebuild with `renderedRangesChanged(update)` in place of `update.viewportChanged`. It is true when the viewport moved or the set of off-viewport selection lines changed; a caret moving between lines inside the viewport does not trigger a rebuild.
- A node can touch two rendered ranges (a fence spanning from the caret's line into the viewport). Dedupe by node start before adding to a `RangeSetBuilder`, or its sorted-insert invariant throws.
- Syntax highlighting comes from `@codemirror/language`'s tree highlighter, which also only covers `visibleRanges` and takes no configuration. `offscreenSelectionHighlightExtension` runs the same `highlightTree` walk over the off-viewport selection lines with the state's highlighters (`highlightingFor`), so heading font sizes and code fonts apply there too. Height-relevant styling can stay in `HighlightStyle`s because of it; don't move styles to line classes to work around the highlighter.
- `codeFenceScroll.ts` still reads `view.visibleRanges` on purpose: it measures the horizontal scroll of visible code blocks and does not affect height.

## Tree-derived StateFields go stale in unparsed regions

`syntaxTree(state)` returns a frozen snapshot committed at the last `LanguageState` flip — not the live parse context. `ensureSyntaxTree` advances the live context and returns the fresh tree, but `syntaxTree(state)` keeps returning the old one until some later transaction commits a new `LanguageState` (`forceParsing` = `ensureSyntaxTree` + that dispatch). Lezer's background worker fills the tree in `requestIdleCallback` slices, which starve during continuous scrolling and are budget-capped on long documents.

Consequence: any `StateField` that builds decorations by iterating `syntaxTree(state)` (list geometry, hide, fold) renders nothing for regions the committed tree hasn't reached — scrolled-into list items lose their hanging indent, markers show raw, etc. The fields' `syntaxTree(startState) !== syntaxTree(state)` rebuild guards only fire once a parse-commit transaction lands.

`viewportParsePlugin` in `use-prosemark-editor.ts` closes the gap: on `viewportChanged` into a region where `syntaxTreeAvailable` is false, it defers a `forceParsing(view, viewport.to + overshoot)` (dispatching inside an update cycle is illegal, hence the `setTimeout`). Mount and tab-swap paths call `advanceViewportParse` for the same reason. Don't add per-field force-parses.

The parse-commit transaction that `forceParsing` dispatches changes neither the doc nor the viewport. So every tree-derived decoration source, StateField **and** ViewPlugin, must rebuild on the tree itself changing. Use `treeChanged(update)` from `prosemark-core/utils.ts`:

```ts
update(update: ViewUpdate) {
  if (update.docChanged || update.viewportChanged || treeChanged(update)) rebuild();
}
```

The StateFields (`hideExtension`, `foldExtension`, `listDecorationsField`) and the ViewPlugins (`headingPlugin`, `codeBlockDecorationsExtension`, `blockQuoteExtension`) all carry it. Without it a region jumped into (Cmd+G, section rail, anchor) keeps stale decorations until the next scroll. Don't add a "tree sync" plugin that re-dispatches a selection to nudge a rebuild; that was the old workaround and it tripled the rebuild cost per parse commit.

## Synchronous render in `toDOM` beats IntersectionObserver-deferred

If your renderer is sync and cache-backed (or cheap to call), paint in `toDOM`. The async-deferred path adds a "Loading…" gap users see, can re-fire after a toggle (producing a visible flash), and has no real benefit when the cache makes repeat renders O(map lookup). CM only calls `toDOM` for widgets in its viewport buffer anyway.

Reference: `mermaid-decorations.ts` mounts the canvas synchronously in `toDOM`; the SVG cache is bounded LRU and the output is sanitised before reaching `innerHTML`.

## Mermaid diagrams render through Pele

`mermaid-renderer.ts` is the one place that calls [Pele](https://pele.run) (`render`, synchronous). It returns either a sanitised SVG with its natural size or an error message; the canvas, the widget and fullscreen only ever see that result. Rules:

- **Theme in CSS, never in render options.** Pele writes every colour into the SVG as `var(--pele-*, default)`. `mermaid-canvas.css` maps those onto the theme primaries (`--fg-base`, `--bg-base`, `--accent`, `--contrast`) on `.cm-mermaid-canvas`, so a theme, accent or contrast change recolours diagrams on screen with no re-render and the cache key has no theme in it. Use opaque `color-mix(… var(--fg-base) N%, var(--bg-base))` values: Pele stacks shapes, and the app's translucent overlay tokens double up where they overlap. When Pele adds a colour variable, `tests/mermaid.test.ts` ("Pele theme mapping") fails until the CSS maps it.
- **The font Pele measures is the font it paints.** Pele sizes nodes by measuring labels in `fontFamily` and writes that font into the SVG as the fallback of `var(--pele-font, …)`. Leave `--pele-font` unset; setting it in CSS paints labels in a font they weren’t measured in, so they can overflow or underfill their boxes. The renderer reads `--ui-font` / `--mono-font` from the root's inline style (where `applyCssVarBindings` puts them; `getComputedStyle` would force a style recalc on every `toDOM`) and keys the cache by them. After a font change, diagrams already on screen keep the old font until they re-render; accepted, since each one stays self-consistent.
- **Restyle with paint only.** `mermaid-canvas.css` also overrides Pele's classes for Writer's diagram look (accent arrowheads, muted edge labels, dashed lifelines, accent series). Colours, strokes, dashes and fills are safe; never change `font-*` or `letter-spacing` on diagram text, since Pele laid the boxes out for the measured width.
- **Fixed size, no adaptive layout.** `responsive: false` and no `maxWidth`: the canvas scales the SVG itself for fit and zoom, and a width-dependent layout would reshuffle the diagram when the source panel opens. That's also why the canvas keeps its own pan/zoom instead of Pele's `mount()` / `enableZoom()`.
- **Links off.** A `click` link in the SVG would navigate the webview away from the app, so `links: false`.
- **Bounded output.** Rendering is on the main thread, so `outputLimit` is 1M characters (Pele's default is 4M): a near-limit diagram would block the editor for most of a second and make each cache entry megabytes. Over-limit diagrams show Pele's limit error.
- **Sanitise once, before caching, with a private DOMPurify instance** (hooks on the shared default instance, like the HTML block's `<a>` rewrite, must not apply). The SVG profile keeps everything Pele emits except `role` (it's in DOMPurify's HTML list), hence `ADD_ATTR: ["role"]`. The test suite checks the sanitiser leaves Pele's output for every diagram type unchanged; if it starts failing after a Pele bump, allow the new attribute rather than dropping the sanitiser.
- **Errors are text.** `PeleError` messages quote the diagram source; display them with `textContent`. Anything else thrown is a renderer bug: it is logged and shown as "Unexpected error", never thrown out of `toDOM`. Errors are cached like SVGs, so an invalid diagram is parsed (and logged) once per source.

## Test the dispatch path, not just the helpers

Pure-helper tests (`computeToggleSelection`-style) catch math bugs but not focus races, `posAtDOM` boundary errors, or cross-widget interference. The actual contract is "click does the right thing in CM," which only an integration test can verify.

When a widget has a click → dispatch → mode-change cycle, mount a real `EditorView` with two instances and simulate clicks. Assert against `view.state.selection.main` and `view.state.field(foldExtension)`, not against helper outputs.

## Per-block horizontal scroll goes through a decoration, not a scroll container

Code lines don't wrap (`white-space: pre`). A block is a run of sibling `.cm-line`s with nothing wrapping them, so there is no element to give `overflow-x: auto`. Don't make the lines themselves scroll containers either: `drawSelection` paints the caret and selection in layers beside the content, so a natively scrolled line leaves them stale until the next update, and CodeMirror's scroll-into-view (`scrollRectIntoView` walks every ancestor whose `scrollWidth` exceeds its `clientWidth`) would scroll one line out of step with its block.

Instead the offset is state: `codeBlockScrollField` in `prosemark-core/codeFenceScroll.ts` holds pixels per block start, `codeFenceExtension` renders it as `text-indent: -<offset>px` on each line decoration, and the lines clip with `overflow-x: clip` (`hidden` would make them scroll containers again). Wheel input and caret reveal both dispatch `setCodeBlockScroll`; the resulting decoration rebuild is what redraws the layers. Caret reveal measures in a `requestMeasure` read and dispatches from a `setTimeout` in the write, since measure writes still run inside the update cycle. The scrollbar is also drawn rather than native: a `layer` places one thumb per overflowing block and dispatches the same effect when the thumb is dragged. The drag follows mouse moves on the window, not on the thumb, because a redraw can replace thumb elements.

## Plugin decorations set in a measure callback aren't read until the next update

A `ViewPlugin` exposes `decorations` that CodeMirror reads during a view update. Assigning `this.decorations` inside a `requestMeasure` write changes nothing on screen until some later update reads it again. `blockQuoteExtension` used to build its whole decoration set there, so quote bars lagged one update behind and a note opened by replacing the document showed none until a key was pressed. Build whatever the tree alone determines (the `.cm-blockquote-line` bars) synchronously in `update`. Measure only what needs the DOM (nested-quote bar offsets), and when a measurement changes the decorations, dispatch an effect-only transaction from outside the measure cycle (a microtask or `setTimeout`) so the view re-reads them.

## Commands that move the caret must ask to scroll

A `view.dispatch` with a new selection does not scroll unless the transaction says `scrollIntoView: true`; CodeMirror's own motion and editing commands set it, hand-written ones have to. Writer's list Enter/Backspace/Tab, the formatting line commands, the line-boundary keys and the block-reveal arrows all set it. The reveal arrows matter most: moving into a table, display math, Mermaid or `<details>` block swaps the widget for its source, so the block's height changes after the move was computed. Without the scroll the caret landed up to ~500px outside the window and stayed there.

## Transaction filters that override the selection: `sequential: true`

A `transactionFilter` returning `[tr, { selection }]` adds a spec whose positions are read in the **start** document unless the spec has `sequential: true`. A clamped selection computed from `tr.newSelection` is in the new document, so without the flag CodeMirror maps it through the changes a second time and throws a `RangeError` as soon as the doc grew (the heading-hash selection guard, since removed, dropped every heading-shortcut transaction this way).

## File map

- `mermaid-decorations.ts` — canonical replace-only block widget with in-widget editing. Reference for live position lookup (`findEnclosingFencedCode`) and writing the fence back from a nested editor.
- `mermaid-renderer.ts` — `renderMermaid`, the one call into Pele: render options, DOMPurify, LRU cache, error messages. `mermaid-canvas.css` holds the `--pele-*` theme mapping.
- `fold/image.ts` — canonical conditional replace ↔ widget, plus the measured-height cache for async-loading content.
- `table-decorations.ts` — canonical conditional replace ↔ source-line styling; uses `selectAllDecorationsOnSelectExtension` for click-to-select.
- `prosemark-core/codeFenceScroll.ts` — `codeBlockScrollField` / `setCodeBlockScroll` / `codeBlockAt`, the one place a code block's horizontal offset is stored and driven (wheel, caret reveal, resize clamp, drawn scrollbar thumb).
- `prosemark-core/links.ts` — `linkUrlAt` / `rawUrlAt`, the one place that resolves a link destination from a document position.
- `prosemark-core/imageSrc.ts` — `imageSrcResolverFacet` / `resolveImageSrc`; widgets resolve `<img src>` in `toDOM` (Writer provides the facet from `image-src-resolver.ts`), so no DOM observer rewrites images after insertion.
- `editor-scroll.ts` — `findOuterScroller` / `scrollPosToSafeTop`, the one place that scrolls the ancestor container to a document position.
- `editor-extensions.ts` — `createEditorExtensions`, the one place the extension list is assembled. Pieces: `editor-search-extensions.ts` (hidden search panel, `EditorView.scrollHandler` for the ancestor-scroller case, Mod-f / Mod-g / Escape), `link-navigation.ts` (click-to-follow, `followLink`), `editor-clipboard.ts` (image + frontmatter paste), `editor-body-menu.ts` (right-click menu), `viewport-parse.ts`. `use-prosemark-editor.ts` only mounts, swaps, and disposes the view.
- `node_modules/@prosemark/core/dist/main.js:30` — `selectionTouchesRange` semantics.
