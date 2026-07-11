use std::{env, process::ExitCode};

use relay_factory_core::{ServiceIdentity, configured_identity, health_json};

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
        _ => {
            eprintln!("usage: relay-node probe [--identity node]");
            ExitCode::from(64)
        }
    }
}
