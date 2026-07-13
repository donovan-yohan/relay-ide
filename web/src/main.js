import {
  credentialToJson,
  decodePublicKeyOptions,
  isPasskeySupported,
  presentationForAuthError,
} from "./auth.js";
import { renderChatTimeline, sessionMayHaveMoreEvents } from "./chat.js";
import {
  claudeMetadata,
  mergeRecentClaudeSessions,
  restoreRecentClaudeSessions,
  serializeRecentClaudeSessions,
  sessionSurface,
} from "./claude-workbench.js";
import { createTerminalInputQueue } from "./terminal-input.js";
import { terminalErrorPresentation, terminalInputRecovery } from "./terminal-recovery.js";
import {
  LayoutLimitError,
  activeSessionTab,
  addSessionTab,
  closeSelectedPane,
  createWorkspaceLayout,
  moveSelectedPane,
  moveTab,
  openSessionTab,
  removeSessionFromLayout,
  restoreWorkspaceLayout,
  selectTab,
  serializeWorkspaceLayout,
  setSplitRatio,
  sessionIds,
  splitSelectedPane,
} from "./workspace-layout.js";

const WORKBENCH_URL = "/api/workbench";
const STORAGE_KEY = "relay-factory/workbench/v1";
const LAYOUT_STORAGE_KEY = "relay-factory/workbench-layouts/v1";
const PROVIDER_LABELS = new Map([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["hermes", "Hermes"],
]);
const TERMINAL_ERROR_CODES = new Set([
  "claude_unavailable",
  "csrf_denied",
  "input_backpressure",
  "input_delivery_lost",
  "invalid_input",
  "invalid_resize",
  "pty_teardown_failed",
  "pty_transport",
  "session_capacity",
  "session_forbidden",
  "session_missing",
  "stale_session",
]);
const workspaceList = document.querySelector("#workspace-list");
const workspaceEmpty = document.querySelector("#workspace-empty");
const workspaceAdd = document.querySelector("#workspace-add");
const directoryPath = document.querySelector("#directory-path");
const directoryList = document.querySelector("#directory-list");
const directoryUp = document.querySelector("#directory-up");
const selectDirectory = document.querySelector("#select-directory");
const sessionList = document.querySelector("#session-list");
const sessionEmpty = document.querySelector("#session-empty");
const sessionTitle = document.querySelector("#session-title");
const sessionSubtitle = document.querySelector("#session-subtitle");
const sessionStatus = document.querySelector("#session-status");
const interruptSession = document.querySelector("#interrupt-session");
const closeTerminal = document.querySelector("#close-terminal");
const paneRoot = document.querySelector("#pane-root");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message-input");
const sendMessage = document.querySelector("#send-message");
const workbenchError = document.querySelector("#workbench-error");
const authStatus = document.querySelector("#auth-status");
const recoveryCode = document.querySelector("#recovery-code");
const enrollPasskey = document.querySelector("#enroll-passkey");
const signIn = document.querySelector("#sign-in");
const signOut = document.querySelector("#sign-out");
const browserAccess = document.querySelector(".auth-compact");
const securityManagement = document.querySelector("#security-management");
const trustedBrowsers = document.querySelector("#trusted-browsers");
const passkeys = document.querySelector("#passkeys");
const securityAudit = document.querySelector("#security-audit");

let workbench = { providers: { claude: false, codex: false, hermes: false }, sessions: [], workspaces: [] };
let saved = loadSavedState();
let savedLayouts = loadSavedLayouts();
let recentClaudeSessions = restoreRecentClaudeSessions(JSON.stringify(saved.claudeSessions ?? []));
let mayHaveSession = saved.mayHaveSession === true;
let selectedWorkspaceCwd = saved.selectedWorkspaceCwd ?? null;
let selectedSessionId = saved.selectedSessionId ?? null;
let activeLayout = null;
let activeLayoutWorkspaceCwd = null;
let authorized = false;
let security = { sessions: [], credentials: [], audit: [] };
let hasWorkbenchSnapshot = false;
let workbenchEpoch = 0;
let refreshTimer = null;
let draggedTab = null;
const resumingSessionIds = new Set();
let visibleError = "";
let layoutResizeTimer = null;
let directorySnapshot = null;
let pendingDirectoryBrowse = null;
const terminalRuntimes = new Map();
const retainedTerminalInput = new Map();

document.querySelector("#show-workspace-add").addEventListener("click", () => {
  workspaceAdd.hidden = false;
  void browseDirectory();
});
document.querySelector("#cancel-workspace-add").addEventListener("click", () => {
  workspaceAdd.hidden = true;
  directorySnapshot = null;
});
directoryUp.addEventListener("click", () => void browseDirectory(directorySnapshot?.parent ?? undefined));
selectDirectory.addEventListener("click", () => void addWorkspace(directorySnapshot?.path));
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMessage();
});
interruptSession.addEventListener("click", () => void interrupt());
closeTerminal.addEventListener("click", () => void closeClaudeTerminal(activeSession()));
for (const button of document.querySelectorAll("[data-provider]")) {
  button.addEventListener("click", () => void startSession(button.dataset.provider));
}
for (const button of document.querySelectorAll("[data-layout-action]")) {
  button.addEventListener("click", () => runLayoutAction(button.dataset.layoutAction));
}
document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.target.matches("input, textarea")) return;
  const action = new Map([
    ["t", "new-tab"],
    ["\\", "split-pane"],
    ["w", "close-pane"],
    ["m", "move-pane"],
  ]).get(event.key.toLowerCase());
  if (!action) return;
  event.preventDefault();
  runLayoutAction(action);
});
window.addEventListener("resize", () => {
  window.clearTimeout(layoutResizeTimer);
  layoutResizeTimer = window.setTimeout(() => render(), 80);
});

