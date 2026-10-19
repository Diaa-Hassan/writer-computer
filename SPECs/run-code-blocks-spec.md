# Run Code Blocks Spec

## Summary

A ` ```bash ` fence gets a **▶ Run** pill in its top-right corner. Clicking it (or **⌥↵** with the caret in the block) runs the block's code as a child process and streams stdout and stderr into an output tray attached under the block, then shows how it ended. While it runs the pill reads **■ Stop** and kills the run.

## Languages

| Fence (aliases)              | Tools tried, first installed wins                  | How the code is passed                                                                                       |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `bash`                       | `bash -c`                                          | inline                                                                                                       |
| `zsh`                        | `zsh -c`                                           | inline                                                                                                       |
| `sh` (`shell`)               | `sh -c`                                            | inline                                                                                                       |
| `python` (`py`, `python3`)   | `python3 -u -c`, `python -u -c`                    | inline, unbuffered                                                                                           |
| `javascript` (`js`, `node`)  | `node -e`, `bun -e`, `deno eval`                   | inline                                                                                                       |
| `typescript` (`ts`)          | `bun run`, `deno run -A`, `tsx`                    | temp file `main.ts`                                                                                          |
| `ruby` (`rb`)                | `ruby -e`                                          | inline                                                                                                       |
| `perl` (`pl`)                | `perl -e`                                          | inline                                                                                                       |
| `lua`                        | `lua -e`, `luajit -e`                              | inline                                                                                                       |
| `go` (`golang`)              | `go run`                                           | temp file `main.go` (needs `package main`)                                                                   |
| `swift`                      | `swift`                                            | temp file `main.swift`                                                                                       |
| `applescript` (`osascript`)  | `osascript -e`                                     | inline (macOS)                                                                                               |
| `powershell` (`pwsh`, `ps1`) | `pwsh -NoLogo -NoProfile -NonInteractive -Command` | inline                                                                                                       |
| `r`                          | `Rscript -e`                                       | inline                                                                                                       |
| `php`                        | `php`                                              | temp file `main.php`; `<?php` is added when the block doesn't start with a PHP tag (after a shebang, if any) |
| `csharp` (`cs`, `c#`)        | `dotnet run`                                       | temp file `main.cs` (.NET 10 file-based app; a block's first run builds it, so it takes a few seconds)       |
| `java`                       | `java`                                             | temp file `main.java`, single-file source launch (Java 11+)                                                  |
| `c`                          | `cc`, `gcc`, `clang` (with `-lm`)                  | compiled: `main.c` → `main`, then run                                                                        |
| `cpp` (`c++`, `cxx`)         | `c++`, `g++`, `clang++` (with `-std=c++17`)        | compiled: `main.cpp` → `main`, then run                                                                      |
| `rust` (`rs`)                | `rustc --edition 2021`                             | compiled: `main.rs` → `main`, then run                                                                       |
| `julia` (`jl`)               | `julia -e`                                         | inline                                                                                                       |
| `elixir` (`ex`, `exs`)       | `elixir -e`                                        | inline                                                                                                       |
| `dart`                       | `dart run`                                         | temp file `main.dart`                                                                                        |
| `haskell` (`hs`)             | `runghc`, `runhaskell`                             | temp file `main.hs`                                                                                          |
| `clojure` (`clj`)            | `bb` (Babashka), `clojure -M`                      | temp file `main.clj`                                                                                         |
| `fish`                       | `fish -c`                                          | inline                                                                                                       |
| `nushell` (`nu`)             | `nu -c`                                            | inline                                                                                                       |
| `tcl`                        | `tclsh`                                            | temp file `main.tcl`                                                                                         |
| `sql` (`sqlite`)             | `sqlite3 -header -column :memory:`                 | inline: the block is run against a fresh in-memory SQLite database                                           |

**Compiled languages** run as one `/bin/sh -c 'src=$1; out=$2; shift 2; "$0" "$src" -o "$out" "$@" && exec "$out"' <compiler> main.c main <flags>`: a compile error is the run's stderr and exit code, and on success the shell is replaced by the program. Both steps share the run's process group, so Stop and the time limit cover the compiler too. Every run also gets `DOTNET_NOLOGO=1` so dotnet's first-run banner stays out of the output.

**Works on any machine.** Nothing assumes a particular setup:

- **PATH** comes from the user's login shell (`$SHELL -ilc`, fish-aware), asked once on the first run and cached, so tools from Homebrew, nvm, pyenv, asdf, bun… resolve exactly as in Terminal. Never asked at startup (an interactive shell runs the user's rc files). If the shell doesn't answer within 5 s, the app's own PATH plus `/opt/homebrew/{bin,sbin}` and `/usr/local/bin` is used.
- **Tool fallbacks:** each language lists alternatives; the first found on that PATH runs. When none is installed the tray says which to install: "Can't run TypeScript: install `bun` or `deno` or `tsx` (or make sure your shell's PATH includes it)".
- **Temp files** live in `$TMPDIR/writer-run-<run id>/` and are removed when the run ends. The run id names the directory, so the backend rejects ids that aren't `[A-Za-z0-9-]`.

