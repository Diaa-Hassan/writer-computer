//! Runs the code inside a fenced block (```bash) as a child process and
//! streams its output back to the editor widget over a Tauri channel.
//!
//! Nothing here runs on its own: a run starts only from the widget's Run
//! button. Each run is a fresh process; there is no shared session.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::AppError;

/// Output past this many bytes (stdout + stderr) stops the run, so a runaway
/// loop can't flood the webview.
const OUTPUT_LIMIT: usize = 1024 * 1024;

/// Fence languages that can run, and the interpreter each one uses. Mirrors
/// `shared/code-runtimes.json`, which the editor reads to decide where to show
/// a Run button; a test keeps the two in sync.
const RUNTIMES: &[(&str, &str)] = &[("bash", "bash")];

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
    },
}

struct RunHandle {
    pid: u32,
    cancelled: Arc<AtomicBool>,
}

/// Live runs keyed by the id the widget generated, so Stop can find them.
#[derive(Default)]
pub struct RunRegistry(Mutex<HashMap<String, RunHandle>>);

pub fn runtime_for(lang: &str) -> Option<&'static str> {
    let lang = lang.trim().to_ascii_lowercase();
    RUNTIMES
        .iter()
        .find(|(name, _)| *name == lang)
        .map(|(_, cmd)| *cmd)
}

fn path_with_extras(current: Option<std::ffi::OsString>) -> std::ffi::OsString {
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

#[tauri::command]
pub fn run_code(
    run_id: String,
    lang: String,
    code: String,
    cwd: Option<String>,
    on_event: Channel<RunEvent>,
    registry: State<'_, Arc<RunRegistry>>,
) -> Result<(), AppError> {
    let program = runtime_for(&lang)
        .ok_or_else(|| AppError::Unsupported(format!("no runtime for `{lang}`")))?;

    let mut command = Command::new(program);
    command
        .arg("-c")
        .arg(&code)
        .env("PATH", path_with_extras(std::env::var_os("PATH")))
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

    let mut child = command
        .spawn()
        .map_err(|e| AppError::Io(format!("failed to start {program}: {e}")))?;
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

    let registry = registry.inner().clone();
    std::thread::spawn(move || {
        for reader in readers {
            let _ = reader.join();
        }
        let code = child.wait().ok().and_then(|status| status.code());
        registry.0.lock().remove(&run_id);
        let _ = on_event.send(RunEvent::Exit {
            code,
            cancelled: cancelled.load(Ordering::Relaxed),
            truncated: truncated.load(Ordering::Relaxed),
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
    fn only_registered_languages_run() {
        assert_eq!(runtime_for("bash"), Some("bash"));
        assert_eq!(runtime_for(" Bash "), Some("bash"));
        assert_eq!(runtime_for("python"), None);
        assert_eq!(runtime_for(""), None);
    }

    #[test]
    fn runtimes_match_shared_contract() {
        let shared: std::collections::BTreeMap<String, String> =
            serde_json::from_str(include_str!("../../../shared/code-runtimes.json")).unwrap();
        let ours: std::collections::BTreeMap<String, String> =
            RUNTIMES.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(shared, ours);
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