if (isPasskeySupported(window)) {
  authStatus.textContent = "Sign in with an enrolled passkey to open this workbench.";
} else {
  const presentation = presentationForAuthError();
  authStatus.textContent = presentation.message;
  enrollPasskey.disabled = true;
  signIn.disabled = true;
}
enrollPasskey.addEventListener("click", () => void enroll().catch(() => {}));
signIn.addEventListener("click", () => void signInWithPasskey().catch(() => {}));
signOut.addEventListener("click", () => void signOutThisBrowser());

function selectedWorkspace() {
  return workbench.workspaces.find((workspace) => workspace.cwd === selectedWorkspaceCwd) ?? null;
}

function sessionsForSelectedWorkspace() {
  const workspace = selectedWorkspace();
  if (!workspace) return [];
  const live = workbench.sessions.filter((session) => session.workspaceId === workspace.id);
  return mergeRecentClaudeSessions(live, recentClaudeSessions, workspace);
}

function activeSession() {
  if (!activeLayout) return null;
  try {
    const sessionId = activeSessionTab(activeLayout).tab.content.sessionId;
    return sessionsForSelectedWorkspace().find((session) => session.id === sessionId) ?? null;
  } catch {
    return null;
  }
}

function normalizeSelection() {
  if (!selectedWorkspace() && workbench.workspaces.length > 0) {
    selectedWorkspaceCwd = workbench.workspaces[0].cwd;
  }
  const workspace = selectedWorkspace();
  const sessions = sessionsForSelectedWorkspace();
  if (!sessions.some((session) => session.id === selectedSessionId)) {
    selectedSessionId = sessions[0]?.id ?? null;
  }
  if (!workspace || sessions.length === 0) {
    activeLayout = null;
    activeLayoutWorkspaceCwd = null;
    return;
  }
  if (activeLayoutWorkspaceCwd !== workspace.cwd) {
    const restored = savedLayouts[workspace.cwd]
      ? restoreWorkspaceLayout(savedLayouts[workspace.cwd]).state
      : createLayout(workspace, selectedSessionId);
    activeLayout = layoutReferencesLiveSessions(restored, sessions)
      ? restored
      : createLayout(workspace, selectedSessionId);
    activeLayoutWorkspaceCwd = workspace.cwd;
  }
  const current = activeSession();
  if (!current) {
    activeLayout = createLayout(workspace, selectedSessionId);
  }
  selectedSessionId = activeSession()?.id ?? selectedSessionId;
}

function createLayout(workspace, sessionId) {
  return createWorkspaceLayout({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    root: workspace.cwd,
    sessionId,
  });
}

function layoutReferencesLiveSessions(layout, sessions) {
  const available = new Set(sessions.map((session) => session.id));
  return sessionIds(layout).every((sessionId) => available.has(sessionId));
}

function render() {
  normalizeSelection();
  const workspace = selectedWorkspace();
  const session = activeSession();
  const terminalSelected = sessionSurface(session) === "terminal";
  renderWorkspaceList();
  renderSessionList();
  renderSecurityManagement();
  renderPaneRoot(workspace);

  workbenchError.textContent = visibleError;
  if (!authorized) {
    sessionTitle.textContent = "Relay workbench";
    sessionSubtitle.textContent = "Sign in with a passkey to open a local Workspace.";
    setSessionState("locked", "unknown");
  } else if (!workspace) {
    sessionTitle.textContent = "Choose a Workspace";
    sessionSubtitle.textContent = "Open an approved local directory from the sidebar.";
    setSessionState("ready", "idle");
  } else if (!session) {
    sessionTitle.textContent = workspace.name;
    sessionSubtitle.textContent = workspace.cwd;
    setSessionState("ready", "idle");
  } else {
    sessionTitle.textContent = sessionTabTitle(session);
    sessionSubtitle.textContent = workspace.cwd;
    setSessionState(session.status, session.status);
  }

  messageInput.parentElement.hidden = terminalSelected;
  messageInput.disabled = !session || terminalSelected;
  sendMessage.disabled = !session || terminalSelected;
  interruptSession.disabled = !session || (terminalSelected
    ? !["starting", "running"].includes(session.status)
    : !["working", "idle"].includes(session.status));
  closeTerminal.hidden = !terminalSelected;
  closeTerminal.disabled = !terminalSelected || ["closing", "closed"].includes(session?.status);
  for (const button of document.querySelectorAll("[data-provider]")) {
    button.disabled = !workspace || !authorized || !workbench.providers[button.dataset.provider];
  }
  for (const button of document.querySelectorAll("[data-layout-action]")) {
    button.disabled = !session;
  }
  persistState();
  persistLayout();
  scheduleRefresh();
}

function setSessionState(label, state) {
  sessionStatus.textContent = label;
  sessionStatus.dataset.state = state;
}

function renderWorkspaceList() {
  workspaceList.replaceChildren();
  if (!authorized || !hasWorkbenchSnapshot) {
    workspaceEmpty.hidden = false;
    return;
  }
  const currentCwds = new Set(workbench.workspaces.map((workspace) => workspace.cwd));
  for (const workspace of workbench.workspaces) {
    workspaceList.append(workspaceButton(workspace));
  }
  for (const workspace of saved.workspaces.filter((workspace) => !currentCwds.has(workspace.cwd))) {
    workspaceList.append(workspaceButton(workspace, true));
  }
  workspaceEmpty.hidden = workspaceList.childElementCount > 0;
}

function workspaceButton(workspace, needsRestore = false) {
  const button = sidebarButton(workspace.name, workspace.cwd);
  button.setAttribute("aria-current", workspace.cwd === selectedWorkspaceCwd ? "page" : "false");
  button.addEventListener("click", () => {
    if (needsRestore) {
      void restoreWorkspace(workspace);
      return;
    }
    void selectWorkspace(workspace);
  });
  return button;
}

function renderSessionList() {
  sessionList.replaceChildren();
  if (!authorized || !hasWorkbenchSnapshot) {
    sessionEmpty.hidden = false;
    return;
  }
  for (const session of sessionsForSelectedWorkspace()) {
    sessionList.append(sessionRow(session));
  }
  sessionEmpty.hidden = sessionList.childElementCount > 0;
}

