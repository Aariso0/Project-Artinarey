use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{path::BaseDirectory, Manager};

const MAX_BODY_BYTES: usize = 1024 * 1024;
const HEADER_BUDGET: usize = 16 * 1024;
const IO_TIMEOUT_SECS: u64 = 5;
const CLONE_IO_TIMEOUT_SECS: u64 = 300;
const DAEMON_START_TIMEOUT: Duration = Duration::from_secs(10);

/// A clone can outlast the short timeout used for every other GUI call.
pub fn io_timeout_secs(method: &str) -> u64 {
    if method == "gui.cloneProject" { CLONE_IO_TIMEOUT_SECS } else { IO_TIMEOUT_SECS }
}

/// The bundled Node runtime and compiled daemon entry inside the app resources.
/// Absent in development builds, where the daemon is started from the CLI.
struct DaemonBundle {
    node: PathBuf,
    entry: PathBuf,
}

static DAEMON_BUNDLE: OnceLock<DaemonBundle> = OnceLock::new();
static DAEMON_SPAWN: Mutex<()> = Mutex::new(());
static DAEMON_CHILD: Mutex<Option<Child>> = Mutex::new(None);
/// Every method the webview can reach. The daemon re-checks the `gui.` prefix
/// and its own method table; native code is the only place that adds a method.
const ALLOWED_GUI_METHODS: [&str; 26] = [
    "gui.projects", "gui.personas", "gui.worktrees", "gui.mail",
    "gui.tasks", "gui.leases", "gui.sessions", "gui.preMerge", "gui.audit",
    "gui.approvals", "gui.approve", "gui.autoApprove", "gui.stopSession",
    "gui.createWorktree", "gui.adoptWorktree", "gui.setHomeWorktree", "gui.chat",
    "gui.storage", "gui.setStorage", "gui.movePreflight", "gui.moveStart",
    "gui.moveStatus", "gui.moveUndo", "gui.moveDeleteOld",
    "gui.openProject", "gui.cloneProject",
];

/// The only error shape crossing the native boundary: `{ code, message }`.
#[derive(Debug, Serialize)]
pub struct GuiError {
    pub code: String,
    pub message: String,
}

impl GuiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
}

impl fmt::Display for GuiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl Error for GuiError {}

pub fn parse_body_cap(length: usize) -> Result<usize, GuiError> {
    if length > MAX_BODY_BYTES {
        return Err(GuiError::new("BODY_TOO_LARGE", "body exceeds the 1 MiB cap"));
    }
    Ok(length)
}

pub fn map_status(status: u16) -> GuiError {
    let (code, message) = match status {
        400 => ("INVALID_REQUEST", "invalid request"),
        401 => ("AUTH_FAILED", "daemon rejected the bearer token"),
        403 => ("FORBIDDEN_METHOD", "method is not available on the GUI surface"),
        404 => ("NOT_FOUND", "daemon method was not found"),
        413 => ("BODY_TOO_LARGE", "daemon rejected an oversized body"),
        500 => ("INTERNAL_ERROR", "daemon reported an internal error"),
        502 | 503 | 504 => ("DAEMON_UNREACHABLE", "daemon is temporarily unavailable"),
        _ => ("BAD_RESPONSE", "unexpected daemon status"),
    };
    GuiError::new(code, format!("HTTP {status}: {message}"))
}

