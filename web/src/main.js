import {
  credentialToJson,
  decodePublicKeyOptions,
  isPasskeySupported,
  presentationForAuthError,
} from "./auth.js";
import {
  MAX_PANE_COUNT,
  MAX_TAB_COUNT,
  addSessionTab,
  closeSelectedPane,
  createWorkspaceLayout,
  layoutMetrics,
  moveSelectedPane,
  resetWorkspaceLayout,
  restoreWorkspaceLayout,
  selectTab,
  selectedPane,
  serializeWorkspaceLayout,
  sessionIds,
  setNodeAvailability,
  splitSelectedPane,
  toggleSelectedTabStrip,
} from "./workspace-layout.js";

const HEALTH_URL = "http://127.0.0.1:8787/health";
const STORAGE_KEY = "relay-factory/workspace-layout/v1";
const nodeStatus = document.querySelector("#status");
const workspaceName = document.querySelector("[data-workspace-name]");
const nodeBinding = document.querySelector("[data-node-binding]");
const rootPath = document.querySelector("[data-root-path]");
const rootKind = document.querySelector("[data-root-kind]");
const layoutSummary = document.querySelector("[data-layout-summary]");
const layoutNotice = document.querySelector("[data-layout-notice]");
const layoutRoot = document.querySelector("[data-layout]");
const sessionIdentity = document.querySelector("[data-session-identity]");
const sessionAuthority = document.querySelector("[data-session-authority]");
const authStatus = document.querySelector("#auth-status");
const recoveryCode = document.querySelector("#recovery-code");
const enrollPasskey = document.querySelector("#enroll-passkey");
const signIn = document.querySelector("#sign-in");
const refreshSessions = document.querySelector("#refresh-sessions");
const revokeCurrent = document.querySelector("#revoke-current");
const sessionStatus = document.querySelector("#session-status");
const trustedDevices = document.querySelector("#trusted-devices");
let currentDeviceId = null;
let state = loadLayout();
let transientNotice = null;

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => applyAction(button.dataset.action));
}

layoutRoot.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-select-tab]");
  if (tab) {
    apply(() => selectTab(state, tab.dataset.paneId, tab.dataset.tabId));
    return;
  }

  const pane = event.target.closest("[data-select-pane]");
  if (pane && pane.dataset.selectPane !== state.selectedPaneId) {
    apply(() => ({ ...state, selectedPaneId: pane.dataset.selectPane }));
  }
});

function loadLayout() {
  try {
    return restoreWorkspaceLayout(window.localStorage.getItem(STORAGE_KEY)).state;
  } catch {
    return {
      ...createWorkspaceLayout(),
      nodeAvailability: "unknown",
      recovery: {
        code: "storage-unavailable",
        message: "Browser storage is unavailable. Layout changes will not survive a reopen.",
      },
    };
  }
}

function applyAction(action) {
  const operations = {
    "new-tab": addSessionTab,
    split: splitSelectedPane,
    move: moveSelectedPane,
    "toggle-strip": toggleSelectedTabStrip,
    close: closeSelectedPane,
    "reset-layout": resetWorkspaceLayout,
  };
  apply(operations[action]);
}

function apply(operation) {
  transientNotice = null;
  try {
    state = operation(state);
    persistLayout();
  } catch (error) {
    transientNotice = { kind: "error", title: "Layout action", message: error.message };
  }
  render();
}

function persistLayout() {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeWorkspaceLayout(state));
  } catch {
    transientNotice = {
      kind: "error",
      title: "Layout persistence",
      message: "Layout changed for this view, but browser storage could not save it.",
    };
  }
}

async function refreshNodeAvailability() {
  try {
    const response = await fetch(HEALTH_URL);
    if (!response.ok) {
      throw new Error("unexpected liveness response");
    }
    const health = await response.json();
    if (health.api !== "relay-factory/v1" || health.service !== "hub" || health.status !== "ok") {
      throw new Error("unexpected liveness response");
    }
    state = setNodeAvailability(state, "available");
  } catch {
    state = setNodeAvailability(state, "unavailable");
  }
  render();
}

function render() {
  const metrics = layoutMetrics(state);
  const activePane = selectedPane(state);

  workspaceName.textContent = state.workspace.name;
  nodeBinding.textContent = `${state.workspace.node.label} · ${state.workspace.node.id}`;
  rootPath.textContent = state.workspace.root.path;
  rootKind.textContent = state.workspace.root.kind === "non-repo" ? "Non-repo roots are valid" : "Repository root";
  layoutSummary.textContent = `${metrics.paneCount}/${MAX_PANE_COUNT} panes · ${metrics.tabCount}/${MAX_TAB_COUNT} tabs · versioned layout v${state.version}`;

  renderNodeStatus();
  renderNotice();
  renderSessionIdentity();
  renderLayout(state.layout, layoutRoot);

  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    button.disabled =
      (action === "new-tab" && metrics.tabCount >= MAX_TAB_COUNT) ||
      (action === "split" && metrics.paneCount >= MAX_PANE_COUNT) ||
      (action === "move" && metrics.paneCount < 2) ||
      (action === "close" && metrics.paneCount === 1 && activePane.tabs.length === 1);
  }

  sessionAuthority.textContent = sessionAuthorityMessage();
}

