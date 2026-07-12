use std::{
    env, fmt,
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::ExitCode,
    sync::{Arc, Mutex, TryLockError},
    thread,
    time::{Duration, Instant},
};

use relay_factory_core::{
    AuthBoundary, AuthError, AuthOrigin, EnrollmentAuthority, ServiceIdentity, configured_identity,
    health_http_response, health_json, not_found_http_response,
};
use relay_hermes_session::GatewayEndpoint;
use relay_session::claude_pty::{
    ClaudePtyError, NodePtyRuntime, OwnerSessionCloseDisposition, PtyTermination,
    PtyTerminationOutcome, TerminalSnapshot,
};
use serde_json::Value;

mod workbench;

use workbench::{Workbench, WorkbenchError};

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_REQUEST_BYTES: usize = 65_536;
const MAX_BODY_BYTES: usize = 48_000;
// Eight capacity-consuming records, three bounded attempts, and the accepted
// TERM/reap windows fit below this single controlled-shutdown ceiling.
const PTY_SHUTDOWN_BUDGET: Duration = Duration::from_secs(35);
const PTY_LIFECYCLE_POLL: Duration = Duration::from_millis(10);

#[derive(Default)]
struct PtyRetryDriver {
    running: bool,
}

struct HubRuntime {
    auth: Option<Arc<AuthBoundary>>,
    owner_lifecycle: Mutex<()>,
    pty: Mutex<NodePtyRuntime>,
    retry_driver: Mutex<PtyRetryDriver>,
    workbench: Mutex<Workbench>,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(RunError::Config(error)) => {
            eprintln!("{}", error.to_json());
            ExitCode::from(2)
        }
        Err(RunError::Auth(error)) => {
            eprintln!("{}", auth_error_json(error.code()));
            ExitCode::from(2)
        }
        Err(RunError::Usage) => {
            eprintln!(
                "usage: relay-hub <probe|serve --bind <address> [--identity hub] [--origin https://relay.example] [--recovery-code-hash sha256hex] [--workspace-root PATH] [--hermes-gateway-url ws://127.0.0.1:PORT/api/ws?token=...] [--test-claude-fixture cat]>"
            );
            ExitCode::from(64)
        }
        Err(RunError::Io) => {
            eprintln!("relay-hub could not serve the configured boundary");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug)]
enum RunError {
    Config(relay_factory_core::ConfigError),
    Auth(AuthError),
    Usage,
    Io,
}

#[derive(Debug)]
enum ConnectionError {
    Request(RequestReadError),
    Write(io::Error),
}

#[derive(Debug)]
enum RequestReadError {
    Disconnected,
    Read(io::Error),
    TimedOut,
    TooLarge,
}

impl fmt::Display for ConnectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request(error) => write!(formatter, "request: {error}"),
            Self::Write(error) => write!(formatter, "write: {error}"),
        }
    }
}

impl fmt::Display for RequestReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Disconnected => formatter.write_str("peer disconnected"),
            Self::Read(error) => write!(formatter, "read: {error}"),
            Self::TimedOut => formatter.write_str("request timed out"),
            Self::TooLarge => formatter.write_str("request exceeded byte limit"),
        }
    }
}

fn run() -> Result<(), RunError> {
    let arguments: Vec<String> = env::args().skip(1).collect();

    match arguments.as_slice() {
        [command, rest @ ..] if command == "probe" => {
            let identity =
                configured_identity(rest, ServiceIdentity::Hub).map_err(RunError::Config)?;
            println!("{}", health_json(identity));
            Ok(())
        }
        [command, rest @ ..] if command == "serve" => serve(rest),
        _ => Err(RunError::Usage),
    }
}

fn serve(arguments: &[String]) -> Result<(), RunError> {
    let options = ServeOptions::parse(arguments)?;
    let listener = TcpListener::bind(options.address).map_err(|_| RunError::Io)?;
    #[cfg(debug_assertions)]
    let pty = if options.test_claude_fixture {
        NodePtyRuntime::test_fixture_cat()
    } else {
        NodePtyRuntime::default()
    };
    #[cfg(not(debug_assertions))]
    let pty = NodePtyRuntime::default();
    let runtime = Arc::new(HubRuntime {
        auth: options.auth,
        owner_lifecycle: Mutex::new(()),
        pty: Mutex::new(pty),
        retry_driver: Mutex::new(PtyRetryDriver::default()),
        workbench: options.workbench,
    });

    println!(
        "relay-hub liveness listening on {}",
        listener.local_addr().map_err(|_| RunError::Io)?
    );
    serve_connections(options.identity, runtime, || {
        listener.accept().map(|(stream, _)| stream)
    })
}

struct ServeOptions {
    address: SocketAddr,
    identity: ServiceIdentity,
    auth: Option<Arc<AuthBoundary>>,
    workbench: Mutex<Workbench>,
    #[cfg(debug_assertions)]
    test_claude_fixture: bool,
}

impl ServeOptions {
    fn parse(arguments: &[String]) -> Result<Self, RunError> {
        let mut bind = None;
        let mut identity_arguments = None;
        let mut origin = None;
        let mut recovery_hash = None;
        let mut workspace_roots = Vec::new();
        let mut hermes_gateway_url = None;
        #[cfg(debug_assertions)]
        let mut test_claude_fixture = false;
        let mut index = 0;

        while index < arguments.len() {
            let flag = &arguments[index];
            let value = arguments.get(index + 1).ok_or(RunError::Usage)?;
            match flag.as_str() {
                "--bind" if bind.is_none() => bind = Some(value.clone()),
                "--identity" if identity_arguments.is_none() => {
                    identity_arguments = Some(vec![flag.clone(), value.clone()]);
                }
                "--origin" if origin.is_none() => origin = Some(value.clone()),
                "--recovery-code-hash" if recovery_hash.is_none() => {
                    recovery_hash = Some(value.clone());
                }
                "--workspace-root" => workspace_roots.push(PathBuf::from(value)),
                "--hermes-gateway-url" if hermes_gateway_url.is_none() => {
                    hermes_gateway_url = Some(value.clone());
                }
                "--test-claude-fixture" if value == "cat" => {
                    #[cfg(debug_assertions)]
                    {
                        if test_claude_fixture {
                            return Err(RunError::Usage);
                        }
                        test_claude_fixture = true;
                    }
                    #[cfg(not(debug_assertions))]
                    {
                        return Err(RunError::Usage);
                    }
                }
                _ => return Err(RunError::Usage),
            }
            index += 2;
        }

        let address = bind.ok_or(RunError::Usage)?;
        let address = address.parse().map_err(|_| RunError::Usage)?;
        let identity = configured_identity(
            identity_arguments.as_deref().unwrap_or_default(),
            ServiceIdentity::Hub,
        )
        .map_err(RunError::Config)?;
        let auth = match (origin, recovery_hash) {
            (None, None) => None,
            (Some(origin), Some(recovery_hash)) => Some(Arc::new(
                AuthBoundary::from_recovery_hash_hex(
                    AuthOrigin::parse(&origin).map_err(RunError::Auth)?,
                    &recovery_hash,
                )
                .map_err(RunError::Auth)?,
            )),
            _ => return Err(RunError::Usage),
        };
        if workspace_roots.is_empty() {
            workspace_roots.push(env::current_dir().map_err(|_| RunError::Io)?);
        }
        let hermes_endpoint = hermes_gateway_url
            .map(|url| GatewayEndpoint::parse(&url).map_err(|_| RunError::Usage))
            .transpose()?;
        let workbench =
            Workbench::new(workspace_roots, hermes_endpoint).map_err(|_| RunError::Usage)?;

        Ok(Self {
            address,
            identity,
            auth,
            workbench: Mutex::new(workbench),
            #[cfg(debug_assertions)]
            test_claude_fixture,
        })
    }
}

