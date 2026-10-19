# Run Code Blocks Spec

## Summary

A ` ```bash ` fence gets a **▶ Run** pill in its top-right corner. Clicking it (or **⌥↵** with the caret in the block) runs the block's code as a child process and streams stdout and stderr into an output tray attached under the block, then shows how it ended. While it runs the pill reads **■ Stop** and kills the run.

First version: bash only. More languages are one line each (see Adding a language).

## Behaviour

- **Where it shows:** under every closed fence whose info string's first word is a runnable language (`bash`, case-insensitive, extra words like `title=x` ignored) and whose body is not blank. An unclosed fence (still being typed) gets nothing.
- **Never automatic.** Nothing runs on open, on edit or on save; only a click on Run starts a process.
- **The fence stays plain source.** The widget sits below the fence (`Decoration.widget` at `node.to`, `keepDecorationOnUnfold`), so editing the code is unchanged.
- **Working directory:** the note's folder. Falls back to the app's working directory when the note has no path or the folder is gone.
- **Environment:** the app's environment, with `/opt/homebrew/bin`, `/opt/homebrew/sbin` and `/usr/local/bin` put in front of `PATH` when missing (GUI apps on macOS don't get the login shell's `PATH`). No stdin: a block that reads input gets end-of-file.
- **Run control:** a quiet `▶ Run` pill floated into the fence's first line (the hidden ```marker line), so it sits in the block's top-right corner. While running it becomes an accent-tinted`■ Stop`. **⌥↵** (Alt+Enter) runs or stops the runnable block containing the caret; it falls through when the caret isn't in one.
- **Output tray:** appears only after the first run, attached to the block's bottom edge (the last code line loses its bottom radius, the tray continues the code surface with a hairline divider). Header: status dot + text — `Running · 3.2s` (pulsing accent dot, live timer; no pulse under reduced motion), `Done · 120ms` (green), `Exit 2 · 40ms` (red), `Stopped · 4.1s` — and actions Copy output, Run again (hidden while running) and Clear (removes the tray; stops the run if it is still going). Body: stdout, stderr in red, terminal escape codes stripped (a code split across reads is held back until complete), `No output` when the run printed nothing. The body caps at 22em and scrolls; it follows new output only while scrolled to the bottom.
- **Output lifetime:** kept in memory, never written to the note. It belongs to the fence, not to the widget DOM: the fence's start carries a mark (a `RangeSet` in editor state, mapped through edits) holding the id of its latest run, so output survives edits and scrolling the block out of view. Re-running replaces it. The run is stopped and its output dropped when the mark goes away: the fence is deleted, Clear is pressed, the tab switches to another document, or the editor closes.
- **Stop** kills the run's whole process group (`SIGKILL`), so children such as `sleep` stop too.
- **Limits:** a run that prints more than 1 MiB (stdout + stderr) is stopped and the panel says so.

## Design

- `shared/code-runtimes.json` maps fence language → interpreter. The editor reads it to decide where to show Run; `commands/run.rs` has the same table and a test keeps the two equal.
- `commands/run.rs`
  - `run_code(runId, lang, code, cwd, onEvent: Channel<RunEvent>)` spawns `<interpreter> -c <code>` in its own process group. Two reader threads stream chunks (UTF-8 split across reads is carried, not mangled); a waiter thread sends `exit { code, cancelled, truncated }`.
  - `cancel_run(runId)` marks the run cancelled and kills its process group.
  - `RunRegistry` (managed state) maps run id → pid.
- `components/editor-area/code-run-decorations.ts` owns the UI: `runsField` (fence → run id marks), `decorationsField` (corner toggle widget at the fence start, tray block widget at its end, rebuilt on doc/tree changes and run effects), `runLifecycle` (stops and forgets runs whose mark disappeared), the Alt-Enter keymap, and the session store holding each run's output. Events from a superseded run id are dropped.

## Adding a language

Add the entry to `shared/code-runtimes.json` and to `RUNTIMES` in `commands/run.rs`. An interpreter that doesn't take `-c <code>` needs a per-runtime argument shape in `run.rs`.

## Non-goals (this version)

- Shared state between blocks, variables across blocks or languages.
- Interactive stdin, a terminal/TTY, rendering colours (escape codes are stripped, not drawn).
- Saving output into the note.
- Running from Reading/preview surfaces other than the editor, or a Run All command.