function renderSecurityManagement() {
  signOut.hidden = !authorized;
  securityManagement.hidden = !authorized;
  trustedBrowsers.replaceChildren();
  passkeys.replaceChildren();
  securityAudit.replaceChildren();
  if (!authorized) return;

  for (const browser of security.sessions) {
    const row = securityRow(
      `${browser.current ? "This browser" : "Trusted browser"} · signed in ${ageLabel(browser.signedInSecondsAgo)}`,
      browser.deviceId,
    );
    if (!browser.current) {
      row.append(securityAction("Revoke browser", () => void revokeBrowser(browser.deviceId)));
    }
    trustedBrowsers.append(row);
  }
  const currentCredentialId = security.sessions.find((browser) => browser.current)?.credentialId;
  for (const credential of security.credentials) {
    const row = securityRow(
      `${credential.credentialId === currentCredentialId ? "Current passkey" : "Passkey"} · enrolled ${ageLabel(credential.enrolledSecondsAgo)} · ${credential.activeSessions} active`,
      credential.credentialId,
    );
    const revoke = securityAction("Revoke passkey", () => void revokeCredential(credential.credentialId));
    revoke.disabled = credential.credentialId === currentCredentialId;
    revoke.title = revoke.disabled
      ? "Use another trusted browser to revoke the passkey active here."
      : "Revoke this passkey and all browser sessions signed in with it.";
    row.append(revoke);
    passkeys.append(row);
  }
  for (const event of security.audit.slice(-8).reverse()) {
    const item = document.createElement("li");
    item.textContent = `${event.action}: ${event.targetId}`;
    securityAudit.append(item);
  }
}

function ageLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 60) return "moments ago";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3_600)}h ago`;
}

function securityRow(label, id) {
  const row = document.createElement("div");
  row.className = "security-row";
  const identity = document.createElement("code");
  identity.textContent = `${label} · ${id}`;
  row.append(identity);
  return row;
}

function securityAction(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

async function signOutThisBrowser() {
  clearError();
  try {
    await request("/auth/sign-out", { method: "POST", body: "{}" });
    authorized = false;
    mayHaveSession = false;
    hasWorkbenchSnapshot = false;
    security = { sessions: [], credentials: [], audit: [] };
    authStatus.textContent = "This browser is signed out. Shared Workspaces remain available to other trusted browsers.";
    saveSignedOutState();
  } catch (error) {
    showError(error);
  }
  render();
}

async function revokeBrowser(deviceId) {
  clearError();
  try {
    await request("/auth/sessions/revoke", {
      method: "POST",
      body: JSON.stringify({ deviceId }),
    });
    security = await request("/auth/sessions");
  } catch (error) {
    showError(error);
  }
  render();
}

async function revokeCredential(credentialId) {
  clearError();
  try {
    await request("/auth/credentials/revoke", {
      method: "POST",
      body: JSON.stringify({ credentialId }),
    });
    security = await request("/auth/sessions");
  } catch (error) {
    showError(error);
  }
  render();
}

function sessionRow(session) {
  const row = document.createElement("div");
  row.className = "session-row";
  const button = sidebarButton(sessionTabTitle(session), session.provider === "claude" ? "terminal" : "chat");
  button.setAttribute("aria-current", session.id === activeSession()?.id ? "page" : "false");
  button.addEventListener("click", () => openExistingSession(session));
  const resume = iconButton("Resume session", "Resume session", "M6 12a6 6 0 1 0 2-4.2M6 5v4h4");
  resume.classList.add("session-row__action");
  resume.disabled = resumingSessionIds.has(session.id);
  resume.hidden = session.provider === "claude";
  resume.addEventListener("click", () => void resumeSession(session));
  const closeLabel = session.provider === "claude" ? "Close terminal process" : "Close Session";
  const close = iconButton(closeLabel, closeLabel, "M7 7l10 10M17 7 7 17");
  close.classList.add("session-row__action");
  close.disabled = session.provider === "claude" && ["closing", "closed"].includes(session.status);
  close.addEventListener("click", () => void (session.provider === "claude" ? closeClaudeTerminal(session) : closeSession(session)));
  row.append(button, resume, close);
  return row;
}

function sidebarButton(label, meta) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-item";
  const text = document.createElement("span");
  text.className = "sidebar-item__text";
  const title = document.createElement("span");
  title.className = "sidebar-item__label";
  title.textContent = label;
  const detail = document.createElement("span");
  detail.className = "sidebar-item__meta";
  detail.textContent = meta;
  text.append(title, detail);
  button.append(text);
  return button;
}

function renderPaneRoot(workspace) {
  disposeTerminals({ preservePausedInput: true });
  paneRoot.replaceChildren();
  if (!authorized) {
    paneRoot.append(emptyCanvas("Sign in to continue."));
    return;
  }
  if (!workspace) {
    paneRoot.append(emptyCanvas("Choose an approved Workspace to start a conversation."));
    return;
  }
  if (!activeLayout) {
    paneRoot.append(emptyCanvas("Start Claude Code, Hermes, or Codex for this Project."));
    return;
  }
  paneRoot.append(renderLayoutNode(activeLayout.layout));
}

function renderLayoutNode(node) {
  if (node.kind === "split") {
    const split = document.createElement("section");
    split.className = "workspace-split";
    split.dataset.splitId = node.id;
    applySplitColumns(split, node.ratio);
    split.append(renderLayoutNode(node.first), splitDivider(node), renderLayoutNode(node.second));
    return split;
  }

  const pane = document.createElement("section");
  pane.className = node.id === activeLayout?.selectedPaneId ? "workbench-pane workbench-pane--selected" : "workbench-pane";
  pane.dataset.paneId = node.id;
  pane.addEventListener("click", () => selectPane(node.id));
  if (node.showTabStrip) {
    const tabList = document.createElement("div");
    tabList.className = "tab-strip";
    for (const [index, tab] of node.tabs.entries()) {
      tabList.append(renderTab(node, tab, index));
    }
    tabList.addEventListener("dragover", (event) => event.preventDefault());
    tabList.addEventListener("drop", (event) => handleTabDrop(event, node.id, node.tabs.length));
    pane.append(tabList);
  }
  const active = node.tabs.find((tab) => tab.id === node.activeTabId);
  const session = active ? sessionsForSelectedWorkspace().find((candidate) => candidate.id === active.content.sessionId) : null;
  const body = document.createElement("div");
  body.className = "pane-body";
  if (sessionSurface(session) === "terminal") {
    body.classList.add("pane-body--terminal");
    body.append(renderTerminalSurface(node.id, session));
    pane.append(body);
    return pane;
  }
  const timeline = document.createElement("div");
  timeline.className = "chat-timeline";
  timeline.setAttribute("aria-live", "polite");
  renderChatTimeline(timeline, session);
  body.append(timeline);
  pane.append(body);
  return pane;
}

function renderTerminalSurface(paneId, session) {
  const surface = document.createElement("section");
  surface.className = "terminal-surface";
  surface.dataset.terminalSessionId = session.providerSessionId;
  const status = document.createElement("p");
  status.className = "terminal-status";
  status.setAttribute("aria-live", "polite");
  status.textContent = `Claude Code · ${session.status}`;
  const host = document.createElement("div");
  host.className = "terminal-host";
  const recovery = document.createElement("div");
  recovery.className = "terminal-recovery";
  recovery.hidden = true;
  const message = document.createElement("p");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry saved input";
  const discard = document.createElement("button");
  discard.type = "button";
  discard.textContent = "Discard saved input";
  const newSession = document.createElement("button");
  newSession.type = "button";
  newSession.textContent = "New Claude Session";
  newSession.hidden = true;
  recovery.append(message, retry, discard, newSession);
  surface.append(status, host, recovery);
  queueMicrotask(() => {
    if (host.isConnected) {
      mountTerminal(paneId, session, host, status, { root: recovery, message, retry, discard, newSession });
    }
  });
  return surface;
}

function mountTerminal(paneId, session, host, status, recovery) {
  if (typeof window.Terminal !== "function") {
    status.textContent = "Claude Code terminal assets are unavailable. Refresh Relay.";
    return;
  }
  const retained = retainedTerminalInput.get(session.providerSessionId);
  retainedTerminalInput.delete(session.providerSessionId);
  const terminal = new window.Terminal({
    cols: 120,
    rows: 36,
    cursorBlink: true,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    scrollback: 2_000,
    theme: {
      background: "#000000",
      foreground: "#d8d2cd",
      cursor: "#d97855",
      selectionBackground: "#4b3026",
    },
  });
  terminal.open(host);
  if (paneId === activeLayout?.selectedPaneId) terminal.focus();
  const runtime = {
    paneId,
    sessionId: session.providerSessionId,
    terminal,
    host,
    status,
    recovery,
    cursor: 0,
    timer: null,
    resizeTimer: null,
    resizeObserver: null,
    inputSubscription: null,
    inputQueue: null,
    inputRecoveryMessage: "",
    polled: false,
    interactive: !session.staleCandidate && ["starting", "running"].includes(session.status),
    cols: 0,
    rows: 0,
    sentCols: 0,
    sentRows: 0,
  };
  terminalRuntimes.set(paneId, runtime);
  runtime.inputQueue = createTerminalInputQueue({
    isActive: () => terminalRuntimes.get(paneId) === runtime,
    send: (data) => request(`/node/claude/sessions/${runtime.sessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ data }),
    }),
    onError: (error) => {
      if (terminalRuntimes.get(paneId) !== runtime) return;
      const presentation = terminalInputRecovery(error);
      const paused = runtime.inputQueue?.isPaused();
      runtime.status.textContent = `${paused ? "Input paused" : "Input not queued"}: ${presentation.message}`;
      if (paused) showTerminalRecovery(runtime, presentation.message);
      else hideTerminalRecovery(runtime);
    },
    initialPausedInput: retained?.pending,
  });
  if (retained) {
    status.textContent = `Input paused: ${retained.message}`;
    showTerminalRecovery(runtime, retained.message);
  }
  recovery.retry.addEventListener("click", () => {
    if (!runtime.inputQueue?.resume()) return;
    hideTerminalRecovery(runtime);
    runtime.status.textContent = "Retrying saved input. Inspect output for possible prior delivery.";
  });
  recovery.discard.addEventListener("click", () => {
    if (!runtime.inputQueue?.discard()) return;
    hideTerminalRecovery(runtime);
    runtime.status.textContent = "Saved terminal input discarded.";
  });
  recovery.newSession.addEventListener("click", () => void startSession("claude"));
  runtime.inputSubscription = terminal.onData((data) => {
    if (runtime.interactive && runtime.paneId === activeLayout?.selectedPaneId) {
      runtime.inputQueue.enqueue(data);
    }
  });
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

function disposeTerminals({ preservePausedInput = false } = {}) {
  for (const runtime of terminalRuntimes.values()) {
    const recoverableInput = preservePausedInput ? runtime.inputQueue?.recoverableInput() : null;
    if (recoverableInput) {
      retainedTerminalInput.set(runtime.sessionId, {
        pending: recoverableInput,
        message: runtime.inputRecoveryMessage || "Delivery was in progress when this view changed. Inspect output before retrying.",
      });
    } else {
      retainedTerminalInput.delete(runtime.sessionId);
    }
    window.clearTimeout(runtime.timer);
    window.clearTimeout(runtime.resizeTimer);
    runtime.resizeObserver?.disconnect();
    runtime.inputSubscription?.dispose();
    runtime.inputQueue?.dispose();
    runtime.terminal.dispose();
  }
  terminalRuntimes.clear();
}

function showTerminalRecovery(runtime, message, { stale = false } = {}) {
  runtime.inputRecoveryMessage = message;
  runtime.recovery.message.textContent = message;
  runtime.recovery.retry.hidden = stale;
  runtime.recovery.discard.hidden = stale;
  runtime.recovery.newSession.hidden = !stale;
  runtime.recovery.root.hidden = false;
}

