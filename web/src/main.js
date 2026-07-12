import {
  credentialToJson,
  decodePublicKeyOptions,
  isPasskeySupported,
  presentationForAuthError,
} from "./auth.js";
import { createTerminalInputQueue } from "./terminal-input.js";
import { terminalErrorPresentation, terminalInputRecovery } from "./terminal-recovery.js";
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
  attachSessionToSelectedTab,
} from "./workspace-layout.js";

const HEALTH_URL = "/health";
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
const openClaude = document.querySelector("#open-claude");
const interruptSession = document.querySelector("#interrupt-session");
const endSession = document.querySelector("#end-session");
const sessionStatus = document.querySelector("#session-status");
const trustedDevices = document.querySelector("#trusted-devices");
let currentDeviceId = null;
let terminalRuntime = null;
const retainedTerminalInput = new Map();
let claudeCreateInFlight = false;
const resolvedClaudeSessionIds = new Set();
const MAX_RESOLVED_CLAUDE_SESSION_IDS = MAX_TAB_COUNT;
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

openClaude.addEventListener("click", () => void openClaudeTerminal());
interruptSession.addEventListener("click", () => void interruptClaudeTerminal());
endSession.addEventListener("click", () => void closeClaudeTerminal());

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
  const activeTab = activePane.tabs.find((tab) => tab.id === activePane.activeTabId);

  workspaceName.textContent = state.workspace.name;
  nodeBinding.textContent = `${state.workspace.node.label} · ${state.workspace.node.id}`;
  rootPath.textContent = state.workspace.root.path;
  rootKind.textContent = state.workspace.root.kind === "non-repo" ? "Non-repo roots are valid" : "Repository root";
  layoutSummary.textContent = `${metrics.paneCount}/${MAX_PANE_COUNT} panes · ${metrics.tabCount}/${MAX_TAB_COUNT} tabs · versioned layout v${state.version}`;

  renderNodeStatus();
  renderNotice();
  renderSessionIdentity();
  disposeTerminal({ preservePausedInput: true });
  renderLayout(state.layout, layoutRoot);

  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    button.disabled =
      (action === "new-tab" && metrics.tabCount >= MAX_TAB_COUNT) ||
      (action === "split" && metrics.paneCount >= MAX_PANE_COUNT) ||
      (action === "move" && metrics.paneCount < 2) ||
      (action === "close" && metrics.paneCount === 1 && activePane.tabs.length === 1);
  }

  const activeClaudeSession = activeTab?.content.sessionId.startsWith("claude-pty-");
  openClaude.disabled = !canOpenClaudeTerminal();
  interruptSession.disabled = !activeClaudeSession || !currentDeviceId;
  endSession.disabled = !activeClaudeSession || !currentDeviceId;
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
  );
  if (activeTab.content.sessionId.startsWith("claude-pty-")) {
    const status = textElement("p", "Attaching Relay-owned Claude terminal…", "terminal-status");
    status.setAttribute("aria-live", "polite");
    const host = document.createElement("div");
    host.className = "terminal-host";
    const inputRecovery = document.createElement("div");
    inputRecovery.className = "terminal-input-recovery";
    inputRecovery.hidden = true;
    const inputRecoveryMessage = textElement("p", "", "terminal-status");
    const retryInput = document.createElement("button");
    retryInput.type = "button";
    retryInput.textContent = "Retry saved input";
    const discardInput = document.createElement("button");
    discardInput.type = "button";
    discardInput.textContent = "Discard saved input";
    inputRecovery.append(inputRecoveryMessage, retryInput, discardInput);
    session.append(
      status,
      host,
      inputRecovery,
      textElement("p", "Pane moves and close detach this browser view; only the explicit terminal close reaps the node-owned process.", "session-note"),
    );
    if (node.id === state.selectedPaneId) {
      mountTerminal(activeTab.content.sessionId, host, status, {
        root: inputRecovery,
        message: inputRecoveryMessage,
        retry: retryInput,
        discard: discardInput,
      });
    }
  } else {
    session.append(textElement(
      "p",
      "This tab references the same opaque Session ID. Layout actions do not start, duplicate, input to, or end it.",
      "session-note",
    ));
  }
  pane.append(session);

  return pane;
}

