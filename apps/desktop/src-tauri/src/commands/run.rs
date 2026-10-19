//! Runs the code inside a fenced block (```bash) as a child process and
//! streams its output back to the editor widget over a Tauri channel.
//!
//! Nothing here runs on its own: a run starts only from the widget's Run
//! button. Each run is a fresh process; there is no shared session.
//!
//! Interpreters are found on the user's login-shell PATH (see `user_path`),
//! so tools installed through nvm, pyenv, bun or asdf resolve the same way
//! they do in Terminal.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use crate::config::ConfigValue;
use crate::error::AppError;
use crate::state::AppState;

/// Output past this many bytes (stdout + stderr) stops the run, so a runaway
/// loop can't flood the webview.
const OUTPUT_LIMIT: usize = 1024 * 1024;

/// How a runtime receives the block's code.
#[derive(Debug, PartialEq)]
enum Source {
    /// As the last argument: `bash -c <code>`.
    Inline,
    /// Written to `main.<ext>` in a per-run temp dir, whose path is the last
    /// argument: `go run /tmp/…/main.go`. For tools that only read files.
    File(&'static str),
    /// Written to `main.<ext>`, compiled to `main` next to it, then run:
    /// `cc main.c -o main <args…> && exec ./main`, both under one `sh` so
    /// Stop and the time limit cover the compiler and the program alike.
    Compile(&'static str),
}

/// Compiles `$1` to `$2` with the compiler in `$0` (extra flags follow),
/// then replaces the shell with the program.
const COMPILE_SCRIPT: &str =
    r#"src="$1"; out="$2"; shift 2; "$0" "$src" -o "$out" "$@" && exec "$out""#;

/// Set for every run. dotnet prints a first-run banner into the output
/// otherwise.
const RUN_ENV: &[(&str, &str)] = &[("DOTNET_NOLOGO", "1")];

/// One way to run a language: a program, its arguments, and how it takes
/// the code.
struct Tool {
    program: &'static str,
    args: &'static [&'static str],
    source: Source,
    /// Rewrites the block before it is written or passed (PHP's open tag).
    prepare: Option<fn(&str) -> String>,
}

const fn inline(program: &'static str, args: &'static [&'static str]) -> Tool {
    Tool {
        program,
        args,
        source: Source::Inline,
        prepare: None,
    }
}

const fn file(program: &'static str, args: &'static [&'static str], ext: &'static str) -> Tool {
    Tool {
        program,
        args,
        source: Source::File(ext),
        prepare: None,
    }
}

const fn compile(program: &'static str, args: &'static [&'static str], ext: &'static str) -> Tool {
    Tool {
        program,
        args,
        source: Source::Compile(ext),
        prepare: None,
    }
}

/// PHP files print anything outside `<?php`, so a block written without the
/// tag gets one (after a shebang line, if there is one).
fn php_open_tag(code: &str) -> String {
    let body_start = if code.starts_with("#!") {
        code.find('\n').map_or(code.len(), |i| i + 1)
    } else {
        0
    };
    if code[body_start..].trim_start().starts_with("<?") {
        return code.to_owned();
    }
    format!("{}<?php\n{}", &code[..body_start], &code[body_start..])
}

/// A language and the tools that can run it, in order of preference. A run
/// uses the first tool installed on the user's PATH, so the same note works
/// on machines set up differently (bun here, deno there).
struct Runtime {
    id: &'static str,
    label: &'static str,
    tools: &'static [Tool],
}

/// Every runtime, by id. `shared/code-runtimes.json` maps fence languages and
/// their aliases (`py`, `js`, …) to these ids; the editor reads it to decide
/// where to show Run, and a test keeps the two in sync.
const RUNTIMES: &[Runtime] = &[
    Runtime {
        id: "bash",
        label: "Bash",
        tools: &[inline("bash", &["-c"])],
    },
    Runtime {
        id: "zsh",
        label: "Zsh",
        tools: &[inline("zsh", &["-c"])],
    },
    Runtime {
        id: "sh",
        label: "sh",
        tools: &[inline("sh", &["-c"])],
    },
    Runtime {
        id: "python",
        label: "Python",
        // -u: unbuffered, so output streams instead of arriving at exit.
        tools: &[
            inline("python3", &["-u", "-c"]),
            inline("python", &["-u", "-c"]),
        ],
    },
    Runtime {
        id: "javascript",
        label: "JavaScript",
        tools: &[
            inline("node", &["-e"]),
            inline("bun", &["-e"]),
            inline("deno", &["eval"]),
        ],
    },
    Runtime {
        id: "typescript",
        label: "TypeScript",
        tools: &[
            file("bun", &["run"], "ts"),
            // -A: deno sandboxes by default; every other runtime here has the
            // user's full access, so match that.
            file("deno", &["run", "-A"], "ts"),
            file("tsx", &[], "ts"),
        ],
    },
    Runtime {
        id: "ruby",
        label: "Ruby",
        tools: &[inline("ruby", &["-e"])],
    },
    Runtime {
        id: "perl",
        label: "Perl",
        tools: &[inline("perl", &["-e"])],
    },
    Runtime {
        id: "lua",
        label: "Lua",
        tools: &[inline("lua", &["-e"]), inline("luajit", &["-e"])],
    },
    Runtime {
        id: "go",
        label: "Go",
        tools: &[file("go", &["run"], "go")],
    },
    Runtime {
        id: "swift",
        label: "Swift",
        tools: &[file("swift", &[], "swift")],
    },
    Runtime {
        id: "applescript",
        label: "AppleScript",
        tools: &[inline("osascript", &["-e"])],
    },
    Runtime {
        id: "powershell",
        label: "PowerShell",
        tools: &[inline(
            "pwsh",
            &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
        )],
    },
    Runtime {
        id: "r",
        label: "R",
        tools: &[inline("Rscript", &["-e"])],
    },
    Runtime {
        id: "php",
        label: "PHP",
        tools: &[Tool {
            program: "php",
            args: &[],
            source: Source::File("php"),
            prepare: Some(php_open_tag),
        }],
    },
    Runtime {
        id: "csharp",
        label: "C#",
        // .NET 10 runs a single .cs file directly.
        tools: &[file("dotnet", &["run"], "cs")],
    },
    Runtime {
        id: "java",
        label: "Java",
        // Single-file source launch (Java 11+): no javac step needed.
        tools: &[file("java", &[], "java")],
    },
    Runtime {
        id: "c",
        label: "C",
        // -lm: Linux keeps libm separate; harmless on macOS.
        tools: &[
            compile("cc", &["-lm"], "c"),
            compile("gcc", &["-lm"], "c"),
            compile("clang", &["-lm"], "c"),
        ],
    },
    Runtime {
        id: "cpp",
        label: "C++",
        tools: &[
            compile("c++", &["-std=c++17"], "cpp"),
            compile("g++", &["-std=c++17"], "cpp"),
            compile("clang++", &["-std=c++17"], "cpp"),
        ],
    },
    Runtime {
        id: "rust",
        label: "Rust",
        tools: &[compile("rustc", &["--edition", "2021"], "rs")],
    },
    Runtime {
        id: "julia",
        label: "Julia",
        tools: &[inline("julia", &["-e"])],
    },
    Runtime {
        id: "elixir",
        label: "Elixir",
        tools: &[inline("elixir", &["-e"])],
    },
    Runtime {
        id: "dart",
        label: "Dart",
        tools: &[file("dart", &["run"], "dart")],
    },
    Runtime {
        id: "haskell",
        label: "Haskell",
        tools: &[file("runghc", &[], "hs"), file("runhaskell", &[], "hs")],
    },
    Runtime {
        id: "clojure",
        label: "Clojure",
        // Babashka starts in milliseconds; the JVM clojure CLI is the fallback.
        tools: &[file("bb", &[], "clj"), file("clojure", &["-M"], "clj")],
    },
    Runtime {
        id: "fish",
        label: "fish",
        tools: &[inline("fish", &["-c"])],
    },
    Runtime {
        id: "nushell",
        label: "Nushell",
        tools: &[inline("nu", &["-c"])],
    },
    Runtime {
        id: "tcl",
        label: "Tcl",
        tools: &[file("tclsh", &[], "tcl")],
    },
    Runtime {
        id: "sql",
        label: "SQL",
        // An in-memory SQLite database per run; the block is the SQL to run.
        tools: &[inline("sqlite3", &["-header", "-column", ":memory:"])],
    },
];

/// How long to wait for the login shell to report its PATH.
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const PATH_MARKER: &str = "__WRITER_PATH__";

/// GUI apps on macOS don't inherit the login shell's PATH, so Homebrew tools
/// would be missing from every run without these.
const EXTRA_PATHS: &[&str] = &["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum RunEvent {
    Stdout(String),
    Stderr(String),
    #[serde(rename_all = "camelCase")]
    Exit {
        code: Option<i32>,
        cancelled: bool,
        truncated: bool,
        timed_out: bool,
    },
}

struct RunHandle {
    pid: u32,
    cancelled: Arc<AtomicBool>,
}

/// Live runs keyed by the id the widget generated, so Stop can find them.
#[derive(Default)]
pub struct RunRegistry(Mutex<HashMap<String, RunHandle>>);

fn runtime(id: &str) -> Option<&'static Runtime> {
    RUNTIMES.iter().find(|r| r.id == id)
}

/// Absolute path of `program` in the first PATH entry that has it.
fn find_program(program: &str, path: &OsString) -> Option<PathBuf> {
    std::env::split_paths(path).find_map(|dir| {
        let candidate = dir.join(program);
        #[cfg(windows)]
        let candidate = candidate.with_extension("exe");
        candidate.is_file().then_some(candidate)
    })
}

/// The first of the runtime's tools that is installed, with its path.
fn resolve_tool(
    runtime: &'static Runtime,
    path: &OsString,
) -> Result<(&'static Tool, PathBuf), AppError> {
    runtime
        .tools
        .iter()
        .find_map(|tool| find_program(tool.program, path).map(|found| (tool, found)))
        .ok_or_else(|| {
            let names: Vec<_> = runtime
                .tools
                .iter()
                .map(|t| format!("`{}`", t.program))
                .collect();
            AppError::Message(format!(
                "Can't run {}: install {} (or make sure your shell's PATH includes it)",
                runtime.label,
                names.join(" or ")
            ))
        })
}

/// PATH as the user's login shell sets it, plus the Homebrew folders. Asked
/// once, on the first run (never at startup: an interactive shell runs the
/// user's rc files), and cached; falls back to the app's own PATH when the
/// shell doesn't answer in time.
fn user_path() -> &'static OsString {
    static USER_PATH: OnceLock<OsString> = OnceLock::new();
    USER_PATH
        .get_or_init(|| path_with_extras(login_shell_path().or_else(|| std::env::var_os("PATH"))))
}

fn login_shell_path() -> Option<OsString> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = if Path::new(&shell).file_name().is_some_and(|n| n == "fish") {
        // fish keeps PATH as a list; "$PATH" would join it with spaces.
        format!("printf '{PATH_MARKER}%s{PATH_MARKER}' (string join : $PATH)")
    } else {
        format!("printf '{PATH_MARKER}%s{PATH_MARKER}' \"$PATH\"")
    };
    let mut command = Command::new(&shell);
    // -i as well as -l: version managers usually hook in from .zshrc/.bashrc.
    command
        .arg("-ilc")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(LOGIN_SHELL_TIMEOUT);
    kill_group(child.id());
    let _ = child.wait();
    marked_path(&out.ok()?)
}

/// The text between the first two markers; rc files may print around it.
fn marked_path(out: &str) -> Option<OsString> {
    let mut parts = out.split(PATH_MARKER);
    parts.next()?;
    let path = parts.next()?;
    (parts.next().is_some() && !path.is_empty()).then(|| path.into())
}

fn path_with_extras(current: Option<OsString>) -> OsString {
    let mut parts: Vec<std::path::PathBuf> = current
        .as_deref()
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    for extra in EXTRA_PATHS.iter().rev() {
        if !parts.iter().any(|p| p == Path::new(extra)) {
            parts.insert(0, extra.into());
        }
    }
    std::env::join_paths(parts).unwrap_or_default()
}

/// Split `buf` into the longest valid UTF-8 prefix and the bytes of a
/// multi-byte character cut off at the end of a read. Invalid bytes in the
/// middle are replaced, not carried.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let out = s.to_owned();
            buf.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            let rest = buf.split_off(e.valid_up_to());
            let out = String::from_utf8_lossy(buf).into_owned();
            *buf = rest;
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            out
        }
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    // The child leads its own process group, so this also stops anything it
    // spawned (`sleep`, pipelines). ESRCH just means it already exited.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