pub fn platform_origin(os: &str) -> &'static str {
    match os {
        "windows" | "android" => "http://tauri.localhost",
        _ => "tauri://localhost",
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn status_from_head(head: &[u8]) -> Result<u16, GuiError> {
    let end = find_bytes(head, b"\r\n").unwrap_or(head.len());
    let line = std::str::from_utf8(&head[..end])
        .map_err(|_| GuiError::new("BAD_RESPONSE", "daemon status line is not UTF-8"))?;
    let mut parts = line.split_whitespace();
    parts.next().ok_or_else(|| GuiError::new("BAD_RESPONSE", "daemon status line is empty"))?;
    let status = parts
        .next()
        .ok_or_else(|| GuiError::new("BAD_RESPONSE", "daemon status code is missing"))?
        .parse::<u16>()
        .map_err(|_| GuiError::new("BAD_RESPONSE", "daemon status code is invalid"))?;
    if (100..=599).contains(&status) {
        Ok(status)
    } else {
        Err(GuiError::new("BAD_RESPONSE", "daemon status code is out of range"))
    }
}

fn header_values(headers: &[u8], name: &str) -> Vec<String> {
    let mut values = Vec::new();
    for line in headers.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let Some(colon) = line.iter().position(|byte| *byte == b':') else {
            continue;
        };
        if line[..colon].eq_ignore_ascii_case(name.as_bytes()) {
            let value = std::str::from_utf8(&line[colon + 1..]).unwrap_or("").trim();
            values.push(value.to_string());
        }
    }
    values
}

fn decode_chunked_body(body: &[u8]) -> Result<Vec<u8>, GuiError> {
    let mut output = Vec::new();
    let mut position = 0usize;
    loop {
        let relative_end = body
            .get(position..)
            .and_then(|remaining| find_bytes(remaining, b"\r\n"))
            .ok_or_else(|| GuiError::new("BAD_RESPONSE", "chunk size line is incomplete"))?;
        let line_end = position + relative_end;
        let line = std::str::from_utf8(&body[position..line_end])
            .map_err(|_| GuiError::new("BAD_RESPONSE", "chunk size line is not UTF-8"))?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| GuiError::new("BAD_RESPONSE", "chunk size is invalid"))?;
        position = line_end + 2;
        if size == 0 {
            return Ok(output);
        }
        let total = output
            .len()
            .checked_add(size)
            .ok_or_else(|| GuiError::new("BODY_TOO_LARGE", "body exceeds the 1 MiB cap"))?;
        parse_body_cap(total)?;
        let end = position
            .checked_add(size)
            .ok_or_else(|| GuiError::new("BODY_TOO_LARGE", "body exceeds the 1 MiB cap"))?;
        if end > body.len() {
            return Err(GuiError::new("BAD_RESPONSE", "chunked body is truncated"));
        }
        output.extend_from_slice(&body[position..end]);
        position = end;
        if body.get(position..position + 2) != Some(&b"\r\n"[..]) {
            return Err(GuiError::new("BAD_RESPONSE", "chunk is not CRLF terminated"));
        }
        position += 2;
    }
}

fn response_body(header_bytes: &[u8], body: &[u8]) -> Result<Vec<u8>, GuiError> {
    let content_lengths = header_values(header_bytes, "content-length");
    let transfer_encodings = header_values(header_bytes, "transfer-encoding");
    if content_lengths.len() > 1
        || transfer_encodings.len() > 1
        || (!content_lengths.is_empty() && !transfer_encodings.is_empty())
    {
        return Err(GuiError::new("BAD_RESPONSE", "conflicting response framing headers"));
    }
    if let Some(encoding) = transfer_encodings.first() {
        if encoding
            .split(',')
            .any(|value| value.trim().eq_ignore_ascii_case("chunked"))
        {
            return decode_chunked_body(body);
        }
    }
    if let Some(declared) = content_lengths.first() {
        let length = declared
            .parse::<usize>()
            .map_err(|_| GuiError::new("BAD_RESPONSE", "Content-Length is invalid"))?;
        parse_body_cap(length)?;
        if body.len() < length {
            return Err(GuiError::new("BAD_RESPONSE", "daemon response body is truncated"));
        }
        return Ok(body[..length].to_vec());
    }
    parse_body_cap(body.len())?;
    Ok(body.to_vec())
}

fn error_from_body(value: &Value) -> Option<GuiError> {
    let error = value.get("error")?;
    let code = error.get("code").and_then(Value::as_str)?;
    let message = error.get("message").and_then(Value::as_str)?;
    if code.is_empty() {
        None
    } else {
        Some(GuiError::new(code, message))
    }
}

