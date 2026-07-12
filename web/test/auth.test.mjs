import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialToJson,
  decodePublicKeyOptions,
  isPasskeySupported,
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

test("classifies unsupported, denied, and recovery flows without PIN fallback", () => {
  assert.equal(isPasskeySupported({ isSecureContext: false, navigator: {} }), false);
  assert.equal(isPasskeySupported({ isSecureContext: true, navigator: { credentials: {} } }), false);
  assert.deepEqual(presentationForAuthError({ name: "NotAllowedError" }), {
    code: "passkey_denied",
    message: "The passkey ceremony was cancelled or denied. No weaker sign-in method was used.",
  });
  assert.deepEqual(presentationForAuthError({ code: "recovery_required" }), {
    code: "recovery_required",
    message: "No enrolled passkey is available. Recovery can enroll a replacement passkey but cannot sign you in.",
  });
});
