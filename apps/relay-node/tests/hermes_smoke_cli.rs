use std::process::Command;

#[test]
fn hermes_smoke_rejects_remote_gateway_urls_without_echoing_credentials() {
    let token = "not-a-real-token";
    let output = Command::new(env!("CARGO_BIN_EXE_relay-node"))
        .args([
            "hermes-smoke",
            "--gateway-url",
            &format!("ws://example.test:9119/api/ws?token={token}"),
        ])
        .output()
        .expect("run relay-node");

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8(output.stderr).expect("stderr UTF-8");
    assert_eq!(
        stderr.trim(),
        "{\"error\":{\"code\":\"unsupported_endpoint\"}}"
    );
    assert!(!stderr.contains(token));
}
