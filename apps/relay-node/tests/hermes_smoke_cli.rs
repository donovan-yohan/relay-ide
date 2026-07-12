use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    thread,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha1::{Digest, Sha1};

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

#[test]
fn hermes_smoke_reports_gateway_loss_during_observation() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);

        assert_eq!(read_text_frame(&mut stream)["method"], "session.list");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":1,"result":{"sessions":[]}}"#,
        );
        assert_eq!(read_text_frame(&mut stream)["method"], "session.create");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":2,"result":{"session_id":"live","stored_session_id":"stored"}}"#,
        );
        assert_eq!(read_text_frame(&mut stream)["method"], "prompt.submit");
        write_text_frame(&mut stream, r#"{"jsonrpc":"2.0","id":3,"result":{}}"#);
        assert_eq!(read_text_frame(&mut stream)["method"], "session.resume");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":4,"result":{"session_id":"resumed","stored_session_id":"stored"}}"#,
        );
    });

    let output = Command::new(env!("CARGO_BIN_EXE_relay-node"))
        .args([
            "hermes-smoke",
            "--gateway-url",
            &format!("ws://127.0.0.1:{port}/api/ws?token=test-token"),
            "--prompt",
            "ok",
            "--observe-ms",
            "100",
        ])
        .output()
        .expect("run relay-node");

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stderr)
            .expect("stderr UTF-8")
            .trim(),
        "{\"error\":{\"code\":\"gateway_lost\"}}"
    );
    server.join().expect("fake dashboard exits");
}

fn accept_upgrade(stream: &mut TcpStream) {
    let request = read_headers(stream);
    let key = request
        .lines()
        .find_map(|line| line.strip_prefix("Sec-WebSocket-Key: "))
        .expect("websocket key");
    let mut digest = Sha1::new();
    digest.update(key.as_bytes());
    digest.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let accept = STANDARD.encode(digest.finalize());
    write!(
        stream,
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    .expect("write websocket upgrade");
}

fn read_headers(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut byte = [0_u8; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).expect("read HTTP header byte");
        bytes.push(byte[0]);
    }
    String::from_utf8(bytes).expect("HTTP header is UTF-8")
}

fn read_text_frame(stream: &mut TcpStream) -> serde_json::Value {
    let mut header = [0_u8; 2];
    stream
        .read_exact(&mut header)
        .expect("read websocket header");
    assert_eq!(header[0], 0x81, "client text frame");
    assert_ne!(header[1] & 0x80, 0, "client frames are masked");
    let length = usize::from(header[1] & 0x7F);
    assert!(length < 126, "test request stays compact");
    let mut mask = [0_u8; 4];
    stream.read_exact(&mut mask).expect("read mask");
    let mut payload = vec![0_u8; length];
    stream.read_exact(&mut payload).expect("read payload");
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % mask.len()];
    }
    serde_json::from_slice(&payload).expect("JSON-RPC request")
}

fn write_text_frame(stream: &mut TcpStream, text: &str) {
    assert!(text.len() < 126, "test response stays compact");
    stream
        .write_all(&[0x81, text.len() as u8])
        .expect("write frame header");
    stream
        .write_all(text.as_bytes())
        .expect("write frame payload");
    stream.flush().expect("flush frame");
}