#[cfg(test)]
fn serve_connections_with_auth(
    identity: ServiceIdentity,
    auth: Option<Arc<AuthBoundary>>,
    accept: impl FnMut() -> io::Result<TcpStream>,
) -> Result<(), RunError> {
    serve_connections(
        identity,
        Arc::new(HubRuntime {
            auth,
            owner_lifecycle: Mutex::new(()),
            pty: Mutex::new(NodePtyRuntime::default()),
            retry_driver: Mutex::new(PtyRetryDriver::default()),
            workbench: test_workbench(),
        }),
        accept,
    )
}

#[cfg(test)]
fn test_workbench() -> Mutex<Workbench> {
    Mutex::new(
        Workbench::new(
            vec![env::current_dir().expect("test current directory")],
            None,
        )
        .expect("test workbench"),
    )
}

fn serve_connections(
    identity: ServiceIdentity,
    runtime: Arc<HubRuntime>,
    mut accept: impl FnMut() -> io::Result<TcpStream>,
) -> Result<(), RunError> {
    let result = loop {
        let stream = match accept() {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("relay-hub accept error: {error}");
                break Err(RunError::Io);
            }
        };
        let runtime = Arc::clone(&runtime);
        if let Err(error) = thread::Builder::new().spawn(move || {
            if let Err(error) = handle_connection(stream, identity, runtime) {
                eprintln!("relay-hub connection error: {error}");
            }
        }) {
            eprintln!("relay-hub connection handler error: {error}");
            break Err(RunError::Io);
        }
    };

    if !shutdown_pty_runtime(&runtime) {
        eprintln!("relay Claude PTY shutdown incomplete; retained resources did not reach Closed");
    }
    result
}

fn handle_connection(
    mut stream: TcpStream,
    identity: ServiceIdentity,
    runtime: Arc<HubRuntime>,
) -> Result<(), ConnectionError> {
    stream
        .set_write_timeout(Some(CONNECTION_TIMEOUT))
        .map_err(ConnectionError::Write)?;
    let mut request = [0_u8; MAX_REQUEST_BYTES];
    let response = match read_request(&mut stream, &mut request) {
        Ok(length) => HttpRequest::parse(&request[..length])
            .map(|request| route_request(&request, identity, &runtime))
            .unwrap_or_else(not_found_http_response),
        Err(RequestReadError::TooLarge) => not_found_http_response(),
        Err(error) => return Err(ConnectionError::Request(error)),
    };

    stream
        .write_all(response.as_bytes())
        .map_err(ConnectionError::Write)
}

struct HttpRequest<'a> {
    method: &'a str,
    path: &'a str,
    query: Option<&'a str>,
    headers: Vec<(&'a str, &'a str)>,
    body: &'a str,
}

impl<'a> HttpRequest<'a> {
    fn parse(bytes: &'a [u8]) -> Option<Self> {
        let request = std::str::from_utf8(bytes).ok()?;
        let (head, body) = request.split_once("\r\n\r\n")?;
        let mut lines = head.split("\r\n");
        let request_line = lines.next()?;
        let mut request_parts = request_line.split_ascii_whitespace();
        let method = request_parts.next()?;
        let target = request_parts.next()?;
        if request_parts.next()? != "HTTP/1.1" || target.len() > 256 {
            return None;
        }
        let (path, query) = target
            .split_once('?')
            .map_or((target, None), |(path, query)| (path, Some(query)));
        let mut headers = Vec::new();
        for line in lines {
            let (name, value) = line.split_once(':')?;
            if name.is_empty() || value.len() > 4096 {
                return None;
            }
            headers.push((name, value.trim()));
        }
        Some(Self {
            method,
            path,
            query,
            headers,
            body,
        })
    }

    fn header(&self, name: &str) -> Option<&str> {
        let mut result = None;
        for (candidate, value) in &self.headers {
            if candidate.eq_ignore_ascii_case(name) {
                if result.is_some() {
                    return None;
                }
                result = Some(*value);
            }
        }
        result
    }

    fn cookie(&self, name: &str) -> Option<&str> {
        let cookies = self.header("cookie")?;
        let mut result = None;
        for cookie in cookies.split(';') {
            let cookie = cookie.trim();
            let Some((candidate, value)) = cookie.split_once('=') else {
                if cookie == name {
                    return None;
                }
                continue;
            };
            if candidate == name {
                if result.is_some() || value.is_empty() || value.len() > 256 {
                    return None;
                }
                result = Some(value);
            }
        }
        result
    }
}

