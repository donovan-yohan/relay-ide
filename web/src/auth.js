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

export function isPasskeySupported(environment) {
  return Boolean(environment.isSecureContext && environment.navigator?.credentials?.create && environment.navigator?.credentials?.get);
}

export function presentationForAuthError(error) {
  const code = error?.code ?? (error?.name === "NotAllowedError" ? "passkey_denied" : "unsupported");
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
    case "origin_mismatch":
      return {
        code,
        message: "This page is not at Relay's configured secure origin, so passkey requests are blocked.",
      };
    case "recovery_denied":
      return {
        code,
        message: "Recovery was denied. It never falls back to a PIN or anonymous session.",
      };
    default:
      return {
        code: "unsupported",
        message: "This browser or origin cannot run a secure passkey ceremony.",
      };
  }
}
