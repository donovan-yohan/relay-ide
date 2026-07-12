import {
  credentialToJson,
  decodePublicKeyOptions,
  isPasskeySupported,
  presentationForAuthError,
} from "./auth.js";

const HEALTH_URL = "http://127.0.0.1:8787/health";
const status = document.querySelector("#status");
const authStatus = document.querySelector("#auth-status");
const recoveryCode = document.querySelector("#recovery-code");
const enrollPasskey = document.querySelector("#enroll-passkey");
const signIn = document.querySelector("#sign-in");
const refreshSessions = document.querySelector("#refresh-sessions");
const revokeCurrent = document.querySelector("#revoke-current");
const sessionStatus = document.querySelector("#session-status");
const trustedDevices = document.querySelector("#trusted-devices");
let currentDeviceId = null;

async function renderLiveness() {
  try {
    const response = await fetch(HEALTH_URL);
    if (!response.ok) {
      throw new Error("liveness request failed");
    }

    const health = await response.json();
    if (health.api !== "relay-factory/v1" || health.service !== "hub" || health.status !== "ok") {
      throw new Error("unexpected liveness response");
    }

    status.textContent = `${health.service} is ${health.status} (${health.version})`;
  } catch {
    status.textContent = "Hub liveness is unavailable.";
  }
}

void renderLiveness();

if (isPasskeySupported(window)) {
  authStatus.textContent = "This browser can use a passkey at Relay's configured secure origin.";
} else {
  authStatus.textContent = presentationForAuthError().message;
  enrollPasskey.disabled = true;
  signIn.disabled = true;
}

enrollPasskey.addEventListener("click", () => void enroll().catch(() => {}));
signIn.addEventListener("click", () => void signInWithPasskey().catch(() => {}));
refreshSessions.addEventListener("click", () => void refreshTrustedDevices());
revokeCurrent.addEventListener("click", () => void revokeCurrentSession());

async function enroll() {
  const recovery = recoveryCode.value;
  const headers = {};
  if (recovery) {
    headers["X-Relay-Recovery-Code"] = recovery;
  } else {
    headers["X-Relay-CSRF"] = csrfToken();
  }
  if (!(await runCeremony("/auth/passkeys/enroll/options", "/auth/passkeys/enroll/verify", "create", headers))) {
    return;
  }
  recoveryCode.value = "";
  authStatus.textContent = "Passkey enrolled. Sign in with that passkey to create a browser session.";
}

async function signInWithPasskey() {
  if (!(await runCeremony("/auth/passkeys/sign-in/options", "/auth/passkeys/sign-in/verify", "get"))) {
    return;
  }
  authStatus.textContent = "Passkey verified. This browser session is scoped to hub actions only.";
  await refreshTrustedDevices();
}

async function runCeremony(optionsPath, verifyPath, operation, headers = {}) {
  try {
    const options = await request(optionsPath, { method: "POST", headers });
    const credential = await navigator.credentials[operation]({ publicKey: decodePublicKeyOptions(options) });
    if (!credential) {
      throw { name: "NotAllowedError" };
    }
    await request(verifyPath, {
      method: "POST",
      body: JSON.stringify(credentialToJson(credential)),
    });
    return true;
  } catch (error) {
    const presentation = presentationForAuthError(error);
    authStatus.textContent = presentation.message;
    return false;
  }
}

async function refreshTrustedDevices() {
  try {
    const response = await request("/auth/sessions");
    const current = response.sessions.find((session) => session.current);
    currentDeviceId = current?.deviceId ?? null;
    revokeCurrent.disabled = !currentDeviceId;
    renderTrustedDevices(response.sessions);
    sessionStatus.textContent = currentDeviceId
      ? `${response.sessions.length} trusted browser session(s).`
      : "No active browser session.";
  } catch (error) {
    const presentation = presentationForAuthError(error);
    sessionStatus.textContent = presentation.code === "unsupported" ? "No active browser session." : presentation.message;
    revokeCurrent.disabled = true;
    trustedDevices.replaceChildren();
  }
}

async function revokeCurrentSession() {
  if (!currentDeviceId) {
    return;
  }
  await revokeSession(currentDeviceId);
}

function renderTrustedDevices(sessions) {
  trustedDevices.replaceChildren(
    ...sessions.map((session) => {
      const item = document.createElement("li");
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = session.current ? "Revoke this browser session" : "Revoke browser session";
      revoke.addEventListener("click", () => void revokeSession(session.deviceId));
      item.append(session.current ? "This browser session " : "Other browser session ", revoke);
      return item;
    }),
  );
}

async function revokeSession(deviceId) {
  const revokingCurrent = deviceId === currentDeviceId;
  try {
    await request("/auth/sessions/revoke", {
      method: "POST",
      headers: { "X-Relay-CSRF": csrfToken() },
      body: JSON.stringify({ deviceId }),
    });
    if (revokingCurrent) {
      currentDeviceId = null;
      revokeCurrent.disabled = true;
      trustedDevices.replaceChildren();
      sessionStatus.textContent = "This browser session was revoked. Protected hub calls now fail closed.";
    } else {
      await refreshTrustedDevices();
    }
  } catch (error) {
    authStatus.textContent = presentationForAuthError(error).message;
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    throw body.error;
  }
  return body;
}

function csrfToken() {
  return document.cookie
    .split("; ")
    .find((value) => value.startsWith("__Host-relay_csrf="))
    ?.slice("__Host-relay_csrf=".length) ?? "";
}