Known limits: Ruby, Perl and Lua buffer output when it isn't a terminal, so their output may arrive in batches rather than line by line.

## Behaviour

- **Where it shows:** under every closed fence whose info string's first word is a runnable language (`bash`, case-insensitive, extra words like `title=x` ignored) and whose body is not blank. An unclosed fence (still being typed) gets nothing.
- **Never automatic.** Nothing runs on open, on edit or on save; only a click on Run starts a process.
- **The fence stays plain source.** The widget sits below the fence (`Decoration.widget` at `node.to`, `keepDecorationOnUnfold`), so editing the code is unchanged.
- **Working directory:** the note's folder. Falls back to the app's working directory when the note has no path or the folder is gone.
- **Environment:** the app's environment with `PATH` replaced by the login shell's (see Languages).
- **Run control:** a quiet `▶ Run` pill floated into the fence's first line (the hidden ```marker line), so it sits in the block's top-right corner. While running it becomes an accent-tinted`■ Stop`. **⌥↵** (Alt+Enter) runs or stops the runnable block containing the caret; it falls through when the caret isn't in one.
- **Output tray:** appears only after the first run, attached to the block's bottom edge (the last code line loses its bottom radius, the tray continues the code surface with a hairline divider). Header: status dot + text — `Running · 3.2s` (pulsing accent dot, live timer; no pulse under reduced motion), `Done · 120ms` (green), `Exit 2 · 40ms` (red), `Stopped · 4.1s` — and actions Copy output, Run again (hidden while running) and Clear (removes the tray; stops the run if it is still going). Body: stdout, stderr in red, terminal colours drawn (see Colours), `No output` when the run printed nothing. The body caps at 22em and scrolls; it follows new output only while scrolled to the bottom.
- **Output lifetime:** kept in memory, never written to the note. It belongs to the fence, not to the widget DOM: the fence's start carries a mark (a `RangeSet` in editor state, mapped through edits) holding the id of its latest run, so output survives edits and scrolling the block out of view. Re-running replaces it. The run is stopped and its output dropped when the mark goes away: the fence is deleted, Clear is pressed, the editor reuses the tab for another document, or the tab is closed. Switching tabs does not: inactive tabs stay mounted, so their runs continue.
- **Stop** kills the run's whole process group (`SIGKILL`), so children such as `sleep` stop too.
- **Limits:** a run that prints more than 1 MiB (stdout + stderr) is stopped and the panel says so.

## Run All

- **Commands** (⌘P, shown only when the visible note has runnable blocks): **Run All Code Blocks** (also **⌥⇧↵**), **Run Code Blocks Above Cursor** (blocks that end before the caret, so not the one the caret is in), and **Stop All Code Runs** (while anything in the note is running).
- Blocks run **one at a time, top to bottom**, each scrolled into view as it starts, and the sequence **stops at the first block that fails or is stopped**. A block that is already running is waited for, not restarted.
- Edits during a Run All don't derail it: the queued fence positions are mapped through every change, a block deleted meanwhile is skipped.
- The palette acts on the visible tab's editor (`activeEditorView`: inactive panes stay mounted but carry `invisible`; a compact window has a single editor).

## Settings (Settings → Code)

All three are `"scope": "global"`, and a Rust test fails if that ever changes. Workspace settings live in `<folder>/.writer/config`, inside the folder, so a workspace-scoped run setting would let a cloned repo turn running on or point a language at a binary it ships. `Settings::get` already ignores workspace values for global keys.

- **Run Code Blocks** (`code.run-enabled`, default on). Off: no Run buttons, trays, shortcuts or palette commands (the editor mirrors the setting into `enabledField` through a store subscription, so it applies to open notes at once), running blocks are stopped, and the backend refuses `run_code` with "Running code is turned off in Settings".
- **Run Time Limit** (`code.timeout-seconds`, default 0 = none). A watchdog kills the run's process group when it's exceeded; the tray shows `Time limit reached · 30.0s` in red, and Run All stops there.
- **Interpreters** (`code.interpreters`, list of `language=absolute path`, language may be an alias). Replaces the PATH lookup for that language. The tool whose program name matches the file name supplies the arguments (`typescript=/opt/homebrew/bin/deno` → `deno run -A`), otherwise the language's first tool (`python=/…/.venv/bin/python3.12` → `-u -c`). A malformed entry or a path that isn't an existing absolute file is reported in the tray instead of falling back silently.

## Trusted Folders

