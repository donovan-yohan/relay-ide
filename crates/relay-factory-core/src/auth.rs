use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use webauthn_rs::prelude::{
    Passkey, PasskeyAuthentication, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Webauthn, WebauthnBuilder,
};

use crate::{AuthError, AuthOrigin};

const CEREMONY_TTL: Duration = Duration::from_secs(5 * 60);
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_CEREMONIES: usize = 16;
const MAX_PASSKEYS: usize = 8;
const MAX_SESSIONS: usize = 8;
const MAX_AUDIT_EVENTS: usize = 64;
const MAX_RECOVERY_CODE_BYTES: usize = 256;
const OPERATOR_NAME: &str = "operator";
const OPERATOR_DISPLAY_NAME: &str = "Relay operator";

pub struct AuthBoundary {
    origin: AuthOrigin,
    recovery_hash: [u8; 32],
    operator_id: Uuid,
    webauthn: Webauthn,
    state: Mutex<AuthState>,
}

#[derive(Clone, Copy)]
pub enum EnrollmentAuthority<'a> {
    RecoveryCode(&'a str),
    ExistingSession(&'a str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CeremonyStart {
    pub ceremony_id: String,
    pub options_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGrant {
    pub session_token: String,
    pub csrf_token: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDevice {
    pub device_id: String,
    pub credential_id: String,
    pub signed_in_seconds_ago: u64,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialDevice {
    pub credential_id: String,
    pub active_sessions: usize,
    pub enrolled_seconds_ago: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthAuditEvent {
    pub sequence: u64,
    pub action: String,
    pub target_kind: String,
    pub target_id: String,
    pub actor_device_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySnapshot {
    pub sessions: Vec<SessionDevice>,
    pub credentials: Vec<CredentialDevice>,
    pub audit: Vec<AuthAuditEvent>,
}

struct StoredCredential {
    id: String,
    passkey: Passkey,
    enrolled_at: Instant,
}

struct AuthState {
    passkeys: Vec<StoredCredential>,
    ceremonies: HashMap<[u8; 32], PendingCeremony>,
    sessions: HashMap<[u8; 32], StoredSession>,
    audit: Vec<AuthAuditEvent>,
    next_audit_sequence: u64,
}

impl AuthState {
    fn new() -> Self {
        Self {
            passkeys: Vec::new(),
            ceremonies: HashMap::new(),
            sessions: HashMap::new(),
            audit: Vec::new(),
            next_audit_sequence: 1,
        }
    }

    fn discard_expired(&mut self, now: Instant) {
        self.ceremonies
            .retain(|_, ceremony| ceremony.expires_at() > now);
        self.sessions.retain(|_, session| session.expires_at > now);
        self.discard_unauthorized_registrations();
    }

    fn discard_unauthorized_registrations(&mut self) {
        let sessions = &self.sessions;
        self.ceremonies.retain(|_, ceremony| match ceremony {
            PendingCeremony::Registration {
                authority: RegistrationAuthority::Session(session_key),
                ..
            } => sessions.contains_key(session_key),
            _ => true,
        });
    }
}

enum PendingCeremony {
    Registration {
        state: PasskeyRegistration,
        authority: RegistrationAuthority,
        expires_at: Instant,
    },
    Authentication {
        state: PasskeyAuthentication,
        expires_at: Instant,
    },
}

#[derive(Clone, Copy)]
enum RegistrationAuthority {
    Recovery,
    Session([u8; 32]),
}

impl PendingCeremony {
    const fn expires_at(&self) -> Instant {
        match self {
            Self::Registration { expires_at, .. } | Self::Authentication { expires_at, .. } => {
                *expires_at
            }
        }
    }
}

struct StoredSession {
    csrf_hash: [u8; 32],
    device_id: String,
    credential_id: String,
    created_at: Instant,
    expires_at: Instant,
}

impl AuthBoundary {
    pub fn new(origin: AuthOrigin, recovery_code: &str) -> Result<Self, AuthError> {
        if recovery_code.is_empty() || recovery_code.len() > MAX_RECOVERY_CODE_BYTES {
            return Err(AuthError::InvalidRecoveryConfig);
        }
        Self::with_recovery_hash(origin, hash_secret(recovery_code.as_bytes()))
    }

    pub fn from_recovery_hash_hex(origin: AuthOrigin, value: &str) -> Result<Self, AuthError> {
        let bytes = decode_sha256_hex(value)?;
        Self::with_recovery_hash(origin, bytes)
    }

    fn with_recovery_hash(origin: AuthOrigin, recovery_hash: [u8; 32]) -> Result<Self, AuthError> {
        let webauthn = WebauthnBuilder::new(origin.rp_id(), origin.as_url())
            .map_err(|_| AuthError::InvalidOrigin)?
            .rp_name("Relay")
            .timeout(CEREMONY_TTL)
            .build()
            .map_err(|_| AuthError::InvalidOrigin)?;

        Ok(Self {
            origin,
            recovery_hash,
            operator_id: Uuid::new_v4(),
            webauthn,
            state: Mutex::new(AuthState::new()),
        })
    }

    pub fn enforce_origin(&self, value: Option<&str>) -> Result<(), AuthError> {
        let value = value.ok_or(AuthError::OriginMismatch)?;
        let origin = AuthOrigin::parse(value).map_err(|_| AuthError::OriginMismatch)?;
        if origin == self.origin {
            Ok(())
        } else {
            Err(AuthError::OriginMismatch)
        }
    }

    pub fn start_registration(
        &self,
        authority: EnrollmentAuthority<'_>,
    ) -> Result<CeremonyStart, AuthError> {
        let (passkeys, registration_authority) = {
            let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
            state.discard_expired(Instant::now());
            self.enrollment_is_authorized(&state, authority)?;
            if state.passkeys.len() >= MAX_PASSKEYS {
                return Err(AuthError::CredentialLimit);
            }
            let passkeys = state
                .passkeys
                .iter()
                .map(|credential| credential.passkey.clone())
                .collect::<Vec<_>>();
            let authority = match authority {
                EnrollmentAuthority::RecoveryCode(_) => RegistrationAuthority::Recovery,
                EnrollmentAuthority::ExistingSession(session_token) => {
                    RegistrationAuthority::Session(hash_secret(session_token.as_bytes()))
                }
            };
            (passkeys, authority)
        };

        let excluded_credentials = passkeys
            .iter()
            .map(|passkey| passkey.cred_id().clone())
            .collect::<Vec<_>>();
        let (options, registration) = self
            .webauthn
            .start_passkey_registration(
                self.operator_id,
                OPERATOR_NAME,
                OPERATOR_DISPLAY_NAME,
                Some(excluded_credentials),
            )
            .map_err(|_| AuthError::PasskeyDenied)?;
        let options_json = serde_json::to_string(&options).map_err(|_| AuthError::Internal)?;

        self.store_ceremony(PendingCeremony::Registration {
            state: registration,
            authority: registration_authority,
            expires_at: Instant::now() + CEREMONY_TTL,
        })
        .map(|ceremony_id| CeremonyStart {
            ceremony_id,
            options_json,
        })
    }

    pub fn finish_registration(&self, ceremony_id: &str, response: &str) -> Result<(), AuthError> {
        let (registration, authority) = match self.take_ceremony(ceremony_id)? {
            PendingCeremony::Registration {
                state, authority, ..
            } => (state, authority),
            PendingCeremony::Authentication { .. } => return Err(AuthError::PasskeyDenied),
        };
        let response = serde_json::from_str::<RegisterPublicKeyCredential>(response)
            .map_err(|_| AuthError::PasskeyDenied)?;
        let passkey = self
            .webauthn
            .finish_passkey_registration(&response, &registration)
            .map_err(|_| AuthError::PasskeyDenied)?;

        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        if let RegistrationAuthority::Session(session_key) = authority
            && !state.sessions.contains_key(&session_key)
        {
            return Err(AuthError::SessionMissing);
        }
        if state.passkeys.len() >= MAX_PASSKEYS {
            return Err(AuthError::CredentialLimit);
        }
        if state
            .passkeys
            .iter()
            .any(|existing| existing.passkey.cred_id() == passkey.cred_id())
        {
            return Err(AuthError::PasskeyDenied);
        }
        let id = credential_id(&passkey);
        state.passkeys.push(StoredCredential {
            id,
            passkey,
            enrolled_at: Instant::now(),
        });
        Ok(())
    }

    pub fn start_authentication(&self) -> Result<CeremonyStart, AuthError> {
        let passkeys = {
            let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
            state.discard_expired(Instant::now());
            if state.passkeys.is_empty() {
                return Err(AuthError::RecoveryRequired);
            }
            state
                .passkeys
                .iter()
                .map(|credential| credential.passkey.clone())
                .collect::<Vec<_>>()
        };
        let (options, authentication) = self
            .webauthn
            .start_passkey_authentication(&passkeys)
            .map_err(|_| AuthError::PasskeyDenied)?;
        let options_json = serde_json::to_string(&options).map_err(|_| AuthError::Internal)?;

        self.store_ceremony(PendingCeremony::Authentication {
            state: authentication,
            expires_at: Instant::now() + CEREMONY_TTL,
        })
        .map(|ceremony_id| CeremonyStart {
            ceremony_id,
            options_json,
        })
    }

    pub fn finish_authentication(
        &self,
        ceremony_id: &str,
        response: &str,
    ) -> Result<SessionGrant, AuthError> {
        let authentication = match self.take_ceremony(ceremony_id)? {
            PendingCeremony::Authentication { state, .. } => state,
            PendingCeremony::Registration { .. } => return Err(AuthError::PasskeyDenied),
        };
        let response = serde_json::from_str::<PublicKeyCredential>(response)
            .map_err(|_| AuthError::PasskeyDenied)?;
        let result = self
            .webauthn
            .finish_passkey_authentication(&response, &authentication)
            .map_err(|_| AuthError::PasskeyDenied)?;

        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        let mut credential_id = None;
        for credential in &mut state.passkeys {
            if credential.passkey.update_credential(&result).is_some() {
                credential_id = Some(credential.id.clone());
                break;
            }
        }
        let Some(credential_id) = credential_id else {
            return Err(AuthError::PasskeyDenied);
        };
        issue_session(&mut state, &credential_id)
    }

    pub fn require_session(&self, session_token: &str) -> Result<(), AuthError> {
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        let key = hash_secret(session_token.as_bytes());
        if state.sessions.contains_key(&key) {
            Ok(())
        } else {
            Err(AuthError::SessionMissing)
        }
    }

    /// Return the opaque authenticated-browser identity for a live session.
    /// Request handlers use this server-resolved value for actor attribution;
    /// the raw browser session token remains confined to this boundary.
    pub fn current_device_id(&self, session_token: &str) -> Result<String, AuthError> {
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        let key = hash_secret(session_token.as_bytes());
        state
            .sessions
            .get(&key)
            .map(|session| session.device_id.clone())
            .ok_or(AuthError::SessionMissing)
    }

    pub fn require_csrf(&self, session_token: &str, csrf_token: &str) -> Result<(), AuthError> {
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        require_csrf_in_state(&state, session_token, csrf_token)
    }

    pub fn security_snapshot(&self, session_token: &str) -> Result<SecuritySnapshot, AuthError> {
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        let current = hash_secret(session_token.as_bytes());
        if !state.sessions.contains_key(&current) {
            return Err(AuthError::SessionMissing);
        }
        let now = Instant::now();
        let sessions = state
            .sessions
            .iter()
            .map(|(key, session)| SessionDevice {
                device_id: session.device_id.clone(),
                credential_id: session.credential_id.clone(),
                signed_in_seconds_ago: now.saturating_duration_since(session.created_at).as_secs(),
                current: key.ct_eq(&current).into(),
            })
            .collect();
        let credentials = state
            .passkeys
            .iter()
            .map(|credential| CredentialDevice {
                credential_id: credential.id.clone(),
                active_sessions: state
                    .sessions
                    .values()
                    .filter(|session| session.credential_id == credential.id)
                    .count(),
                enrolled_seconds_ago: now
                    .saturating_duration_since(credential.enrolled_at)
                    .as_secs(),
            })
            .collect();
        Ok(SecuritySnapshot {
            sessions,
            credentials,
            audit: state.audit.clone(),
        })
    }

    pub fn revoke_session(
        &self,
        session_token: &str,
        csrf_token: &str,
        device_id: &str,
    ) -> Result<(), AuthError> {
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        require_csrf_in_state(&state, session_token, csrf_token)?;
        let before = state.sessions.len();
        let actor_device_id = state
            .sessions
            .get(&hash_secret(session_token.as_bytes()))
            .map(|session| session.device_id.clone())
            .ok_or(AuthError::SessionMissing)?;
        state
            .sessions
            .retain(|_, session| session.device_id != device_id);
        state.discard_unauthorized_registrations();
        if state.sessions.len() == before {
            Err(AuthError::SessionMissing)
        } else {
            push_audit(
                &mut state,
                "session.revoked",
                "session",
                device_id,
                &actor_device_id,
            );
            Ok(())
        }
    }

    pub fn revoke_credential(
        &self,
        session_token: &str,
        csrf_token: &str,
        credential_id: &str,
    ) -> Result<(), AuthError> {
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        require_csrf_in_state(&state, session_token, csrf_token)?;
        let actor_device_id = state
            .sessions
            .get(&hash_secret(session_token.as_bytes()))
            .map(|session| session.device_id.clone())
            .ok_or(AuthError::SessionMissing)?;
        if !state
            .passkeys
            .iter()
            .any(|credential| credential.id == credential_id)
        {
            return Err(AuthError::CredentialMissing);
        }
        if state.passkeys.len() <= 1 {
            return Err(AuthError::LastCredential);
        }
        let before = state.passkeys.len();
        state
            .passkeys
            .retain(|credential| credential.id != credential_id);
        if state.passkeys.len() == before {
            return Err(AuthError::CredentialMissing);
        }
        remove_sessions_for_credential(&mut state, credential_id);
        state.discard_unauthorized_registrations();
        push_audit(
            &mut state,
            "credential.revoked",
            "credential",
            credential_id,
            &actor_device_id,
        );
        Ok(())
    }

    fn enrollment_is_authorized(
        &self,
        state: &AuthState,
        authority: EnrollmentAuthority<'_>,
    ) -> Result<(), AuthError> {
        match authority {
            EnrollmentAuthority::RecoveryCode(recovery_code)
                if recovery_code.len() <= MAX_RECOVERY_CODE_BYTES
                    && self
                        .recovery_hash
                        .ct_eq(&hash_secret(recovery_code.as_bytes()))
                        .into() =>
            {
                Ok(())
            }
            EnrollmentAuthority::RecoveryCode(_) => Err(AuthError::RecoveryDenied),
            EnrollmentAuthority::ExistingSession(session_token)
                if state
                    .sessions
                    .contains_key(&hash_secret(session_token.as_bytes())) =>
            {
                Ok(())
            }
            EnrollmentAuthority::ExistingSession(_) => Err(AuthError::SessionMissing),
        }
    }

    fn store_ceremony(&self, ceremony: PendingCeremony) -> Result<String, AuthError> {
        let id = random_token(32)?;
        let key = hash_secret(id.as_bytes());
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        if state.ceremonies.len() >= MAX_CEREMONIES {
            return Err(AuthError::CeremonyLimit);
        }
        state.ceremonies.insert(key, ceremony);
        Ok(id)
    }

    fn take_ceremony(&self, ceremony_id: &str) -> Result<PendingCeremony, AuthError> {
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        let now = Instant::now();
        let key = hash_secret(ceremony_id.as_bytes());
        let ceremony = state
            .ceremonies
            .remove(&key)
            .ok_or(AuthError::UnknownCeremony)?;
        state.discard_expired(now);
        if ceremony.expires_at() <= now {
            Err(AuthError::CeremonyExpired)
        } else {
            Ok(ceremony)
        }
    }
}

fn issue_session(state: &mut AuthState, credential_id: &str) -> Result<SessionGrant, AuthError> {
    while state.sessions.len() >= MAX_SESSIONS {
        let oldest = state
            .sessions
            .iter()
            .min_by_key(|(_, session)| session.created_at)
            .map(|(key, _)| *key)
            .ok_or(AuthError::Internal)?;
        state.sessions.remove(&oldest);
        state.discard_unauthorized_registrations();
    }

    let session_token = random_token(32)?;
    let csrf_token = random_token(32)?;
    let device_id = random_token(12)?;
    let now = Instant::now();
    state.sessions.insert(
        hash_secret(session_token.as_bytes()),
        StoredSession {
            csrf_hash: hash_secret(csrf_token.as_bytes()),
            device_id: device_id.clone(),
            credential_id: credential_id.to_owned(),
            created_at: now,
            expires_at: now + SESSION_TTL,
        },
    );

    Ok(SessionGrant {
        session_token,
        csrf_token,
        device_id,
    })
}

fn credential_id(passkey: &Passkey) -> String {
    let digest = hash_secret(passkey.cred_id().as_ref());
    format!("passkey-{}", URL_SAFE_NO_PAD.encode(&digest[..9]))
}

fn require_csrf_in_state(
    state: &AuthState,
    session_token: &str,
    csrf_token: &str,
) -> Result<(), AuthError> {
    let session = state
        .sessions
        .get(&hash_secret(session_token.as_bytes()))
        .ok_or(AuthError::SessionMissing)?;
    if session
        .csrf_hash
        .ct_eq(&hash_secret(csrf_token.as_bytes()))
        .into()
    {
        Ok(())
    } else {
        Err(AuthError::CsrfDenied)
    }
}

fn remove_sessions_for_credential(state: &mut AuthState, credential_id: &str) {
    state
        .sessions
        .retain(|_, session| session.credential_id != credential_id);
}

fn push_audit(
    state: &mut AuthState,
    action: &str,
    target_kind: &str,
    target_id: &str,
    actor_device_id: &str,
) {
    if state.audit.len() >= MAX_AUDIT_EVENTS {
        state.audit.remove(0);
    }
    state.audit.push(AuthAuditEvent {
        sequence: state.next_audit_sequence,
        action: action.to_owned(),
        target_kind: target_kind.to_owned(),
        target_id: target_id.to_owned(),
        actor_device_id: actor_device_id.to_owned(),
    });
    state.next_audit_sequence = state.next_audit_sequence.saturating_add(1);
}

fn random_token(bytes: usize) -> Result<String, AuthError> {
    let mut token = vec![0_u8; bytes];
    getrandom::fill(&mut token).map_err(|_| AuthError::Internal)?;
    Ok(URL_SAFE_NO_PAD.encode(token))
}

fn hash_secret(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}

fn decode_sha256_hex(value: &str) -> Result<[u8; 32], AuthError> {
    if value.len() != 64 || !value.is_ascii() {
        return Err(AuthError::InvalidRecoveryConfig);
    }

    let mut output = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(pair).map_err(|_| AuthError::InvalidRecoveryConfig)?;
        output[index] =
            u8::from_str_radix(pair, 16).map_err(|_| AuthError::InvalidRecoveryConfig)?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boundary() -> AuthBoundary {
        AuthBoundary::new(
            AuthOrigin::parse("https://relay.example.test").expect("stable origin"),
            "recovery-test-secret",
        )
        .expect("auth boundary")
    }

    #[test]
    fn bounds_pending_ceremonies() {
        let boundary = boundary();

        for _ in 0..MAX_CEREMONIES {
            boundary
                .start_registration(EnrollmentAuthority::RecoveryCode("recovery-test-secret"))
                .expect("bounded ceremony slot");
        }
        assert_eq!(
            boundary
                .start_registration(EnrollmentAuthority::RecoveryCode("recovery-test-secret"))
                .unwrap_err(),
            AuthError::CeremonyLimit
        );
    }

    #[test]
    fn expired_ceremony_is_consumed_without_attempting_verification() {
        let boundary = boundary();
        let ceremony = boundary
            .start_registration(EnrollmentAuthority::RecoveryCode("recovery-test-secret"))
            .expect("ceremony");
        let mut state = boundary.state.lock().expect("auth state");
        let key = hash_secret(ceremony.ceremony_id.as_bytes());
        match state.ceremonies.get_mut(&key).expect("stored ceremony") {
            PendingCeremony::Registration { expires_at, .. } => {
                *expires_at = Instant::now() - Duration::from_secs(1);
            }
            PendingCeremony::Authentication { .. } => panic!("expected registration ceremony"),
        }
        drop(state);

        assert_eq!(
            boundary
                .finish_registration(&ceremony.ceremony_id, "{}")
                .unwrap_err(),
            AuthError::CeremonyExpired
        );
        assert_eq!(
            boundary
                .finish_registration(&ceremony.ceremony_id, "{}")
                .unwrap_err(),
            AuthError::UnknownCeremony
        );
    }

    #[test]
    fn revoking_a_browser_invalidates_its_pending_passkey_enrollment() {
        let boundary = boundary();
        {
            let mut state = boundary.state.lock().expect("auth state");
            let now = Instant::now();
            state.sessions.insert(
                hash_secret(b"requester"),
                StoredSession {
                    csrf_hash: hash_secret(b"requester-csrf"),
                    device_id: "requester-device".into(),
                    credential_id: "passkey-requester".into(),
                    created_at: now,
                    expires_at: now + SESSION_TTL,
                },
            );
        }
        let ceremony = boundary
            .start_registration(EnrollmentAuthority::ExistingSession("requester"))
            .expect("live browser can begin enrollment");

        boundary
            .revoke_session("requester", "requester-csrf", "requester-device")
            .expect("browser revocation");

        assert_eq!(
            boundary
                .finish_registration(&ceremony.ceremony_id, "{}")
                .unwrap_err(),
            AuthError::UnknownCeremony
        );
    }

    #[test]
    fn session_expiry_and_revocation_fail_closed_without_affecting_other_browsers() {
        let boundary = boundary();
        {
            let mut state = boundary.state.lock().expect("auth state");
            let now = Instant::now();
            state.sessions.insert(
                hash_secret(b"expired"),
                StoredSession {
                    csrf_hash: hash_secret(b"expired-csrf"),
                    device_id: "expired-device".into(),
                    credential_id: "passkey-expired".into(),
                    created_at: now - Duration::from_secs(2),
                    expires_at: now - Duration::from_secs(1),
                },
            );
            state.sessions.insert(
                hash_secret(b"requester"),
                StoredSession {
                    csrf_hash: hash_secret(b"requester-csrf"),
                    device_id: "requester-device".into(),
                    credential_id: "passkey-requester".into(),
                    created_at: now,
                    expires_at: now + SESSION_TTL,
                },
            );
            state.sessions.insert(
                hash_secret(b"target"),
                StoredSession {
                    csrf_hash: hash_secret(b"target-csrf"),
                    device_id: "target-device".into(),
                    credential_id: "passkey-target".into(),
                    created_at: now,
                    expires_at: now + SESSION_TTL,
                },
            );
            state.sessions.insert(
                hash_secret(b"retained"),
                StoredSession {
                    csrf_hash: hash_secret(b"retained-csrf"),
                    device_id: "retained-device".into(),
                    credential_id: "passkey-retained".into(),
                    created_at: now,
                    expires_at: now + SESSION_TTL,
                },
            );
        }
        assert_eq!(
            boundary.require_session("expired"),
            Err(AuthError::SessionMissing)
        );
        assert_eq!(boundary.require_session("retained"), Ok(()));
        boundary
            .revoke_session("requester", "requester-csrf", "target-device")
            .expect("live session can revoke the target device");
        assert_eq!(
            boundary.require_session("target"),
            Err(AuthError::SessionMissing)
        );
        assert_eq!(boundary.require_session("requester"), Ok(()));
        assert_eq!(boundary.require_session("retained"), Ok(()));
        let security = boundary.security_snapshot("requester").unwrap();
        assert_eq!(security.sessions.len(), 2);
        assert_eq!(security.audit.len(), 1);
        assert_eq!(security.audit[0].action, "session.revoked");
        assert_eq!(security.audit[0].target_id, "target-device");
        assert_eq!(security.audit[0].actor_device_id, "requester-device");
    }

    #[test]
    fn session_capacity_evicts_only_the_oldest_browser() {
        let capacity_boundary = self::boundary();
        {
            let mut state = capacity_boundary.state.lock().expect("auth state");
            let now = Instant::now();
            for index in 0..MAX_SESSIONS {
                let token = format!("session-{index}");
                state.sessions.insert(
                    hash_secret(token.as_bytes()),
                    StoredSession {
                        csrf_hash: hash_secret(token.as_bytes()),
                        device_id: format!("device-{index}"),
                        credential_id: "passkey-capacity".into(),
                        created_at: now + Duration::from_secs(index as u64),
                        expires_at: now + SESSION_TTL,
                    },
                );
            }
            issue_session(&mut state, "passkey-capacity")
                .expect("capacity eviction issues a replacement");
        }
        assert_eq!(
            capacity_boundary.require_session("session-0"),
            Err(AuthError::SessionMissing)
        );
        assert_eq!(capacity_boundary.require_session("session-1"), Ok(()));
    }

    #[test]
    fn credential_revocation_removes_only_sessions_bound_to_that_passkey() {
        let mut state = AuthState::new();
        let now = Instant::now();
        for (token, device_id, credential_id) in [
            ("target-a", "device-a", "passkey-target"),
            ("target-b", "device-b", "passkey-target"),
            ("retained", "device-c", "passkey-retained"),
        ] {
            state.sessions.insert(
                hash_secret(token.as_bytes()),
                StoredSession {
                    csrf_hash: hash_secret(token.as_bytes()),
                    device_id: device_id.into(),
                    credential_id: credential_id.into(),
                    created_at: now,
                    expires_at: now + SESSION_TTL,
                },
            );
        }

        remove_sessions_for_credential(&mut state, "passkey-target");

        assert_eq!(state.sessions.len(), 1);
        assert_eq!(
            state.sessions.values().next().unwrap().credential_id,
            "passkey-retained"
        );
    }
}