async function openClaudeTerminal() {
  if (!canOpenClaudeTerminal()) return;
  claudeCreateInFlight = true;
  openClaude.disabled = true;
  try {
    const snapshot = await request("/node/claude/sessions", {
      method: "POST",
      headers: { "X-Relay-CSRF": csrfToken() },
      body: "{}",
    });
    state = attachSessionToSelectedTab(state, snapshot.sessionId, "Claude terminal");
    persistLayout();
  } catch (error) {
    transientNotice = { kind: "error", title: "Claude terminal", message: terminalErrorMessage(error) };
  } finally {
    claudeCreateInFlight = false;
    render();
  }
}

async function interruptClaudeTerminal() {
  const active = selectedPane(state).tabs.find((tab) => tab.id === selectedPane(state).activeTabId);
  if (!active?.content.sessionId.startsWith("claude-pty-")) return;
  try {
    await request(`/node/claude/sessions/${active.content.sessionId}/interrupt`, {
      method: "POST",
      headers: { "X-Relay-CSRF": csrfToken() },
      body: "{}",
    });
  } catch (error) {
    transientNotice = { kind: "error", title: "Claude terminal", message: terminalErrorMessage(error) };
    render();
  }
}

async function closeClaudeTerminal() {
  const active = selectedPane(state).tabs.find((tab) => tab.id === selectedPane(state).activeTabId);
  if (!active?.content.sessionId.startsWith("claude-pty-")) return;
  try {
    await request(`/node/claude/sessions/${active.content.sessionId}/close`, {
      method: "POST",
      headers: { "X-Relay-CSRF": csrfToken() },
      body: "{}",
    });
    rememberResolvedClaudeSession(active.content.sessionId);
    disposeTerminal();
    transientNotice = { kind: "warning", title: "Claude terminal", message: "The Relay-owned process was closed and reaped. This tab keeps the closed Session reference for an honest reattach state." };
    render();
  } catch (error) {
    transientNotice = { kind: "error", title: "Claude terminal", message: terminalErrorMessage(error) };
    render();
  }
}

function mountTerminal(sessionId, host, status, inputRecovery) {
  const retainedInput = retainedTerminalInput.get(sessionId);
  retainedTerminalInput.delete(sessionId);
  const terminal = new window.Terminal({
    cols: 120,
    rows: 36,
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    scrollback: 2_000,
    theme: { background: "#050914", foreground: "#edf2ff", cursor: "#82aaff" },
  });
  terminal.open(host);
  terminal.focus();
  const runtime = {
    sessionId,
    terminal,
    status,
    host,
    cursor: 0,
    timer: null,
    resizeTimer: null,
    resizeObserver: null,
    inputSubscription: null,
    inputQueue: null,
    inputRecovery,
    inputRecoveryMessage: "",
    cols: 0,
    rows: 0,
  };
  terminalRuntime = runtime;
  runtime.inputQueue = createTerminalInputQueue({
    isActive: () => terminalRuntime === runtime,
    send: (data) => request(`/node/claude/sessions/${runtime.sessionId}/input`, {
      method: "POST",
      headers: { "X-Relay-CSRF": csrfToken() },
      body: JSON.stringify({ data }),
    }),
    onError: (error) => {
      if (terminalRuntime !== runtime) return;
      const presentation = terminalInputRecovery(error);
      const inputPaused = runtime.inputQueue?.isPaused();
      runtime.status.textContent = `${inputPaused ? "Input paused" : "Input not queued"}: ${presentation.message}`;
      if (inputPaused) {
        showTerminalInputRecovery(runtime, presentation.message);
      } else {
        hideTerminalInputRecovery(runtime);
      }
    },
    initialPausedInput: retainedInput?.pending,
  });
  if (retainedInput) {
    runtime.status.textContent = `Input paused: ${retainedInput.message}`;
    showTerminalInputRecovery(runtime, retainedInput.message);
  }
  inputRecovery.retry.addEventListener("click", () => {
    if (!runtime.inputQueue?.resume()) return;
    hideTerminalInputRecovery(runtime);
    runtime.status.textContent = "Retrying saved terminal input. Inspect terminal output for possible duplicate delivery.";
  });
  inputRecovery.discard.addEventListener("click", () => {
    if (!runtime.inputQueue?.discard()) return;
    hideTerminalInputRecovery(runtime);
    runtime.status.textContent = "Saved terminal input was discarded.";
  });
  runtime.inputSubscription = terminal.onData((data) => runtime.inputQueue.enqueue(data));
  if (typeof ResizeObserver === "function") {
    runtime.resizeObserver = new ResizeObserver(() => {
      if (runtime.resizeTimer !== null) return;
      runtime.resizeTimer = window.setTimeout(() => {
        runtime.resizeTimer = null;
        void resizeTerminal(runtime);
      }, 50);
    });
    runtime.resizeObserver.observe(host);
  }
  void resizeTerminal(runtime);
  void pollTerminal(runtime);
}