fn route_request(
    request: &HttpRequest<'_>,
    identity: ServiceIdentity,
    runtime: &Arc<HubRuntime>,
) -> String {
    // A request is also the bounded retry driver: lease selection and result
    // reinsertion hold the mutex briefly, while TERM/KILL/reap run outside it.
    drive_pty_terminations(runtime);
    let auth = runtime.auth.as_deref();
    let response = match (request.method, request.path) {
        ("GET", "/health") => health_http_response(identity),
        ("POST", "/auth/passkeys/enroll/options") => start_enrollment_response(request, auth),
        ("POST", "/auth/passkeys/enroll/verify") => finish_enrollment_response(request, auth),
        ("POST", "/auth/passkeys/sign-in/options") => start_sign_in_response(request, auth),
        ("POST", "/auth/passkeys/sign-in/verify") => finish_sign_in_response(request, auth),
        ("GET", "/auth/sessions") => list_sessions_response(request, auth),
        ("POST", "/auth/sessions/revoke") => revoke_session_response(request, runtime),
        ("GET", "/protected/hub") => protected_hub_response(request, auth),
        (_, "/protected/node") => auth_error_response(403, "node_authority_required", &[]),
        (_, path) if path.starts_with("/api/") => {
            workbench_response(request, auth, &runtime.workbench)
        }
        ("POST", "/node/claude/sessions") => create_claude_session_response(request, runtime),
        ("GET", path) if claude_session_id(path, "").is_some() => {
            poll_claude_session_response(request, runtime)
        }
        ("POST", path) if claude_session_id(path, "/input").is_some() => {
            input_claude_session_response(request, runtime)
        }
        ("POST", path) if claude_session_id(path, "/resize").is_some() => {
            resize_claude_session_response(request, runtime)
        }
        ("POST", path) if claude_session_id(path, "/interrupt").is_some() => {
            interrupt_claude_session_response(request, runtime)
        }
        ("POST", path) if claude_session_id(path, "/close").is_some() => {
            close_claude_session_response(request, runtime)
        }
        _ => not_found_http_response(),
    };
    reap_invalidated_owner_sessions(runtime);
    ensure_pty_retry_driver(runtime);
    response
}

fn start_enrollment_response(request: &HttpRequest<'_>, auth: Option<&AuthBoundary>) -> String {
    let auth = match state_change_auth(request, auth) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let authority = match request.header("x-relay-recovery-code") {
        Some(code) => EnrollmentAuthority::RecoveryCode(code),
        None => {
            let session = match request.cookie("__Host-relay_session") {
                Some(session) => session,
                None => return auth_error_response(401, "session_missing", &[]),
            };
            let csrf = match request.header("x-relay-csrf") {
                Some(csrf) => csrf,
                None => return auth_error_response(403, "csrf_denied", &[]),
            };
            if let Err(error) = auth.require_csrf(session, csrf) {
                return auth_error_response(auth_error_status(&error), error.code(), &[]);
            }
            EnrollmentAuthority::ExistingSession(session)
        }
    };
    match auth.start_registration(authority) {
        Ok(ceremony) => json_response(
            200,
            &ceremony.options_json,
            &[ceremony_cookie(&ceremony.ceremony_id)],
        ),
        Err(error) => auth_error_response(auth_error_status(&error), error.code(), &[]),
    }
}

fn finish_enrollment_response(request: &HttpRequest<'_>, auth: Option<&AuthBoundary>) -> String {
    let auth = match state_change_auth(request, auth) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let ceremony = match request.cookie("__Host-relay_ceremony") {
        Some(ceremony) => ceremony,
        None => return auth_error_response(403, "unknown_ceremony", &[]),
    };
    match auth.finish_registration(ceremony, request.body) {
        Ok(()) => json_response(
            200,
            "{\"status\":\"passkey_enrolled\"}",
            &[clear_ceremony_cookie()],
        ),
        Err(error) => auth_error_response(
            auth_error_status(&error),
            error.code(),
            &[clear_ceremony_cookie()],
        ),
    }
}

fn start_sign_in_response(request: &HttpRequest<'_>, auth: Option<&AuthBoundary>) -> String {
    let auth = match state_change_auth(request, auth) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    match auth.start_authentication() {
        Ok(ceremony) => json_response(
            200,
            &ceremony.options_json,
            &[ceremony_cookie(&ceremony.ceremony_id)],
        ),
        Err(error) => auth_error_response(auth_error_status(&error), error.code(), &[]),
    }
}

fn finish_sign_in_response(request: &HttpRequest<'_>, auth: Option<&AuthBoundary>) -> String {
    let auth = match state_change_auth(request, auth) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let ceremony = match request.cookie("__Host-relay_ceremony") {
        Some(ceremony) => ceremony,
        None => return auth_error_response(403, "unknown_ceremony", &[]),
    };
    match auth.finish_authentication(ceremony, request.body) {
        Ok(session) => json_response(
            200,
            &format!("{{\"deviceId\":\"{}\"}}", session.device_id),
            &[
                clear_ceremony_cookie(),
                session_cookie(&session.session_token),
                csrf_cookie(&session.csrf_token),
            ],
        ),
        Err(error) => auth_error_response(
            auth_error_status(&error),
            error.code(),
            &[clear_ceremony_cookie()],
        ),
    }
}

fn list_sessions_response(request: &HttpRequest<'_>, auth: Option<&AuthBoundary>) -> String {
    let auth = match auth {
        Some(auth) => auth,
        None => return auth_error_response(404, "auth_unavailable", &[]),
    };
    let session = match request.cookie("__Host-relay_session") {
        Some(session) => session,
        None => return auth_error_response(401, "session_missing", &[]),
    };
    match auth.list_sessions(session) {
        Ok(sessions) => match serde_json::to_string(&serde_json::json!({ "sessions": sessions })) {
            Ok(body) => json_response(200, &body, &[]),
            Err(_) => auth_error_response(500, "internal", &[]),
        },
        Err(error) => auth_error_response(auth_error_status(&error), error.code(), &[]),
    }
}

fn revoke_session_response(request: &HttpRequest<'_>, runtime: &HubRuntime) -> String {
    let auth = match state_change_auth(request, runtime.auth.as_deref()) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let session = match request.cookie("__Host-relay_session") {
        Some(session) => session,
        None => return auth_error_response(401, "session_missing", &[]),
    };
    let csrf = match request.header("x-relay-csrf") {
        Some(csrf) => csrf,
        None => return auth_error_response(403, "csrf_denied", &[]),
    };
    let device_id = match device_id_from_body(request.body) {
        Some(device_id) => device_id,
        None => return auth_error_response(400, "invalid_request", &[]),
    };
    let result = auth.revoke_session(session, csrf, &device_id);
    reap_invalidated_owner_sessions(runtime);
    let cleanup_pending = auth
        .invalidated_device_ids()
        .map(|owners| owners.contains(&device_id))
        .unwrap_or(true);
    match result {
        Ok(()) if cleanup_pending => {
            json_response(200, "{\"status\":\"revoked\",\"cleanup\":\"pending\"}", &[])
        }
        Ok(()) => json_response(200, "{\"status\":\"revoked\"}", &[]),
        Err(error) => auth_error_response(auth_error_status(&error), error.code(), &[]),
    }
}

