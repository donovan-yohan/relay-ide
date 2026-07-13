function base64UrlToBuffer(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.codePointAt(0)).buffer;
}

function bufferToBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCredentialDescriptors(descriptors) {
  return descriptors?.map((descriptor) => ({ ...descriptor, id: base64UrlToBuffer(descriptor.id) }));
}

export function decodePublicKeyOptions(options) {
  const publicKey = { ...options.publicKey, challenge: base64UrlToBuffer(options.publicKey.challenge) };
  if (publicKey.user) {
    publicKey.user = { ...publicKey.user, id: base64UrlToBuffer(publicKey.user.id) };
  }
  publicKey.excludeCredentials = decodeCredentialDescriptors(publicKey.excludeCredentials);
  publicKey.allowCredentials = decodeCredentialDescriptors(publicKey.allowCredentials);
  return publicKey;
}

export function credentialToJson(credential) {
  const response = credential.response;
  const common = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  if ("attestationObject" in response) {
    return {
      ...common,
      response: {
        attestationObject: bufferToBase64Url(response.attestationObject),
        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
        transports: response.getTransports?.(),
      },
    };
  }
  return {
    ...common,
    response: {
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
    },
  };
}

export function passkeyCapability(environment) {
  if (!environment.isSecureContext) {
    return {
      supported: false,
      code: "insecure_context",
      message: "Passkeys require Relay's exact HTTPS address. Reopen this page using the secure URL shown below.",
    };
  }
  if (
    !environment.PublicKeyCredential
    || !environment.navigator?.credentials?.create
    || !environment.navigator?.credentials?.get
  ) {
    return {
      supported: false,
      code: "passkey_browser_unsupported",
      message: "Passkeys are unavailable here. Copy the URL and open Relay directly in Safari or Chrome.",
    };
  }
  return {
    supported: true,
    code: "passkey_ready",
    message: "Sign in with an enrolled passkey to open this workbench.",
  };
}

export function isPasskeySupported(environment) {
  return passkeyCapability(environment).supported;
}

function authErrorCode(error) {
  if (error?.code) return error.code;
  switch (error?.name) {
    case "NotAllowedError":
    case "AbortError":
      return "passkey_denied";
    case "SecurityError":
      return "passkey_security_error";
    case "NotSupportedError":
      return "passkey_browser_unsupported";
    case "ConstraintError":
    case "InvalidStateError":
    case "UnknownError":
      return "authenticator_unavailable";
    default:
      return "passkey_failed";
  }
}

export function presentationForAuthError(error) {
  const code = authErrorCode(error);
  switch (code) {
    case "passkey_denied":
      return {
        code,
        message: "The passkey ceremony was cancelled or denied. No weaker sign-in method was used.",
      };
    case "recovery_required":
      return {
        code,
        message: "No enrolled passkey is available. Recovery can enroll a replacement passkey but cannot sign you in.",
      };
    case "session_missing":
      return {
        code,
        message: "Browser access is not active. Enter the deployment recovery code to set up this browser, or sign in with an existing passkey.",
      };
    case "origin_mismatch":
    case "passkey_security_error":
      return {
        code,
        message: "Relay could not verify this page as its configured secure origin. Open the exact HTTPS Relay URL in Safari or Chrome.",
      };
    case "recovery_denied":
      return {
        code,
        message: "That recovery code is invalid for this Relay deployment. Obtain the current code privately, then try again. No PIN or anonymous session was enabled.",
      };
    case "insecure_context":
      return {
        code,
        message: "Passkeys require Relay's exact HTTPS address. Reopen this page using the secure URL shown below.",
      };
    case "passkey_browser_unsupported":
      return {
        code,
        message: "Passkeys are unavailable here. Copy the URL and open Relay directly in Safari or Chrome.",
      };
    case "authenticator_unavailable":
      return {
        code,
        message: "No compatible device passkey authenticator was available. Enable device screen lock and passkey sync, then retry in Safari or Chrome.",
      };
    default:
      return {
        code: "passkey_failed",
        message: "Passkey setup failed in this browser. Copy the secure Relay URL below, open it in Safari or Chrome, and retry.",
      };
  }
}
