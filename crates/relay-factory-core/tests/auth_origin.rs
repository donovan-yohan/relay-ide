use relay_factory_core::{AuthError, AuthOrigin};

#[test]
fn accepts_a_stable_https_rp_origin_and_derives_its_rp_id() {
    let origin = AuthOrigin::parse("https://relay.example.test:8443").expect("valid stable origin");

    assert_eq!(origin.as_str(), "https://relay.example.test:8443/");
    assert_eq!(origin.rp_id(), "relay.example.test");
}

#[test]
fn rejects_insecure_or_non_origin_rp_configuration() {
    assert_eq!(
        AuthOrigin::parse("http://relay.example.test").unwrap_err(),
        AuthError::InsecureOrigin
    );
    assert_eq!(
        AuthOrigin::parse("https://relay.example.test/auth").unwrap_err(),
        AuthError::InvalidOrigin
    );
}
