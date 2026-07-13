use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use relay_factory_core::{
    AuthBoundary, AuthError, AuthOrigin, EnrollmentAuthority, FirstOwnerExposure, OwnerStore,
};

fn boundary() -> AuthBoundary {
    AuthBoundary::new(
        AuthOrigin::parse("https://relay.example.test").expect("stable origin"),
        "recovery-test-secret",
    )
    .expect("auth boundary")
}

#[test]
fn recovery_can_begin_only_a_passkey_enrollment_and_never_a_session() {
    let boundary = boundary();

    assert_eq!(
        boundary.start_authentication().unwrap_err(),
        AuthError::RecoveryRequired
    );
    assert_eq!(
        boundary
            .start_registration(EnrollmentAuthority::RecoveryCode("wrong"))
            .unwrap_err(),
        AuthError::RecoveryDenied
    );

    let ceremony = boundary
        .start_registration(EnrollmentAuthority::RecoveryCode("recovery-test-secret"))
        .expect("recovery authorizes only enrollment");
    assert!(ceremony.options_json.contains("publicKey"));
    assert!(!ceremony.options_json.contains("recovery-test-secret"));
    assert!(!ceremony.ceremony_id.is_empty());
}

#[test]
fn an_attempted_registration_is_consumed_before_verification_to_prevent_replay() {
    let boundary = boundary();
    let ceremony = boundary
        .start_registration(EnrollmentAuthority::RecoveryCode("recovery-test-secret"))
        .expect("ceremony");

    assert_eq!(
        boundary
            .finish_registration(&ceremony.ceremony_id, "{}")
            .unwrap_err(),
        AuthError::PasskeyDenied
    );
    assert_eq!(
        boundary
            .finish_registration(&ceremony.ceremony_id, "{}")
            .unwrap_err(),
        AuthError::UnknownCeremony
    );
}

#[test]
fn durable_unclaimed_boundary_is_code_free_only_at_private_exposure() {
    let root = std::env::temp_dir().join(format!(
        "relay-auth-boundary-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let path = root.join("owner.json");
    let origin = AuthOrigin::parse("https://relay.example.test").unwrap();
    OwnerStore::init(&path, &origin).unwrap();

    for exposure in [
        FirstOwnerExposure::Public,
        FirstOwnerExposure::Funnel,
        FirstOwnerExposure::Unknown,
    ] {
        let denied = AuthBoundary::from_owner_store(
            origin.clone(),
            &"11".repeat(32),
            OwnerStore::open(&path, &origin).unwrap(),
            exposure,
        )
        .unwrap();
        assert_eq!(
            denied
                .start_registration(EnrollmentAuthority::FirstOwner)
                .unwrap_err(),
            AuthError::ClaimExposureDenied
        );
        assert_eq!(
            denied.finish_registration("unknown", "{}").unwrap_err(),
            AuthError::ClaimExposureDenied
        );
        drop(denied);
    }

    let private = AuthBoundary::from_owner_store(
        origin.clone(),
        &"11".repeat(32),
        OwnerStore::open(&path, &origin).unwrap(),
        FirstOwnerExposure::Private,
    )
    .unwrap();
    assert_eq!(
        private.start_authentication().unwrap_err(),
        AuthError::OwnerUnclaimed
    );
    assert!(
        private
            .start_registration(EnrollmentAuthority::FirstOwner)
            .unwrap()
            .options_json
            .contains("publicKey")
    );
    drop(private);
    fs::remove_dir_all(root).unwrap();
}
