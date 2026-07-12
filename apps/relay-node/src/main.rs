use std::{
    env,
    process::ExitCode,
    time::{Duration, Instant},
};

use relay_factory_core::{ServiceIdentity, configured_identity, health_json};
use relay_hermes_session::{
    AdapterError, EventKind, GatewayEndpoint, HermesSessionAdapter, SessionStatus,
};
use relay_session::{
    DEFAULT_DEADLINE, ProcessTransport, SessionError, Supervisor,
    codex::{assert_local_stdio_only, codex_command_args},
};

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().skip(1).collect();

    match arguments.as_slice() {
        [command, identity_arguments @ ..] if command == "probe" => {
            match configured_identity(identity_arguments, ServiceIdentity::Node) {
                Ok(identity) => {
                    println!("{}", health_json(identity));
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("{}", error.to_json());
                    ExitCode::from(2)
                }
            }
        }
        [command, probe_arguments @ ..] if command == "codex-stdio-probe" => {
            codex_stdio_probe(probe_arguments)
        }
        [command, smoke_arguments @ ..] if command == "hermes-smoke" => {
            match run_hermes_smoke(smoke_arguments) {
                Ok(summary) => {
                    println!("{summary}");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("{{\"error\":{{\"code\":\"{}\"}}}}", error.code());
                    ExitCode::from(2)
                }
            }
        }
        _ => {
            eprintln!(
                "usage: relay-node <probe [--identity node]|codex-stdio-probe [--negative-transport|--handshake|--exercise]|hermes-smoke --gateway-url ws://127.0.0.1:PORT/api/ws?token=... [--cwd PATH] [--prompt TEXT] [--observe-ms 0..30000]>"
            );
            ExitCode::from(64)
        }
    }
}

/// An executable guard that proves the adapter only constructs local stdio
/// commands. `--handshake` opens and closes the real app-server; `--exercise`
/// additionally creates, resumes, prompts, and cancels a native thread.
fn codex_stdio_probe(arguments: &[String]) -> ExitCode {
    match arguments {
        [] => negative_transport_probe(),
        [flag] if flag == "--negative-transport" => negative_transport_probe(),
        [flag] if flag == "--handshake" => live_stdio_probe(false),
        [flag] if flag == "--exercise" => live_stdio_probe(true),
        _ => {
            eprintln!(
                "usage: relay-node codex-stdio-probe [--negative-transport|--handshake|--exercise]"
            );
            ExitCode::from(64)
        }
    }
}

fn negative_transport_probe() -> ExitCode {
    let fixed = codex_command_args();
    let websocket_attempt = vec![
        "app-server".to_owned(),
        "--listen".to_owned(),
        "ws://127.0.0.1:0".to_owned(),
    ];
    if assert_local_stdio_only(&fixed).is_ok()
        && assert_local_stdio_only(&websocket_attempt).is_err()
    {
        println!(
            "{{\"adapter\":\"codex-app-server-stdio\",\"network_transport\":\"rejected\",\"status\":\"ok\"}}"
        );
        ExitCode::SUCCESS
    } else {
        eprintln!("{{\"error\":{{\"code\":\"transport_guard_failed\"}}}}");
        ExitCode::FAILURE
    }
}

fn live_stdio_probe(exercise_turn: bool) -> ExitCode {
    let cwd = env::current_dir().ok();
    let mut session = match ProcessTransport::spawn(cwd.as_deref()) {
        Ok(transport) => Supervisor::new(transport),
        Err(error) => return probe_error(error),
    };
    let session_id = match session.create(DEFAULT_DEADLINE) {
        Ok(session_id) => session_id,
        Err(error) => return probe_error(error),
    };

    if !exercise_turn {
        session.close();
        println!(
            "{{\"adapter\":\"codex-app-server-stdio\",\"operation\":\"create\",\"status\":\"ok\"}}"
        );
        return ExitCode::SUCCESS;
    }

    let turn_id = match session.prompt(
        "Reply with exactly READY and do not use tools.",
        DEFAULT_DEADLINE,
    ) {
        Ok(turn_id) => turn_id,
        Err(error) => return probe_error(error),
    };
    let cancel = match session.cancel(&turn_id, DEFAULT_DEADLINE) {
        Ok(()) => "acknowledged",
        Err(SessionError::Raced(_)) => "raced",
        Err(error) => return probe_error(error),
    };
    session.pump();
    session.close();

    let mut resumed = match ProcessTransport::spawn(cwd.as_deref()) {
        Ok(transport) => Supervisor::new(transport),
        Err(error) => return probe_error(error),
    };
    if let Err(error) = resumed.resume(session_id.as_str(), DEFAULT_DEADLINE) {
        return probe_error(error);
    }
    resumed.close();
    println!(
        r#"{{"adapter":"codex-app-server-stdio","cancel":"{cancel}","operations":["create","prompt","cancel","resume"],"status":"ok"}}"#
    );
    ExitCode::SUCCESS
}

