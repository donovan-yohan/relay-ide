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

test("per-tab submission clears, locks duplicate sends, and recovers before newer typing", async () => {
  const app = await readFile(new URL("main.js", source), "utf8");
  const helpers = app.slice(
    app.indexOf("function updateChatComposerSendState"),
    app.indexOf("function captureChatScrollStates"),
  );
  const chatDrafts = new Map([["tab-1", "hello"]]);
  const pendingChatSubmissions = new Set();
  const send = { disabled: false };
  const form = { dataset: { tabId: "tab-1" }, querySelector: () => send };
  const textarea = {
    closest: () => form,
    scrollHeight: 64,
    style: {},
    value: "hello",
  };
  const { clearSubmittedChatDraft, recoverChatDraft, updateChatComposerSendState } = Function(
    "chatDrafts",
    "pendingChatSubmissions",
    "paneRoot",
    `"use strict"; ${helpers}; return { clearSubmittedChatDraft, recoverChatDraft, updateChatComposerSendState };`,
  )(chatDrafts, pendingChatSubmissions, { querySelectorAll: () => [textarea] });

  pendingChatSubmissions.add("tab-1");
  clearSubmittedChatDraft("tab-1", textarea, send);
  assert.equal(textarea.value, "");
  assert.equal(send.disabled, true);
  assert.equal(chatDrafts.has("tab-1"), false);
  assert.equal(textarea.style.height, "64px");
  assert.equal(textarea.disabled, undefined, "a pending request must not disable newer typing");

  textarea.value = "new text typed while sending";
  chatDrafts.set("tab-1", "new text typed while sending");
  updateChatComposerSendState("tab-1", textarea, send);
  assert.equal(send.disabled, true, "a pending tab must block a second send");
  recoverChatDraft("tab-1", "hello");
  assert.equal(textarea.value, "hello\nnew text typed while sending");
  assert.equal(chatDrafts.get("tab-1"), textarea.value);
  assert.equal(send.disabled, true, "failure recovery stays locked until the request settles");
  pendingChatSubmissions.delete("tab-1");
  updateChatComposerSendState("tab-1", textarea, send);
  assert.equal(send.disabled, false, "a settled request unlocks the recovered draft");

  textarea.value = "hello";
  chatDrafts.set("tab-1", "hello");
  pendingChatSubmissions.add("tab-1");
  recoverChatDraft("tab-1", "hello");
  assert.equal(
    textarea.value,
    "hello\nhello",
    "identical non-empty text is still independent newer typing and must not be deduplicated",
  );
  pendingChatSubmissions.delete("tab-1");
  assert.match(app, /const pendingChatSubmissions = new Set\(\)/);
  assert.match(app, /if \(!text \|\| pendingChatSubmissions\.has\(tabId\)\) return;/);
  assert.match(app, /clearSubmittedChatDraft\(tabId, textarea, send\);\s*void submitMessage/);
  assert.match(app, /catch \(error\) \{\s*recoverChatDraft\(draftKey, text\);/);
  assert.match(app, /finally \{\s*pendingChatSubmissions\.delete\(draftKey\);\s*render\(\);/);
});

test("pending submission unlocks after both request success and ordered failure recovery", async () => {
  const app = await readFile(new URL("main.js", source), "utf8");
  const submitSource = app.slice(
    app.indexOf("async function submitMessage"),
    app.indexOf("async function interrupt"),
  );
  const session = { id: "session-1", events: [], provider: "codex" };

  async function exercise(request) {
    const pending = new Set(["tab-1"]);
    const order = [];
    const submitMessage = Function(
      "chatDrafts",
      "pendingChatSubmissions",
      "clearError",
      "beginWorkbenchMutation",
      "replaceSession",
      "render",
      "request",
      "recoverChatDraft",
      "showError",
      "refreshWorkbench",
      `"use strict"; ${submitSource}; return submitMessage;`,
    )(
      new Map(),
      pending,
      () => order.push("clear"),
      () => order.push("begin"),
      () => order.push("replace"),
      () => order.push(`render:${pending.has("tab-1") ? "pending" : "settled"}`),
      request,
      () => order.push("recover"),
      () => order.push("error"),
      async () => order.push("refresh"),
    );
    await submitMessage(session, "hello", "tab-1");
    return { order, pending };
  }

  const success = await exercise(async () => ({ ...session, events: [{ role: "user" }] }));
  assert.equal(success.pending.has("tab-1"), false);
  assert.deepEqual(success.order, ["clear", "begin", "replace", "render:pending", "replace", "render:settled"]);

  const failure = await exercise(async () => { throw new Error("offline"); });
  assert.equal(failure.pending.has("tab-1"), false);
  assert.deepEqual(
    failure.order,
    ["clear", "begin", "replace", "render:pending", "recover", "error", "refresh", "render:settled"],
    "failed text must recover before the pending lock is released",
  );
});

test("message rows omit visible role labels and expose resilient copy actions", async () => {
  const [page, app] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("main.js", source), "utf8"),
  ]);
  const copySource = app.slice(
    app.indexOf("async function copyChatMessage"),
    app.indexOf("function renderChatComposer"),
  );
  const copied = [];
  const copyChatMessage = Function(
    "navigator",
    `"use strict"; ${copySource}; return copyChatMessage;`,
  )({ clipboard: { writeText: async (text) => copied.push(text) } });
  const button = { dataset: {} };
  const status = { textContent: "" };
  await copyChatMessage(button, status, "answer text");
  assert.deepEqual(copied, ["answer text"]);
  assert.equal(button.dataset.copyState, "copied");
  assert.equal(status.textContent, "Message copied.");

  const failedCopy = Function(
    "navigator",
    `"use strict"; ${copySource}; return copyChatMessage;`,
  )({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
  await failedCopy(button, status, "preserved answer");
  assert.equal(button.dataset.copyState, "unavailable");
  assert.match(status.textContent, /conversation is unchanged/);

  assert.match(app, /item\.querySelector\("header"\)\?\.remove\(\)/);
  assert.match(app, /item\.setAttribute\("aria-label", item\.classList\.contains\("chat-event--user"\) \? "Your message" : "Assistant message"\)/);
  assert.match(app, /iconButton\("Copy message", "Copy message",/);
  assert.match(app, /copy\.dataset\.chatCopyKey = `\$\{tabId\}:\$\{messageIndex\}`/);
  assert.match(app, /status\.setAttribute\("aria-live", "polite"\)/);
  assert.match(page, /\.chat-event--message:hover \.chat-event__copy/);
  assert.match(page, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*?\.chat-event__copy \{[^}]*min-height: 2\.75rem;[^}]*opacity: 1;[^}]*pointer-events: auto;[^}]*width: 2\.75rem;/);
  assert.doesNotMatch(page, /chat-event--thinking/);
  assert.doesNotMatch(page, /\.chat-event__role/);
});