fn reap_invalidated_owner_sessions(runtime: &HubRuntime) {
    let Some(auth) = runtime.auth.as_deref() else {
        return;
    };
    {
        let _owner_lifecycle = owner_lifecycle_lock(runtime);
        let Ok(owner_ids) = auth.invalidated_device_ids() else {
            return;
        };
        if owner_ids.is_empty() {
            return;
        }
        let mut pty = pty_lifecycle_lock(runtime);
        for owner_id in &owner_ids {
            pty.begin_owner_session_closes(owner_id);
        }
    }

    drive_pty_terminations(runtime);
    acknowledge_ready_invalidated_owners(runtime);
}

fn acknowledge_ready_invalidated_owners(runtime: &HubRuntime) {
    let Some(auth) = runtime.auth.as_deref() else {
        return;
    };
    let _owner_lifecycle = owner_lifecycle_lock(runtime);
    let Ok(owner_ids) = auth.invalidated_device_ids() else {
        return;
    };
    let ready = {
        let pty = pty_lifecycle_lock(runtime);
        owner_ids
            .iter()
            .filter(|owner_id| invalidated_owner_ready_for_acknowledgement(&pty, owner_id))
            .cloned()
            .collect::<Vec<_>>()
    };
    if !ready.is_empty() {
        let _ = auth.acknowledge_invalidated_device_ids(&ready);
    }
}

fn invalidated_owner_ready_for_acknowledgement(pty: &NodePtyRuntime, owner_id: &str) -> bool {
    pty.owner_close_disposition(owner_id) == OwnerSessionCloseDisposition::Complete
}

fn pty_lifecycle_lock(runtime: &HubRuntime) -> std::sync::MutexGuard<'_, NodePtyRuntime> {
    runtime.pty.lock().unwrap_or_else(|poisoned| {
        eprintln!("relay Claude PTY lifecycle recovered its poisoned owner lock");
        poisoned.into_inner()
    })
}

fn owner_lifecycle_lock(runtime: &HubRuntime) -> std::sync::MutexGuard<'_, ()> {
    runtime.owner_lifecycle.lock().unwrap_or_else(|poisoned| {
        eprintln!("relay Claude PTY owner lifecycle recovered its poisoned gate");
        poisoned.into_inner()
    })
}

fn retry_driver_lock(runtime: &HubRuntime) -> std::sync::MutexGuard<'_, PtyRetryDriver> {
    runtime.retry_driver.lock().unwrap_or_else(|poisoned| {
        eprintln!("relay Claude PTY retry driver recovered its poisoned state");
        poisoned.into_inner()
    })
}

fn drive_pty_terminations(runtime: &HubRuntime) {
    drive_pty_terminations_with(runtime, PtyTermination::finish);
}

fn drive_pty_terminations_with(
    runtime: &HubRuntime,
    mut finish: impl FnMut(PtyTermination) -> PtyTerminationOutcome,
) {
    let leases = pty_lifecycle_lock(runtime).claim_due_terminations();
    for termination in leases {
        let outcome = finish(termination);
        pty_lifecycle_lock(runtime).complete_termination(outcome);
    }
}

fn ensure_pty_retry_driver(runtime: &Arc<HubRuntime>) {
    if !pty_lifecycle_lock(runtime).has_pending_terminations() {
        return;
    }
    let mut state = retry_driver_lock(runtime);
    if state.running {
        return;
    }
    state.running = true;
    let worker_runtime = Arc::clone(runtime);
    match thread::Builder::new()
        .name("relay-claude-pty-retry".into())
        .spawn(move || run_pty_retry_driver(worker_runtime))
    {
        Ok(_) => {}
        Err(error) => {
            eprintln!("relay Claude PTY retry worker spawn failed: {error}; running inline");
            drop(state);
            run_pty_retry_driver(Arc::clone(runtime));
        }
    }
}

fn run_pty_retry_driver(runtime: Arc<HubRuntime>) {
    run_retry_loop(
        || {
            drive_pty_terminations(&runtime);
            acknowledge_ready_invalidated_owners(&runtime);
        },
        || {
            let mut state = retry_driver_lock(&runtime);
            if pty_lifecycle_lock(&runtime).has_pending_terminations() {
                true
            } else {
                state.running = false;
                false
            }
        },
        || thread::sleep(PTY_LIFECYCLE_POLL),
    );
}

fn run_retry_loop(
    mut drive: impl FnMut(),
    mut still_pending: impl FnMut() -> bool,
    mut wait: impl FnMut(),
) {
    loop {
        drive();
        if !still_pending() {
            return;
        }
        wait();
    }
}

/// Drain the one-node PTY owner when the server loop exits normally through a
/// controlled error path. Abrupt process termination remains explicitly
/// outside this in-memory guarantee.
fn shutdown_pty_runtime(runtime: &HubRuntime) -> bool {
    let deadline = Instant::now() + PTY_SHUTDOWN_BUDGET;
    let scheduled = {
        let _owner_lifecycle = owner_lifecycle_lock(runtime);
        pty_lifecycle_lock(runtime).begin_shutdown()
    };
    acknowledge_ready_invalidated_owners(runtime);
    if scheduled == OwnerSessionCloseDisposition::Complete && !retry_driver_lock(runtime).running {
        return true;
    }

    loop {
        drive_pty_terminations(runtime);
        acknowledge_ready_invalidated_owners(runtime);
        let disposition = {
            let pty = pty_lifecycle_lock(runtime);
            (pty.shutdown_disposition(), pty.has_terminal_failures())
        };
        let driver_running = retry_driver_lock(runtime).running;
        match disposition {
            (OwnerSessionCloseDisposition::Complete, _) if !driver_running => return true,
            (_, true) if !driver_running => return false,
            (OwnerSessionCloseDisposition::Complete, _)
            | (_, true)
            | (OwnerSessionCloseDisposition::Retry, false) => {}
        }

        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return false;
        };
        thread::sleep(remaining.min(PTY_LIFECYCLE_POLL));
    }
}

fn protected_hub_response(request: &HttpRequest<'_>, auth: Option<&AuthBoundary>) -> String {
    let auth = match auth {
        Some(auth) => auth,
        None => return auth_error_response(404, "auth_unavailable", &[]),
    };
    match request
        .cookie("__Host-relay_session")
        .ok_or(AuthError::SessionMissing)
        .and_then(|session| auth.require_session(session))
    {
        Ok(()) => json_response(200, "{\"status\":\"operator_authorized\"}", &[]),
        Err(error) => auth_error_response(auth_error_status(&error), error.code(), &[]),
    }
}