// ---------------------------------------------------------------------------
// Settings (all global-scope in the schema, so a workspace's own
// `.writer/config` can't turn running on or point a language at its binary)
// ---------------------------------------------------------------------------

const ENABLED_KEY: &str = "code.run-enabled";
const TIMEOUT_KEY: &str = "code.timeout-seconds";
const INTERPRETERS_KEY: &str = "code.interpreters";
const TRUSTED_KEY: &str = "code.trusted-folders";

struct RunSettings {
    enabled: bool,
    timeout: Option<Duration>,
    interpreters: Vec<String>,
    trusted: Vec<String>,
}

fn list_setting(settings: &crate::config::Settings, key: &str) -> Vec<String> {
    match settings.get(key) {
        Some(ConfigValue::List(entries)) => entries.clone(),
        _ => Vec::new(),
    }
}

fn run_settings(app: &tauri::AppHandle, label: &str) -> Result<RunSettings, AppError> {
    let state = app.state::<AppState>().get_or_create(label);
    let guard = state.settings.read();
    let settings = guard
        .as_ref()
        .ok_or_else(|| AppError::Io("Settings not initialized".into()))?;
    let timeout = settings
        .get(TIMEOUT_KEY)
        .and_then(ConfigValue::as_f64)
        .filter(|secs| secs.is_finite() && *secs > 0.0)
        .map(Duration::from_secs_f64);
    Ok(RunSettings {
        enabled: settings
            .get(ENABLED_KEY)
            .and_then(ConfigValue::as_bool)
            .unwrap_or(true),
        timeout,
        interpreters: list_setting(settings, INTERPRETERS_KEY),
        trusted: list_setting(settings, TRUSTED_KEY),
    })
}