function renderNodeStatus() {
  nodeStatus.dataset.state = state.nodeAvailability;
  if (state.nodeAvailability === "available") {
    nodeStatus.textContent = "Node liveness confirmed";
    return;
  }
  if (state.nodeAvailability === "unavailable") {
    nodeStatus.textContent = "Node unavailable";
    return;
  }
  nodeStatus.textContent = "Node status unknown";
}

function renderNotice() {
  const notice = transientNotice ?? state.recovery;
  layoutNotice.hidden = !notice;
  if (!notice) {
    return;
  }
  layoutNotice.dataset.kind = notice.kind ?? "warning";
  layoutNotice.replaceChildren();
  layoutNotice.append(
    textElement("strong", transientNotice ? (transientNotice.title ?? "Layout action") : "Layout recovery"),
    document.createTextNode(` — ${notice.message} `),
  );
  if (!transientNotice && state.recovery) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = "reset-layout";
    button.textContent = "Reset layout";
    button.addEventListener("click", () => applyAction("reset-layout"));
    layoutNotice.append(button);
  }
}

function renderSessionIdentity() {
  const references = [...new Set(sessionIds(state))];
  sessionIdentity.replaceChildren();
  if (references.length === 0) {
    sessionIdentity.textContent = "No Session references in this layout.";
    return;
  }
  sessionIdentity.append(document.createTextNode("Referenced Session ID: "));
  references.forEach((sessionId, index) => {
    if (index > 0) {
      sessionIdentity.append(document.createTextNode(", "));
    }
    sessionIdentity.append(textElement("code", sessionId));
  });
}

function renderLayout(node, container) {
  container.replaceChildren(renderLayoutNode(node));
}

function renderLayoutNode(node) {
  if (node.kind === "split") {
    const split = document.createElement("div");
    split.className = "split";
    split.append(renderLayoutNode(node.first), renderLayoutNode(node.second));
    return split;
  }

  const pane = document.createElement("section");
  pane.className = "pane";
  pane.dataset.selected = String(node.id === state.selectedPaneId);

  const header = document.createElement("div");
  header.className = "pane-head";
  const select = document.createElement("button");
  select.type = "button";
  select.className = "pane-select";
  select.dataset.selectPane = node.id;
  select.append(textElement("span", "Pane", "pane-label"), document.createTextNode(" "), textElement("strong", node.id));
  header.append(select, textElement("span", "Presentation only", "pane-id"));
  pane.append(header);

  const tabs = document.createElement("div");
  tabs.className = "tab-strip";
  tabs.role = "tablist";
  tabs.hidden = !node.showTabStrip;
  for (const tab of node.tabs) {
    const tabButton = document.createElement("button");
    tabButton.type = "button";
    tabButton.className = "tab";
    tabButton.role = "tab";
    tabButton.dataset.selectTab = "true";
    tabButton.dataset.paneId = node.id;
    tabButton.dataset.tabId = tab.id;
    tabButton.setAttribute("aria-selected", String(tab.id === node.activeTabId));
    tabButton.textContent = tab.title;
    tabs.append(tabButton);
  }
  pane.append(tabs);

  const activeTab = node.tabs.find((tab) => tab.id === node.activeTabId);
  const session = document.createElement("article");
  session.className = "session-card";
  session.append(
    textElement("p", "Session reference", "meta-label"),
    textElement("code", activeTab.content.sessionId),
    textElement(
      "p",
      "This tab references the same opaque Session ID. Layout actions do not start, duplicate, input to, or end it.",
      "session-note",
    ),
  );
  pane.append(session);

  return pane;
}

function sessionAuthorityMessage() {
  if (state.nodeAvailability === "unavailable") {
    return "Node unavailable: live Session actions stay disabled and no historical context is substituted.";
  }
  if (state.nodeAvailability === "unknown") {
    return "Node status is unknown: live Session actions stay disabled until the one-node liveness check completes.";
  }
  return "The one-node liveness check passed. This presentation surface still has no Session control endpoint.";
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  return element;
}

render();
void refreshNodeAvailability();

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
  recoveryCode.value = "";
  const headers = {};
  if (recovery) {
    headers["X-Relay-Recovery-Code"] = recovery;
  } else {
    headers["X-Relay-CSRF"] = csrfToken();
  }
  if (!(await runCeremony("/auth/passkeys/enroll/options", "/auth/passkeys/enroll/verify", "create", headers))) {
    return;
  }
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