function hideTerminalRecovery(runtime) {
  runtime.inputRecoveryMessage = "";
  runtime.recovery.message.textContent = "";
  runtime.recovery.root.hidden = true;
}

async function pollTerminal(runtime) {
  try {
    const snapshot = await request(`/node/claude/sessions/${runtime.sessionId}?cursor=${runtime.cursor}`);
    if (terminalRuntimes.get(runtime.paneId) !== runtime) return;
    if (snapshot.truncated) runtime.terminal.writeln("\r\n[Relay: earlier terminal output was truncated]\r\n");
    for (const chunk of snapshot.output) {
      if (chunk.sequence > runtime.cursor) runtime.terminal.write(chunk.text);
    }
    runtime.cursor = snapshot.nextCursor;
    runtime.polled = true;
    runtime.interactive = ["starting", "running"].includes(snapshot.status);
    runtime.status.textContent = `Claude Code · ${snapshot.status}`;
    updateClaudeSessionStatus(runtime.sessionId, snapshot.status);
    if (runtime.interactive) void resizeTerminal(runtime);
    if (["closed", "exited"].includes(snapshot.status)) return;
    runtime.timer = window.setTimeout(() => void pollTerminal(runtime), snapshot.hasMore ? 0 : 100);
  } catch (error) {
    if (terminalRuntimes.get(runtime.paneId) !== runtime) return;
    const presentation = terminalErrorPresentation(error);
    runtime.status.textContent = presentation.message;
    if (presentation.code === "stale_session") {
      showTerminalRecovery(runtime, presentation.message, { stale: true });
    } else if (!error?.code || error.code === "pty_transport") {
      runtime.timer = window.setTimeout(() => void pollTerminal(runtime), 1_000);
    }
  }
}

async function resizeTerminal(runtime) {
  if (terminalRuntimes.get(runtime.paneId) !== runtime) return;
  const cols = Math.max(20, Math.min(500, Math.floor(runtime.host.clientWidth / 8.2) || 120));
  const rows = Math.max(4, Math.min(300, Math.floor(runtime.host.clientHeight / 16) || 36));
  if (runtime.cols !== cols || runtime.rows !== rows) {
    runtime.cols = cols;
    runtime.rows = rows;
    runtime.terminal.resize(cols, rows);
  }
  if (
    !runtime.polled
    || !runtime.interactive
    || runtime.paneId !== activeLayout?.selectedPaneId
    || (runtime.sentCols === cols && runtime.sentRows === rows)
  ) return;
  runtime.sentCols = cols;
  runtime.sentRows = rows;
  try {
    await request(`/node/claude/sessions/${runtime.sessionId}/resize`, {
      method: "POST",
      body: JSON.stringify({ cols, rows }),
    });
  } catch (error) {
    if (terminalRuntimes.get(runtime.paneId) === runtime) {
      runtime.sentCols = 0;
      runtime.sentRows = 0;
      runtime.status.textContent = terminalErrorPresentation(error).message;
    }
  }
}

function renderTab(pane, tab, index) {
  const session = sessionsForSelectedWorkspace().find((candidate) => candidate.id === tab.content.sessionId);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-tab";
  button.draggable = true;
  button.dataset.paneId = pane.id;
  button.dataset.tabId = tab.id;
  button.dataset.tabIndex = String(index);
  button.dataset.active = String(tab.id === pane.activeTabId);
  button.textContent = session ? sessionTabTitle(session) : "Unavailable session";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    activeLayout = selectTab(activeLayout, pane.id, tab.id);
    selectedSessionId = tab.content.sessionId;
    render();
  });
  button.addEventListener("dragstart", (event) => {
    draggedTab = { paneId: pane.id, tabId: tab.id };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tab.id);
  });
  button.addEventListener("dragover", (event) => event.preventDefault());
  button.addEventListener("drop", (event) => handleTabDrop(event, pane.id, index));
  button.addEventListener("dragend", () => { draggedTab = null; });
  return button;
}

function splitDivider(node) {
  const divider = document.createElement("div");
  divider.className = "pane-divider";
  divider.dataset.splitId = node.id;
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", compactPaneLayout() ? "horizontal" : "vertical");
  divider.setAttribute("aria-label", "Resize panes");
  divider.setAttribute("aria-valuemin", "20");
  divider.setAttribute("aria-valuemax", "80");
  divider.setAttribute("aria-valuenow", String(Math.round(node.ratio * 100)));
  divider.addEventListener("pointerdown", (event) => beginResize(event, divider, node.id));
  divider.addEventListener("keydown", (event) => {
    const keys = compactPaneLayout() ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    if (!activeLayout || !keys.includes(event.key)) return;
    event.preventDefault();
    const change = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -0.05 : 0.05;
    activeLayout = setSplitRatio(activeLayout, node.id, node.ratio + change);
    persistLayout();
    render();
  });
  return divider;
}

function beginResize(event, divider, splitId) {
  if (event.button !== 0) return;
  const split = divider.parentElement;
  const compact = compactPaneLayout();
  const update = (coordinate) => {
    const bounds = split.getBoundingClientRect();
    const ratio = compact
      ? (coordinate - bounds.top) / bounds.height
      : (coordinate - bounds.left) / bounds.width;
    activeLayout = setSplitRatio(activeLayout, splitId, ratio);
    const nextRatio = splitRatio(activeLayout.layout, splitId) ?? ratio;
    applySplitColumns(split, nextRatio);
    divider.setAttribute("aria-valuenow", String(Math.round(nextRatio * 100)));
  };
  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    persistLayout();
    render();
  };
  const move = (moveEvent) => update(compact ? moveEvent.clientY : moveEvent.clientX);
  try {
    divider.setPointerCapture?.(event.pointerId);
  } catch {
    // Synthetic and remote pointer paths can resize through the window listeners without capture.
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish, { once: true });
}