/// Options written in the fence's info string (` ```bash cwd=../app timeout=30
/// color `), parsed by the editor.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunOptions {
    /// Folder to run in: absolute, `~/…`, or relative to the note's folder.
    dir: Option<String>,
    /// Seconds before the run is stopped; overrides the global time limit,
    /// and 0 means no limit for this block.
    timeout_seconds: Option<f64>,
    /// Ask tools to colour their output although it isn't a terminal.
    color: bool,
}

/// Environment that makes common tools emit colour when stdout is a pipe:
/// Node/chalk, BSD `ls`, pytest, git, and anything that checks TERM.
const COLOR_ENV: &[(&str, &str)] = &[
    ("TERM", "xterm-256color"),
    ("FORCE_COLOR", "1"),
    ("CLICOLOR", "1"),
    ("CLICOLOR_FORCE", "1"),
    ("PY_COLORS", "1"),
    ("GIT_CONFIG_COUNT", "1"),
    ("GIT_CONFIG_KEY_0", "color.ui"),
    ("GIT_CONFIG_VALUE_0", "always"),
];

/// The folder a `cwd=` option names, resolved against the note's folder.
fn option_dir(dir: &str, note_dir: Option<&Path>) -> Result<PathBuf, AppError> {
    let expanded = match dir
        .strip_prefix("~/")
        .or(if dir == "~" { Some("") } else { None })
    {
        Some(rest) => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .ok_or_else(|| AppError::Message("cwd=~: HOME isn't set".into()))?,
        None => PathBuf::from(dir),
    };
    let path = if expanded.is_absolute() {
        expanded
    } else {
        note_dir
            .ok_or_else(|| {
                AppError::Message(format!(
                    "cwd={dir}: save the note first, or use an absolute path"
                ))
            })?
            .join(expanded)
    };
    match std::fs::canonicalize(&path) {
        Ok(found) if found.is_dir() => Ok(found),
        _ => Err(AppError::Message(format!(
            "cwd={dir}: {} isn't a folder",
            path.display()
        ))),
    }
}

