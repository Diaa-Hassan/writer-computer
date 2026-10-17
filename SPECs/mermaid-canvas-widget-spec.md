# Mermaid Canvas Widget Spec

## Summary

Render mermaid fenced code blocks inside a fixed-height "canvas" widget — like an embedded canvas pane — with pan, zoom in/out, reset, and a toggle button that flips the widget back to source for editing. Today the widget grows to fit the rendered SVG, which makes large diagrams dominate the document and makes small ones awkwardly stretched. A bounded viewport with viewport controls keeps documents scannable while still letting users explore detail.

## Goals

- Render every mermaid block inside a fixed-height, full-width container regardless of the diagram's natural size.
- Provide pan (drag) and zoom (in / out / reset to fit) controls inside the widget.
- Provide a small icon toggle on the widget that enters "edit code" mode (reveals the fenced source) and returns to the rendered diagram.
- Render the inline source editor selection with CodeMirror's `drawSelection()` layer, not the browser-native `::selection` highlight.
- Render synchronously per widget against a bounded cache so scrolling and theme switches stay smooth without an IntersectionObserver-driven deferral that can miss transitions.
- Keep the widget keyboard-accessible: focusable container, arrow-key pan, `+` / `-` / `0` for zoom in / zoom out / reset, `Enter` to toggle edit mode.

## Non-Goals

- Editing the diagram visually (still text-based).
- Resizing the widget per-block (no inline height control in markdown).
- Exporting the rendered diagram (PNG/SVG export is out of scope for this spec).
- Cross-document widget state — pan/zoom resets when the widget remounts.

## UX Decisions

- Default widget height: 480px (single tunable constant).
- Diagram is initially rendered "fit to viewport" — scaled so the full SVG is visible inside the canvas with a small inset.
- Two corner control clusters: a 28px code icon toggle in the top-right, and a vertical reset / `+` / `−` zoom stack in the bottom-right. Both fade in on hover/focus and stay visible while the widget has focus. The reset button mirrors the `0` keyboard shortcut and restores the fit-to-viewport pan/zoom state. No live zoom % indicator.
- The code pane opens and closes instantly; avoid animated motion in the editor panel so toggling source view feels like a direct editing action. Refit the diagram after the layout change lands.
- Pan: click-and-drag inside the canvas, or arrow keys when focused. Cursor changes to `grab` / `grabbing`.
- Zoom: mouse wheel with `⌘`/`Ctrl` modifier, pinch on trackpad, or the +/– buttons. WebKit's synthetic Ctrl-wheel pinch path uses a higher sensitivity so small trackpad deltas feel responsive. Zoom range clamped (0.25× – 4×); a diagram too big to fit at 0.25× fits below it, and zooming out stops at that fit, so the whole diagram can always be brought back into view. Zoom anchors on the cursor position when using wheel/pinch, and on the viewport center when using buttons.
- "Edit code" toggle dispatches a **range selection covering the entire fence** (`EditorSelection.single(fenceTo, fenceFrom)`). The reverse-anchor convention matches `selectAllDecorationsOnSelectExtension` in `@prosemark/core`. `selectionTouchesRange` is overlap-based with inclusive bounds (`a.from <= b.to && b.from <= a.to`), so a range selection always flips the syntax facet into edit mode regardless of where the head lands inside the fence. The "Preview" affordance dispatches a caret at `fenceTo + 1` (clamped) so the selection no longer overlaps the fence range.
- Errors render inside the canvas frame (border + fixed height retained): a "Can’t draw this diagram" title over Pele's message in the code font (a syntax error quotes the line and points at the column), set with `textContent` because the message quotes the source. The controls stay mounted, so Edit code opens the source to fix it in place; fullscreen opens on the same error.

## Implementation Notes

