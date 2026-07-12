use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use relay_hermes_session::{
    AdapterError, ApprovalChoice, GatewayEndpoint, HermesSessionAdapter, SessionStatus,
};
use sha1::{Digest, Sha1};

#[test]
fn interrupt_race_is_degraded_and_never_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "session.create");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
        );
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "session.interrupt");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":4009,"message":"already completed"}}"#,
        );
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter =
        HermesSessionAdapter::connect(endpoint).expect("authenticated websocket handshake");

    let session = adapter.create(None).expect("owned live session");
    assert_eq!(
        adapter.interrupt(&session.live_id),
        Err(AdapterError::Raced)
    );
    assert_eq!(adapter.status(), SessionStatus::Degraded);
    server.join().expect("fake dashboard exits");
}

#[test]
fn interrupt_remote_failure_is_not_misreported_as_a_race() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "session.create");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
        );
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "session.interrupt");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":5000,"message":"gateway failure"}}"#,
        );
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter = HermesSessionAdapter::connect(endpoint).expect("dashboard handshake");
    let session = adapter.create(None).expect("owned live session");

    assert_eq!(
        adapter.interrupt(&session.live_id),
        Err(AdapterError::RemoteFailure)
    );
    assert_eq!(adapter.status(), SessionStatus::Degraded);
    server.join().expect("fake dashboard exits");
}

#[test]
fn forbidden_upgrade_is_typed_auth_failure_without_endpoint_or_token_echo() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        read_headers(&mut stream);
        stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            .expect("write forbidden response");
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let error = match HermesSessionAdapter::connect(endpoint) {
        Ok(_) => panic!("forbidden upgrade must fail"),
        Err(error) => error,
    };

    assert_eq!(error, AdapterError::AuthFailed);
    assert!(!error.to_string().contains("test-token"));
    server.join().expect("fake dashboard exits");
}

#[test]
fn approval_response_uses_a_supported_gateway_choice() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "session.create");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
        );
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "approval.respond");
        assert_eq!(request["params"]["session_id"], "live-session");
        assert_eq!(request["params"]["choice"], "once");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":2,"result":{"resolved":1}}"#,
        );
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter = HermesSessionAdapter::connect(endpoint).expect("dashboard handshake");
    let session = adapter.create(None).expect("owned live session");
    adapter
        .ingest_json(
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"approval.request","session_id":"live-session","payload":{}}}"#,
        )
        .expect("approval event");

    assert_eq!(
        adapter.respond_approval(&session.live_id, ApprovalChoice::Once),
        Ok(())
    );
    server.join().expect("fake dashboard exits");
}

#[test]
fn approval_race_is_not_reported_as_success_and_keeps_the_request_retryable() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        read_text_frame(&mut stream);
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
        );
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "approval.respond");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":2,"result":{"resolved":0}}"#,
        );
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "approval.respond");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":3,"result":{"resolved":1}}"#,
        );
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter = HermesSessionAdapter::connect(endpoint).expect("dashboard handshake");
    let session = adapter.create(None).expect("owned live session");
    adapter
        .ingest_json(
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"approval.request","session_id":"live-session","payload":{}}}"#,
        )
        .expect("approval event");

    assert_eq!(
        adapter.respond_approval(&session.live_id, ApprovalChoice::Once),
        Err(AdapterError::Raced)
    );
    assert_eq!(
        adapter.respond_approval(&session.live_id, ApprovalChoice::Once),
        Ok(())
    );
    server.join().expect("fake dashboard exits");
}

#[test]
fn approval_event_arriving_during_a_response_keeps_its_own_pending_marker() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        read_text_frame(&mut stream);
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
        );
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "approval.respond");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"approval.request","session_id":"live-session","payload":{}}}"#,
        );
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":2,"result":{"resolved":1}}"#,
        );
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "approval.respond");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":3,"result":{"resolved":1}}"#,
        );
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter = HermesSessionAdapter::connect(endpoint).expect("dashboard handshake");
    let session = adapter.create(None).expect("owned live session");
    adapter
        .ingest_json(
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"approval.request","session_id":"live-session","payload":{}}}"#,
        )
        .expect("first approval event");

    assert_eq!(
        adapter.respond_approval(&session.live_id, ApprovalChoice::Once),
        Ok(())
    );
    assert_eq!(
        adapter.respond_approval(&session.live_id, ApprovalChoice::Once),
        Ok(())
    );
    server.join().expect("fake dashboard exits");
}

#[test]
fn approval_remote_failure_does_not_clear_the_pending_request() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        read_text_frame(&mut stream);
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
        );
        read_text_frame(&mut stream);
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":5000,"message":"retryable gateway failure"}}"#,
        );
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "approval.respond");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":3,"result":{"resolved":1}}"#,
        );
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter = HermesSessionAdapter::connect(endpoint).expect("dashboard handshake");
    let session = adapter.create(None).expect("owned live session");
    adapter
        .ingest_json(
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"approval.request","session_id":"live-session","payload":{}}}"#,
        )
        .expect("approval event");

    assert_eq!(
        adapter.respond_approval(&session.live_id, ApprovalChoice::Once),
        Err(AdapterError::RemoteFailure)
    );
    assert_eq!(
        adapter.respond_approval(&session.live_id, ApprovalChoice::Once),
        Ok(())
    );
    server.join().expect("fake dashboard exits");
}

#[test]
fn clarification_response_exposes_only_its_opaque_correlation_id() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "session.create");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
        );
        let request = read_text_frame(&mut stream);
        assert_eq!(request["method"], "clarify.respond");
        assert_eq!(request["params"]["request_id"], "opaque-clarify-id");
        assert_eq!(request["params"]["answer"], "continue");
        write_text_frame(
            &mut stream,
            r#"{"jsonrpc":"2.0","id":2,"result":{"status":"ok"}}"#,
        );
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter = HermesSessionAdapter::connect(endpoint).expect("dashboard handshake");
    let _session = adapter.create(None).expect("owned live session");
    adapter
        .ingest_json(
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"clarify.request","session_id":"live-session","payload":{"request_id":"opaque-clarify-id","question":"hidden","choices":["hidden"]}}}"#,
        )
        .expect("correlated clarification event");

    let event = adapter.drain_events().pop().expect("clarification event");
    assert_eq!(event.clarification_id.as_deref(), Some("opaque-clarify-id"));
    assert_eq!(event.preview, "clarification requested");
    assert_eq!(
        adapter.respond_clarification("opaque-clarify-id", "continue"),
        Ok(())
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