/// Parses HTTP status, headers and a capped body, returning the unchanged
/// JSON body text. Error statuses prefer a typed daemon error code over the
/// status fallback.
pub fn parse_http_response(raw: &[u8]) -> Result<String, GuiError> {
    let split = find_bytes(raw, b"\r\n\r\n")
        .ok_or_else(|| GuiError::new("BAD_RESPONSE", "daemon response has no header terminator"))?;
    let head = &raw[..split];
    let status = status_from_head(head)?;
    let end_of_status = find_bytes(head, b"\r\n").unwrap_or(head.len());
    let headers = &head[(end_of_status + 2).min(head.len())..];
    let body = response_body(headers, &raw[split + 4..])?;
    let text = String::from_utf8(body)
        .map_err(|_| GuiError::new("BAD_RESPONSE", "daemon response body is not UTF-8"))?;

    if text.trim().is_empty() {
        return Err(if status >= 400 {
            map_status(status)
        } else {
            GuiError::new("BAD_RESPONSE", "daemon response body is empty")
        });
    }

    let value: Value = serde_json::from_str(&text)
        .map_err(|_| GuiError::new("BAD_RESPONSE", "daemon response is not valid JSON"))?;
    if status >= 400 {
        if let Some(error) = error_from_body(&value) {
            return Err(error);
        }
        return Err(map_status(status));
    }
    Ok(text)
}

/// Converts the daemon's `{ ok, ... }` envelope into the result value or a
/// typed error. Anything else is `BAD_RESPONSE`.
pub fn parse_envelope(body: &str) -> Result<Value, GuiError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| GuiError::new("BAD_RESPONSE", "daemon response is not valid JSON"))?;
    if let Some(error) = error_from_body(&value) {
        return Err(error);
    }
    let Some(object) = value.as_object() else {
        return Err(GuiError::new("BAD_RESPONSE", "daemon response is not an object"));
    };
    match object.get("ok").and_then(Value::as_bool) {
        Some(true) if object.contains_key("result") => {
            Ok(object.get("result").cloned().unwrap_or(Value::Null))
        }
        _ => Err(GuiError::new("BAD_RESPONSE", "daemon response is missing the ok envelope")),
    }
}

/// Resolves the config directory from an environment snapshot. Absolute
/// `XDG_CONFIG_HOME` wins; then absolute `HOME`; then absolute `USERPROFILE`.
/// Relative values are ignored, matching the daemon's XDG resolution.
pub fn config_dir_from(env: &HashMap<String, OsString>) -> Result<PathBuf, GuiError> {
    for key in ["XDG_CONFIG_HOME", "HOME", "USERPROFILE"] {
        let Some(value) = env.get(key) else {
            continue;
        };
        let base = PathBuf::from(value);
        if !base.is_absolute() {
            continue;
        }
        let config_home = if key == "XDG_CONFIG_HOME" { base } else { base.join(".config") };
        return Ok(config_home.join("artinarey"));
    }
    Err(GuiError::new("DAEMON_UNREACHABLE", "no absolute config directory is available"))
}