- The canvas frame is a new module (`mermaid-canvas.ts`) mounted by the existing `MermaidWidget` in `mermaid-decorations.ts`. The widget's `toDOM` builds the host shell; once the SVG has rendered, `mountMermaidCanvas` attaches the viewport, controls, and event listeners. State (zoom, panX, panY) is held as a small mutable object inside the mount closure — no reducer; the surface is small enough that the indirection isn't worth it.
- Zoom is applied by resizing the SVG element directly (from the natural width/height Pele reports with the SVG) so the browser re-renders the vector at each zoom step instead of caching a rasterised layer. Pan is applied via `transform: translate(...)` on the stage wrapper inside an `overflow: hidden` viewport.
- `estimatedHeight` returns the fixed canvas height + outer padding. No per-source height cache; the frame is height-stable from the first frame so the heightmap settles immediately.
- "Edit code" toggle resolves the FencedCode range live at click time via `view.posAtDOM(host)` + `syntaxTree.resolveInner(pos, 1)` walking up to the enclosing FencedCode node. No positions are captured on the widget instance and no `eq()` side-effect is needed — every dispatch reads current offsets from the live tree, eliminating an entire class of stale-position bugs.
- The widget's `eq()` compares only `source` + `editMode`. The diff treats source-or-mode changes as a rebuild and structurally identical widgets as reuse — straightforward and self-contained.
- Scroll is preserved across the dispatch via `view.scrollSnapshot()`. The snapshot captures the current viewport-top doc anchor and its screen offset; CodeMirror applies the resulting `StateEffect` after the heightmap rebuild and re-scrolls so the same anchor lands at the same screen Y. This is the canonical CM6 pattern for keeping scroll stable across decoration changes — robust to the heightmap shift caused by switching between replace-decoration (canvas only) and widget-decoration (source above + canvas below).
- Render is synchronous in `toDOM`: Pele's `render` is sync, the SVG cache makes repeat renders O(map lookup), and CodeMirror only calls `toDOM` for widgets in its viewport buffer. Mounting in the same frame the wrapper enters the DOM means there's no async gap that can leave the user stuck on a "Loading…" placeholder, and no IntersectionObserver to fire spuriously after a toggle (which previously caused a "click → flash of source → mermaid re-renders" blink).
- Renderer: [Pele](https://pele.run) (see [`pele-diagrams-spec.md`](./pele-diagrams-spec.md)). Its SVG reads every colour as `var(--pele-*)`; `mermaid-canvas.css` maps those onto the theme primaries on `.cm-mermaid-canvas`, so one cached SVG works in both themes and a theme switch recolours it without re-rendering. The SVG is rendered at its fixed pixel size (`responsive: false`) with links off, then sanitised with DOMPurify (SVG profile plus `role`) before cache insert.
- The SVG cache is bounded LRU (~50 entries) so a long session with many distinct mermaid sources does not leak.
- The nested CodeMirror source editor includes `drawSelection()` and the Mermaid canvas stylesheet scopes native `::selection` to transparent inside `.cm-mermaid-canvas-editor`. This avoids a doubled native-plus-drawn selection while preserving the document editor's broader native-selection fallback.

## Files Expected To Change

- `apps/desktop/src/components/editor-area/mermaid-decorations.ts` — widget mounts the canvas frame, swaps `estimatedHeight` to the fixed height, range-selection toggle.
- `apps/desktop/src/components/editor-area/mermaid-renderer.ts` — sync renderer, LRU cache, output sanitisation.
- new `apps/desktop/src/components/editor-area/mermaid-canvas.ts` — frame, controls, pan/zoom.
- `apps/desktop/tests/mermaid.test.ts` — coverage for fixed-height behaviour, sanitisation, and the range-selection toggle.

## Acceptance Criteria

- Every rendered mermaid block occupies the same fixed height, regardless of diagram size.
- Drag-pan and wheel-zoom (with `⌘`/`Ctrl` modifier) work inside the widget; the reset and +/− zoom buttons work.
- Clicking the code icon toggle selects the entire fence and reveals the source for editing; clicking the active code toggle (or moving the caret out of the fence) returns to the rendered canvas. Cross-widget clicks don't interfere — each click resolves its own fence range live.
- Keyboard: focusing the widget enables arrow-key pan, `+` / `-` zoom, `0` reset-to-fit, and `Enter` toggle.
- Text selected inside the inline source editor shows the drawn CodeMirror selection only, with no native browser highlight layered over it.
- Scrolling a long document with many diagrams stays smooth; the heightmap does not jump as widgets enter/leave the viewport.
- Theme switch flips diagram colours without a visible re-render (CSS custom properties resolve at paint time); errors render inside the canvas frame with the border and fixed height retained.
