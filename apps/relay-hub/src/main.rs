use std::{
    env,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::ExitCode,
};

use relay_factory_core::{
    ConfigError, ServiceIdentity, configured_identity, health_http_response, health_json,
    not_found_http_response,
};

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
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle_connection(stream, identity).map_err(|_| RunError::Io)?,
            Err(_) => return Err(RunError::Io),
        }
    }
    Ok(())
}

fn handle_connection(
    mut stream: TcpStream,
    identity: ServiceIdentity,
) -> Result<(), std::io::Error> {
    let mut request = [0_u8; 1024];
    let length = stream.read(&mut request)?;
    let request = String::from_utf8_lossy(&request[..length]);
    let response = if request.starts_with("GET /health ") {
        health_http_response(identity)
    } else {
        not_found_http_response()
    };

    stream.write_all(response.as_bytes())
}