function applySplitColumns(element, ratio) {
  const divider = 0.5;
  const first = ratio * 100;
  const second = (1 - ratio) * 100;
  const tracks = [
    `minmax(0, calc(${first}% - ${divider * ratio}rem))`,
    `${divider}rem`,
    `minmax(0, calc(${second}% - ${divider * (1 - ratio)}rem))`,
  ].join(" ");
  if (compactPaneLayout()) {
    element.style.gridTemplateColumns = "minmax(0, 1fr)";
    element.style.gridTemplateRows = tracks;
    return;
  }
  element.style.gridTemplateColumns = tracks;
  element.style.gridTemplateRows = "";
}

function compactPaneLayout() {
  return window.matchMedia("(max-width: 64rem)").matches;
}

function handleTabDrop(event, targetPaneId, targetIndex) {
  event.preventDefault();
  if (!draggedTab) return;
  try {
    activeLayout = moveTab(activeLayout, draggedTab.paneId, draggedTab.tabId, targetPaneId, targetIndex);
    selectedSessionId = activeSession()?.id ?? selectedSessionId;
    render();
  } catch (error) {
    showLayoutError(error);
  } finally {
    draggedTab = null;
  }
}

function selectPane(paneId) {
  if (!activeLayout || activeLayout.selectedPaneId === paneId) return;
  const pane = findPaneInLayout(activeLayout.layout, paneId);
  if (!pane) return;
  activeLayout = selectTab(activeLayout, paneId, pane.activeTabId);
  selectedSessionId = activeSession()?.id ?? selectedSessionId;
  render();
}

function findPaneInLayout(node, paneId) {
  if (node.kind === "tabs") return node.id === paneId ? node : null;
  return findPaneInLayout(node.first, paneId) ?? findPaneInLayout(node.second, paneId);
}

function splitRatio(node, splitId) {
  if (node.kind === "tabs") return null;
  if (node.id === splitId) return node.ratio;
  return splitRatio(node.first, splitId) ?? splitRatio(node.second, splitId);
}

function emptyCanvas(text) {
  const empty = document.createElement("p");
  empty.className = "chat-empty workspace-canvas-empty";
  empty.textContent = text;
  return empty;
}

function runLayoutAction(action) {
  const session = activeSession();
  if (!activeLayout || !session) return;
  clearError();
  try {
    switch (action) {
      case "new-tab":
        activeLayout = addSessionTab(activeLayout, { sessionId: session.id, title: sessionTabTitle(session) });
        break;
      case "split-pane":
        activeLayout = splitSelectedPane(activeLayout);
        break;
      case "move-pane":
        activeLayout = moveSelectedPane(activeLayout);
        break;
      case "close-pane":
        activeLayout = closeSelectedPane(activeLayout);
        break;
      default:
        return;
    }
    selectedSessionId = activeSession()?.id ?? selectedSessionId;
    render();
  } catch (error) {
    showLayoutError(error);
  }
}

function showLayoutError(error) {
  visibleError = error instanceof LayoutLimitError ? error.message : "That layout change could not be applied.";
  workbenchError.textContent = visibleError;
}

function sessionTabTitle(session) {
  const provider = PROVIDER_LABELS.get(session.provider) ?? session.provider;
  return `${provider} · ${session.status}`;
}

async function refreshWorkbench({ restore = true } = {}) {
  const refreshEpoch = workbenchEpoch;
  try {
    const snapshot = await request(WORKBENCH_URL);
    const securitySnapshot = await request("/auth/sessions");
    if (refreshEpoch !== workbenchEpoch) return;
    workbench = snapshot;
    security = securitySnapshot;
    authorized = true;
    hasWorkbenchSnapshot = true;
    if (restore && workbench.workspaces.length === 0 && saved.workspaces.length > 0) {
      await restoreWorkspace(saved.workspaces.find((workspace) => workspace.cwd === selectedWorkspaceCwd) ?? saved.workspaces[0]);
      return;
    }
  } catch (error) {
    if (refreshEpoch !== workbenchEpoch) return;
    authorized = false;
    security = { sessions: [], credentials: [], audit: [] };
    mayHaveSession = false;
    if (error?.code && error.code !== "session_missing") showError(error);
  }
  render();
}

function beginWorkbenchMutation() {
  workbenchEpoch += 1;
}

async function browseDirectory(path) {
  clearError();
  directoryPath.textContent = "Loading…";
  directoryList.replaceChildren();
  directoryUp.disabled = true;
  selectDirectory.disabled = true;
  try {
    directorySnapshot = await request("/api/directories", {
      method: "POST",
      body: JSON.stringify(path ? { path } : {}),
    });
    directoryPath.textContent = directorySnapshot.path ?? "Approved roots";
    directoryUp.disabled = directorySnapshot.path === null;
    selectDirectory.disabled = directorySnapshot.path === null;
    for (const directory of directorySnapshot.directories) {
      const button = sidebarButton(directory.name, directory.path);
      button.type = "button";
      button.dataset.directoryPath = directory.path;
      button.addEventListener("click", () => void browseDirectory(directory.path));
      directoryList.append(button);
    }
    if (directoryList.childElementCount === 0) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "No approved subdirectories.";
      directoryList.append(empty);
    }
  } catch (error) {
    if (recoverExpiredDirectoryBrowse(error, path)) return;
    directorySnapshot = null;
    directoryPath.textContent = "Directory unavailable";
    showError(error);
  }
}

function recoverExpiredDirectoryBrowse(error, path) {
  if (!["session_missing", "csrf_denied"].includes(error?.code)) return false;
  pendingDirectoryBrowse = { path };
  authorized = false;
  mayHaveSession = false;
  directorySnapshot = null;
  workspaceAdd.hidden = true;
  directoryPath.textContent = "Sign in to continue";
  directoryList.replaceChildren();
  directoryUp.disabled = true;
  selectDirectory.disabled = true;
  authStatus.textContent = error.code === "csrf_denied"
    ? "Browser access expired. Sign in again to continue adding this Project."
    : "Browser access is no longer active. Sign in again to continue adding this Project.";
  visibleError = "Sign in with your passkey to continue adding this Project.";
  workbenchError.dataset.code = error.code;
  render();
  browserAccess.open = true;
  signIn.focus();
  return true;
}