fn workbench_response(
    request: &HttpRequest<'_>,
    auth: Option<&AuthBoundary>,
    workbench: &Mutex<Workbench>,
) -> String {
    let auth = match auth {
        Some(auth) => auth,
        None => return auth_error_response(404, "auth_unavailable", &[]),
    };
    let session = match request.cookie("__Host-relay_session") {
        Some(session) => session,
        None => return auth_error_response(401, "session_missing", &[]),
    };
    if let Err(error) = auth.require_session(session) {
        return auth_error_response(auth_error_status(&error), error.code(), &[]);
    }
    if request.method != "GET" {
        if let Err(error) = auth.enforce_origin(request.header("origin")) {
            return auth_error_response(auth_error_status(&error), error.code(), &[]);
        }
        let csrf = match request.header("x-relay-csrf") {
            Some(csrf) => csrf,
            None => return auth_error_response(403, "csrf_denied", &[]),
        };
        if let Err(error) = auth.require_csrf(session, csrf) {
            return auth_error_response(auth_error_status(&error), error.code(), &[]);
        }
    }

    let body = match request.method {
        "GET" => Ok(Value::Null),
        _ => serde_json::from_str(request.body).map_err(|_| WorkbenchError::new("invalid_request")),
    };
    let result = body.and_then(|body| {
        let mut workbench = workbench.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => WorkbenchError::new("workbench_busy"),
            TryLockError::Poisoned(_) => WorkbenchError::new("internal"),
        })?;
        let owner_session_is_active = match workbench.owner_session() {
            Some(owner) => match auth.require_session(owner) {
                Ok(()) => true,
                Err(AuthError::SessionMissing) => false,
                Err(_) => return Err(WorkbenchError::new("internal")),
            },
            None => false,
        };
        workbench.authorize(session, owner_session_is_active)?;
        match (request.method, request.path) {
            ("GET", "/api/workbench") => Ok(workbench.snapshot()),
            ("GET", "/api/sessions") => Ok(workbench.sessions_snapshot()),
            ("POST", "/api/workspaces") => workbench.add_workspace(&body),
            ("POST", "/api/workspaces/select") => workbench.select_workspace(&body),
            ("POST", "/api/sessions") => workbench.start_session(&body),
            ("POST", "/api/sessions/resume") => workbench.resume_session(&body),
            ("POST", "/api/sessions/message") => workbench.send_message(&body),
            ("POST", "/api/sessions/interrupt") => workbench.interrupt_session(&body),
            ("POST", "/api/sessions/close") => workbench.close_session(&body),
            _ => Err(WorkbenchError::new("not_found")),
        }
    });

    match result {
        Ok(value) => match serde_json::to_string(&value) {
            Ok(body) => json_response(200, &body, &[]),
            Err(_) => auth_error_response(500, "internal", &[]),
        },
        Err(error) if error.code() == "not_found" => not_found_http_response(),
        Err(error) => auth_error_response(workbench_error_status(error), error.code(), &[]),
    }
}

fn workbench_error_status(error: WorkbenchError) -> u16 {
    match error.code() {
        "invalid_request"
        | "workspace_cwd_invalid"
        | "workspace_cwd_not_absolute"
        | "workspace_cwd_not_approved" => 400,
        "unknown_workspace" | "unknown_session" | "unknown_provider_session" => 404,
        "workbench_owner_mismatch" => 403,
        "hermes_not_configured" | "unavailable" | "executable_unavailable" | "workbench_busy" => {
            503
        }
        "internal" => 500,
        _ => 409,
    }
}

fn create_claude_session_response(request: &HttpRequest<'_>, runtime: &HubRuntime) -> String {
    reap_invalidated_owner_sessions(runtime);
    let (owner, mut session) = {
        // Serialize auth resolution plus admission with invalidation
        // acknowledgement. Outside-lock teardown is deliberately not inside
        // this gate, so unrelated owner operations still make progress.
        let _owner_lifecycle = owner_lifecycle_lock(runtime);
        let owner = match terminal_owner(request, runtime.auth.as_deref(), true) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let session = match runtime.pty.lock() {
            Ok(mut pty) => pty.begin_create(&owner).into_result(),
            Err(_) => return auth_error_response(500, "internal", &[]),
        };
        (owner, session)
    };
    drive_pty_terminations(runtime);
    if session == Err(ClaudePtyError::Capacity) {
        session = {
            let _owner_lifecycle = owner_lifecycle_lock(runtime);
            if let Err(response) = terminal_owner(request, runtime.auth.as_deref(), true) {
                return response;
            }
            match runtime.pty.lock() {
                Ok(mut pty) => pty.begin_create(&owner).into_result(),
                Err(_) => return auth_error_response(500, "internal", &[]),
            }
        };
        drive_pty_terminations(runtime);
    }
    let session = match session {
        Ok(session) => session,
        Err(error) => return claude_pty_error_response(error),
    };
    match runtime
        .pty
        .lock()
        .map_err(|_| ClaudePtyError::Transport)
        .and_then(|mut pty| pty.poll(session.as_str(), &owner, 0))
    {
        Ok(snapshot) => terminal_snapshot_response(snapshot),
        Err(error) => claude_pty_error_response(error),
    }
}

fn poll_claude_session_response(request: &HttpRequest<'_>, runtime: &HubRuntime) -> String {
    let owner = match terminal_owner(request, runtime.auth.as_deref(), false) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let session_id = match claude_session_id(request.path, "") {
        Some(session_id) => session_id,
        None => return not_found_http_response(),
    };
    let cursor = match terminal_cursor(request.query) {
        Some(cursor) => cursor,
        None => return auth_error_response(400, "invalid_request", &[]),
    };
    match runtime
        .pty
        .lock()
        .map_err(|_| ClaudePtyError::Transport)
        .and_then(|mut pty| pty.poll(session_id, &owner, cursor))
    {
        Ok(snapshot) => terminal_snapshot_response(snapshot),
        Err(error) => claude_pty_error_response(error),
    }
}

fn input_claude_session_response(request: &HttpRequest<'_>, runtime: &HubRuntime) -> String {
    let owner = match terminal_owner(request, runtime.auth.as_deref(), true) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let session_id = match claude_session_id(request.path, "/input") {
        Some(session_id) => session_id,
        None => return not_found_http_response(),
    };
    let data = match terminal_input(request.body) {
        Some(data) => data,
        None => return auth_error_response(400, "invalid_request", &[]),
    };
    match runtime
        .pty
        .lock()
        .map_err(|_| ClaudePtyError::Transport)
        .and_then(|mut pty| pty.input(session_id, &owner, &data))
    {
        Ok(()) => json_response(200, "{\"status\":\"queued\"}", &[]),
        Err(error) => claude_pty_error_response(error),
    }
}

