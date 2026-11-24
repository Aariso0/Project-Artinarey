use artinarey_gui_lib::{
    blocking_daemon_call, build_request, config_dir_from, daemon_command, map_status,
    parse_body_cap, parse_envelope, parse_http_response, platform_origin, read_port, read_token,
    validate_gui_method,
};
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join(format!("artinarey-proxy-{label}-{}-{id}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn env_map(entries: &[(&str, &OsStr)]) -> HashMap<String, OsString> {
    entries
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_os_string()))
        .collect()
}

#[test]
fn response_body_is_capped() {
    assert_eq!(parse_body_cap(1_048_576).unwrap(), 1_048_576);
    assert_eq!(parse_body_cap(1_048_577).unwrap_err().code, "BODY_TOO_LARGE");
}

#[test]
fn daemon_statuses_map_to_stable_codes() {
    assert_eq!(map_status(400).code, "INVALID_REQUEST");
    assert_eq!(map_status(401).code, "AUTH_FAILED");
    assert_eq!(map_status(403).code, "FORBIDDEN_METHOD");
    assert_eq!(map_status(404).code, "NOT_FOUND");
    assert_eq!(map_status(413).code, "BODY_TOO_LARGE");
    assert_eq!(map_status(500).code, "INTERNAL_ERROR");
}

#[test]
fn parses_http_response_body() {
    assert_eq!(
        parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap(),
        "{}"
    );
}

#[test]
fn error_envelope_code_takes_priority_over_status() {
    let error = parse_http_response(
        b"HTTP/1.1 401 Unauthorized\r\n\r\n{\"ok\":false,\"error\":{\"code\":\"BAD_ORIGIN\",\"message\":\"blocked\"}}",
    )
    .unwrap_err();
    assert_eq!(error.code, "BAD_ORIGIN");
    assert_eq!(error.message, "blocked");
}

#[test]
fn empty_error_response_uses_status_code() {
    assert_eq!(
        parse_http_response(b"HTTP/1.1 404 Not Found\r\n\r\n").unwrap_err().code,
        "NOT_FOUND"
    );
}

#[test]
fn malformed_or_envelope_free_responses_are_bad_response() {
    assert_eq!(
        parse_http_response(b"HTTP/1.1 200 OK\r\n\r\nnot json").unwrap_err().code,
        "BAD_RESPONSE"
    );
    assert_eq!(parse_envelope("{\"result\":1}").unwrap_err().code, "BAD_RESPONSE");
}

#[test]
fn platform_origin_matches_the_native_shell() {
    assert_eq!(platform_origin("linux"), "tauri://localhost");
    assert_eq!(platform_origin("macos"), "tauri://localhost");
    assert_eq!(platform_origin("windows"), "http://tauri.localhost");
    assert_eq!(platform_origin("android"), "http://tauri.localhost");
}

#[test]
fn missing_token_is_auth_failed() {
    let root = TempDir::new("missing-token");
    let env = env_map(&[("XDG_CONFIG_HOME", root.path().as_os_str())]);
    let dir = config_dir_from(&env).unwrap();
    fs::create_dir_all(&dir).unwrap();
    assert_eq!(read_token(&dir).unwrap_err().code, "AUTH_FAILED");
}

#[test]
fn missing_and_malformed_daemon_json_are_daemon_unreachable() {
    let root = TempDir::new("port-file");
    let env = env_map(&[("XDG_CONFIG_HOME", root.path().as_os_str())]);
    let dir = config_dir_from(&env).unwrap();
    fs::create_dir_all(&dir).unwrap();

    assert_eq!(read_port(&dir).unwrap_err().code, "DAEMON_UNREACHABLE");
    fs::write(dir.join("daemon.json"), "not json").unwrap();
    assert_eq!(read_port(&dir).unwrap_err().code, "DAEMON_UNREACHABLE");
    fs::write(dir.join("daemon.json"), "{\"port\":4242}").unwrap();
    assert_eq!(read_port(&dir).unwrap(), 4242);
}

#[test]
fn built_request_has_canonical_headers_and_keeps_native_token_out_of_payload() {
    let token = "native-secret-token";
    let port = 43219u16;
    let method = "gui.projects";
    let body =
        br#"{"id":"gui","method":"gui.projects","params":{"token":"webview-value","port":9}}"#;

    let request = build_request(token, port, method, body).unwrap();
    let text = String::from_utf8(request).unwrap();
    let (head, sent_body) = text.split_once("\r\n\r\n").unwrap();
    let headers: Vec<&str> = head.lines().collect();

    let host = format!("Host: 127.0.0.1:{port}");
    let authorization = format!("Authorization: Bearer {token}");
    let origin = format!("Origin: {}", platform_origin(env::consts::OS));
    let content_type = "Content-Type: application/json".to_string();
    let content_length = format!("Content-Length: {}", body.len());
    for expected in [&host, &authorization, &origin, &content_type, &content_length] {
        assert!(
            headers.iter().any(|line| *line == expected.as_str()),
            "missing header: {expected}"
        );
    }
    assert_eq!(headers.first().copied(), Some("POST /rpc HTTP/1.1"));
    assert_eq!(headers.iter().filter(|line| line.starts_with("Host:")).count(), 1);
    assert_eq!(
        headers.iter().filter(|line| line.starts_with("Authorization:")).count(),
        1
    );
    assert_eq!(headers.iter().filter(|line| line.starts_with("Origin:")).count(), 1);

    assert!(sent_body.contains("webview-value"));
    assert!(!sent_body.contains(token));
}

