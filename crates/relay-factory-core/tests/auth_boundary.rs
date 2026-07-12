use relay_factory_core::{AuthBoundary, AuthError, AuthOrigin, EnrollmentAuthority};

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