function disposeTerminal({ preservePausedInput = false } = {}) {
  if (!terminalRuntime) return;
  const { sessionId, inputQueue, inputRecoveryMessage } = terminalRuntime;
  const recoverableInput = preservePausedInput ? inputQueue?.recoverableInput() : null;
  if (recoverableInput && sessionIds(state).includes(sessionId)) {
    retainedTerminalInput.set(sessionId, {
      pending: recoverableInput,
      message: inputRecoveryMessage || "Terminal delivery was in progress when this view changed. Relay may already have received the saved input; inspect terminal output before retrying.",
    });
  } else {
    retainedTerminalInput.delete(sessionId);
  }
  clearTimeout(terminalRuntime.timer);
  clearTimeout(terminalRuntime.resizeTimer);
  terminalRuntime.resizeObserver?.disconnect();
  terminalRuntime.inputSubscription?.dispose();
  terminalRuntime.inputQueue?.dispose();
  terminalRuntime.terminal.dispose();
  terminalRuntime = null;
}

function showTerminalInputRecovery(runtime, message) {
  runtime.inputRecoveryMessage = message;
  runtime.inputRecovery.message.textContent = message;
  runtime.inputRecovery.root.hidden = false;
}

function hideTerminalInputRecovery(runtime) {
  runtime.inputRecoveryMessage = "";
  runtime.inputRecovery.message.textContent = "";
  runtime.inputRecovery.root.hidden = true;
}

async function pollTerminal(runtime) {
  try {
    const snapshot = await request(`/node/claude/sessions/${runtime.sessionId}?cursor=${runtime.cursor}`);
    if (terminalRuntime !== runtime) return;
    if (snapshot.truncated) runtime.terminal.writeln("\r\n[Relay: earlier terminal output was truncated]\r\n");
    for (const chunk of snapshot.output) runtime.terminal.write(chunk.text);
    runtime.cursor = snapshot.nextCursor;
    runtime.status.textContent = `Relay-owned terminal · ${snapshot.status} · dropped chunks ${snapshot.droppedChunks}`;
    if (["closed", "exited"].includes(snapshot.status)) {
      rememberResolvedClaudeSession(runtime.sessionId);
      openClaude.disabled = !canOpenClaudeTerminal();
      sessionAuthority.textContent = sessionAuthorityMessage();
      return;
    }
    runtime.timer = window.setTimeout(() => void pollTerminal(runtime), snapshot.hasMore ? 0 : 100);
  } catch (error) {
    if (terminalRuntime === runtime) {
      runtime.status.textContent = `Terminal unavailable: ${terminalErrorMessage(error)}`;
      if (shouldRetryTerminalPoll(error)) {
        runtime.timer = window.setTimeout(() => void pollTerminal(runtime), 1_000);
      }
    }
  }
}