fn process_env() -> HashMap<String, OsString> {
    ["XDG_CONFIG_HOME", "HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(|key| env::var_os(key).map(|value| (key.to_string(), value)))
        .collect()
}

fn token_is_usable(token: &str) -> bool {
    !token.is_empty() && !token.contains('\r') && !token.contains('\n')
}

/// Reads the native token written by the daemon. A missing or unusable token
/// is always `AUTH_FAILED`; the token is never returned to the webview.
pub fn read_token(dir: &Path) -> Result<String, GuiError> {
    let contents = fs::read_to_string(dir.join("token"))
        .map_err(|_| GuiError::new("AUTH_FAILED", "daemon token is unavailable"))?;
    let token = contents.trim();
    if !token_is_usable(token) {
        return Err(GuiError::new("AUTH_FAILED", "daemon token is unusable"));
    }
    Ok(token.to_string())
}

/// Reads the loopback port written by the daemon into `daemon.json`.
pub fn read_port(dir: &Path) -> Result<u16, GuiError> {
    let contents = fs::read_to_string(dir.join("daemon.json"))
        .map_err(|_| GuiError::new("DAEMON_UNREACHABLE", "daemon port file is unavailable"))?;
    let value: Value = serde_json::from_str(&contents)
        .map_err(|_| GuiError::new("DAEMON_UNREACHABLE", "daemon port file is malformed"))?;
    value
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| *port > 0 && *port <= u16::MAX as u64)
        .map(|port| port as u16)
        .ok_or_else(|| GuiError::new("DAEMON_UNREACHABLE", "daemon port is invalid"))
}

fn node_binary_name() -> &'static str {
    if cfg!(windows) { "node.exe" } else { "node" }
}

/// Paths inside the directory declared by `bundle.resources`.
pub fn bundled_daemon_paths(bundle_dir: &Path) -> (PathBuf, PathBuf) {
    (bundle_dir.join(node_binary_name()), bundle_dir.join("daemon.mjs"))
}

/// A port file alone is not enough: a stale daemon.json must not suppress a
/// fresh sidecar spawn.
pub fn daemon_reachable(dir: &Path) -> bool {
    let Ok(port) = read_port(dir) else {
        return false;
    };
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// Starts the bundled daemon only when one is not already listening. The lock
/// keeps two webview calls from racing into two daemons on the same port.
pub fn ensure_daemon_started() -> Result<(), GuiError> {
    let Some(bundle) = DAEMON_BUNDLE.get() else {
        return Ok(());
    };
    if !bundle.node.is_file() || !bundle.entry.is_file() {
        return Ok(());
    }
    let dir = config_dir_from(&process_env())?;
    if daemon_reachable(&dir) {
        return Ok(());
    }
    let _guard = DAEMON_SPAWN
        .lock()
        .map_err(|_| GuiError::new("INTERNAL_ERROR", "daemon spawn lock is poisoned"))?;
    if daemon_reachable(&dir) {
        return Ok(());
    }

    let child = Command::new(&bundle.node)
        .arg(&bundle.entry)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            GuiError::new("DAEMON_UNREACHABLE", format!("daemon sidecar failed to start: {error}"))
        })?;
    if let Ok(mut slot) = DAEMON_CHILD.lock() {
        *slot = Some(child);
    }

    let deadline = Instant::now() + DAEMON_START_TIMEOUT;
    while Instant::now() < deadline {
        if daemon_reachable(&dir) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(GuiError::new(
        "DAEMON_UNREACHABLE",
        "daemon sidecar did not become ready within 10 seconds",
    ))
}

/// Only these deliberately listed `gui.*` methods may cross the native
/// boundary; a future method is rejected until it is added here.
pub fn validate_gui_method(method: &str) -> Result<(), GuiError> {
    if ALLOWED_GUI_METHODS.contains(&method) {
        Ok(())
    } else {
        Err(GuiError::new("FORBIDDEN_METHOD", "method not allowed on the GUI surface"))
    }
}

/// Builds the complete loopback HTTP request. Credentials and routing headers
/// come only from native arguments; `body` is the opaque invoke envelope.
pub fn build_request(
    token: &str,
    port: u16,
    method: &str,
    body: &[u8],
) -> Result<Vec<u8>, GuiError> {
    validate_gui_method(method)?;
    if !token_is_usable(token) {
        return Err(GuiError::new("AUTH_FAILED", "daemon token is unusable"));
    }
    parse_body_cap(body.len())?;

    let request = format!(
        "POST /rpc HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Authorization: Bearer {token}\r\n\
         Origin: {origin}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {length}\r\n\
         Connection: close\r\n\r\n",
        origin = platform_origin(env::consts::OS),
        length = body.len(),
    );
    let mut request_bytes = request.into_bytes();
    request_bytes.extend_from_slice(&body);
    Ok(request_bytes)
}