test("copy focus and feedback survive a pane replacement by stable message key", async () => {
  const app = await readFile(new URL("main.js", source), "utf8");
  const helpers = app.slice(
    app.indexOf("function captureChatCopyState"),
    app.indexOf("async function copyChatMessage"),
  );
  const originalStatus = { textContent: "Message copied." };
  const original = {
    dataset: { chatCopyKey: "tab-2:1", copyState: "copied" },
    matches: (selector) => selector === "[data-chat-copy-key]",
    parentElement: { querySelector: () => originalStatus },
  };
  const sourceRoot = {
    ownerDocument: { activeElement: original },
    querySelectorAll: () => [original],
  };
  const queued = [];
  const { captureChatCopyState, restoreChatCopyState } = Function(
    "queueMicrotask",
    `"use strict"; ${helpers}; return { captureChatCopyState, restoreChatCopyState };`,
  )((callback) => queued.push(callback));
  const state = captureChatCopyState(sourceRoot);
  assert.equal(state.focusedKey, "tab-2:1");
  assert.deepEqual(state.feedback.get("tab-2:1"), {
    copyState: "copied",
    status: "Message copied.",
  });

  const replacementStatus = { textContent: "" };
  let focusOptions;
  const replacement = {
    dataset: { chatCopyKey: "tab-2:1" },
    focus: (options) => { focusOptions = options; },
    isConnected: true,
    parentElement: { querySelector: () => replacementStatus },
  };
  restoreChatCopyState({ querySelectorAll: () => [replacement] }, state);
  assert.equal(replacement.dataset.copyState, "copied");
  assert.equal(replacementStatus.textContent, "Message copied.");
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.deepEqual(focusOptions, { preventScroll: true });
  assert.match(app, /const chatCopyState = captureChatCopyState\(paneRoot\)/);
  assert.match(app, /restoreChatCopyState\(paneRoot, chatCopyState\)/);
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