- The first Run in a folder doesn't run: the backend checks the note's **trust folder** (the workspace root when the note is inside the open workspace, otherwise the note's own folder) against **Trusted Folders** (`code.trusted-folders`, global scope like the other code settings) and answers `{ status: "needsTrust", folder }` without starting anything.
- The tray then shows _Waiting for permission_: "Code hasn't run in this folder before. It runs as you, with access to your files, so only allow folders whose code you trust.", the folder path, and **Allow this folder** / **Cancel**. The corner pill reads Stop, and Stop/⌥↵ cancel the prompt too.
- **Allow** appends the folder to Trusted Folders (through the settings store, the one write path) and starts every block waiting on that folder; a Run All that was waiting carries on. **Cancel** ends the block as Stopped and stops the Run All.
- Trusting a folder trusts its subfolders (`starts_with` on canonical paths, so symlinked paths like `/tmp` → `/private/tmp` match, and `/x/ab` is not inside `/x/a`). Relative or empty entries never match. Notes that were never saved (no folder) run without asking: the text is the user's own.
- Trusted Folders is editable in Settings → Code; removing an entry makes Writer ask again.
- Single-entry list settings: the config file writes a list as one `key = value` line per item, so a one-item list used to read back from disk as a string and the trust check saw no folders. The parser now uses the schema default's type (`List`) to keep it a list; this also fixes one-entry Interpreters and File Associations.

## Block options

Words after the language in the info string, parsed by the editor (`parseFenceOptions`); anything else (titles, `{1,3}`, other tools' flags) is ignored:

| Option                  | Effect                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd=<dir>` (or `dir=`) | Run in that folder: absolute, `~/…`, or relative to the note's folder. Quotes allow spaces (`cwd="my app"`). A folder that doesn't exist, or a relative path in a never-saved note, is reported in the tray. Trust is still decided for the note's folder: `cwd=` only moves where allowed code runs (the code could `cd` anyway). |
| `timeout=<seconds>`     | This block's time limit, overriding Settings → Run Time Limit; `0` means none. `30s` is accepted.                                                                                                                                                                                                                                  |
| `color` (`colour`)      | Sets `TERM=xterm-256color`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `PY_COLORS` and git's `color.ui=always` (via `GIT_CONFIG_*`), so tools that check for a terminal colour their output anyway.                                                                                                                              |
| `skip`                  | Run All passes this block by; its own Run button still works.                                                                                                                                                                                                                                                                      |

## Colours

`ansi.ts` turns output into styled segments: SGR codes give the 16 palette colours (theme-tuned variables `--ansi-0…15`, separate light and dark palettes so "white" stays readable on light), 256-colour and truecolor (inline `rgb()`), bold, dim, italic, underline and inverse. Every other escape (cursor moves, line clears, OSC titles and links) and stray ESC characters are dropped. Style carries across chunks, and an escape cut off at a read boundary is held until its end arrives. Copy output copies the plain text.

## Input

- A run's stdin is a pipe. While it runs, the tray shows an input line under the output: **Enter** sends the line (plus `\n`) through `write_run_stdin` and echoes it into the output in the accent colour, as a terminal would; **⌃D** or **End input** calls `close_run_stdin`, so the program reads end-of-file. The line hides when input is ended or the run finishes.
- **Passwords:** when the last printed line looks like a password prompt (`password`, `passphrase`, `PIN`, `secret`), the field becomes a password field and the typed text isn't echoed (only the newline).
- **sudo** in bash, zsh and sh blocks is wrapped as `sudo() { command sudo -S "$@"; }; ` on the block's first line (line numbers unchanged), so it reads the password from the input line instead of needing a terminal.
- A block that waits for input waits, including during Run All; Stop and the time limit still apply. Writes happen off the registry lock, so a program that never reads can't block Stop.

## Design

- `shared/code-runtimes.json` maps every fence language and alias → runtime id. The editor reads it to decide where to show Run and sends the id; `RUNTIMES` in `commands/run.rs` holds each runtime's tools. A test checks every mapped id exists and every runtime is reachable under its own name.
- `commands/run.rs`
  - `run_code(runId, lang, code, cwd, onEvent: Channel<RunEvent>)` spawns `<interpreter> -c <code>` in its own process group. Two reader threads stream chunks (UTF-8 split across reads is carried, not mangled); a waiter thread sends `exit { code, cancelled, truncated }`.
  - `cancel_run(runId)` marks the run cancelled and kills its process group.
  - `RunRegistry` (managed state) maps run id → pid.
- `components/editor-area/code-run-decorations.ts` owns the UI: `runsField` (fence → run id marks), `decorationsField` (corner toggle widget at the fence start, tray block widget at its end, rebuilt on doc/tree changes and run effects), `runLifecycle` (stops and forgets runs whose mark disappeared), the Alt-Enter keymap, and the session store holding each run's output. Events from a superseded run id are dropped.

## Adding a language

Add a `Runtime` to `RUNTIMES` in `commands/run.rs` (its tools, each `inline(program, args)` or `file(program, args, ext)`), and map the fence name and any aliases to its id in `shared/code-runtimes.json`. Use `compile(program, flags, ext)` for a compiler that takes `<source> -o <binary>`; a tool's optional `prepare` rewrites the code first (see `php_open_tag`).

## Non-goals (this version)

- Shared state between blocks, variables across blocks or languages.
- A terminal/TTY (programs see pipes; `color` covers the common colour switches), carriage-return progress bars redrawing in place.
- Saving output into the note.
- Running from Reading/preview surfaces other than the editor.