fn resize_claude_session_response(request: &HttpRequest<'_>, runtime: &HubRuntime) -> String {
    let owner = match terminal_owner(request, runtime.auth.as_deref(), true) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let session_id = match claude_session_id(request.path, "/resize") {
        Some(session_id) => session_id,
        None => return not_found_http_response(),
    };
    let (cols, rows) = match terminal_size(request.body) {
        Some(size) => size,
        None => return auth_error_response(400, "invalid_request", &[]),
    };
    match runtime
        .pty
        .lock()
        .map_err(|_| ClaudePtyError::Transport)
        .and_then(|mut pty| pty.resize(session_id, &owner, cols, rows))
    {
        Ok(()) => json_response(200, "{\"status\":\"accepted\"}", &[]),
        Err(error) => claude_pty_error_response(error),
    }
}

fn interrupt_claude_session_response(request: &HttpRequest<'_>, runtime: &HubRuntime) -> String {
    let owner = match terminal_owner(request, runtime.auth.as_deref(), true) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let session_id = match claude_session_id(request.path, "/interrupt") {
        Some(session_id) => session_id,
        None => return not_found_http_response(),
    };
    match runtime
        .pty
        .lock()
        .map_err(|_| ClaudePtyError::Transport)
        .and_then(|mut pty| pty.interrupt(session_id, &owner))
    {
        Ok(()) => json_response(200, "{\"status\":\"interrupted\"}", &[]),
        Err(error) => claude_pty_error_response(error),
    }
}

fn close_claude_session_response(request: &HttpRequest<'_>, runtime: &HubRuntime) -> String {
    let owner = match terminal_owner(request, runtime.auth.as_deref(), true) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let session_id = match claude_session_id(request.path, "/close") {
        Some(session_id) => session_id,
        None => return not_found_http_response(),
    };
    let requested = runtime
        .pty
        .lock()
        .map_err(|_| ClaudePtyError::Transport)
        .and_then(|mut pty| pty.request_close(session_id, &owner));
    if let Err(error) = requested {
        return claude_pty_error_response(error);
    }
    drive_pty_terminations(runtime);
    match runtime
        .pty
        .lock()
        .map_err(|_| ClaudePtyError::Transport)
        .and_then(|mut pty| pty.poll(session_id, &owner, 0))
    {
        Ok(snapshot) => terminal_snapshot_response(snapshot),
        Err(error) => claude_pty_error_response(error),
    }
}

fn terminal_owner(
    request: &HttpRequest<'_>,
    auth: Option<&AuthBoundary>,
    state_change: bool,
) -> Result<String, String> {
    let auth = if state_change {
        state_change_auth(request, auth)?
    } else {
        auth.ok_or_else(|| auth_error_response(404, "auth_unavailable", &[]))?
    };
    let session = request
        .cookie("__Host-relay_session")
        .ok_or_else(|| auth_error_response(401, "session_missing", &[]))?;
    if state_change {
        let csrf = request
            .header("x-relay-csrf")
            .ok_or_else(|| auth_error_response(403, "csrf_denied", &[]))?;
        auth.require_csrf(session, csrf)
            .map_err(|error| auth_error_response(auth_error_status(&error), error.code(), &[]))?;
    }
    auth.current_device_id(session)
        .map_err(|error| auth_error_response(auth_error_status(&error), error.code(), &[]))
}

fn claude_session_id<'a>(path: &'a str, suffix: &str) -> Option<&'a str> {
    let session_id = path
        .strip_prefix("/node/claude/sessions/")?
        .strip_suffix(suffix)?;
    if session_id.is_empty()
        || session_id.len() > 64
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    Some(session_id)
}

fn terminal_cursor(query: Option<&str>) -> Option<u64> {
    let Some(query) = query else {
        return Some(0);
    };
    let mut cursor = None;
    for parameter in query.split('&') {
        let Some((key, value)) = parameter.split_once('=') else {
            continue;
        };
        if key != "cursor" {
            continue;
        }
        if cursor.replace(value.parse().ok()?).is_some() {
            return None;
        }
    }
    Some(cursor.unwrap_or(0))
}

fn terminal_input(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    value.get("data")?.as_str().map(str::to_owned)
}

fn terminal_size(body: &str) -> Option<(u16, u16)> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    let cols = u16::try_from(value.get("cols")?.as_u64()?).ok()?;
    let rows = u16::try_from(value.get("rows")?.as_u64()?).ok()?;
    Some((cols, rows))
}

fn terminal_snapshot_response(snapshot: TerminalSnapshot) -> String {
    let output = snapshot
        .output
        .into_iter()
        .map(|chunk| serde_json::json!({ "sequence": chunk.sequence, "text": chunk.text }))
        .collect::<Vec<_>>();
    let status = if snapshot.status == relay_session::claude_pty::ClaudePtyStatus::Closing {
        202
    } else {
        200
    };
    match serde_json::to_string(&serde_json::json!({
        "sessionId": snapshot.session_id.as_str(),
        "status": snapshot.status.code(),
        "output": output,
        "nextCursor": snapshot.next_cursor,
        "hasMore": snapshot.has_more,
        "truncated": snapshot.truncated,
        "droppedChunks": snapshot.dropped_chunks,
    })) {
        Ok(body) => json_response(status, &body, &[]),
        Err(_) => auth_error_response(500, "internal", &[]),
    }
}

fn claude_pty_error_response(error: ClaudePtyError) -> String {
    let status = match error {
        ClaudePtyError::Forbidden => 403,
        ClaudePtyError::InvalidInput | ClaudePtyError::InvalidResize => 400,
        ClaudePtyError::Capacity | ClaudePtyError::StaleHandle | ClaudePtyError::InputLost => 409,
        ClaudePtyError::Backpressure
        | ClaudePtyError::Unavailable
        | ClaudePtyError::Transport
        | ClaudePtyError::TeardownFailed => 503,
    };
    auth_error_response(status, error.code(), &[])
}

fn state_change_auth<'a>(
    request: &HttpRequest<'_>,
    auth: Option<&'a AuthBoundary>,
) -> Result<&'a AuthBoundary, String> {
    let auth = auth.ok_or_else(|| auth_error_response(404, "auth_unavailable", &[]))?;
    auth.enforce_origin(request.header("origin"))
        .map_err(|error| auth_error_response(auth_error_status(&error), error.code(), &[]))?;
    Ok(auth)
}