async function resumeDirectoryBrowseAfterSignIn() {
  if (!pendingDirectoryBrowse) return;
  const retry = pendingDirectoryBrowse;
  pendingDirectoryBrowse = null;
  workspaceAdd.hidden = false;
  await browseDirectory(retry.path);
}

async function addWorkspace(cwd) {
  if (!cwd) return;
  clearError();
  beginWorkbenchMutation();
  try {
    const workspace = await request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
    workspaceAdd.hidden = true;
    directorySnapshot = null;
    await selectWorkspace(workspace, { refresh: true });
  } catch (error) {
    showError(error);
  }
}

async function restoreWorkspace(workspace) {
  clearError();
  beginWorkbenchMutation();
  try {
    const restored = await request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ cwd: workspace.cwd, name: workspace.name }),
    });
    await selectWorkspace(restored, { refresh: true });
  } catch (error) {
    showError(error);
  }
}

async function selectWorkspace(workspace, { refresh = false } = {}) {
  clearError();
  beginWorkbenchMutation();
  selectedWorkspaceCwd = workspace.cwd;
  selectedSessionId = null;
  activeLayout = null;
  activeLayoutWorkspaceCwd = null;
  if (refresh) await refreshWorkbench({ restore: false });
  else render();
}

function openExistingSession(session) {
  if (!activeLayout) return;
  clearError();
  activeLayout = openSessionTab(activeLayout, session.id, sessionTabTitle(session));
  selectedSessionId = session.id;
  render();
}

async function startSession(provider) {
  const workspace = selectedWorkspace();
  if (!workspace) return;
  clearError();
  beginWorkbenchMutation();
  try {
    const created = provider === "claude"
      ? await request("/node/claude/sessions", {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspace.id }),
      })
      : await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspace.id, provider }),
      });
    const session = provider === "claude" ? created.workbenchSession : created;
    workbench.sessions = [session, ...workbench.sessions];
    if (!activeLayout) activeLayout = createLayout(workspace, session.id);
    else activeLayout = openSessionTab(activeLayout, session.id, sessionTabTitle(session));
    activeLayoutWorkspaceCwd = workspace.cwd;
    selectedSessionId = session.id;
    render();
  } catch (error) {
    showError(error);
  }
}

async function resumeSession(source) {
  const workspace = selectedWorkspace();
  if (!workspace) return;
  if (resumingSessionIds.has(source.id)) return;
  clearError();
  beginWorkbenchMutation();
  resumingSessionIds.add(source.id);
  render();
  try {
    const session = await request("/api/sessions/resume", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: workspace.id,
        provider: source.provider,
        providerSessionId: source.providerSessionId,
      }),
    });
    workbench.sessions = [session, ...workbench.sessions];
    openExistingSession(session);
  } catch (error) {
    showError(error);
  } finally {
    resumingSessionIds.delete(source.id);
    render();
  }
}

async function closeSession(session) {
  clearError();
  beginWorkbenchMutation();
  try {
    await request("/api/sessions/close", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id }),
    });
    activeLayout = activeLayout ? removeSessionFromLayout(activeLayout, session.id) : null;
    workbench.sessions = workbench.sessions.filter((candidate) => candidate.id !== session.id);
    selectedSessionId = sessionsForSelectedWorkspace()[0]?.id ?? null;
    if (!activeLayout && selectedSessionId) {
      activeLayout = createLayout(selectedWorkspace(), selectedSessionId);
      activeLayoutWorkspaceCwd = selectedWorkspaceCwd;
    }
    render();
  } catch (error) {
    showError(error);
  }
}

async function closeClaudeTerminal(session) {
  if (session?.provider !== "claude") return;
  clearError();
  beginWorkbenchMutation();
  try {
    const snapshot = await request(`/node/claude/sessions/${session.providerSessionId}/close`, {
      method: "POST",
      body: "{}",
    });
    updateClaudeSessionStatus(session.providerSessionId, snapshot.status);
  } catch (error) {
    showError(error);
  }
  render();
}

async function submitMessage() {
  const session = activeSession();
  const text = messageInput.value.trim();
  if (!session || !text) return;
  clearError();
  beginWorkbenchMutation();
  messageInput.value = "";
  replaceSession({
    ...session,
    events: [...(session.events ?? []), { role: "user", kind: "message", label: "message.sent", text }],
  });
  render();
  try {
    replaceSession(await request("/api/sessions/message", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, text }),
    }));
  } catch (error) {
    showError(error);
    await refreshWorkbench({ restore: false });
    return;
  }
  render();
}

async function interrupt() {
  const session = activeSession();
  if (!session) return;
  clearError();
  beginWorkbenchMutation();
  try {
    if (session.provider === "claude") {
      await request(`/node/claude/sessions/${session.providerSessionId}/interrupt`, {
        method: "POST",
        body: "{}",
      });
    } else {
      replaceSession(await request("/api/sessions/interrupt", {
        method: "POST",
        body: JSON.stringify({ sessionId: session.id }),
      }));
    }
  } catch (error) {
    showError(error);
  }
  render();
}

function replaceSession(updated) {
  workbench.sessions = workbench.sessions.map((session) => session.id === updated.id ? updated : session);
}