fn probe_error(error: SessionError) -> ExitCode {
    eprintln!(r#"{{"error":{{"code":"{}"}}}}"#, error.code());
    ExitCode::FAILURE
}

fn run_hermes_smoke(arguments: &[String]) -> Result<String, AdapterError> {
    let options = HermesSmokeOptions::parse(arguments)?;
    let endpoint = GatewayEndpoint::parse(&options.gateway_url)?;
    let mut adapter = HermesSessionAdapter::connect(endpoint)?;

    let listed = adapter.list()?;
    let created = adapter.create(options.cwd.as_deref())?;
    adapter.prompt(&created.live_id, &options.prompt)?;
    let resumed = adapter.resume(&created.stored_id)?;

    // Prompt submission is asynchronous. The caller chooses a bounded window
    // for real status/tool/interaction observation; a quiet interval is normal.
    let deadline = Instant::now() + Duration::from_millis(options.observe_ms);
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match adapter.pump(remaining.min(Duration::from_millis(250))) {
            Ok(()) | Err(AdapterError::Timeout) => {}
            Err(AdapterError::GatewayLost) => return Err(AdapterError::GatewayLost),
            Err(error) => return Err(error),
        }
    }
    let signals = adapter.stream_signals();
    let events = adapter.drain_events();
    let event_count = events.len();
    let tool_events = events
        .iter()
        .filter(|event| event.kind == EventKind::Tool)
        .count();
    let interaction_events = events
        .iter()
        .filter(|event| {
            matches!(
                event.kind,
                EventKind::ApprovalRequest | EventKind::ClarificationRequest
            )
        })
        .count();
    let status = match adapter.status() {
        SessionStatus::Idle => "idle",
        SessionStatus::Working => "working",
        SessionStatus::Degraded => "degraded",
        SessionStatus::Failed => "failed",
    };

    Ok(format!(
        "{{\"adapter\":\"hermes-rich-client\",\"create\":true,\"list_count\":{},\"resume\":{},\"prompt\":true,\"observed_events\":{},\"tool_events\":{},\"interaction_events\":{},\"unsupported_events\":{},\"foreign_events\":{},\"dropped_events\":{},\"interaction_limited\":{},\"status\":\"{}\"}}",
        listed.len(),
        !resumed.live_id.is_empty(),
        event_count,
        tool_events,
        interaction_events,
        signals.unsupported,
        signals.foreign,
        signals.dropped,
        signals.interaction_limited,
        status,
    ))
}

struct HermesSmokeOptions {
    gateway_url: String,
    cwd: Option<String>,
    prompt: String,
    observe_ms: u64,
}

impl HermesSmokeOptions {
    fn parse(arguments: &[String]) -> Result<Self, AdapterError> {
        let mut gateway_url = None;
        let mut cwd = None;
        let mut prompt = "Reply with exactly: relay rich-client smoke acknowledged".to_owned();
        let mut observe_ms = 200;
        let mut index = 0;
        while index < arguments.len() {
            let flag = &arguments[index];
            let value = arguments.get(index + 1).ok_or(AdapterError::MalformedRpc)?;
            match flag.as_str() {
                "--gateway-url" => gateway_url = Some(value.clone()),
                "--cwd" => cwd = Some(value.clone()),
                "--prompt" => prompt = value.clone(),
                "--observe-ms" => {
                    observe_ms = value
                        .parse::<u64>()
                        .ok()
                        .filter(|milliseconds| *milliseconds <= 30_000)
                        .ok_or(AdapterError::MalformedRpc)?;
                }
                _ => return Err(AdapterError::MalformedRpc),
            }
            index += 2;
        }
        let gateway_url = gateway_url.ok_or(AdapterError::MalformedRpc)?;
        if prompt.is_empty() {
            return Err(AdapterError::MalformedRpc);
        }
        Ok(Self {
            gateway_url,
            cwd,
            prompt,
            observe_ms,
        })
    }
}
