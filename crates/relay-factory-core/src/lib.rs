use std::fmt;

use url::Url;

mod auth;

pub use auth::{
    AuthAuditEvent, AuthBoundary, CeremonyStart, CredentialDevice, EnrollmentAuthority,
    SecuritySnapshot, SessionDevice, SessionGrant,
};

pub const API_VERSION: &str = "relay-factory/v1";
pub const MAX_CONFIG_INPUT_BYTES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    InsecureOrigin,
    InvalidOrigin,
    OriginMismatch,
    InvalidRecoveryConfig,
    RecoveryRequired,
    RecoveryDenied,
    PasskeyDenied,
    UnknownCeremony,
    CeremonyExpired,
    CeremonyLimit,
    CredentialLimit,
    CredentialMissing,
    LastCredential,
    SessionMissing,
    CsrfDenied,
    Internal,
}

impl AuthError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InsecureOrigin => "insecure_origin",
            Self::InvalidOrigin => "invalid_origin",
            Self::OriginMismatch => "origin_mismatch",
            Self::InvalidRecoveryConfig => "invalid_recovery_config",
            Self::RecoveryRequired => "recovery_required",
            Self::RecoveryDenied => "recovery_denied",
            Self::PasskeyDenied => "passkey_denied",
            Self::UnknownCeremony => "unknown_ceremony",
            Self::CeremonyExpired => "ceremony_expired",
            Self::CeremonyLimit => "ceremony_limit",
            Self::CredentialLimit => "credential_limit",
            Self::CredentialMissing => "credential_missing",
            Self::LastCredential => "last_credential",
            Self::SessionMissing => "session_missing",
            Self::CsrfDenied => "csrf_denied",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthOrigin {
    origin: Url,
    rp_id: String,
}

impl AuthOrigin {
    pub fn parse(value: &str) -> Result<Self, AuthError> {
        let origin = Url::parse(value).map_err(|_| AuthError::InvalidOrigin)?;

        if origin.scheme() != "https" {
            return Err(AuthError::InsecureOrigin);
        }
        if origin.cannot_be_a_base()
            || origin.username() != ""
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
        {
            return Err(AuthError::InvalidOrigin);
        }

        let rp_id = origin
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or(AuthError::InvalidOrigin)?
            .to_owned();

        Ok(Self { origin, rp_id })
    }

    pub fn as_str(&self) -> &str {
        self.origin.as_str()
    }

    pub fn rp_id(&self) -> &str {
        &self.rp_id
    }

    pub(crate) fn as_url(&self) -> &Url {
        &self.origin
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceIdentity {
    Hub,
    Node,
}

impl ServiceIdentity {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hub => "hub",
            Self::Node => "node",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    MalformedArguments,
    InputTooLong,
    InvalidIdentity,
    IdentityMismatch {
        expected: ServiceIdentity,
        received: ServiceIdentity,
    },
}

impl ConfigError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::MalformedArguments => "malformed_arguments",
            Self::InputTooLong => "input_too_long",
            Self::InvalidIdentity => "invalid_identity",
            Self::IdentityMismatch { .. } => "identity_mismatch",
        }
    }

    pub fn to_json(&self) -> String {
        match self {
            Self::InputTooLong => format!(
                "{{\"error\":{{\"code\":\"{}\",\"limit\":{MAX_CONFIG_INPUT_BYTES}}}}}",
                self.code()
            ),
            _ => format!("{{\"error\":{{\"code\":\"{}\"}}}}", self.code()),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ConfigError {}

pub fn configured_identity(
    arguments: &[String],
    expected: ServiceIdentity,
) -> Result<ServiceIdentity, ConfigError> {
    let configured = match arguments {
        [] => return Ok(expected),
        [flag, value] if flag == "--identity" => parse_identity(value)?,
        _ => return Err(ConfigError::MalformedArguments),
    };

    if configured == expected {
        Ok(configured)
    } else {
        Err(ConfigError::IdentityMismatch {
            expected,
            received: configured,
        })
    }
}

pub fn health_json(identity: ServiceIdentity) -> String {
    format!(
        "{{\"api\":\"{API_VERSION}\",\"service\":\"{}\",\"status\":\"ok\",\"version\":\"{}\"}}",
        identity.as_str(),
        env!("CARGO_PKG_VERSION")
    )
}

pub fn health_http_response(identity: ServiceIdentity) -> String {
    http_response("200 OK", &health_json(identity))
}

pub fn not_found_http_response() -> String {
    http_response("404 Not Found", "{\"error\":{\"code\":\"not_found\"}}")
}

fn parse_identity(value: &str) -> Result<ServiceIdentity, ConfigError> {
    if value.len() > MAX_CONFIG_INPUT_BYTES {
        return Err(ConfigError::InputTooLong);
    }

    match value {
        "hub" => Ok(ServiceIdentity::Hub),
        "node" => Ok(ServiceIdentity::Node),
        _ => Err(ConfigError::InvalidIdentity),
    }
}

fn http_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_expected_identity() {
        let arguments = vec!["--identity".to_owned(), "hub".to_owned()];
        assert_eq!(
            configured_identity(&arguments, ServiceIdentity::Hub),
            Ok(ServiceIdentity::Hub)
        );
    }

    #[test]
    fn rejects_an_overlong_identity_without_reflecting_it() {
        let value = "x".repeat(MAX_CONFIG_INPUT_BYTES + 1);
        let arguments = vec!["--identity".to_owned(), value.clone()];
        let error = configured_identity(&arguments, ServiceIdentity::Hub).unwrap_err();

        assert_eq!(error.code(), "input_too_long");
        assert!(!error.to_json().contains(&value));
        assert_eq!(
            error.to_json(),
            "{\"error\":{\"code\":\"input_too_long\",\"limit\":32}}"
        );
    }

    #[test]
    fn health_response_exposes_only_the_liveness_contract() {
        let response = health_json(ServiceIdentity::Node);

        assert_eq!(
            response,
            "{\"api\":\"relay-factory/v1\",\"service\":\"node\",\"status\":\"ok\",\"version\":\"0.1.0\"}"
        );
    }
}
