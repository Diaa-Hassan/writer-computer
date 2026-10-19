# Run Code Blocks Spec

## Summary

A ` ```bash ` fence gets a **Run** button under it. Clicking it runs the block's code as a child process and streams stdout and stderr into an output panel under the fence, then shows how it ended (`Done`, `Exit N`, `Stopped`). While it runs the button reads **Stop** and kills the run.

First version: bash only. More languages are one line each (see Adding a language).

## Behaviour

- **Where it shows:** under every closed fence whose info string's first word is a runnable language (`bash`, case-insensitive, extra words like `title=x` ignored) and whose body is not blank. An unclosed fence (still being typed) gets nothing.
- **Never automatic.** Nothing runs on open, on edit or on save; only a click on Run starts a process.
- **The fence stays plain source.** The widget sits below the fence (`Decoration.widget` at `node.to`, `keepDecorationOnUnfold`), so editing the code is unchanged.
- **Working directory:** the note's folder. Falls back to the app's working directory when the note has no path or the folder is gone.
- **Environment:** the app's environment, with `/opt/homebrew/bin`, `/opt/homebrew/sbin` and `/usr/local/bin` put in front of `PATH` when missing (GUI apps on macOS don't get the login shell's `PATH`). No stdin: a block that reads input gets end-of-file.
- **Output** is kept only in the widget, never written to the note. It survives edits to the block (the widget keeps its DOM) and is cleared by the next Run. stderr is shown in red.
- **Stop** kills the run's whole process group (`SIGKILL`), so children such as `sleep` stop too.
- **Limits:** a run that prints more than 1 MiB (stdout + stderr) is stopped and the panel says so.
- **Lifetime:** closing or switching away from the note's tab destroys the widget, which stops its run.

## Design

- `shared/code-runtimes.json` maps fence language → interpreter. The editor reads it to decide where to show Run; `commands/run.rs` has the same table and a test keeps the two equal.
- `commands/run.rs`
  - `run_code(runId, lang, code, cwd, onEvent: Channel<RunEvent>)` spawns `<interpreter> -c <code>` in its own process group. Two reader threads stream chunks (UTF-8 split across reads is carried, not mangled); a waiter thread sends `exit { code, cancelled, truncated }`.
  - `cancel_run(runId)` marks the run cancelled and kills its process group.
  - `RunRegistry` (managed state) maps run id → pid.
- `components/editor-area/code-run-decorations.ts` owns the widget: Run/Stop button, status, output `<pre>`. Events from a superseded run id are dropped.

## Adding a language

Add the entry to `shared/code-runtimes.json` and to `RUNTIMES` in `commands/run.rs`. An interpreter that doesn't take `-c <code>` needs a per-runtime argument shape in `run.rs`.

## Non-goals (this version)

- Shared state between blocks, variables across blocks or languages.
- Interactive stdin, a terminal/TTY, colours (ANSI codes show raw).
- Saving output into the note.
- Running from Reading/preview surfaces other than the editor, or a Run All command.
