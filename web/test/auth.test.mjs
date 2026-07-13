import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialToJson,
  decodePublicKeyOptions,
  isPasskeySupported,
  passkeyCapability,
  presentationForAuthError,
} from "../src/auth.js";

const base64Url = Buffer.from([0, 1, 2, 253, 254, 255]).toString("base64url");

test("decodes WebAuthn challenge fields into browser binary options", () => {
  const options = decodePublicKeyOptions({
    publicKey: {
      challenge: base64Url,
      user: { id: base64Url, name: "operator", displayName: "Relay operator" },
      excludeCredentials: [{ id: base64Url, type: "public-key" }],
    },
  });

  assert.deepEqual([...new Uint8Array(options.challenge)], [0, 1, 2, 253, 254, 255]);
  assert.deepEqual([...new Uint8Array(options.user.id)], [0, 1, 2, 253, 254, 255]);
  assert.deepEqual([...new Uint8Array(options.excludeCredentials[0].id)], [0, 1, 2, 253, 254, 255]);
});

test("serializes a credential response without retaining browser secrets", () => {
  const credential = {
    id: "credential-id",
    rawId: Uint8Array.from([1, 2, 3]).buffer,
    type: "public-key",
    getClientExtensionResults: () => ({ credProps: { rk: false } }),
    response: {
      clientDataJSON: Uint8Array.from([4, 5]).buffer,
      attestationObject: Uint8Array.from([6, 7]).buffer,
      getTransports: () => ["internal"],
    },
  };

  assert.deepEqual(credentialToJson(credential), {
    id: "credential-id",
    rawId: "AQID",
    response: {
      attestationObject: "Bgc",
      clientDataJSON: "BAU",
      transports: ["internal"],
    },
    clientExtensionResults: { credProps: { rk: false } },
    type: "public-key",
  });
});

test("classifies browser capability, ceremony failures, and recovery without auth downgrade", () => {
  const supported = {
    isSecureContext: true,
    PublicKeyCredential: class PublicKeyCredential {},
    navigator: { credentials: { create() {}, get() {} } },
  };
  assert.equal(isPasskeySupported(supported), true);
  assert.deepEqual(passkeyCapability({ isSecureContext: false, navigator: {} }), {
    supported: false,
    code: "insecure_context",
    message: "Passkeys require Relay's exact HTTPS address. Reopen this page using the secure URL shown below.",
  });
  assert.deepEqual(passkeyCapability({ isSecureContext: true, navigator: { credentials: {} } }), {
    supported: false,
    code: "passkey_browser_unsupported",
    message: "Passkeys are unavailable here. Copy the URL and open Relay directly in Safari or Chrome.",
  });
  assert.deepEqual(presentationForAuthError({ name: "NotAllowedError" }), {
    code: "passkey_denied",
    message: "The passkey ceremony was cancelled or denied. No weaker sign-in method was used.",
  });
  assert.deepEqual(presentationForAuthError({ name: "NotSupportedError" }), {
    code: "passkey_browser_unsupported",
    message: "Passkeys are unavailable here. Copy the URL and open Relay directly in Safari or Chrome.",
  });
  assert.deepEqual(presentationForAuthError({ name: "SecurityError" }), {
    code: "passkey_security_error",
    message: "Relay could not verify this page as its configured secure origin. Open the exact HTTPS Relay URL in Safari or Chrome.",
  });
  assert.deepEqual(presentationForAuthError({ name: "InvalidStateError" }), {
    code: "authenticator_unavailable",
    message: "No compatible device passkey authenticator was available. Enable device screen lock and passkey sync, then retry in Safari or Chrome.",
  });
  assert.deepEqual(presentationForAuthError({ code: "recovery_required" }), {
    code: "recovery_required",
    message: "No enrolled passkey is available. Recovery can enroll a replacement passkey but cannot sign you in.",
  });
  assert.deepEqual(presentationForAuthError({ code: "session_missing" }), {
    code: "session_missing",
    message: "Browser access is not active. Enter the deployment recovery code to set up this browser, or sign in with an existing passkey.",
  });
  assert.deepEqual(presentationForAuthError({ code: "recovery_denied" }), {
    code: "recovery_denied",
    message: "That recovery code is invalid for this Relay deployment. Obtain the current code privately, then try again. No PIN or anonymous session was enabled.",
  });
});
