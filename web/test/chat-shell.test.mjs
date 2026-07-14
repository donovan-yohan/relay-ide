import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../src/", import.meta.url);

test("each chat tab owns an integrated keyboard-first composer", async () => {
  const [page, app] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("main.js", source), "utf8"),
  ]);

  assert.match(page, /<template id="chat-composer-template">/);
  assert.match(page, /class="chat-composer__send"[^>]*type="submit"[^>]*aria-label="Send message"/);
  assert.match(page, /Enter sends\. Shift Enter adds a new line\./);
  assert.doesNotMatch(page, /<footer class="composer"|id="message-input"|id="send-message"/);
  assert.match(app, /if \(session && active\) pane\.append\(renderChatComposer\(node\.id, active\.id, session\)\)/);
  assert.match(app, /if \(sessionSurface\(session\) === "terminal"\) \{[\s\S]*?return pane;[\s\S]*?renderChatComposer/);
  assert.match(app, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing/);
  assert.match(app, /event\.preventDefault\(\);\s*form\.requestSubmit\(send\);/);
  assert.match(app, /const chatDrafts = new Map\(\)/);
});

test("chat refresh follows only readers already near the bottom", async () => {
  const app = await readFile(new URL("main.js", source), "utf8");

  assert.match(app, /captureChatScrollStates\(\);\s*disposeTerminals/);
  assert.match(app, /nearBottom: distanceFromBottom <= 80/);
  assert.match(app, /if \(!state \|\| state\.nearBottom\) body\.scrollTop = body\.scrollHeight;\s*else body\.scrollTop = state\.scrollTop;/);
  assert.doesNotMatch(app, /body\.scrollTop = 0/);
});

test("refresh restores the focused composer value and text selection without scrolling", async () => {
  const app = await readFile(new URL("main.js", source), "utf8");
  const helpers = app.slice(
    app.indexOf("function captureComposerFocus"),
    app.indexOf("function renderChatAnnouncement"),
  );
  assert.ok(helpers.includes("function restoreComposerFocus"));
  const queued = [];
  const { captureComposerFocus, restoreComposerFocus } = Function(
    "queueMicrotask",
    `"use strict"; ${helpers}; return { captureComposerFocus, restoreComposerFocus };`,
  )((callback) => queued.push(callback));

  const form = { dataset: { tabId: "tab-2" } };
  const original = {
    closest: () => form,
    matches: (selector) => selector === "[data-chat-composer] textarea",
    selectionDirection: "backward",
    selectionEnd: 12,
    selectionStart: 4,
    value: "keep this draft",
  };
  const root = {
    contains: (candidate) => candidate === original,
    ownerDocument: { activeElement: original },
  };
  const state = captureComposerFocus(root);
  assert.deepEqual(state, {
    tabId: "tab-2",
    value: "keep this draft",
    selectionStart: 4,
    selectionEnd: 12,
    selectionDirection: "backward",
  });

  let focusOptions;
  let selection;
  const replacement = {
    closest: () => form,
    disabled: false,
    focus: (options) => { focusOptions = options; },
    isConnected: true,
    setSelectionRange: (...range) => { selection = range; },
    value: state.value,
  };
  restoreComposerFocus({ querySelectorAll: () => [replacement] }, state);
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.deepEqual(focusOptions, { preventScroll: true });
  assert.deepEqual(selection, [4, 12, "backward"]);
  assert.match(app, /timeline\.setAttribute\("aria-live", "off"\)/);
  assert.match(app, /live\.setAttribute\("aria-atomic", "false"\)/);
});