/// The time limit for a run: the block's own, else the global setting.
fn run_timeout(options: &RunOptions, setting: Option<Duration>) -> Option<Duration> {
    match options.timeout_seconds {
        Some(secs) if secs.is_finite() && secs > 0.0 => Some(Duration::from_secs_f64(secs)),
        Some(0.0) => None,
        _ => setting,
    }
}

/// What run_code did: started the run, or declined because the folder hasn't
/// been trusted yet (the editor asks, adds it to Trusted Folders, retries).
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RunStart {
    Started,
    NeedsTrust { folder: String },
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The folder a run's trust is decided for: the workspace when the note is
/// inside it, otherwise the note's own folder (a file opened on its own).
fn trust_folder(cwd: &Path, workspace_root: Option<&Path>) -> PathBuf {
    let cwd = canonical(cwd);
    match workspace_root.map(canonical) {
        Some(root) if cwd.starts_with(&root) => root,
        _ => cwd,
    }
}

/// Trusting a folder trusts everything below it.
fn is_trusted(folder: &Path, trusted: &[String]) -> bool {
    trusted.iter().map(|entry| entry.trim()).any(|entry| {
        !entry.is_empty()
            && Path::new(entry).is_absolute()
            && folder.starts_with(canonical(Path::new(entry)))
    })
}

/// Fence language (or alias) → runtime id, from the shared contract.
fn runtime_id_for(lang: &str) -> Option<&'static str> {
    static LANGS: OnceLock<HashMap<String, String>> = OnceLock::new();
    LANGS
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../../shared/code-runtimes.json"))
                .expect("shared/code-runtimes.json is valid")
        })
        .get(&lang.trim().to_ascii_lowercase())
        .map(String::as_str)
}

