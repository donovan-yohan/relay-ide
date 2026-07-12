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
    pub current: bool,
}

struct AuthState {
    passkeys: Vec<Passkey>,
    ceremonies: HashMap<[u8; 32], PendingCeremony>,
    sessions: HashMap<[u8; 32], StoredSession>,
    invalidated_device_ids: Vec<String>,
}

impl AuthState {
    fn new() -> Self {
        Self {
            passkeys: Vec::new(),
            ceremonies: HashMap::new(),
            sessions: HashMap::new(),
            invalidated_device_ids: Vec::new(),
        }
    }

    fn discard_expired(&mut self, now: Instant) {
        self.ceremonies
            .retain(|_, ceremony| ceremony.expires_at() > now);
        let expired_devices = self
            .sessions
            .values()
            .filter(|session| session.expires_at <= now)
            .map(|session| session.device_id.clone())
            .collect::<Vec<_>>();
        self.sessions.retain(|_, session| session.expires_at > now);
        for device_id in expired_devices {
            self.invalidate_device(device_id);
        }
    }

    fn invalidate_device(&mut self, device_id: String) {
        if !self.invalidated_device_ids.contains(&device_id) {
            self.invalidated_device_ids.push(device_id);
        }
    }

    fn take_invalidated_device_ids(&mut self) -> Vec<String> {
        std::mem::take(&mut self.invalidated_device_ids)
    }
}

enum PendingCeremony {
    Registration {
        state: PasskeyRegistration,
        expires_at: Instant,
    },
    Authentication {
        state: PasskeyAuthentication,
        expires_at: Instant,
    },
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
        let passkeys = {
            let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
            state.discard_expired(Instant::now());
            self.enrollment_is_authorized(&state, authority)?;
            if state.passkeys.len() >= MAX_PASSKEYS {
                return Err(AuthError::CredentialLimit);
            }
            state.passkeys.clone()
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
            expires_at: Instant::now() + CEREMONY_TTL,
        })
        .map(|ceremony_id| CeremonyStart {
            ceremony_id,
            options_json,
        })
    }

    pub fn finish_registration(&self, ceremony_id: &str, response: &str) -> Result<(), AuthError> {
        let registration = match self.take_ceremony(ceremony_id)? {
            PendingCeremony::Registration { state, .. } => state,
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
        if state.passkeys.len() >= MAX_PASSKEYS {
            return Err(AuthError::CredentialLimit);
        }
        if state
            .passkeys
            .iter()
            .any(|existing| existing.cred_id() == passkey.cred_id())
        {
            return Err(AuthError::PasskeyDenied);
        }
        state.passkeys.push(passkey);
        Ok(())
    }

    pub fn start_authentication(&self) -> Result<CeremonyStart, AuthError> {
        let passkeys = {
            let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
            state.discard_expired(Instant::now());
            if state.passkeys.is_empty() {
                return Err(AuthError::RecoveryRequired);
            }
            state.passkeys.clone()
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
        let mut matched_credential = false;
        for passkey in &mut state.passkeys {
            if passkey.update_credential(&result).is_some() {
                matched_credential = true;
                break;
            }
        }
        if !matched_credential {
            return Err(AuthError::PasskeyDenied);
        }
        issue_session(&mut state)
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
    ///
    /// Node-owned Session handles bind to this value rather than accepting a
    /// browser-supplied owner field. The raw browser session token remains
    /// confined to this authentication boundary.
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

    /// Return device identities whose browser authority was removed by TTL,
    /// explicit revocation, or oldest-session eviction. Resource owners can
    /// reap their handles without receiving an opaque browser session token.
    pub fn take_invalidated_device_ids(&self) -> Result<Vec<String>, AuthError> {
        self.state
            .lock()
            .map(|mut state| state.take_invalidated_device_ids())
            .map_err(|_| AuthError::Internal)
    }

    pub fn require_csrf(&self, session_token: &str, csrf_token: &str) -> Result<(), AuthError> {
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        let session_key = hash_secret(session_token.as_bytes());
        let session = state
            .sessions
            .get(&session_key)
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

    pub fn list_sessions(&self, session_token: &str) -> Result<Vec<SessionDevice>, AuthError> {
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        let current = hash_secret(session_token.as_bytes());
        if !state.sessions.contains_key(&current) {
            return Err(AuthError::SessionMissing);
        }

        Ok(state
            .sessions
            .iter()
            .map(|(key, session)| SessionDevice {
                device_id: session.device_id.clone(),
                current: key.ct_eq(&current).into(),
            })
            .collect())
    }

    pub fn revoke_session(
        &self,
        session_token: &str,
        csrf_token: &str,
        device_id: &str,
    ) -> Result<(), AuthError> {
        self.require_csrf(session_token, csrf_token)?;
        let mut state = self.state.lock().map_err(|_| AuthError::Internal)?;
        state.discard_expired(Instant::now());
        let before = state.sessions.len();
        state
            .sessions
            .retain(|_, session| session.device_id != device_id);
        if state.sessions.len() == before {
            Err(AuthError::SessionMissing)
        } else {
            state.invalidate_device(device_id.to_owned());
            Ok(())
        }
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

fn issue_session(state: &mut AuthState) -> Result<SessionGrant, AuthError> {
    while state.sessions.len() >= MAX_SESSIONS {
        let oldest = state
            .sessions
            .iter()
            .min_by_key(|(_, session)| session.created_at)
            .map(|(key, _)| *key)
            .ok_or(AuthError::Internal)?;
        if let Some(evicted) = state.sessions.remove(&oldest) {
            state.invalidate_device(evicted.device_id);
        }
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
    fn session_invalidations_record_ttl_expiry_and_capacity_eviction() {
        let boundary = boundary();
        let expired_token = "expired-session";
        {
            let mut state = boundary.state.lock().expect("auth state");
            state.sessions.insert(
                hash_secret(expired_token.as_bytes()),
                StoredSession {
                    csrf_hash: hash_secret(b"expired-csrf"),
                    device_id: "expired-device".into(),
                    created_at: Instant::now() - Duration::from_secs(2),
                    expires_at: Instant::now() - Duration::from_secs(1),
                },
            );
        }
        assert_eq!(
            boundary.require_session(expired_token),
            Err(AuthError::SessionMissing)
        );
        assert_eq!(
            boundary.take_invalidated_device_ids().unwrap(),
            vec!["expired-device"]
        );

        {
            let mut state = boundary.state.lock().expect("auth state");
            let now = Instant::now();
            state.sessions.insert(
                hash_secret(b"requester"),
                StoredSession {
                    csrf_hash: hash_secret(b"requester-csrf"),
                    device_id: "requester-device".into(),
                    created_at: now,
                    expires_at: now + SESSION_TTL,
                },
            );
            state.sessions.insert(
                hash_secret(b"revoked"),
                StoredSession {
                    csrf_hash: hash_secret(b"revoked-csrf"),
                    device_id: "revoked-device".into(),
                    created_at: now,
                    expires_at: now + SESSION_TTL,
                },
            );
        }
        boundary
            .revoke_session("requester", "requester-csrf", "revoked-device")
            .expect("live session can revoke the target device");
        assert_eq!(
            boundary.take_invalidated_device_ids().unwrap(),
            vec!["revoked-device"]
        );

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
                        created_at: now + Duration::from_secs(index as u64),
                        expires_at: now + SESSION_TTL,
                    },
                );
            }
            issue_session(&mut state).expect("capacity eviction issues a replacement");
        }
        assert_eq!(
            capacity_boundary.take_invalidated_device_ids().unwrap(),
            vec!["device-0"]
        );
    }
}
