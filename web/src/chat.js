const PRESENTATIONS = {
  assistant: { label: "Assistant", tone: "assistant" },
  error: { label: "Error", tone: "error" },
  status: { label: "Status", tone: "status" },
  tool: { label: "Tool", tone: "tool" },
  user: { label: "You", tone: "user" },
};

const REFRESHABLE_SESSION_STATUSES = new Set(["starting", "working", "degraded"]);
const ROUTINE_STATUS_LABELS = new Set([
  "gateway_ready",
  "item.completed",
  "item.started",
  "mcp.startup_status",
  "message_complete",
  "message_delta",
  "message_started",
  "reasoning",
  "remote_control.status",
  "session.started",
  "session.resumed",
  "session_info",
  "session_title",
  "status_update",
  "turn.completed",
  "turn.started",
]);

export function sessionMayHaveMoreEvents(session) {
  return REFRESHABLE_SESSION_STATUSES.has(session?.status);
}

export function eventPresentation(event) {
  const presentation = event?.role === "assistant" || event?.role === "user"
    ? PRESENTATIONS[event.role]
    : PRESENTATIONS[event?.kind] ?? PRESENTATIONS[event?.role] ?? PRESENTATIONS.status;
  return {
    tone: presentation.tone,
    roleLabel: presentation.label,
    eventLabel: typeof event?.label === "string" && event.label.length > 0 ? event.label : "session.update",
    text: typeof event?.text === "string" && event.text.length > 0 ? event.text : "Provider activity recorded.",
  };
}

export function normalizeChatEvents(events) {
  const normalized = [];
  for (const source of Array.isArray(events) ? events : []) {
    if (!source || typeof source !== "object" || isRoutineStatus(source)) continue;
    const event = { ...source };
    if (event.role === "assistant" && event.kind === "message" && typeof event.text === "string") {
      const previous = normalized.at(-1);
      if (previous?.role === "assistant" && previous.kind === "message") {
        if (event.label === "assistant.message.delta" && previous.label === "assistant.message.delta") {
          previous.text += event.text;
          continue;
        }
        if (event.label === "assistant.message" && previous.label === "assistant.message.delta") {
          previous.label = event.label;
          previous.text = event.text;
          previous.sequence = event.sequence ?? previous.sequence;
          continue;
        }
        if (event.label === previous.label && event.text === previous.text) continue;
      }
    }
    normalized.push(event);
  }
  return normalized;
}

export function renderChatTimeline(container, session) {
  container.replaceChildren();
  if (!session) {
    container.append(emptyState("Choose a conversation or start one from this Workspace."));
    return;
  }
  const events = normalizeChatEvents(session.events);
  if (events.length === 0) {
    container.append(emptyState("Connected. Send the first message when you are ready."));
    return;
  }

  for (const event of events) {
    const presentation = eventPresentation(event);
    const item = document.createElement("article");
    item.className = `chat-event chat-event--${presentation.tone}`;
    const heading = document.createElement("header");
    const role = document.createElement("span");
    role.className = "chat-event__role";
    role.textContent = presentation.roleLabel;
    const kind = document.createElement("code");
    kind.textContent = presentation.eventLabel;
    heading.append(role);
    if (!["assistant", "user"].includes(presentation.tone)) heading.append(kind);
    const text = document.createElement("p");
    text.textContent = presentation.text;
    item.append(heading, text);
    container.append(item);
  }
}

function isRoutineStatus(event) {
  if (!ROUTINE_STATUS_LABELS.has(event.label)) return false;
  if (event.role === "assistant" || event.role === "user") return false;
  return event.signal == null && event.kind !== "error" && event.kind !== "tool";
}

function emptyState(text) {
  const element = document.createElement("p");
  element.className = "chat-empty";
  element.textContent = text;
  return element;
}