/// The user's `language=path` override for `runtime`, if any: the program
/// to run and which of the runtime's tools it is (matched by file name, so
/// `typescript=/opt/deno` gets deno's arguments; otherwise the first tool's).
fn interpreter_override(
    entries: &[String],
    runtime: &'static Runtime,
) -> Option<Result<(&'static Tool, PathBuf), AppError>> {
    entries.iter().find_map(|entry| {
        let entry = entry.trim();
        if entry.is_empty() {
            return None;
        }
        let Some((lang, path)) = entry.split_once('=') else {
            return Some(Err(AppError::Message(format!(
                "Interpreter setting `{entry}` should look like language=/path/to/program"
            ))));
        };
        if runtime_id_for(lang) != Some(runtime.id) {
            return None;
        }
        let path = PathBuf::from(path.trim());
        if !path.is_absolute() || !path.is_file() {
            return Some(Err(AppError::Message(format!(
                "The {} interpreter in Settings doesn't exist: {}",
                runtime.label,
                path.display()
            ))));
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let tool = runtime
            .tools
            .iter()
            .find(|tool| tool.program == name)
            .unwrap_or(&runtime.tools[0]);
        Some(Ok((tool, path)))
    })
}

/// The process to spawn for `tool`: the program itself, or for compiled
/// languages a shell that compiles and then execs the result. `file` is the
/// written source for File/Compile tools.
fn tool_command(tool: &Tool, program: &Path, code: &str, file: Option<&Path>) -> Command {
    match (&tool.source, file) {
        (Source::Compile(_), Some(file)) => {
            let mut command = Command::new("/bin/sh");
            command
                .arg("-c")
                .arg(COMPILE_SCRIPT)
                .arg(program)
                .arg(file)
                .arg(file.with_extension(""))
                .args(tool.args);
            command
        }
        (_, Some(file)) => {
            let mut command = Command::new(program);
            command.args(tool.args).arg(file);
            command
        }
        (_, None) => {
            let mut command = Command::new(program);
            command.args(tool.args).arg(code);
            command
        }
    }
}

/// Writes the block to `main.<ext>` in a temp dir named after the run.
fn write_source(run_id: &str, ext: &str, code: &str) -> Result<(PathBuf, PathBuf), AppError> {
    // The id names a directory, so it must not be able to climb out of it.
    if run_id.is_empty()
        || !run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(AppError::InvalidPath(format!("bad run id `{run_id}`")));
    }
    let dir = std::env::temp_dir().join(format!("writer-run-{run_id}"));
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("main.{ext}"));
    std::fs::write(&file, code)?;
    Ok((dir, file))
}

