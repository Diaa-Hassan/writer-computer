# Editor playground

A plain Vite + React page that mounts the desktop app's editor core
(`apps/desktop/src/lib/prosemark-core`) with the app's editor theme, next to a
live view of the markdown source with whitespace made visible. It exists to
QA editor behaviour in a normal browser, where automation and screen
recording are easy, without building the Tauri app.

Everything Tauri-specific (file IO, clipboard, link navigation, images) is
left out; what is here is the CodeMirror setup, the list/heading/formatting
extensions and the theme.

```sh
vp install
vp run playground#dev      # http://localhost:1430 (or `vp dev` inside apps/playground)
```

Open `http://localhost:1430/?full` to mount the desktop app's complete
extension set (`createEditorExtensions`: tables, math, Mermaid, HTML blocks,
wiki links, search, clipboard) instead of the core subset. Tauri calls are
stubbed to fail, so local images show as broken and link opening / the native
clipboard menu do nothing; editing and rendering behave as in the app.

Add `dark` (`?full&dark`) for the app's dark theme tokens. The theme can also
be flipped live with `document.documentElement.dataset.theme = "light"` (or
`"dark"`), which is how Mermaid diagrams are checked to recolour without a
re-render.

The editor view is on `window.__view` for scripted checks
(`agent-browser eval "window.__view.state.doc.toString()"`), and the
`EditorView` class on `window.__EditorView`, so a script can read facets
(`view.state.facet(window.__EditorView.decorations)`) while diagnosing
height or decoration churn.
