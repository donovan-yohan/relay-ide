use relay_hermes_session::{
    AdapterError, EventKind, GatewayEndpoint, HermesSessionAdapter, SessionStatus,
};

#[test]
fn rejects_non_loopback_and_non_rich_client_endpoints_without_echoing_credentials() {
    let credential = "not-a-real-token";
    let error =
        GatewayEndpoint::parse(&format!("ws://example.test:9119/api/ws?token={credential}"))
            .expect_err("remote gateway fallback must be rejected");

    assert_eq!(error.code(), "unsupported_endpoint");
    assert!(!error.to_string().contains(credential));
}

#[test]
fn unsupported_gateway_events_are_visible_and_never_silently_dropped() {
    let mut adapter = HermesSessionAdapter::scripted();

    adapter
        .ingest_json(r#"{"jsonrpc":"2.0","method":"event","params":{"type":"provider.private","session_id":"live-1","payload":{"secret":"do-not-log"}}}"#)
        .expect("well-formed unknown event is observable");

    let events = adapter.drain_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].session_id, "live-1");
    assert_eq!(events[0].kind, EventKind::Unsupported);
    assert_eq!(events[0].label, "unsupported_event");
    assert!(!events[0].preview.contains("do-not-log"));
    assert_eq!(adapter.status(), SessionStatus::Degraded);
}

#[test]
fn bounded_queue_reports_replay_gap_instead_of_lying_about_complete_history() {
    let mut adapter = HermesSessionAdapter::scripted_with_queue_limit(2);

    for index in 0..3 {
        adapter
            .ingest_json(&format!(
                r#"{{"jsonrpc":"2.0","method":"event","params":{{"type":"tool.start","session_id":"live-1","payload":{{"name":"tool-{index}"}}}}}}"#
            ))
            .expect("tool event fits the supported schema");
    }

    let signals = adapter.stream_signals();
    assert_eq!(signals.dropped, 1);
    assert!(signals.replay_gap);
    assert_eq!(adapter.status(), SessionStatus::Degraded);
}

#[test]
fn malformed_frames_fail_closed_with_a_typed_error() {
    let mut adapter = HermesSessionAdapter::scripted();

    let error = adapter
        .ingest_json("not json")
        .expect_err("bad JSON cannot be mapped");

    assert_eq!(error, AdapterError::MalformedRpc);
    assert_eq!(adapter.status(), SessionStatus::Degraded);
}
