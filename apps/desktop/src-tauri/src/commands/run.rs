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
}

/// One way to run a language: a program, its arguments, and how it takes
/// the code.
struct Tool {
    program: &'static str,
    args: &'static [&'static str],
    source: Source,
}

const fn inline(program: &'static str, args: &'static [&'static str]) -> Tool {
    Tool {
        program,
        args,
        source: Source::Inline,
    }
}

const fn file(program: &'static str, args: &'static [&'static str], ext: &'static str) -> Tool {
    Tool {
        program,
        args,
        source: Source::File(ext),
    }
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

struct RunSettings {
    enabled: bool,
    timeout: Option<Duration>,
    interpreters: Vec<String>,
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
        interpreters: match settings.get(INTERPRETERS_KEY) {
            Some(ConfigValue::List(entries)) => entries.clone(),
            _ => Vec::new(),
        },
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
    on_event: Channel<RunEvent>,
    registry: State<'_, Arc<RunRegistry>>,
) -> Result<(), AppError> {
    let settings = run_settings(&app, webview.label())?;
    if !settings.enabled {
        return Err(AppError::Message(
            "Running code is turned off in Settings (Code → Run Code Blocks)".into(),
        ));
    }
    let runtime =
        runtime(&lang).ok_or_else(|| AppError::Unsupported(format!("no runtime for `{lang}`")))?;
    let path = user_path();
    let (tool, program_path) = match interpreter_override(&settings.interpreters, runtime) {
        Some(found) => found?,
        None => resolve_tool(runtime, path)?,
    };
    let program = tool.program;
    let temp_dir = match tool.source {
        Source::Inline => None,
        Source::File(ext) => Some(write_source(&run_id, ext, &code)?),
    };
    let cleanup = move |dir: Option<(PathBuf, PathBuf)>| {
        if let Some((dir, _)) = dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    };

    let mut command = Command::new(&program_path);
    command.args(tool.args);
    match &temp_dir {
        Some((_, file)) => command.arg(file),
        None => command.arg(&code),
    };
    command
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.as_deref().filter(|d| Path::new(d).is_dir()) {
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
    if let Some(limit) = settings.timeout {
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

    Ok(())
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
        for key in [ENABLED_KEY, TIMEOUT_KEY, INTERPRETERS_KEY] {
            let def = schema.iter().find(|d| d.key == key).expect(key);
            assert_eq!(def.scope, Some(crate::config::SettingScope::Global), "{key}");
        }
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
