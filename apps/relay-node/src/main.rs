use std::{
    env,
    process::ExitCode,
    thread,
    time::{Duration, Instant},
};

use relay_factory_core::{ServiceIdentity, configured_identity, health_json};
use relay_session::claude_pty::{ClaudePtyStatus, NodePtyRuntime};
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
        [command] if command == "claude-pty-probe" => claude_pty_probe(),
        _ => {
            eprintln!(
                "usage: relay-node <probe [--identity node]|codex-stdio-probe [--negative-transport|--handshake|--exercise]|claude-pty-probe>"
            );
            ExitCode::from(64)
        }
    }
}

/// Opt-in owner-context smoke for the fixed Claude PTY runtime. The probe
/// deliberately emits lifecycle facts only: never terminal bytes, OAuth data,
/// or a Session handle.
fn claude_pty_probe() -> ExitCode {
    let mut runtime = NodePtyRuntime::default();
    let session = match runtime.create("relay-node-probe") {
        Ok(session) => session,
        Err(error) => return claude_pty_probe_error(error.code()),
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match runtime.poll(session.as_str(), "relay-node-probe", 0) {
            Ok(snapshot) if snapshot.status != ClaudePtyStatus::Starting => break snapshot.status,
            Ok(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(_) => {
                let _ = runtime.close(session.as_str(), "relay-node-probe");
                return claude_pty_probe_error("startup_timeout");
            }
            Err(error) => return claude_pty_probe_error(error.code()),
        }
    };
    let resize = runtime.resize(session.as_str(), "relay-node-probe", 100, 40);
    let interrupt = runtime.interrupt(session.as_str(), "relay-node-probe");
    let close = runtime.close(session.as_str(), "relay-node-probe");
    match (resize, interrupt, close) {
        (Ok(()), Ok(()), Ok(closed)) if closed.status == ClaudePtyStatus::Closed => {
            println!(
                r#"{{"adapter":"claude-pty","operations":["spawn","resize","interrupt","close"],"ownerHome":"/home/donovanyohan","startup":"{}","status":"ok"}}"#,
                status.code()
            );
            ExitCode::SUCCESS
        }
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            claude_pty_probe_error(error.code())
        }
        _ => claude_pty_probe_error("close_failed"),
    }
}

fn claude_pty_probe_error(code: &str) -> ExitCode {
    eprintln!("{{\"error\":{{\"code\":\"{code}\"}}}}");
    ExitCode::FAILURE
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