fn device_id_from_body(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    let device_id = value.get("deviceId")?.as_str()?;
    if device_id.is_empty() || device_id.len() > 64 || !device_id.is_ascii() {
        return None;
    }
    Some(device_id.to_owned())
}

fn read_request(stream: &mut TcpStream, request: &mut [u8]) -> Result<usize, RequestReadError> {
    let deadline = Instant::now() + CONNECTION_TIMEOUT;
    let mut length = 0;
    let mut expected_length = None;

    loop {
        if expected_length.is_none() {
            if let Some(header_end) = request[..length]
                .windows(4)
                .position(|bytes| bytes == b"\r\n\r\n")
                .map(|index| index + 4)
            {
                let body_length = content_length(&request[..header_end])?;
                if body_length > MAX_BODY_BYTES {
                    return Err(RequestReadError::TooLarge);
                }
                let total = header_end
                    .checked_add(body_length)
                    .filter(|total| *total <= request.len())
                    .ok_or(RequestReadError::TooLarge)?;
                expected_length = Some(total);
            }
        }
        if let Some(expected_length) = expected_length {
            if length >= expected_length {
                return Ok(expected_length);
            }
        }
        if length == request.len() {
            return Err(RequestReadError::TooLarge);
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or(RequestReadError::TimedOut)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(RequestReadError::Read)?;

        let received = match stream.read(&mut request[length..]) {
            Ok(received) => received,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                return Err(RequestReadError::TimedOut);
            }
            Err(error) => return Err(RequestReadError::Read(error)),
        };
        if received == 0 {
            return Err(RequestReadError::Disconnected);
        }
        length += received;
    }
}

fn content_length(headers: &[u8]) -> Result<usize, RequestReadError> {
    let headers = std::str::from_utf8(headers)
        .map_err(|_| RequestReadError::Read(io::Error::from(io::ErrorKind::InvalidData)))?;
    let mut content_length = None;
    for line in headers.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(RequestReadError::Read(io::Error::from(
                    io::ErrorKind::InvalidData,
                )));
            }
            content_length = Some(value.trim().parse().map_err(|_| {
                RequestReadError::Read(io::Error::from(io::ErrorKind::InvalidData))
            })?);
        }
    }
    Ok(content_length.unwrap_or(0))
}

fn auth_error_status(error: &AuthError) -> u16 {
    match error {
        AuthError::SessionMissing => 401,
        AuthError::Internal => 500,
        _ => 403,
    }
}

fn ceremony_cookie(value: &str) -> String {
    format!(
        "Set-Cookie: __Host-relay_ceremony={value}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Strict"
    )
}

fn clear_ceremony_cookie() -> String {
    "Set-Cookie: __Host-relay_ceremony=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict"
        .to_owned()
}

fn session_cookie(value: &str) -> String {
    format!(
        "Set-Cookie: __Host-relay_session={value}; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict"
    )
}

fn csrf_cookie(value: &str) -> String {
    format!("Set-Cookie: __Host-relay_csrf={value}; Path=/; Max-Age=1800; Secure; SameSite=Strict")
}

fn auth_error_json(code: &str) -> String {
    format!("{{\"error\":{{\"code\":\"{code}\"}}}}")
}

fn auth_error_response(status: u16, code: &str, extra_headers: &[String]) -> String {
    json_response(status, &auth_error_json(code), extra_headers)
}

