use std::{
    env, fmt,
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::ExitCode,
    thread,
    time::{Duration, Instant},
};

use relay_factory_core::{
    ConfigError, ServiceIdentity, configured_identity, health_http_response, health_json,
    not_found_http_response,
};

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_REQUEST_BYTES: usize = 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(RunError::Config(error)) => {
            eprintln!("{}", error.to_json());
            ExitCode::from(2)
        }
        Err(RunError::Usage) => {
            eprintln!("usage: relay-hub <probe|serve --bind <address>> [--identity hub]");
            ExitCode::from(64)
        }
        Err(RunError::Io) => {
            eprintln!("relay-hub could not serve the liveness boundary");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug)]
enum RunError {
    Config(ConfigError),
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
    let (address, identity_arguments) = match arguments {
        [bind_flag, address] if bind_flag == "--bind" => (address, &[][..]),
        [bind_flag, address, identity_flag, _]
            if bind_flag == "--bind" && identity_flag == "--identity" =>
        {
            (address, &arguments[2..])
        }
        _ => return Err(RunError::Usage),
    };
    let identity =
        configured_identity(identity_arguments, ServiceIdentity::Hub).map_err(RunError::Config)?;
    let address: SocketAddr = address.parse().map_err(|_| RunError::Usage)?;
    let listener = TcpListener::bind(address).map_err(|_| RunError::Io)?;

    println!(
        "relay-hub liveness listening on {}",
        listener.local_addr().map_err(|_| RunError::Io)?
    );
    serve_connections(identity, || listener.accept().map(|(stream, _)| stream))
}

fn serve_connections(
    identity: ServiceIdentity,
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
        thread::Builder::new()
            .spawn(move || {
                if let Err(error) = handle_connection(stream, identity) {
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
) -> Result<(), ConnectionError> {
    stream
        .set_write_timeout(Some(CONNECTION_TIMEOUT))
        .map_err(ConnectionError::Write)?;
    let mut request = [0_u8; MAX_REQUEST_BYTES];
    let response = match read_request(&mut stream, &mut request) {
        Ok(length) if request[..length].starts_with(b"GET /health ") => {
            health_http_response(identity)
        }
        Ok(_) | Err(RequestReadError::TooLarge) => not_found_http_response(),
        Err(error) => return Err(ConnectionError::Request(error)),
    };

    stream
        .write_all(response.as_bytes())
        .map_err(ConnectionError::Write)
}

fn read_request(stream: &mut TcpStream, request: &mut [u8]) -> Result<usize, RequestReadError> {
    let deadline = Instant::now() + CONNECTION_TIMEOUT;
    let mut length = 0;

    loop {
        if request[..length]
            .windows(4)
            .any(|bytes| bytes == b"\r\n\r\n")
        {
            return Ok(length);
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

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;

    #[test]
    fn listener_accept_failure_stops_serving() {
        let result = serve_connections(ServiceIdentity::Hub, || {
            Err(io::Error::other("injected listener failure"))
        });

        assert!(matches!(result, Err(RunError::Io)));
    }
}
