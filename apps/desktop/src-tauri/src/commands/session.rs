//! Shared sessions: one long-lived interpreter per (window, note, language),
//! so a note's blocks share variables, functions, imports and the working
//! directory, like cells in a notebook. Nothing is replayed: each block runs
//! once, in the process that ran the blocks before it.
//!
//! The session runs a small driver (shell or Python). Writer hands it one
//! block at a time over a control FIFO as one line of fields separated by
//! US (`\x1f`): `id code-file input-fifo cd-dir color vars-file`. Not tabs: a shell's
//! `read` merges runs of whitespace separators, which would drop an empty
//! field. The driver runs the file with
//! the block's own input FIFO as stdin (so typed input reaches only that
//! block, and End input ends only that block's input), then prints
//! `RS "WRITER-END " id " " status RS` on both stdout and stderr. The readers
//! cut each stream at that marker, so every block gets exactly its output.
//!
//! Unix only (FIFOs, process groups); elsewhere blocks run fresh.

use std::collections::HashMap;
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use parking_lot::Mutex;

use super::run::{
    env_value, kill_group, take_utf8, RunEvent, RunHandle, RunRegistry, Sink, StdinSlot, COLOR_ENV,
    OUTPUT_LIMIT, RUN_ENV,
};
use crate::error::AppError;

/// Runtimes that keep a session; everything else runs fresh each time.
/// Mirrors `shared/code-session-runtimes.json` (the editor offers "Restart
/// Code Sessions" for these); a test keeps the two equal.
pub const SESSION_RUNTIMES: &[&str] = &["bash", "zsh", "sh", "python"];

const MARKER_PREFIX: &str = "\u{1e}WRITER-END ";
const RS: char = '\u{1e}';
/// Separates a control line's fields.
const US: char = '\u{1f}';
/// How long a new session has to open its control FIFO.
const START_TIMEOUT: Duration = Duration::from_secs(10);
/// After Ctrl-C, how long Python gets to stop before its session is killed.
const INTERRUPT_GRACE: Duration = Duration::from_secs(3);

/// Window label, note path, runtime id.
type SessionKey = (String, String, &'static str);

/// Live sessions, managed app state.
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<SessionKey, Arc<Session>>>);

pub struct Session {
    pid: u32,
    runtime: &'static str,
    /// The interpreter it runs: a session whose language now resolves to a
    /// different program (Settings → Interpreters) is replaced.
    program: PathBuf,
    label: &'static str,
    /// Python survives Ctrl-C (KeyboardInterrupt); shells have to be killed.
    interruptible: bool,
    ctl: Mutex<File>,
    dir: PathBuf,
    current: Mutex<Option<Block>>,
}

struct Block {
    id: String,
    sink: Sink,
    dir: PathBuf,
    input: PathBuf,
    /// Streams (stdout, stderr) that reached this block's end marker.
    ended: u8,
    status: Option<i32>,
    total: usize,
    cancelled: Arc<AtomicBool>,
    truncated: Arc<AtomicBool>,
    timed_out: Arc<AtomicBool>,
    done: Option<mpsc::Sender<()>>,
}

/// One piece of a session's output stream.
#[derive(Debug, PartialEq)]
pub enum Piece {
    Text(String),
    End { id: String, status: i32 },
}

/// Split `buf` into output text and end markers, leaving a marker that is cut
/// off at the end (or could still become one) in `buf` for the next read.
pub fn take_pieces(buf: &mut String) -> Vec<Piece> {
    let mut pieces = Vec::new();
    let mut text = String::new();
    let mut rest = buf.as_str();
    loop {
        let Some(at) = rest.find(RS) else {
            text.push_str(rest);
            rest = "";
            break;
        };
        text.push_str(&rest[..at]);
        let candidate = &rest[at..];
        if candidate.len() < MARKER_PREFIX.len() {
            if MARKER_PREFIX.starts_with(candidate) {
                rest = candidate; // may still become a marker
                break;
            }
        } else if let Some(body) = candidate.strip_prefix(MARKER_PREFIX) {
            match body.find(RS) {
                None => {
                    rest = candidate; // marker not finished yet
                    break;
                }
                Some(end) => {
                    let mut fields = body[..end].splitn(2, ' ');
                    let id = fields.next().unwrap_or_default().to_owned();
                    let status = fields.next().and_then(|s| s.trim().parse().ok());
                    if let Some(status) = status {
                        if !text.is_empty() {
                            pieces.push(Piece::Text(std::mem::take(&mut text)));
                        }
                        pieces.push(Piece::End { id, status });
                        rest = &body[end + RS.len_utf8()..];
                        continue;
                    }
                }
            }
        }
        // Not a marker: the separator is ordinary output.
        text.push(RS);
        rest = &candidate[RS.len_utf8()..];
    }
    if !text.is_empty() {
        pieces.push(Piece::Text(text));
    }
    *buf = rest.to_owned();
    pieces
}