fn json_response(status: u16, body: &str, extra_headers: &[String]) -> String {
    let reason = match status {
        200 => "200 OK",
        202 => "202 Accepted",
        400 => "400 Bad Request",
        401 => "401 Unauthorized",
        403 => "403 Forbidden",
        404 => "404 Not Found",
        409 => "409 Conflict",
        503 => "503 Service Unavailable",
        _ => "500 Internal Server Error",
    };
    let mut headers = vec![
        format!("HTTP/1.1 {reason}"),
        "Content-Type: application/json".to_owned(),
        "Cache-Control: no-store".to_owned(),
        "X-Content-Type-Options: nosniff".to_owned(),
        format!("Content-Length: {}", body.len()),
        "Connection: close".to_owned(),
    ];
    headers.extend(extra_headers.iter().cloned());
    format!("{}\r\n\r\n{body}", headers.join("\r\n"))
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;

    #[test]
    fn listener_accept_failure_stops_serving() {
        let result = serve_connections_with_auth(ServiceIdentity::Hub, None, || {
            Err(io::Error::other("injected listener failure"))
        });

        assert!(matches!(result, Err(RunError::Io)));
    }

    #[test]
    fn listener_exit_drains_and_latches_the_pty_runtime() {
        let runtime = Arc::new(HubRuntime {
            auth: None,
            owner_lifecycle: Mutex::new(()),
            pty: Mutex::new(NodePtyRuntime::test_fixture_cat()),
            retry_driver: Mutex::new(PtyRetryDriver::default()),
            workbench: test_workbench(),
        });
        let session = runtime
            .pty
            .lock()
            .unwrap()
            .begin_create("device-a")
            .into_result()
            .expect("the fixed test PTY starts");
        let observed = Arc::clone(&runtime);

        let result = serve_connections(ServiceIdentity::Hub, runtime, || {
            Err(io::Error::other("injected listener failure"))
        });

        assert!(matches!(result, Err(RunError::Io)));
        let mut pty = observed.pty.lock().unwrap();
        assert_eq!(
            pty.poll(session.as_str(), "device-a", 0)
                .expect("controlled shutdown retains terminal truth")
                .status,
            relay_session::claude_pty::ClaudePtyStatus::Closed
        );
        assert_eq!(
            pty.begin_create("device-a").into_result(),
            Err(ClaudePtyError::Unavailable),
            "controlled shutdown must latch against concurrent admission"
        );
    }

    #[test]
    fn close_is_accepted_then_reaped_without_another_request() {
        let runtime = Arc::new(HubRuntime {
            auth: None,
            owner_lifecycle: Mutex::new(()),
            pty: Mutex::new(NodePtyRuntime::test_fixture_cat()),
            retry_driver: Mutex::new(PtyRetryDriver::default()),
            workbench: test_workbench(),
        });
        let session = runtime
            .pty
            .lock()
            .unwrap()
            .begin_create("device-a")
            .into_result()
            .expect("the fixed test PTY starts");
        let closing = {
            let mut pty = runtime.pty.lock().unwrap();
            pty.request_close(session.as_str(), "device-a")
                .expect("explicit close enters the lifecycle");
            pty.poll(session.as_str(), "device-a", 0)
                .expect("Closing remains observable")
        };

        let response = terminal_snapshot_response(closing);
        assert!(response.starts_with("HTTP/1.1 202 Accepted"));
        assert!(response.contains("\"status\":\"closing\""));

        ensure_pty_retry_driver(&runtime);
        let deadline = Instant::now() + Duration::from_secs(3);
        let closed = loop {
            let snapshot = runtime
                .pty
                .lock()
                .unwrap()
                .poll(session.as_str(), "device-a", 0)
                .expect("terminal truth remains observable");
            if snapshot.status == relay_session::claude_pty::ClaudePtyStatus::Closed {
                break snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "the autonomous retry driver did not finish the close"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let response = terminal_snapshot_response(closed);
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("\"status\":\"closed\""));
        while retry_driver_lock(&runtime).running {
            assert!(Instant::now() < deadline, "the retry worker did not exit");
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn retry_loop_runs_all_bounded_attempts_without_a_client_request() {
        let attempts = std::cell::Cell::new(0_usize);
        let waits = std::cell::Cell::new(0_usize);

        run_retry_loop(
            || attempts.set(attempts.get().saturating_add(1)),
            || attempts.get() < 3,
            || waits.set(waits.get().saturating_add(1)),
        );

        assert_eq!(attempts.get(), 3);
        assert_eq!(waits.get(), 2);
    }

    #[test]
    fn teardown_lease_allows_unrelated_admission_progress() {
        let runtime = HubRuntime {
            auth: None,
            owner_lifecycle: Mutex::new(()),
            pty: Mutex::new(NodePtyRuntime::test_fixture_cat()),
            retry_driver: Mutex::new(PtyRetryDriver::default()),
            workbench: test_workbench(),
        };
        let closing = runtime
            .pty
            .lock()
            .unwrap()
            .begin_create("device-a")
            .into_result()
            .expect("the closing fixture starts");
        runtime
            .pty
            .lock()
            .unwrap()
            .request_close(closing.as_str(), "device-a")
            .unwrap();
        let mut unrelated = None;

        drive_pty_terminations_with(&runtime, |termination| {
            let owner_lifecycle = runtime
                .owner_lifecycle
                .try_lock()
                .expect("teardown does not retain the owner lifecycle gate");
            let session = runtime
                .pty
                .try_lock()
                .expect("teardown does not retain the PTY mutex")
                .begin_create("device-b")
                .into_result()
                .expect("an unrelated owner can make admission progress");
            unrelated = Some(session);
            drop(owner_lifecycle);
            termination.finish()
        });

        let unrelated = unrelated.expect("the outside-lock callback ran");
        runtime
            .pty
            .lock()
            .unwrap()
            .request_close(unrelated.as_str(), "device-b")
            .unwrap();
        drive_pty_terminations(&runtime);
    }

    #[test]
    fn invalidated_owner_acknowledgement_waits_for_verified_closed() {
        let runtime = HubRuntime {
            auth: None,
            owner_lifecycle: Mutex::new(()),
            pty: Mutex::new(NodePtyRuntime::test_fixture_cat()),
            retry_driver: Mutex::new(PtyRetryDriver::default()),
            workbench: test_workbench(),
        };
        let owners = ["device-a".to_owned()];
        runtime
            .pty
            .lock()
            .unwrap()
            .begin_create(&owners[0])
            .into_result()
            .expect("the fixed test PTY starts");
        {
            let mut pty = runtime.pty.lock().unwrap();
            pty.begin_owner_session_closes(&owners[0]);
            assert!(
                !invalidated_owner_ready_for_acknowledgement(&pty, &owners[0]),
                "Closing must retain the auth invalidation"
            );
        }

        drive_pty_terminations(&runtime);
        assert!(invalidated_owner_ready_for_acknowledgement(
            &runtime.pty.lock().unwrap(),
            &owners[0]
        ));
    }

    #[test]
    fn cookie_skips_valueless_unrelated_segments() {
        let request = HttpRequest::parse(
            b"GET /protected/hub HTTP/1.1\r\nHost: relay.example.test\r\nCookie: __Host-relay_session=valid-session; legacy\r\n\r\n",
        )
        .expect("the request is well formed");

        assert_eq!(
            request.cookie("__Host-relay_session"),
            Some("valid-session")
        );
    }

    #[test]
    fn cookie_rejects_invalid_or_ambiguous_target_segments() {
        let oversized = format!("__Host-relay_session={}", "a".repeat(257));
        for cookie in [
            "__Host-relay_session",
            "__Host-relay_session=",
            "__Host-relay_session=first; __Host-relay_session=second",
            oversized.as_str(),
        ] {
            let request = format!(
                "GET /protected/hub HTTP/1.1\r\nHost: relay.example.test\r\nCookie: {cookie}\r\n\r\n"
            );
            let request =
                HttpRequest::parse(request.as_bytes()).expect("the request is well formed");

            assert_eq!(
                request.cookie("__Host-relay_session"),
                None,
                "cookie: {cookie}"
            );
        }
    }

    #[test]
    fn terminal_cursor_accepts_unrelated_parameters_and_rejects_ambiguous_cursor_values() {
        assert_eq!(terminal_cursor(None), Some(0));
        assert_eq!(terminal_cursor(Some("trace=browser&cursor=42")), Some(42));
        assert_eq!(terminal_cursor(Some("cursor=42&trace=browser")), Some(42));
        assert_eq!(terminal_cursor(Some("trace=browser")), Some(0));
        assert_eq!(terminal_cursor(Some("cursor=not-a-number")), None);
        assert_eq!(terminal_cursor(Some("cursor=1&cursor=2")), None);
    }

    #[test]
    fn input_delivery_loss_is_an_explicit_nonretryable_conflict() {
        let response = claude_pty_error_response(ClaudePtyError::InputLost);

        assert!(response.starts_with("HTTP/1.1 409 Conflict"));
        assert!(response.contains("input_delivery_lost"));
    }

    #[test]
    fn terminal_capacity_transport_and_teardown_failure_remain_typed_api_failures() {
        for (error, status, code) in [
            (
                ClaudePtyError::Capacity,
                "HTTP/1.1 409 Conflict",
                "session_capacity",
            ),
            (
                ClaudePtyError::Transport,
                "HTTP/1.1 503 Service Unavailable",
                "pty_transport",
            ),
            (
                ClaudePtyError::TeardownFailed,
                "HTTP/1.1 503 Service Unavailable",
                "pty_teardown_failed",
            ),
        ] {
            let response = claude_pty_error_response(error);

            assert!(response.starts_with(status));
            assert!(response.contains(code));
        }
    }
}