// `async` keeps it off the main thread: the first run waits for the login
// shell's PATH.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn run_code(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    run_id: String,
    lang: String,
    code: String,
    cwd: Option<String>,
    options: Option<RunOptions>,
    on_event: Channel<RunEvent>,
    registry: State<'_, Arc<RunRegistry>>,
) -> Result<RunStart, AppError> {
    let options = options.unwrap_or_default();
    let settings = run_settings(&app, webview.label())?;
    if !settings.enabled {
        return Err(AppError::Message(
            "Running code is turned off in Settings (Code → Run Code Blocks)".into(),
        ));
    }
    let cwd = cwd.filter(|dir| Path::new(dir).is_dir());
    // A note that was never saved has no folder; it is the user's own text.
    if let Some(dir) = cwd.as_deref() {
        let workspace = app
            .state::<AppState>()
            .get_or_create(webview.label())
            .workspace_snapshot()
            .map(|(root, _)| root);
        let folder = trust_folder(Path::new(dir), workspace.as_deref());
        if !is_trusted(&folder, &settings.trusted) {
            return Ok(RunStart::NeedsTrust {
                folder: folder.to_string_lossy().into_owned(),
            });
        }
    }
    // Trust was decided for the note's folder above; `cwd=` only moves where
    // the already-allowed code runs.
    let run_dir = match options.dir.as_deref() {
        Some(dir) => Some(option_dir(dir, cwd.as_deref().map(Path::new))?),
        None => cwd.as_deref().map(PathBuf::from),
    };
    let runtime =
        runtime(&lang).ok_or_else(|| AppError::Unsupported(format!("no runtime for `{lang}`")))?;
    let path = user_path();
    let (tool, program_path) = match interpreter_override(&settings.interpreters, runtime) {
        Some(found) => found?,
        None => resolve_tool(runtime, path)?,
    };
    let program = tool.program;
    let code = match tool.prepare {
        Some(prepare) => prepare(&code),
        None => code,
    };
    let temp_dir = match tool.source {
        Source::Inline => None,
        Source::File(ext) | Source::Compile(ext) => Some(write_source(&run_id, ext, &code)?),
    };
    let cleanup = move |dir: Option<(PathBuf, PathBuf)>| {
        if let Some((dir, _)) = dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    };

    let mut command = tool_command(
        tool,
        &program_path,
        &code,
        temp_dir.as_ref().map(|(_, f)| f.as_path()),
    );
    command
        .env("PATH", path)
        .envs(RUN_ENV.iter().copied())
        .envs(if options.color { COLOR_ENV } else { &[] }.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = run_dir.as_deref() {
        command.current_dir(dir);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            cleanup(temp_dir);
            return Err(AppError::Io(format!("failed to start {program}: {e}")));
        }
    };
    let pid = child.id();
    let cancelled = Arc::new(AtomicBool::new(false));
    registry.0.lock().insert(
        run_id.clone(),
        RunHandle {
            pid,
            cancelled: cancelled.clone(),
        },
    );

    let total = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    let readers: Vec<_> = [
        (
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
            true,
        ),
        (
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
            false,
        ),
    ]
    .into_iter()
    .filter_map(|(stream, is_stdout)| stream.map(|s| (s, is_stdout)))
    .map(|(mut stream, is_stdout)| {
        let channel = on_event.clone();
        let total = total.clone();
        let truncated = truncated.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                let n = match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                if total.fetch_add(n, Ordering::Relaxed) + n > OUTPUT_LIMIT {
                    truncated.store(true, Ordering::Relaxed);
                    kill_group(pid);
                    break;
                }
                pending.extend_from_slice(&chunk[..n]);
                let text = take_utf8(&mut pending);
                if text.is_empty() {
                    continue;
                }
                let event = if is_stdout {
                    RunEvent::Stdout(text)
                } else {
                    RunEvent::Stderr(text)
                };
                if channel.send(event).is_err() {
                    // The widget is gone (tab closed, app reloading).
                    kill_group(pid);
                    break;
                }
            }
        })
    })
    .collect();

    // Time limit: a watchdog that kills the group unless the run ends first.
    let timed_out = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    if let Some(limit) = run_timeout(&options, settings.timeout) {
        let timed_out = timed_out.clone();
        std::thread::spawn(move || {
            if done_rx.recv_timeout(limit) == Err(mpsc::RecvTimeoutError::Timeout) {
                timed_out.store(true, Ordering::Relaxed);
                kill_group(pid);
            }
        });
    }

    let registry = registry.inner().clone();
    std::thread::spawn(move || {
        for reader in readers {
            let _ = reader.join();
        }
        let code = child.wait().ok().and_then(|status| status.code());
        let _ = done_tx.send(());
        registry.0.lock().remove(&run_id);
        cleanup(temp_dir);
        let _ = on_event.send(RunEvent::Exit {
            code,
            cancelled: cancelled.load(Ordering::Relaxed),
            truncated: truncated.load(Ordering::Relaxed),
            timed_out: timed_out.load(Ordering::Relaxed),
        });
    });

    Ok(RunStart::Started)
}