/// Single-quote a value for a POSIX shell.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// The declared variables as a file the session's driver loads before the
/// block: `export name='value'` lines for shells (shell variables and
/// environment both), or JSON with typed values and env strings for Python.
fn write_vars(
    dir: &Path,
    runtime: &str,
    vars: &[(String, serde_json::Value)],
) -> Result<PathBuf, AppError> {
    if runtime == "python" {
        let values: serde_json::Map<_, _> = vars.iter().cloned().collect();
        let env: serde_json::Map<_, _> = vars
            .iter()
            .map(|(name, value)| (name.clone(), serde_json::Value::String(env_value(value))))
            .collect();
        let path = dir.join("vars.json");
        std::fs::write(
            &path,
            serde_json::json!({ "values": values, "env": env }).to_string(),
        )?;
        Ok(path)
    } else {
        let lines: String = vars
            .iter()
            .map(|(name, value)| format!("export {name}={}\n", shell_quote(&env_value(value))))
            .collect();
        let path = dir.join("vars.sh");
        std::fs::write(&path, lines)?;
        Ok(path)
    }
}

/// One control line, or an error if a field could break the protocol.
pub fn control_line(
    id: &str,
    file: &Path,
    input: &Path,
    cd: Option<&Path>,
    color: bool,
    vars: Option<&Path>,
) -> Result<String, AppError> {
    let fields = [
        id.to_owned(),
        file.to_string_lossy().into_owned(),
        input.to_string_lossy().into_owned(),
        cd.map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default(),
        if color { "1" } else { "0" }.to_owned(),
        vars.map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_default(),
    ];
    if fields.iter().any(|f| f.contains([US, '\n', '\r'])) {
        return Err(AppError::Message(
            "Can't run in a shared session: a path contains a control character".into(),
        ));
    }
    Ok(format!("{}\n", fields.join(&US.to_string())))
}