#[test]
fn only_the_deliberately_listed_gui_methods_are_accepted_locally() {
    for method in ["send_mail", "approve", "tasks", "gui.nope", "gui.approvals_approve"] {
        assert_eq!(validate_gui_method(method).unwrap_err().code, "FORBIDDEN_METHOD", "{method}");
    }
    for method in [
        "gui.projects", "gui.personas", "gui.worktrees", "gui.mail",
        "gui.tasks", "gui.leases", "gui.sessions", "gui.preMerge", "gui.audit",
        "gui.approvals", "gui.approve", "gui.autoApprove", "gui.stopSession",
        "gui.createWorktree", "gui.adoptWorktree", "gui.setHomeWorktree", "gui.chat",
        "gui.storage", "gui.setStorage", "gui.movePreflight", "gui.moveStart",
        "gui.moveStatus", "gui.moveUndo", "gui.moveDeleteOld",
    ] {
        assert!(validate_gui_method(method).is_ok(), "{method}");
    }
}

#[test]
fn blocking_call_keeps_the_method_allowlist_before_any_io() {
    for method in ["send_mail", "gui.nope", "gui.approvals_approve"] {
        let error = blocking_daemon_call(method.to_string(), json!({})).unwrap_err();
        assert_eq!(error.code, "FORBIDDEN_METHOD", "{method}");
    }
}

#[test]
fn async_daemon_command_awaits_blocking_work_off_the_window_thread() {
    let caller = std::thread::current().id();
    let worker = tauri::async_runtime::block_on(async {
        tauri::async_runtime::spawn_blocking(|| std::thread::current().id())
            .await
            .expect("blocking task completed")
    });
    assert_ne!(worker, caller, "blocking work must not run on the caller thread");

    let error = tauri::async_runtime::block_on(daemon_command("send_mail".to_string(), json!({})))
        .unwrap_err();
    assert_eq!(error.code, "FORBIDDEN_METHOD");
}

#[test]
fn config_dir_prefers_absolute_xdg_then_home_then_userprofile() {
    let xdg = TempDir::new("xdg");
    let home = TempDir::new("home");
    let profile = TempDir::new("profile");

    let all = env_map(&[
        ("XDG_CONFIG_HOME", xdg.path().as_os_str()),
        ("HOME", home.path().as_os_str()),
        ("USERPROFILE", profile.path().as_os_str()),
    ]);
    assert_eq!(config_dir_from(&all).unwrap(), xdg.path().join("artinarey"));

    let without_xdg = env_map(&[
        ("HOME", home.path().as_os_str()),
        ("USERPROFILE", profile.path().as_os_str()),
    ]);
    assert_eq!(
        config_dir_from(&without_xdg).unwrap(),
        home.path().join(".config").join("artinarey")
    );

    let without_home = env_map(&[("USERPROFILE", profile.path().as_os_str())]);
    assert_eq!(
        config_dir_from(&without_home).unwrap(),
        profile.path().join(".config").join("artinarey")
    );
}

#[test]
fn relative_config_values_are_ignored() {
    let home = TempDir::new("relative-home");
    let relative = OsStr::new("relative/config");

    let all_relative = env_map(&[
        ("XDG_CONFIG_HOME", relative),
        ("HOME", relative),
        ("USERPROFILE", relative),
    ]);
    assert_eq!(config_dir_from(&all_relative).unwrap_err().code, "DAEMON_UNREACHABLE");

    let relative_xdg = env_map(&[
        ("XDG_CONFIG_HOME", relative),
        ("HOME", home.path().as_os_str()),
    ]);
    assert_eq!(
        config_dir_from(&relative_xdg).unwrap(),
        home.path().join(".config").join("artinarey")
    );
}

#[test]
fn chunked_response_body_is_decoded() {
    assert_eq!(
        parse_http_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n")
            .unwrap(),
        "{}"
    );
}

#[test]
fn oversized_content_length_is_typed() {
    assert_eq!(
        parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n{}")
            .unwrap_err()
            .code,
        "BODY_TOO_LARGE"
    );
}

#[test]
fn truncated_bodies_are_bad_response() {
    assert_eq!(
        parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}")
            .unwrap_err()
            .code,
        "BAD_RESPONSE"
    );
    assert_eq!(
        parse_http_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{}")
            .unwrap_err()
            .code,
        "BAD_RESPONSE"
    );
}

#[test]
fn duplicate_framing_headers_are_bad_response() {
    assert_eq!(
        parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap_err()
            .code,
        "BAD_RESPONSE"
    );
    assert_eq!(
        parse_http_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n"
        )
        .unwrap_err()
        .code,
        "BAD_RESPONSE"
    );
}