test("tab edges detach through the layout model and closed terminals leave no shadow pane", async () => {
  const app = await readFile(new URL("main.js", source), "utf8");

  assert.match(app, /detachTabToNewPane\(activeLayout, \{\s*sourcePaneId: draggedTab\.paneId,\s*tabId: draggedTab\.tabId,\s*placement,/);
  assert.match(app, /tabDetachDropZones\(node\.id\)/);
  assert.match(app, /activeLayout = activeLayout \? removeSessionFromLayout\(activeLayout, session\.id\) : null;/);
  assert.match(app, /recentClaudeSessions = recentClaudeSessions\.filter/);
  assert.match(app, /"Remove closed terminal"/);
});

test("account sign-out is nested behind compact settings", async () => {
  const page = await readFile(new URL("index.html", source), "utf8");
  const settings = page.match(/<details class="auth-compact">[\s\S]*?<\/details>/)?.[0];

  assert.ok(settings, "compact settings menu must exist");
  assert.match(settings, /<summary aria-label="Settings">/);
  assert.match(settings, /id="sign-out"/);
  assert.doesNotMatch(page.replace(settings, ""), /id="sign-out"/);
});

test("hidden optional controls cannot displace pane content or bottom-left settings", async () => {
  const page = await readFile(new URL("index.html", source), "utf8");

  assert.match(page, /\.main-panel \{[^}]*grid-template-areas: "header" "notice" "panes";/);
  assert.match(page, /\.session-header \{[^}]*grid-area: header;/);
  assert.match(page, /\.workspace-error \{[^}]*grid-area: notice;/);
  assert.match(page, /\.pane-root \{[^}]*grid-area: panes;/);
  assert.match(page, /\.workspace-error:empty \{ display: none; \}/);

  assert.match(page, /\.sidebar \{[^}]*grid-template-areas: "brand" "picker" "projects" "recent" "settings";/);
  assert.match(page, /\.brand \{[^}]*grid-area: brand;/);
  assert.match(page, /\.workspace-add \{[^}]*grid-area: picker;/);
  assert.match(page, /\.workspace-section \{[^}]*grid-area: projects;/);
  assert.match(page, /\.session-section \{[^}]*grid-area: recent;/);
  assert.match(page, /\.auth-compact \{[^}]*grid-area: settings;/);
  assert.match(
    page,
    /@media \(max-width: 48rem\) \{[\s\S]*?\.sidebar \{[^}]*grid-template-areas: "brand" "picker" "projects" "recent" "settings";[^}]*grid-template-rows: repeat\(5, auto\);/,
  );
});

test("closed Claude tombstones survive reload, stay bounded, and filter only matching terminals", async () => {
  const app = await readFile(new URL("main.js", source), "utf8");
  const savedStateSource = app.slice(
    app.indexOf("function savedStateFromStorage"),
    app.indexOf("function normalizeDismissedClaudeSessionIds"),
  );
  const normalizeSource = app.slice(
    app.indexOf("function normalizeDismissedClaudeSessionIds"),
    app.indexOf("function rememberDismissedClaudeSession"),
  );
  const filterSource = app.slice(
    app.indexOf("function isDismissedClaudeSession"),
    app.indexOf("function activeSession"),
  );
  const { savedStateFromStorage, isDismissedClaudeSession } = Function(
    "MAX_DISMISSED_CLAUDE_SESSIONS",
    "MAX_PROVIDER_SESSION_ID_LENGTH",
    `"use strict"; ${normalizeSource}; ${savedStateSource}; ${filterSource}; return { savedStateFromStorage, isDismissedClaudeSession };`,
  )(64, 128);

  const ids = Array.from({ length: 70 }, (_, index) => `pty-${index}`);
  const reloaded = savedStateFromStorage(JSON.stringify({
    version: 2,
    workspaces: [],
    dismissedClaudeSessionIds: [...ids, { output: "terminal secret" }, "", "pty-10"],
  }));
  assert.equal(reloaded.dismissedClaudeSessionIds.length, 64);
  assert.equal(reloaded.dismissedClaudeSessionIds[0], "pty-6");
  assert.equal(reloaded.dismissedClaudeSessionIds.at(-1), "pty-10");
  assert.equal(JSON.stringify(reloaded).includes("terminal secret"), false);

  const dismissed = new Set(reloaded.dismissedClaudeSessionIds);
  assert.equal(isDismissedClaudeSession({ provider: "claude", providerSessionId: "pty-10" }, dismissed), true);
  assert.equal(isDismissedClaudeSession({ provider: "claude", providerSessionId: "pty-1" }, dismissed), false);
  assert.equal(isDismissedClaudeSession({ provider: "codex", providerSessionId: "pty-10" }, dismissed), false);
  assert.match(app, /dismissedClaudeSessionIds: normalizeDismissedClaudeSessionIds\(\[\.\.\.dismissedClaudeSessionIds\]\)/);
  assert.match(app, /const dismissedClaudeSessionIds = new Set\(saved\.dismissedClaudeSessionIds\)/);
  assert.match(app, /restoreRecentClaudeSessions[\s\S]*?\.filter\(\(session\) => !dismissedClaudeSessionIds\.has\(session\.providerSessionId\)\)/);
});

test("browser auth smoke targets per-tab composers instead of the removed universal footer", async () => {
  const smoke = await readFile(new URL("../../scripts/passkey-browser-smoke.mjs", import.meta.url), "utf8");

  assert.match(smoke, /querySelectorAll\('\[data-chat-composer\]'\)\.length/);
  assert.match(smoke, /document\.querySelector\("\[data-chat-composer\]"\)/);
  assert.doesNotMatch(smoke, /querySelector\('\.composer'\)|#message-input|#send-message|#composer/);
  const liveExercise = smoke.slice(
    smoke.indexOf("async function exerciseLiveWorkbench"),
    smoke.indexOf("async function createCertificate"),
  );
  assert.match(liveExercise, /expectedWorkspaceCount, workspaceCwd, workspaceId/);
  assert.match(liveExercise, /workspace-list button'\)\.length >= \$\{expectedWorkspaceCount\}/);
  assert.match(liveExercise, /live Codex QA must target the intended original Project/);
  assert.match(liveExercise, /event\.label === 'assistant\.message'/);
  assert.match(liveExercise, /live QA presentation cleanup to one pane/);
  assert.doesNotMatch(liveExercise, /workspace-list button'\)\.length"\)\) === 1/);
  assert.doesNotMatch(liveExercise, /event\.label === 'turn\.started'/);
});