function updateClaudeSessionStatus(providerSessionId, status) {
  const changed = workbench.sessions.some((session) => (
    session.provider === "claude"
    && session.providerSessionId === providerSessionId
    && session.status !== status
  )) || recentClaudeSessions.some((session) => (
    session.providerSessionId === providerSessionId && session.status !== status
  ));
  workbench.sessions = workbench.sessions.map((session) => (
    session.provider === "claude" && session.providerSessionId === providerSessionId
      ? { ...session, status }
      : session
  ));
  recentClaudeSessions = recentClaudeSessions.map((session) => (
    session.providerSessionId === providerSessionId ? { ...session, status } : session
  ));
  if (!changed) return;
  const session = sessionsForSelectedWorkspace().find((candidate) => candidate.providerSessionId === providerSessionId);
  if (session && activeSession()?.providerSessionId === providerSessionId) {
    setSessionState(status, status);
  }
  persistState();
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  const hasPendingSession = sessionsForSelectedWorkspace().some(sessionMayHaveMoreEvents);
  if (authorized && hasPendingSession) {
    refreshTimer = window.setTimeout(() => void refreshWorkbench({ restore: false }), 900);
  }
}

function showError(error) {
  const code = error?.code ?? "request_failed";
  const messages = {
    hermes_not_configured: "Hermes is not available on this Relay hub.",
    workbench_busy: "Relay is busy. Retry this action.",
    csrf_denied: "Your browser security check expired. Sign in again.",
    unknown_session: "That session is no longer available. Reopen a recent session or start a new one.",
    unknown_workspace: "That Workspace is no longer available. Open it again.",
    unknown_provider_session: "That recent provider session is no longer available. Start a new session.",
    workspace_cwd_not_approved: "Choose a directory inside an approved Workspace root.",
    workspace_cwd_invalid: "That directory is unavailable.",
    executable_unavailable: "The provider executable is unavailable on this node.",
    unavailable: "The provider is unavailable right now. Retry when it is ready.",
  };
  visibleError = TERMINAL_ERROR_CODES.has(code)
    ? terminalErrorPresentation(error).message
    : messages[code] ?? "Relay could not complete that action. Retry or choose another session.";
  workbenchError.dataset.code = code;
  workbenchError.textContent = visibleError;
}

function clearError() {
  visibleError = "";
  delete workbenchError.dataset.code;
}

function loadSavedState() {
  try {
    const state = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if ([1, 2].includes(state?.version) && Array.isArray(state.workspaces)) return state;
  } catch {
    // Browser storage is convenience-only; live workbench state remains hub-owned.
  }
  return { version: 2, mayHaveSession: false, selectedSessionId: null, selectedWorkspaceCwd: null, workspaces: [], claudeSessions: [] };
}

function persistState() {
  if (!authorized || !hasWorkbenchSnapshot) return;
  const liveClaude = workbench.sessions.flatMap((session) => {
    if (session.provider !== "claude") return [];
    const workspace = workbench.workspaces.find((candidate) => candidate.id === session.workspaceId);
    const metadata = claudeMetadata({ ...session, title: "Claude Code" }, workspace?.cwd);
    return metadata ? [metadata] : [];
  });
  recentClaudeSessions = restoreRecentClaudeSessions(serializeRecentClaudeSessions([
    ...liveClaude,
    ...recentClaudeSessions.filter((recent) => !liveClaude.some((live) => live.providerSessionId === recent.providerSessionId)),
  ]));
  saved = {
    version: 2,
    mayHaveSession,
    selectedSessionId,
    selectedWorkspaceCwd,
    workspaces: workbench.workspaces.map((workspace) => ({ cwd: workspace.cwd, name: workspace.name })),
    claudeSessions: recentClaudeSessions,
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Do not downgrade a live provider Session when browser storage is blocked.
  }
}

function saveSignedOutState() {
  saved = { ...saved, mayHaveSession: false };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Server-side revocation already completed; local persistence is convenience-only.
  }
}

function loadSavedLayouts() {
  try {
    const layouts = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
    return layouts && typeof layouts === "object" && !Array.isArray(layouts) ? layouts : {};
  } catch {
    return {};
  }
}

function persistLayout() {
  if (!activeLayout || !activeLayoutWorkspaceCwd) return;
  try {
    savedLayouts = { ...savedLayouts, [activeLayoutWorkspaceCwd]: serializeWorkspaceLayout(activeLayout) };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(savedLayouts));
  } catch {
    // A blocked persistence write cannot affect the live pane arrangement.
  }
}

function iconButton(label, title, path) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.setAttribute("aria-label", label);
  button.title = title;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  button.append(svg);
  return button;
}

async function enroll() {
  const recovery = recoveryCode.value;
  recoveryCode.value = "";
  const headers = recovery ? { "X-Relay-Recovery-Code": recovery } : { "X-Relay-CSRF": csrfToken() };
  if (await runCeremony("/auth/passkeys/enroll/options", "/auth/passkeys/enroll/verify", "create", headers)) {
    authStatus.textContent = "Passkey enrolled. Sign in to open Workspaces.";
  }
}

async function signInWithPasskey() {
  if (await runCeremony("/auth/passkeys/sign-in/options", "/auth/passkeys/sign-in/verify", "get")) {
    mayHaveSession = true;
    authStatus.textContent = "Browser access verified.";
    await refreshWorkbench();
    if (authorized) await resumeDirectoryBrowseAfterSignIn();
  }
}

async function runCeremony(optionsPath, verifyPath, operation, headers = {}) {
  try {
    const options = await request(optionsPath, { method: "POST", headers });
    const credential = await navigator.credentials[operation]({ publicKey: decodePublicKeyOptions(options) });
    if (!credential) throw { name: "NotAllowedError" };
    await request(verifyPath, { method: "POST", body: JSON.stringify(credentialToJson(credential)) });
    return true;
  } catch (error) {
    authStatus.textContent = presentationForAuthError(error).message;
    return false;
  }
}

async function request(path, options = {}) {
  const csrf = options.method && options.method !== "GET" ? csrfToken() : "";
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-Relay-CSRF": csrf } : {}),
      ...options.headers,
    },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw { code: "invalid_response" };
  }
  if (!response.ok) throw body?.error ?? { code: "invalid_response" };
  return body;
}

function csrfToken() {
  return document.cookie
    .split("; ")
    .find((value) => value.startsWith("__Host-relay_csrf="))
    ?.slice("__Host-relay_csrf=".length) ?? "";
}

render();
if (mayHaveSession) void refreshWorkbench();
