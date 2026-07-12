use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use relay_hermes_session::{AdapterError, GatewayEndpoint, HermesSessionAdapter, SessionStatus};
use sha1::{Digest, Sha1};

#[test]
fn gateway_disconnect_during_a_control_request_is_terminal_and_typed() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        read_text_frame(&mut stream);
        write_text_frame(
            &mut stream,
            r#"{"id":1,"result":{"session_id":"live-session","stored_session_id":"stored-session"}}"#,
        );
        read_text_frame(&mut stream);
        // Drop the live transport before the interrupt JSON-RPC response.
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter = HermesSessionAdapter::connect(endpoint).expect("dashboard handshake");
    let session = adapter.create(None).expect("session creation response");

    assert_eq!(
        adapter.interrupt(&session.live_id),
        Err(AdapterError::GatewayLost)
    );
    assert_eq!(adapter.status(), SessionStatus::Failed);
    server.join().expect("fake dashboard exits");
}

#[test]
fn quiet_observation_timeout_preserves_the_prior_session_status() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        thread::sleep(Duration::from_millis(50));
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter = HermesSessionAdapter::connect(endpoint).expect("dashboard handshake");

    assert_eq!(
        adapter.pump(Duration::from_millis(5)),
        Err(AdapterError::Timeout)
    );
    assert_eq!(adapter.status(), SessionStatus::Idle);
    server.join().expect("fake dashboard exits");
}

#[test]
fn connected_adapter_rejects_controls_for_unowned_live_sessions() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake dashboard");
    let port = listener.local_addr().expect("listener address").port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("adapter connects");
        accept_upgrade(&mut stream);
        thread::sleep(Duration::from_millis(50));
    });

    let endpoint =
        GatewayEndpoint::parse(&format!("ws://127.0.0.1:{port}/api/ws?token=test-token"))
            .expect("loopback dashboard URL");
    let mut adapter = HermesSessionAdapter::connect(endpoint).expect("dashboard handshake");

    assert_eq!(
        adapter.interrupt("another-live-session"),
        Err(AdapterError::UnknownSession)
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

fn read_text_frame(stream: &mut TcpStream) {
    let mut header = [0_u8; 2];
    stream
        .read_exact(&mut header)
        .expect("read websocket header");
    let length = usize::from(header[1] & 0x7F);
    assert!(length < 126, "test request stays compact");
    let mut mask = [0_u8; 4];
    stream.read_exact(&mut mask).expect("read mask");
    let mut payload = vec![0_u8; length];
    stream.read_exact(&mut payload).expect("read payload");
}

fn write_text_frame(stream: &mut TcpStream, text: &str) {
    let payload = text.as_bytes();
    assert!(payload.len() < 126, "test response stays compact");
    stream
        .write_all(&[0x81, payload.len() as u8])
        .expect("write websocket header");
    stream.write_all(payload).expect("write websocket payload");
}
