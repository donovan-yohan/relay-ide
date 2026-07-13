const PRESENTATIONS = {
  assistant: { label: "Assistant", tone: "assistant" },
  error: { label: "Error", tone: "error" },
  status: { label: "Status", tone: "status" },
  tool: { label: "Tool", tone: "tool" },
  user: { label: "You", tone: "user" },
};

const REFRESHABLE_SESSION_STATUSES = new Set(["starting", "working", "degraded"]);

export function sessionMayHaveMoreEvents(session) {
  return REFRESHABLE_SESSION_STATUSES.has(session?.status);
}

export function eventPresentation(event) {
  const presentation = PRESENTATIONS[event?.role] ?? PRESENTATIONS.status;
  return {
    tone: presentation.tone,
    roleLabel: presentation.label,
    eventLabel: typeof event?.label === "string" && event.label.length > 0 ? event.label : "session.update",
    text: typeof event?.text === "string" && event.text.length > 0 ? event.text : "Provider activity recorded.",
  };
}

export function renderChatTimeline(container, session) {
  container.replaceChildren();
  if (!session) {
    container.append(emptyState("Choose a conversation or start one from this Workspace."));
    return;
  }
  if (!Array.isArray(session.events) || session.events.length === 0) {
    container.append(emptyState("Connected. Send the first message when you are ready."));
    return;
  }

  for (const event of session.events) {
    const presentation = eventPresentation(event);
    const item = document.createElement("article");
    item.className = `chat-event chat-event--${presentation.tone}`;
    const heading = document.createElement("header");
    const role = document.createElement("span");
    role.className = "chat-event__role";
    role.textContent = presentation.roleLabel;
    const kind = document.createElement("code");
    kind.textContent = presentation.eventLabel;
    heading.append(role, kind);
    const text = document.createElement("p");
    text.textContent = presentation.text;
    item.append(heading, text);
    container.append(item);
  }
  container.scrollTop = container.scrollHeight;
}

function emptyState(text) {
  const element = document.createElement("p");
  element.className = "chat-empty";
  element.textContent = text;
  return element;
}