#[tauri::command]
pub fn cancel_run(run_id: String, registry: State<'_, Arc<RunRegistry>>) {
    if let Some(handle) = registry.0.lock().get(&run_id) {
        handle.cancelled.store(true, Ordering::Relaxed);
        kill_group(handle.pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtimes_match_shared_contract() {
        let shared: std::collections::BTreeMap<String, String> =
            serde_json::from_str(include_str!("../../../shared/code-runtimes.json")).unwrap();
        // Every fence language points at a runtime that exists…
        for (lang, id) in &shared {
            assert_eq!(
                lang,
                &lang.to_ascii_lowercase(),
                "fence names are lowercase"
            );
            assert!(
                runtime(id).is_some(),
                "`{lang}` maps to unknown runtime `{id}`"
            );
        }
        // …and every runtime is reachable under its own name.
        for r in RUNTIMES {
            assert_eq!(
                shared.get(r.id).map(String::as_str),
                Some(r.id),
                "`{}` unreachable",
                r.id
            );
        }
    }

    #[test]
    fn unknown_runtimes_are_rejected() {
        assert!(runtime("bash").is_some());
        assert!(
            runtime("py").is_none(),
            "aliases resolve in the editor, not here"
        );
        assert!(runtime("").is_none());
    }

    #[test]
    fn the_first_installed_tool_wins() {
        let dir = tempfile::tempdir().unwrap();
        let path: OsString = dir.path().into();
        let ts = runtime("typescript").unwrap();

        let err = resolve_tool(ts, &path).err().unwrap().to_string();
        assert!(err.contains("`bun` or `deno` or `tsx`"), "{err}");

        // Only deno and tsx installed: deno is preferred.
        for name in ["deno", "tsx"] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }
        let (tool, found) = resolve_tool(ts, &path).unwrap();
        assert_eq!(tool.program, "deno");
        assert_eq!(found, dir.path().join("deno"));
    }

    #[test]
    fn run_settings_cannot_come_from_a_workspace() {
        // A workspace's `.writer/config` lives inside the folder; if any of
        // these were workspace-scoped, opening a cloned repo could enable
        // running or swap in its own interpreter.
        let schema = crate::config::settings_schema();
        for key in [ENABLED_KEY, TIMEOUT_KEY, INTERPRETERS_KEY, TRUSTED_KEY] {
            let def = schema.iter().find(|d| d.key == key).expect(key);
            assert_eq!(
                def.scope,
                Some(crate::config::SettingScope::Global),
                "{key}"
            );
        }
    }

    #[test]
    fn trust_is_decided_for_the_workspace_or_the_note_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path());
        let notes = root.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();

        assert_eq!(
            trust_folder(&notes, Some(&root)),
            root,
            "inside the workspace"
        );
        assert_eq!(
            trust_folder(elsewhere.path(), Some(&root)),
            canonical(elsewhere.path()),
            "a file outside the workspace is judged by its own folder"
        );
        assert_eq!(trust_folder(&notes, None), notes, "no workspace");
    }

    #[test]
    fn trusting_a_folder_covers_its_subfolders_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path());
        let sub = root.join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        let trusted = vec![format!("  {}  ", root.join("a").display())];

        assert!(is_trusted(&sub, &trusted));
        assert!(is_trusted(&root.join("a"), &trusted));
        assert!(!is_trusted(&root, &trusted), "the parent isn't trusted");
        // `/x/ab` must not count as inside `/x/a`.
        std::fs::create_dir_all(root.join("ab")).unwrap();
        assert!(!is_trusted(&root.join("ab"), &trusted));
        assert!(!is_trusted(&root, &["".into(), "relative/path".into()]));
    }

    #[test]
    fn interpreter_overrides_match_language_or_alias() {
        let dir = tempfile::tempdir().unwrap();
        let deno = dir.path().join("deno");
        let python = dir.path().join("python3.12");
        std::fs::write(&deno, "").unwrap();
        std::fs::write(&python, "").unwrap();
        let entries = vec![
            String::new(),
            format!("ts = {}", deno.display()),
            format!("py={}", python.display()),
        ];

        // Matched by alias; deno's own arguments are used.
        let (tool, path) = interpreter_override(&entries, runtime("typescript").unwrap())
            .unwrap()
            .unwrap();
        assert_eq!((tool.program, path), ("deno", deno));
        // An unrecognised file name falls back to the first tool's arguments.
        let (tool, path) = interpreter_override(&entries, runtime("python").unwrap())
            .unwrap()
            .unwrap();
        assert_eq!((tool.program, path), ("python3", python));
        // No entry for this language: none.
        assert!(interpreter_override(&entries, runtime("ruby").unwrap()).is_none());
    }

    #[test]
    fn bad_interpreter_entries_explain_themselves() {
        let go = runtime("go").unwrap();
        let err = |entries: &[&str]| {
            let entries: Vec<String> = entries.iter().map(|e| e.to_string()).collect();
            interpreter_override(&entries, go)
                .unwrap()
                .err()
                .unwrap()
                .to_string()
        };
        assert!(err(&["go /usr/bin/go"]).contains("language=/path"));
        assert!(err(&["go=relative/go"]).contains("doesn't exist"));
        assert!(err(&["go=/no/such/go"]).contains("doesn't exist"));
    }

    #[test]
    fn cwd_option_resolves_against_the_note_folder() {
        let dir = tempfile::tempdir().unwrap();
        let note = canonical(dir.path()).join("notes");
        let app = canonical(dir.path()).join("app");
        std::fs::create_dir_all(&note).unwrap();
        std::fs::create_dir_all(&app).unwrap();

        assert_eq!(option_dir("../app", Some(&note)).unwrap(), app);
        assert_eq!(option_dir(app.to_str().unwrap(), None).unwrap(), app);
        let missing = option_dir("../nope", Some(&note)).unwrap_err().to_string();
        assert!(missing.contains("isn't a folder"), "{missing}");
        let unsaved = option_dir("app", None).unwrap_err().to_string();
        assert!(unsaved.contains("save the note first"), "{unsaved}");
        if let Some(home) = std::env::var_os("HOME") {
            assert_eq!(option_dir("~", None).unwrap(), canonical(Path::new(&home)));
        }
    }

    #[test]
    fn block_timeout_overrides_the_setting() {
        let setting = Some(Duration::from_secs(60));
        let with = |secs: Option<f64>| RunOptions {
            timeout_seconds: secs,
            ..Default::default()
        };
        assert_eq!(run_timeout(&with(None), setting), setting);
        assert_eq!(
            run_timeout(&with(Some(5.0)), setting),
            Some(Duration::from_secs(5))
        );
        assert_eq!(run_timeout(&with(Some(0.0)), setting), None, "0 = no limit");
        assert_eq!(
            run_timeout(&with(Some(-1.0)), setting),
            setting,
            "nonsense is ignored"
        );
    }

    #[test]
    fn php_blocks_get_an_open_tag_once() {
        assert_eq!(php_open_tag("echo 1;"), "<?php\necho 1;");
        assert_eq!(php_open_tag("<?php echo 1;"), "<?php echo 1;");
        assert_eq!(php_open_tag("  <?= 1 ?>"), "  <?= 1 ?>");
        assert_eq!(
            php_open_tag("#!/usr/bin/env php\necho 1;"),
            "#!/usr/bin/env php\n<?php\necho 1;"
        );
    }

    fn argv(command: &Command) -> Vec<String> {
        std::iter::once(command.get_program())
            .chain(command.get_args())
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn each_source_kind_builds_its_command() {
        let python = &runtime("python").unwrap().tools[0];
        assert_eq!(
            argv(&tool_command(
                python,
                Path::new("/bin/python3"),
                "print(1)",
                None
            )),
            ["/bin/python3", "-u", "-c", "print(1)"]
        );
        let go = &runtime("go").unwrap().tools[0];
        assert_eq!(
            argv(&tool_command(
                go,
                Path::new("/bin/go"),
                "",
                Some(Path::new("/t/main.go"))
            )),
            ["/bin/go", "run", "/t/main.go"]
        );
        let c = &runtime("c").unwrap().tools[0];
        assert_eq!(
            argv(&tool_command(
                c,
                Path::new("/usr/bin/cc"),
                "",
                Some(Path::new("/t/main.c"))
            )),
            [
                "/bin/sh",
                "-c",
                COMPILE_SCRIPT,
                "/usr/bin/cc",
                "/t/main.c",
                "/t/main",
                "-lm"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_compile_script_compiles_then_runs() {
        // A stand-in "compiler" that writes a script to the -o path proves the
        // argument order and the exec, without needing a real toolchain.
        let dir = tempfile::tempdir().unwrap();
        let fake_cc = dir.path().join("fakecc");
        std::fs::write(
            &fake_cc,
            "#!/bin/sh\nprintf '#!/bin/sh\\necho ran %s with %s\\n' \"$1\" \"$4\" > \"$3\"; chmod +x \"$3\"\n",
        )
        .unwrap();
        let src = dir.path().join("main.c");
        std::fs::write(&src, "").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_cc, std::fs::Permissions::from_mode(0o755)).unwrap();

        let tool = compile("fakecc", &["-lm"], "c");
        let out = tool_command(&tool, &fake_cc, "", Some(&src))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            format!("ran {} with -lm\n", src.display())
        );
    }

    #[test]
    fn login_shell_path_is_read_between_markers() {
        let out = format!("rc noise\n{PATH_MARKER}/a:/b{PATH_MARKER}more noise");
        assert_eq!(marked_path(&out), Some("/a:/b".into()));
        assert_eq!(marked_path("no markers"), None);
        assert_eq!(
            marked_path(&format!("{PATH_MARKER}/a")),
            None,
            "unterminated"
        );
        assert_eq!(
            marked_path(&format!("{PATH_MARKER}{PATH_MARKER}")),
            None,
            "empty"
        );
    }

    #[test]
    fn run_ids_cannot_escape_the_temp_dir() {
        assert!(write_source("../evil", "sh", "").is_err());
        assert!(write_source("a/b", "sh", "").is_err());
        assert!(write_source("", "sh", "").is_err());
        let (dir, file) = write_source("test-0001", "go", "package main").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "package main");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn utf8_split_across_reads_is_carried() {
        // "é" is 0xC3 0xA9; the first read ends between the two bytes.
        let mut buf = vec![b'a', 0xC3];
        assert_eq!(take_utf8(&mut buf), "a");
        assert_eq!(buf, vec![0xC3]);
        buf.push(0xA9);
        assert_eq!(take_utf8(&mut buf), "é");
        assert!(buf.is_empty());
    }

    #[test]
    fn invalid_bytes_are_replaced_not_carried() {
        let mut buf = vec![b'a', 0xFF, b'b'];
        assert_eq!(take_utf8(&mut buf), "a\u{FFFD}b");
        assert!(buf.is_empty());
    }

    #[test]
    fn homebrew_paths_are_prepended_once() {
        let joined = path_with_extras(Some("/usr/bin:/opt/homebrew/bin".into()));
        let parts: Vec<_> = std::env::split_paths(&joined).collect();
        assert_eq!(
            parts
                .iter()
                .filter(|p| *p == Path::new("/opt/homebrew/bin"))
                .count(),
            1
        );
        assert_eq!(parts[0], Path::new("/opt/homebrew/sbin"));
        assert!(parts.contains(&"/usr/bin".into()));
    }
}
