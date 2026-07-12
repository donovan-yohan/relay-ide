import {
  credentialToJson,
  decodePublicKeyOptions,
  isPasskeySupported,
  presentationForAuthError,
} from "./auth.js";
import { renderChatTimeline } from "./chat.js";
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
const workspaceList = document.querySelector("#workspace-list");
const workspaceEmpty = document.querySelector("#workspace-empty");
const workspaceAdd = document.querySelector("#workspace-add");
const workspaceForm = document.querySelector("#workspace-form");
const workspaceCwd = document.querySelector("#workspace-cwd");
const sessionList = document.querySelector("#session-list");
const sessionEmpty = document.querySelector("#session-empty");
const sessionTitle = document.querySelector("#session-title");
const sessionSubtitle = document.querySelector("#session-subtitle");
const sessionStatus = document.querySelector("#session-status");
const interruptSession = document.querySelector("#interrupt-session");
const paneRoot = document.querySelector("#pane-root");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message-input");
const sendMessage = document.querySelector("#send-message");
const workbenchError = document.querySelector("#workbench-error");
const authStatus = document.querySelector("#auth-status");
const recoveryCode = document.querySelector("#recovery-code");
const enrollPasskey = document.querySelector("#enroll-passkey");
const signIn = document.querySelector("#sign-in");

let workbench = { providers: { codex: false, hermes: false }, sessions: [], workspaces: [] };
let saved = loadSavedState();
let savedLayouts = loadSavedLayouts();
let mayHaveSession = saved.mayHaveSession === true;
let selectedWorkspaceCwd = saved.selectedWorkspaceCwd ?? null;
let selectedSessionId = saved.selectedSessionId ?? null;
let activeLayout = null;
let activeLayoutWorkspaceCwd = null;
let authorized = false;
let hasWorkbenchSnapshot = false;
let workbenchEpoch = 0;
let refreshTimer = null;
let draggedTab = null;
const resumingSessionIds = new Set();
let visibleError = "";
let layoutResizeTimer = null;

document.querySelector("#show-workspace-add").addEventListener("click", () => {
  workspaceAdd.hidden = false;
  workspaceCwd.focus();
});
document.querySelector("#cancel-workspace-add").addEventListener("click", () => {
  workspaceAdd.hidden = true;
  workspaceForm.reset();
});
workspaceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void addWorkspace();
});
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMessage();
});
interruptSession.addEventListener("click", () => void interrupt());
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

function selectedWorkspace() {
  return workbench.workspaces.find((workspace) => workspace.cwd === selectedWorkspaceCwd) ?? null;
}