function shouldRetryTerminalPoll(error) {
  return !error?.code || error.code === "pty_transport";
}

function rememberResolvedClaudeSession(sessionId) {
  resolvedClaudeSessionIds.delete(sessionId);
  resolvedClaudeSessionIds.add(sessionId);
  while (resolvedClaudeSessionIds.size > MAX_RESOLVED_CLAUDE_SESSION_IDS) {
    resolvedClaudeSessionIds.delete(resolvedClaudeSessionIds.values().next().value);
  }
}

function canOpenClaudeTerminal() {
  if (claudeCreateInFlight || state.nodeAvailability !== "available" || !currentDeviceId) return false;
  const pane = selectedPane(state);
  const active = pane.tabs.find((tab) => tab.id === pane.activeTabId);
  const sessionId = active?.content.sessionId;
  if (!sessionId?.startsWith("claude-pty-")) return true;
  if (resolvedClaudeSessionIds.has(sessionId)) return true;
  return sessionIds(state).filter((candidate) => candidate === sessionId).length > 1;
}

async function resizeTerminal(runtime) {
  if (terminalRuntime !== runtime) return;
  const cols = Math.max(20, Math.min(500, Math.floor(runtime.host.clientWidth / 8.2) || 120));
  const rows = Math.max(4, Math.min(300, Math.floor(runtime.host.clientHeight / 16) || 36));
  if (runtime.cols === cols && runtime.rows === rows) return;
  runtime.cols = cols;
  runtime.rows = rows;
  runtime.terminal.resize(cols, rows);
  try {
    await request(`/node/claude/sessions/${runtime.sessionId}/resize`, {
      method: "POST",
      headers: { "X-Relay-CSRF": csrfToken() },
      body: JSON.stringify({ cols, rows }),
    });
  } catch (error) {
    if (terminalRuntime === runtime) runtime.status.textContent = `Resize rejected: ${terminalErrorMessage(error)}`;
  }
}

function terminalErrorMessage(error) {
  return terminalErrorPresentation(error).message;
}

function sessionAuthorityMessage() {
  if (state.nodeAvailability === "unavailable") {
    return "Node unavailable: live Session actions stay disabled and no historical context is substituted.";
  }
  if (state.nodeAvailability === "unknown") {
    return "Node status is unknown: live Session actions stay disabled until the one-node liveness check completes.";
  }
  if (!currentDeviceId) {
    return "Sign in with a passkey before requesting a Relay-owned Claude terminal. Browser authority gates the node runtime; it never exposes a process handle.";
  }
  if (claudeCreateInFlight) {
    return "Relay is creating one node-owned PTY Session. Wait for that request to settle before opening another terminal.";
  }
  const pane = selectedPane(state);
  const active = pane.tabs.find((tab) => tab.id === pane.activeTabId);
  if (active?.content.sessionId.startsWith("claude-pty-") && !resolvedClaudeSessionIds.has(active.content.sessionId)) {
    if (sessionIds(state).filter((candidate) => candidate === active.content.sessionId).length > 1) {
      return "This tab mirrors a live Relay-owned terminal. Opening here preserves the existing Session reference in another tab.";
    }
    return "This tab already owns a live Relay terminal. End it explicitly or open a new tab before replacing this Session reference.";
  }
  return "The node is available. Open a Claude terminal to create one authenticated, node-owned PTY Session; layout changes remain presentation-only.";
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
    render();
  } catch (error) {
    currentDeviceId = null;
    const presentation = presentationForAuthError(error);
    sessionStatus.textContent = presentation.code === "unsupported" ? "No active browser session." : presentation.message;
    revokeCurrent.disabled = true;
    trustedDevices.replaceChildren();
    render();
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
      render();
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