/// The blocking half of the native command. Connection settings and
/// credentials are derived only from the local config directory, never from
/// `method` or `params`. This runs on a blocking executor, never the window thread.
pub fn blocking_daemon_call(method: String, params: Value) -> Result<Value, GuiError> {
    validate_gui_method(&method)?;
    ensure_daemon_started()?;

    let dir = config_dir_from(&process_env())?;
    let token = read_token(&dir)?;
    let port = read_port(&dir)?;

    let envelope = json!({ "id": "gui", "method": method.clone(), "params": params });
    let body = serde_json::to_vec(&envelope)
        .map_err(|error| GuiError::new("INVALID_REQUEST", error.to_string()))?;
    let request = build_request(&token, port, &method, &body)?;

    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|_| GuiError::new("DAEMON_UNREACHABLE", "daemon is not reachable on loopback"))?;
    let timeout = Some(Duration::from_secs(io_timeout_secs(&method)));
    stream
        .set_read_timeout(timeout)
        .and_then(|()| stream.set_write_timeout(timeout))
        .map_err(|_| GuiError::new("DAEMON_UNREACHABLE", "daemon socket could not be configured"))?;

    stream
        .write_all(&request)
        .map_err(|_| GuiError::new("DAEMON_UNREACHABLE", "daemon request could not be sent"))?;
    let _ = stream.shutdown(Shutdown::Write);

    let mut response = Vec::new();
    let mut bounded = stream.take((MAX_BODY_BYTES + HEADER_BUDGET) as u64);
    bounded
        .read_to_end(&mut response)
        .map_err(|_| GuiError::new("DAEMON_UNREACHABLE", "daemon response could not be read"))?;

    let response_body = parse_http_response(&response)?;
    parse_envelope(&response_body)
}

/// Awaits the blocking socket work off the window thread; the typed error
/// shape is unchanged. Public so the async behavior can be tested directly.
pub async fn daemon_command(method: String, params: Value) -> Result<Value, GuiError> {
    tauri::async_runtime::spawn_blocking(move || blocking_daemon_call(method, params))
        .await
        .map_err(|_| GuiError::new("INTERNAL_ERROR", "daemon call task failed"))?
}

/// The single native command exposed to the webview.
#[tauri::command]
async fn daemon_call(method: String, params: Value) -> Result<Value, GuiError> {
    daemon_command(method, params).await
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let bundle_dir = app.path().resolve("resources/daemon", BaseDirectory::Resource)?;
            let (node, entry) = bundled_daemon_paths(&bundle_dir);
            let _ = DAEMON_BUNDLE.set(DaemonBundle { node, entry });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![daemon_call])
        .run(tauri::generate_context!())
        .expect("error while running Artinarey window");
}

#[cfg(test)]
mod sidecar_tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "artinarey-sidecar-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bundled_paths_follow_resource_layout() {
        let (node, entry) = bundled_daemon_paths(Path::new("/app/resources/daemon"));
        assert_eq!(node, Path::new("/app/resources/daemon/node"));
        assert_eq!(entry, Path::new("/app/resources/daemon/daemon.mjs"));
    }

    #[test]
    fn reachable_needs_both_a_port_file_and_a_live_listener() {
        let dir = scratch_dir();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        fs::write(dir.join("daemon.json"), format!("{{\"port\":{port}}}")).unwrap();
        assert!(daemon_reachable(&dir));

        drop(listener);
        assert!(!daemon_reachable(&dir));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stale_or_missing_port_file_is_not_reachable() {
        let dir = scratch_dir();
        assert!(!daemon_reachable(&dir));
        fs::write(dir.join("daemon.json"), "not json").unwrap();
        assert!(!daemon_reachable(&dir));
        fs::remove_dir_all(&dir).unwrap();
    }
}
