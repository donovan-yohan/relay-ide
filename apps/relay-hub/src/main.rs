use std::{
    env, fmt,
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::ExitCode,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use relay_factory_core::{
    AuthBoundary, AuthError, AuthOrigin, EnrollmentAuthority, ServiceIdentity, configured_identity,
    health_http_response, health_json, not_found_http_response,
};
use serde_json::Value;

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_REQUEST_BYTES: usize = 65_536;
const MAX_BODY_BYTES: usize = 48_000;

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
                "usage: relay-hub <probe|serve --bind <address> [--identity hub] [--origin https://relay.example] [--recovery-code-hash sha256hex]>"
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

    println!(
        "relay-hub liveness listening on {}",
        listener.local_addr().map_err(|_| RunError::Io)?
    );
    serve_connections_with_auth(options.identity, options.auth, || {
        listener.accept().map(|(stream, _)| stream)
    })
}

struct ServeOptions {
    address: SocketAddr,
    identity: ServiceIdentity,
    auth: Option<Arc<AuthBoundary>>,
}

impl ServeOptions {
    fn parse(arguments: &[String]) -> Result<Self, RunError> {
        let mut bind = None;
        let mut identity_arguments = None;
        let mut origin = None;
        let mut recovery_hash = None;
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

        Ok(Self {
            address,
            identity,
            auth,
        })
    }
}

fn serve_connections_with_auth(
    identity: ServiceIdentity,
    auth: Option<Arc<AuthBoundary>>,
    mut accept: impl FnMut() -> io::Result<TcpStream>,
) -> Result<(), RunError> {
    loop {
        let stream = match accept() {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("relay-hub accept error: {error}");
                return Err(RunError::Io);
            }
        };
        let auth = auth.clone();
        thread::Builder::new()
            .spawn(move || {
                if let Err(error) = handle_connection(stream, identity, auth.as_deref()) {
                    eprintln!("relay-hub connection error: {error}");
                }
            })
            .map_err(|error| {
                eprintln!("relay-hub connection handler error: {error}");
                RunError::Io
            })?;
    }
}

fn handle_connection(
    mut stream: TcpStream,
    identity: ServiceIdentity,
    auth: Option<&AuthBoundary>,
) -> Result<(), ConnectionError> {
    stream
        .set_write_timeout(Some(CONNECTION_TIMEOUT))
        .map_err(ConnectionError::Write)?;
    let mut request = [0_u8; MAX_REQUEST_BYTES];
    let response = match read_request(&mut stream, &mut request) {
        Ok(length) => HttpRequest::parse(&request[..length])
            .map(|request| route_request(&request, identity, auth))
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
        let path = request_parts.next()?;
        if request_parts.next()? != "HTTP/1.1" || path.len() > 256 {
            return None;
        }
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
            let (candidate, value) = cookie.trim().split_once('=')?;
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
    auth: Option<&AuthBoundary>,
) -> String {
    match (request.method, request.path) {
        ("GET", "/health") => health_http_response(identity),
        ("POST", "/auth/passkeys/enroll/options") => start_enrollment_response(request, auth),
        ("POST", "/auth/passkeys/enroll/verify") => finish_enrollment_response(request, auth),
        ("POST", "/auth/passkeys/sign-in/options") => start_sign_in_response(request, auth),
        ("POST", "/auth/passkeys/sign-in/verify") => finish_sign_in_response(request, auth),
        ("GET", "/auth/sessions") => list_sessions_response(request, auth),
        ("POST", "/auth/sessions/revoke") => revoke_session_response(request, auth),
        ("GET", "/protected/hub") => protected_hub_response(request, auth),
        (_, "/protected/node") => auth_error_response(403, "node_authority_required", &[]),
        _ => not_found_http_response(),
    }
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

fn revoke_session_response(request: &HttpRequest<'_>, auth: Option<&AuthBoundary>) -> String {
    let auth = match state_change_auth(request, auth) {
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
    match auth.revoke_session(session, csrf, &device_id) {
        Ok(()) => json_response(200, "{\"status\":\"revoked\"}", &[]),
        Err(error) => auth_error_response(auth_error_status(&error), error.code(), &[]),
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
        400 => "400 Bad Request",
        401 => "401 Unauthorized",
        403 => "403 Forbidden",
        404 => "404 Not Found",
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
}