function sessionsForSelectedWorkspace() {
  const workspace = selectedWorkspace();
  return workspace ? workbench.sessions.filter((session) => session.workspaceId === workspace.id) : [];
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
    const selected = workbench.workspaces.find((workspace) => workspace.id === workbench.selectedWorkspaceId);
    selectedWorkspaceCwd = selected?.cwd ?? workbench.workspaces[0].cwd;
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
  renderWorkspaceList();
  renderSessionList();
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

  messageInput.disabled = !session;
  sendMessage.disabled = !session;
  interruptSession.disabled = !session || !["working", "idle"].includes(session.status);
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

function sessionRow(session) {
  const row = document.createElement("div");
  row.className = "session-row";
  const button = sidebarButton(sessionTabTitle(session), session.providerSessionId);
  button.setAttribute("aria-current", session.id === activeSession()?.id ? "page" : "false");
  button.addEventListener("click", () => openExistingSession(session));
  const resume = iconButton("Resume session", "Resume session", "M6 12a6 6 0 1 0 2-4.2M6 5v4h4");
  resume.classList.add("session-row__action");
  resume.disabled = resumingSessionIds.has(session.id);
  resume.addEventListener("click", () => void resumeSession(session));
  const close = iconButton("Close provider session", "Close provider session", "M7 7l10 10M17 7 7 17");
  close.classList.add("session-row__action");
  close.addEventListener("click", () => void closeSession(session));
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
    paneRoot.append(emptyCanvas("Start Hermes or Codex for this Workspace."));
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
  const timeline = document.createElement("div");
  timeline.className = "chat-timeline";
  timeline.setAttribute("aria-live", "polite");
  renderChatTimeline(timeline, session);
  body.append(timeline);
  pane.append(body);
  return pane;
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
  return `${session.provider} · ${session.status}`;
}

async function refreshWorkbench({ restore = true } = {}) {
  const refreshEpoch = workbenchEpoch;
  try {
    const snapshot = await request(WORKBENCH_URL);
    if (refreshEpoch !== workbenchEpoch) return;
    workbench = snapshot;
    authorized = true;
    hasWorkbenchSnapshot = true;
    if (restore && workbench.workspaces.length === 0 && saved.workspaces.length > 0) {
      await restoreWorkspace(saved.workspaces.find((workspace) => workspace.cwd === selectedWorkspaceCwd) ?? saved.workspaces[0]);
      return;
    }
  } catch (error) {
    if (refreshEpoch !== workbenchEpoch) return;
    authorized = false;
    mayHaveSession = false;
    if (error?.code && error.code !== "session_missing") showError(error);
  }
  render();
}

function beginWorkbenchMutation() {
  workbenchEpoch += 1;
}

async function addWorkspace() {
  clearError();
  beginWorkbenchMutation();
  try {
    const workspace = await request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ cwd: workspaceCwd.value.trim() }),
    });
    workspaceAdd.hidden = true;
    workspaceForm.reset();
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
  try {
    await request("/api/workspaces/select", {
      method: "POST",
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    selectedWorkspaceCwd = workspace.cwd;
    selectedSessionId = null;
    activeLayout = null;
    activeLayoutWorkspaceCwd = null;
    if (refresh) await refreshWorkbench({ restore: false });
    else render();
  } catch (error) {
    showError(error);
  }
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
    const session = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspaceId: workspace.id, provider }),
    });
    workbench.sessions = [...workbench.sessions, session];
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
    workbench.sessions = [...workbench.sessions, session];
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
    replaceSession(await request("/api/sessions/interrupt", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id }),
    }));
  } catch (error) {
    showError(error);
  }
  render();
}

function replaceSession(updated) {
  workbench.sessions = workbench.sessions.map((session) => session.id === updated.id ? updated : session);
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  const hasPendingSession = sessionsForSelectedWorkspace().some((session) => ["working", "starting"].includes(session.status));
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
    workbench_owner_mismatch: "This Workbench is open in another browser session. Close or sign out there first.",
    unknown_session: "That session is no longer available. Reopen a recent session or start a new one.",
    unknown_workspace: "That Workspace is no longer available. Open it again.",
    unknown_provider_session: "That recent provider session is no longer available. Start a new session.",
    workspace_cwd_not_approved: "Choose a directory inside an approved Workspace root.",
    workspace_cwd_invalid: "That directory is unavailable.",
    executable_unavailable: "The provider executable is unavailable on this node.",
    unavailable: "The provider is unavailable right now. Retry when it is ready.",
  };
  visibleError = messages[code] ?? "Relay could not complete that action. Retry or choose another session.";
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
    if (state?.version === 1 && Array.isArray(state.workspaces)) return state;
  } catch {
    // Browser storage is convenience-only; live workbench state remains hub-owned.
  }
  return { version: 1, mayHaveSession: false, selectedSessionId: null, selectedWorkspaceCwd: null, workspaces: [] };
}

function persistState() {
  if (!authorized || !hasWorkbenchSnapshot) return;
  saved = {
    version: 1,
    mayHaveSession,
    selectedSessionId,
    selectedWorkspaceCwd,
    workspaces: workbench.workspaces.map((workspace) => ({ cwd: workspace.cwd, name: workspace.name })),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Do not downgrade a live provider Session when browser storage is blocked.
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
  const body = await response.json().catch(() => ({ error: { code: "invalid_response" } }));
  if (!response.ok) throw body.error;
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