fn color_exports() -> String {
    COLOR_ENV
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Shell driver (`$1` is the control FIFO). Blocks are sourced with `.`, so
/// variables, functions, `cd` and `export` carry over; `exit` ends the session.
fn shell_driver() -> String {
    format!(
        r#"__w_us=$(printf '\037'); __w_rs=$(printf '\036')
exec 3<"$1"
while IFS="$__w_us" read -r __w_id __w_file __w_in __w_dir __w_color __w_vars <&3; do
  [ -n "$__w_dir" ] && cd "$__w_dir"
  [ "$__w_color" = 1 ] && export {exports}
  [ -n "$__w_vars" ] && . "$__w_vars"
  . "$__w_file" <"$__w_in"
  __w_status=$?
  printf '%sWRITER-END %s %s%s' "$__w_rs" "$__w_id" "$__w_status" "$__w_rs"
  printf '%sWRITER-END %s %s%s' "$__w_rs" "$__w_id" "$__w_status" "$__w_rs" >&2
done
"#,
        exports = color_exports()
    )
}

/// Python driver (`sys.argv[1]` is the control FIFO). Blocks run with `exec`
/// in one namespace; exceptions, `sys.exit()` and Ctrl-C end the block, not
/// the session. Tracebacks skip the driver's own frame.
fn python_driver() -> String {
    let env = COLOR_ENV
        .iter()
        .map(|(k, v)| format!("{k:?}: {v:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"import os, sys, traceback
__w_ns = {{"__name__": "__main__", "__builtins__": __builtins__}}
__w_ctl = open(sys.argv[1], "r", encoding="utf-8")
__w_stdin = sys.stdin
while True:
    try:
        __w_line = __w_ctl.readline()
    except KeyboardInterrupt:
        continue
    if not __w_line:
        break
    __w_id, __w_file, __w_in, __w_dir, __w_color, __w_vars = __w_line.rstrip("\n").split("\x1f")
    __w_status = 0
    try:
        if __w_dir:
            os.chdir(__w_dir)
        if __w_color == "1":
            os.environ.update({{{env}}})
        if __w_vars:
            import json as __w_json
            with open(__w_vars, encoding="utf-8") as f:
                __w_declared = __w_json.load(f)
            __w_ns.update(__w_declared["values"])
            os.environ.update(__w_declared["env"])
        with open(__w_file, encoding="utf-8") as f:
            __w_src = f.read()
        sys.stdin = open(__w_in, encoding="utf-8")
        exec(compile(__w_src, "<block>", "exec"), __w_ns)
    except SystemExit as e:
        if e.code is None or isinstance(e.code, int):
            __w_status = e.code or 0
        else:
            print(e.code, file=sys.stderr)
            __w_status = 1
    except KeyboardInterrupt:
        print("KeyboardInterrupt", file=sys.stderr)
        __w_status = 130
    except BaseException:
        __w_type, __w_value, __w_tb = sys.exc_info()
        traceback.print_exception(__w_type, __w_value, __w_tb.tb_next)
        __w_status = 1
    finally:
        try:
            sys.stdin.close()
        except Exception:
            pass
        sys.stdin = __w_stdin
    __w_end = "\x1eWRITER-END %s %d\x1e" % (__w_id, __w_status)
    sys.stdout.flush(); sys.stderr.flush()
    sys.stdout.write(__w_end); sys.stdout.flush()
    sys.stderr.write(__w_end); sys.stderr.flush()
"#
    )
}

fn mkfifo(path: &Path) -> Result<(), AppError> {
    let c = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| AppError::InvalidPath(path.display().to_string()))?;
    // SAFETY: a valid NUL-terminated path; mkfifo only reads it.
    if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } != 0 {
        return Err(AppError::Io(format!(
            "mkfifo {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

/// Open a FIFO's write end without hanging forever if no reader comes.
fn open_writer(path: &Path, timeout: Duration) -> Option<File> {
    let (tx, rx) = mpsc::channel();
    let owned = path.to_path_buf();
    std::thread::spawn(move || {
        let _ = tx.send(std::fs::OpenOptions::new().write(true).open(owned));
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(file)) => Some(file),
        _ => {
            unblock_writer(path);
            None
        }
    }
}

/// A thread blocked opening `path` for writing returns once a reader opens it.
fn unblock_writer(path: &Path) {
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path);
}

impl Session {
    fn start(
        runtime: &'static str,
        label: &'static str,
        program: &Path,
        cwd: Option<&Path>,
        path_env: &std::ffi::OsStr,
    ) -> Result<(Arc<Session>, Child), AppError> {
        let dir = std::env::temp_dir().join(format!("writer-session-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir)?;
        let ctl_path = dir.join("ctl");
        mkfifo(&ctl_path)?;

        let python = runtime == "python";
        let mut command = Command::new(program);
        if python {
            command.args(["-u", "-c", &python_driver()]);
        } else {
            command.args(["-c", &shell_driver(), "writer-session"]);
        }
        command
            .arg(&ctl_path)
            .env("PATH", path_env)
            .envs(RUN_ENV.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let mut child = command.spawn().map_err(|e| {
            let _ = std::fs::remove_dir_all(&dir);
            AppError::Io(format!("failed to start a {label} session: {e}"))
        })?;
        let Some(ctl) = open_writer(&ctl_path, START_TIMEOUT) else {
            kill_group(child.id());
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&dir);
            return Err(AppError::Message(format!(
                "The {label} session didn't start"
            )));
        };
        let session = Arc::new(Session {
            pid: child.id(),
            runtime,
            program: program.to_path_buf(),
            label,
            interruptible: python,
            ctl: Mutex::new(ctl),
            dir,
            current: Mutex::new(None),
        });
        Ok((session, child))
    }

    /// Stop the running block: Ctrl-C for Python (the session lives on, and
    /// is killed only if the block ignores it), killing the session for shells.
    pub fn stop_block(self: &Arc<Self>, id: &str) {
        if !self.interruptible {
            kill_group(self.pid);
            return;
        }
        // SAFETY: plain signal to our own child's process group.
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGINT);
        }
        let session = self.clone();
        let id = id.to_owned();
        std::thread::spawn(move || {
            std::thread::sleep(INTERRUPT_GRACE);
            if session.current.lock().as_ref().is_some_and(|b| b.id == id) {
                kill_group(session.pid);
            }
        });
    }

    /// Send the block its exit event and forget it.
    fn finish_block(&self, registry: &RunRegistry, session_ended: bool, code: Option<i32>) {
        let Some(mut block) = self.current.lock().take() else {
            return;
        };
        if let Some(done) = block.done.take() {
            let _ = done.send(());
        }
        registry.0.lock().remove(&block.id);
        unblock_writer(&block.input);
        let _ = std::fs::remove_dir_all(&block.dir);
        (block.sink)(RunEvent::Exit {
            code: block.status.or(code),
            cancelled: block.cancelled.load(Ordering::Relaxed),
            truncated: block.truncated.load(Ordering::Relaxed),
            timed_out: block.timed_out.load(Ordering::Relaxed),
            session_ended,
        });
    }
}

/// Route one stream's output to the current block, until the session ends.
fn pump(session: Arc<Session>, registry: Arc<RunRegistry>, mut stream: impl Read, is_stdout: bool) {
    let mut chunk = [0u8; 8192];
    let mut bytes = Vec::new();
    let mut text = String::new();
    loop {
        let n = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        bytes.extend_from_slice(&chunk[..n]);
        text.push_str(&take_utf8(&mut bytes));
        for piece in take_pieces(&mut text) {
            let mut current = session.current.lock();
            let Some(block) = current.as_mut() else {
                continue; // output between blocks (a background job): dropped
            };
            match piece {
                Piece::Text(t) => {
                    block.total += t.len();
                    if block.total > OUTPUT_LIMIT {
                        if !block.truncated.swap(true, Ordering::Relaxed) {
                            let id = block.id.clone();
                            drop(current);
                            session.stop_block(&id);
                        }
                        continue;
                    }
                    let event = if is_stdout {
                        RunEvent::Stdout(t)
                    } else {
                        RunEvent::Stderr(t)
                    };
                    (block.sink)(event);
                }
                Piece::End { id, status } if id == block.id => {
                    if is_stdout {
                        block.status = Some(status);
                    }
                    block.ended += 1;
                    if block.ended == 2 {
                        drop(current);
                        session.finish_block(&registry, false, None);
                    }
                }
                Piece::End { .. } => {}
            }
        }
    }
}

impl Sessions {
    fn spawn_watchers(
        self: &Arc<Self>,
        key: SessionKey,
        session: &Arc<Session>,
        mut child: Child,
        registry: &Arc<RunRegistry>,
    ) {
        let out = child.stdout.take();
        let err = child.stderr.take();
        let readers = [
            out.map(|s| {
                let (session, registry) = (session.clone(), registry.clone());
                std::thread::spawn(move || pump(session, registry, s, true))
            }),
            err.map(|s| {
                let (session, registry) = (session.clone(), registry.clone());
                std::thread::spawn(move || pump(session, registry, s, false))
            }),
        ];
        let (sessions, session, registry) = (self.clone(), session.clone(), registry.clone());
        std::thread::spawn(move || {
            for reader in readers.into_iter().flatten() {
                let _ = reader.join();
            }
            let code = child.wait().ok().and_then(|s| s.code());
            {
                let mut map = sessions.0.lock();
                if map.get(&key).is_some_and(|s| Arc::ptr_eq(s, &session)) {
                    map.remove(&key);
                }
            }
            session.finish_block(&registry, true, code);
            let _ = std::fs::remove_dir_all(&session.dir);
        });
    }

    /// Run a block in the note's session for `runtime`, starting it if needed.
    #[allow(clippy::too_many_arguments)]
    pub fn run_block(
        self: &Arc<Self>,
        registry: &Arc<RunRegistry>,
        key: (String, String),
        runtime: &'static str,
        label: &'static str,
        program: &Path,
        session_cwd: Option<&Path>,
        path_env: &std::ffi::OsStr,
        run: BlockRun,
    ) -> Result<(), AppError> {
        let key = (key.0, key.1, runtime);
        let existing = self.0.lock().get(&key).cloned().filter(|session| {
            if session.program == program {
                return true;
            }
            // The interpreter changed: the old session is retired. Its waiter
            // only removes the map entry if it still points at it.
            kill_group(session.pid);
            false
        });
        let session = match existing {
            Some(session) => session,
            None => {
                let (session, child) =
                    Session::start(runtime, label, program, session_cwd, path_env)?;
                self.0.lock().insert(key.clone(), session.clone());
                self.spawn_watchers(key, &session, child, registry);
                session
            }
        };

        let block_dir = session.dir.join(&run.id);
        std::fs::create_dir_all(&block_dir)?;
        let file = block_dir.join(if runtime == "python" {
            "block.py"
        } else {
            "block.sh"
        });
        std::fs::write(&file, &run.code)?;
        let input = block_dir.join("in");
        mkfifo(&input)?;
        let vars_file = (!run.vars.is_empty())
            .then(|| write_vars(&block_dir, runtime, &run.vars))
            .transpose()?;
        let line = control_line(
            &run.id,
            &file,
            &input,
            run.cd.as_deref(),
            run.color,
            vars_file.as_deref(),
        )?;

        {
            let mut current = session.current.lock();
            if current.is_some() {
                let _ = std::fs::remove_dir_all(&block_dir);
                return Err(AppError::Message(format!(
                    "This note's {} session is still running a block. Wait for it or stop it",
                    session.label
                )));
            }
            let (done_tx, done_rx) = mpsc::channel();
            *current = Some(Block {
                id: run.id.clone(),
                sink: run.sink,
                dir: block_dir,
                input: input.clone(),
                ended: 0,
                status: None,
                total: 0,
                cancelled: run.cancelled.clone(),
                truncated: Arc::new(AtomicBool::new(false)),
                timed_out: run.timed_out.clone(),
                done: Some(done_tx),
            });
            if let Some(limit) = run.timeout {
                let (session, id, timed_out) =
                    (session.clone(), run.id.clone(), run.timed_out.clone());
                std::thread::spawn(move || {
                    if done_rx.recv_timeout(limit) == Err(mpsc::RecvTimeoutError::Timeout) {
                        timed_out.store(true, Ordering::Relaxed);
                        session.stop_block(&id);
                    }
                });
            }
        }

        let stdin = Arc::new(Mutex::new(StdinSlot::default()));
        let stop_session = session.clone();
        let stop_id = run.id.clone();
        registry.0.lock().insert(
            run.id.clone(),
            RunHandle {
                group: session.pid,
                cancelled: run.cancelled,
                stdin: stdin.clone(),
                stop: Arc::new(move || stop_session.stop_block(&stop_id)),
            },
        );
        // The driver opens the block's input FIFO when it starts the block;
        // input typed before then waits in the slot.
        std::thread::spawn(move || {
            if let Some(pipe) = open_writer(&input, Duration::from_secs(24 * 60 * 60)) {
                stdin.lock().attach(Box::new(pipe));
            }
        });

        if let Err(e) = session.ctl.lock().write_all(line.as_bytes()) {
            session.finish_block(registry, true, None);
            kill_group(session.pid);
            return Err(AppError::Message(format!(
                "The {} session stopped unexpectedly ({e})",
                session.label
            )));
        }
        Ok(())
    }

    /// End a window's sessions: one note's, or all of them.
    pub fn end(&self, label: &str, note: Option<&str>) -> usize {
        let map = self.0.lock();
        let doomed: Vec<_> = map
            .iter()
            .filter(|((l, n, _), _)| l == label && note.is_none_or(|note| n == note))
            .map(|(_, s)| s.pid)
            .collect();
        drop(map);
        for pid in &doomed {
            kill_group(*pid);
        }
        doomed.len()
    }

    /// Kill every session and remove its files now (app exit): the waiter
    /// threads that normally clean up don't outlive the process.
    pub fn end_all(&self) {
        for session in self.0.lock().drain().map(|(_, session)| session) {
            kill_group(session.pid);
            let _ = std::fs::remove_dir_all(&session.dir);
        }
    }

    pub fn runtimes_for(&self, label: &str, note: &str) -> Vec<&'static str> {
        self.0
            .lock()
            .iter()
            .filter(|((l, n, _), _)| l == label && n == note)
            .map(|(_, s)| s.runtime)
            .collect()
    }
}

/// What a block brings to its session.
pub struct BlockRun {
    pub id: String,
    pub code: String,
    pub cd: Option<PathBuf>,
    pub color: bool,
    /// Declared variables, set in the session before the block runs.
    pub vars: Vec<(String, serde_json::Value)>,
    pub timeout: Option<Duration>,
    pub sink: Sink,
    pub cancelled: Arc<AtomicBool>,
    pub timed_out: Arc<AtomicBool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(id: &str, status: i32) -> String {
        format!("{MARKER_PREFIX}{id} {status}{RS}")
    }

    #[test]
    fn pieces_split_output_at_end_markers() {
        let mut buf = format!("hello\n{}after", end("b1", 0));
        assert_eq!(
            take_pieces(&mut buf),
            [
                Piece::Text("hello\n".into()),
                Piece::End {
                    id: "b1".into(),
                    status: 0
                },
                Piece::Text("after".into()),
            ]
        );
        assert_eq!(buf, "");
    }

    #[test]
    fn a_marker_cut_across_reads_is_held() {
        let full = format!("out{}", end("b2", 3));
        let (first, second) = full.split_at(8);
        let mut buf = first.to_owned();
        assert_eq!(take_pieces(&mut buf), [Piece::Text("out".into())]);
        buf.push_str(second);
        assert_eq!(
            take_pieces(&mut buf),
            [Piece::End {
                id: "b2".into(),
                status: 3
            }]
        );
    }

    #[test]
    fn a_stray_separator_is_just_output() {
        let mut buf = "a\u{1e}b and \u{1e}WRITER-ENDLESS".to_owned();
        assert_eq!(
            take_pieces(&mut buf),
            [Piece::Text("a\u{1e}b and \u{1e}WRITER-ENDLESS".into())]
        );
        // A prefix of the marker at the very end waits for more.
        let mut buf = "x\u{1e}WRI".to_owned();
        assert_eq!(take_pieces(&mut buf), [Piece::Text("x".into())]);
        assert_eq!(buf, "\u{1e}WRI");
    }

    #[test]
    fn session_runtimes_match_shared_contract() {
        let shared: Vec<String> =
            serde_json::from_str(include_str!("../../../shared/code-session-runtimes.json"))
                .unwrap();
        assert_eq!(shared, SESSION_RUNTIMES);
    }

    #[test]
    fn control_lines_refuse_tabs_and_newlines() {
        let ok = control_line(
            "id",
            Path::new("/t/b.sh"),
            Path::new("/t/in"),
            None,
            true,
            None,
        )
        .unwrap();
        assert_eq!(ok, "id\u{1f}/t/b.sh\u{1f}/t/in\u{1f}\u{1f}1\u{1f}\n");
        // Tabs are fine now; the separator and newlines aren't.
        assert!(control_line(
            "id",
            Path::new("/t/a\tb"),
            Path::new("/t/in"),
            None,
            false,
            None
        )
        .is_ok());
        assert!(control_line(
            "id",
            Path::new("/t/a\u{1f}b"),
            Path::new("/t/in"),
            None,
            false,
            None
        )
        .is_err());
        assert!(control_line(
            "id",
            Path::new("/t/b"),
            Path::new("/t/in"),
            Some(Path::new("/x\ny")),
            false,
            None
        )
        .is_err());
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use crate::commands::run::RunEvent;

    struct Done {
        stdout: String,
        stderr: String,
        code: Option<i32>,
        cancelled: bool,
        session_ended: bool,
    }

    fn program(name: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .chain(["/opt/homebrew/bin".into(), "/usr/local/bin".into()])
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    }

    struct Harness {
        sessions: Arc<Sessions>,
        registry: Arc<RunRegistry>,
        runtime: &'static str,
        program: PathBuf,
        /// Declared variables sent with every block.
        vars: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl Harness {
        fn new(runtime: &'static str, binary: &str) -> Option<Self> {
            Some(Harness {
                sessions: Arc::new(Sessions::default()),
                registry: Arc::new(RunRegistry::default()),
                runtime,
                program: program(binary)?,
                vars: Mutex::new(Vec::new()),
            })
        }

        /// Start a block; returns its id and a receiver for its events.
        fn start(&self, code: &str) -> (String, mpsc::Receiver<RunEvent>) {
            let (tx, rx) = mpsc::channel();
            let tx = Mutex::new(tx);
            let id = uuid::Uuid::new_v4().to_string();
            self.sessions
                .run_block(
                    &self.registry,
                    ("window".into(), "/notes/a.md".into()),
                    self.runtime,
                    "test",
                    &self.program,
                    None,
                    &std::env::var_os("PATH").unwrap_or_default(),
                    BlockRun {
                        id: id.clone(),
                        code: code.into(),
                        cd: None,
                        color: false,
                        vars: self.vars.lock().clone(),
                        timeout: None,
                        sink: Arc::new(move |event| {
                            let _ = tx.lock().send(event);
                        }),
                        cancelled: Arc::new(AtomicBool::new(false)),
                        timed_out: Arc::new(AtomicBool::new(false)),
                    },
                )
                .unwrap();
            (id, rx)
        }

        fn wait(rx: mpsc::Receiver<RunEvent>) -> Done {
            let mut done = Done {
                stdout: String::new(),
                stderr: String::new(),
                code: None,
                cancelled: false,
                session_ended: false,
            };
            loop {
                match rx
                    .recv_timeout(Duration::from_secs(20))
                    .expect("block never finished")
                {
                    RunEvent::Stdout(t) => done.stdout.push_str(&t),
                    RunEvent::Stderr(t) => done.stderr.push_str(&t),
                    RunEvent::Exit {
                        code,
                        cancelled,
                        session_ended,
                        ..
                    } => {
                        done.code = code;
                        done.cancelled = cancelled;
                        done.session_ended = session_ended;
                        return done;
                    }
                }
            }
        }

        fn run(&self, code: &str) -> Done {
            Self::wait(self.start(code).1)
        }

        fn stop(&self, id: &str) {
            let stop = self.registry.0.lock().get(id).map(|h| {
                h.cancelled.store(true, Ordering::Relaxed);
                h.stop.clone()
            });
            stop.expect("block isn't registered")();
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.sessions.end_all();
        }
    }

    #[test]
    fn bash_blocks_share_variables_functions_and_folder() {
        let Some(h) = Harness::new("bash", "bash") else {
            return;
        };
        let first = h.run("x=41; greet() { echo \"hi $1\"; }; cd /");
        assert_eq!((first.code, first.stdout.as_str()), (Some(0), ""));
        let second = h.run("echo $((x + 1)); greet there; pwd");
        assert_eq!(second.stdout, "42\nhi there\n/\n");
        // The driver itself must never write to the block's output.
        assert_eq!((first.stderr.as_str(), second.stderr.as_str()), ("", ""));
        // A failing command is the block's status; the session carries on.
        assert_eq!(h.run("false").code, Some(1));
        assert_eq!(h.run("echo $x").stdout, "41\n");
    }

    #[test]
    fn python_keeps_state_across_blocks_and_exceptions() {
        let Some(h) = Harness::new("python", "python3") else {
            return;
        };
        assert_eq!(h.run("import math\nr = 2").code, Some(0));
        let boom = h.run("x = 1\nraise ValueError('nope')");
        assert_eq!(boom.code, Some(1));
        assert!(boom.stderr.contains("ValueError: nope"), "{}", boom.stderr);
        assert!(
            boom.stderr.contains("<block>"),
            "traceback points at the block"
        );
        assert!(
            !boom.stderr.contains("__w_"),
            "driver frames leaked: {}",
            boom.stderr
        );
        assert_eq!(h.run("import sys\nsys.exit(3)").code, Some(3));
        assert_eq!(
            h.run("print(round(math.pi * r * r, 2), x)").stdout,
            "12.57 1\n"
        );
    }

    #[test]
    fn typed_input_reaches_the_session_block() {
        let Some(h) = Harness::new("python", "python3") else {
            return;
        };
        let (id, rx) = h.start("name = input('Name? ')\nprint(name.upper())");
        let slot = h.registry.0.lock().get(&id).unwrap().stdin.clone();
        slot.lock().write(b"diaa\n").unwrap();
        let done = Harness::wait(rx);
        assert_eq!(done.stdout, "Name? DIAA\n");
        // The next block gets its own input, not leftovers.
        let (id, rx) = h.start("import sys\nprint(repr(sys.stdin.read()))");
        h.registry.0.lock().get(&id).unwrap().stdin.lock().close();
        assert_eq!(Harness::wait(rx).stdout, "''\n");
    }

    #[test]
    fn stop_interrupts_python_but_keeps_its_state() {
        let Some(h) = Harness::new("python", "python3") else {
            return;
        };
        h.run("kept = 'yes'");
        let (id, rx) = h.start("import time\nprint('start', flush=True)\ntime.sleep(30)");
        std::thread::sleep(Duration::from_millis(500));
        h.stop(&id);
        let stopped = Harness::wait(rx);
        assert!(stopped.cancelled && !stopped.session_ended);
        assert!(stopped.stderr.contains("KeyboardInterrupt"));
        assert_eq!(h.run("print(kept)").stdout, "yes\n");
    }

    #[test]
    fn stop_ends_a_shell_session_and_the_next_run_starts_fresh() {
        let Some(h) = Harness::new("bash", "bash") else {
            return;
        };
        h.run("kept=yes");
        let (id, rx) = h.start("sleep 30");
        std::thread::sleep(Duration::from_millis(300));
        h.stop(&id);
        let stopped = Harness::wait(rx);
        assert!(stopped.cancelled && stopped.session_ended);
        assert_eq!(h.run("echo \"[${kept}]\"").stdout, "[]\n");
    }

    #[test]
    fn a_new_interpreter_replaces_the_session() {
        let Some(mut h) = Harness::new("sh", "bash") else {
            return;
        };
        h.run("kept=yes");
        let Some(zsh) = program("zsh") else { return };
        h.program = zsh;
        let done = h.run("echo \"[${kept}] ${ZSH_VERSION:+zsh}\"");
        assert_eq!(done.stdout, "[] zsh\n");
    }

    #[test]
    fn cd_and_color_fields_reach_the_driver() {
        let Some(h) = Harness::new("bash", "bash") else {
            return;
        };
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        h.sessions
            .run_block(
                &h.registry,
                ("window".into(), "/notes/a.md".into()),
                "bash",
                "test",
                &h.program,
                None,
                &std::env::var_os("PATH").unwrap_or_default(),
                BlockRun {
                    id: "with-options".into(),
                    code: "pwd; echo \"$FORCE_COLOR\"".into(),
                    cd: Some(PathBuf::from("/")),
                    color: true,
                    vars: Vec::new(),
                    timeout: None,
                    sink: Arc::new(move |event| {
                        let _ = tx.lock().send(event);
                    }),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    timed_out: Arc::new(AtomicBool::new(false)),
                },
            )
            .unwrap();
        let done = Harness::wait(rx);
        assert_eq!((done.stdout.as_str(), done.stderr.as_str()), ("/\n1\n", ""));
    }

    #[test]
    fn end_all_leaves_no_files_behind() {
        let Some(h) = Harness::new("bash", "bash") else {
            return;
        };
        h.run("true");
        let dir = h.sessions.0.lock().values().next().unwrap().dir.clone();
        assert!(dir.exists());
        h.sessions.end_all();
        assert!(!dir.exists());
    }

    fn declared() -> Vec<(String, serde_json::Value)> {
        vec![
            ("port".into(), serde_json::json!(8080)),
            ("greeting".into(), serde_json::json!("it's \"quoted\"")),
            ("tags".into(), serde_json::json!(["a", "b"])),
            ("debug".into(), serde_json::json!(true)),
        ]
    }

    #[test]
    fn declared_variables_reach_shell_blocks_as_vars_and_env() {
        let Some(h) = Harness::new("bash", "bash") else {
            return;
        };
        *h.vars.lock() = declared();
        let done = h.run("echo \"$port|$greeting|$tags|$debug\"; env | grep -c '^port=8080$'");
        assert_eq!(done.stdout, "8080|it's \"quoted\"|[\"a\",\"b\"]|true\n1\n");
        assert_eq!(done.stderr, "");
    }

    #[test]
    fn declared_variables_reach_python_typed() {
        let Some(h) = Harness::new("python", "python3") else {
            return;
        };
        *h.vars.lock() = declared();
        let done = h.run(
            "import os\nprint(port + 1, type(port).__name__, greeting, tags[1], debug is True, os.environ['port'])",
        );
        assert_eq!(done.stdout, "8081 int it's \"quoted\" b True 8080\n");
        assert_eq!(done.stderr, "");
    }

    #[test]
    fn exit_ends_the_session_with_its_code() {
        let Some(h) = Harness::new("bash", "bash") else {
            return;
        };
        let done = h.run("echo bye; exit 4");
        assert_eq!(
            (done.code, done.session_ended, done.stdout.as_str()),
            (Some(4), true, "bye\n")
        );
        assert_eq!(h.run("echo again").stdout, "again\n");
    }
}
