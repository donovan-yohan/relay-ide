import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { RelayEvent } from "@/shared/api/types";
import type { RawChannel, RawChannelDetail } from "@/shared/api/tauriChannels";
import type {
  AgentDetailCardV2,
  AgentRunMetrics,
  AgentRunRecord,
  AgentRunSummary,
  ChannelMessage,
} from "@/features/agent-runs/types";

export function stringToPubkey(str: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(str)));
}

export const OPERATOR_PUBKEY = stringToPubkey("human:operator");
const CAPABILITIES_HEADER = "context:read,context:write,session:read,session:create:agent";

export type ProfileInfo = {
  pubkey: string;
  displayName: string;
  name: string;
  isAgent: boolean;
  avatarUrl: string | null;
};

const profileRegistry = new Map<string, ProfileInfo>();
const idMap = new Map<string, string>(); // hexPubkey -> senderId

export function registerProfile(senderId: string, displayName?: string, isAgent?: boolean): string {
  const pubkey = stringToPubkey(senderId);
  idMap.set(pubkey, senderId);
  const name = displayName || senderId.split(":").pop() || "Agent";
  profileRegistry.set(pubkey, {
    pubkey,
    displayName: name,
    name,
    isAgent: isAgent ?? (senderId.startsWith("agent") || senderId.startsWith("agent-profile")),
    avatarUrl: null,
  });
  return pubkey;
}

// Seed known profiles
registerProfile("human:operator", "Operator", false);
registerProfile("agent:local-cli", "Local CLI", true);
registerProfile("agent-profile:claude:default", "Claude Code", true);
registerProfile("agent-profile:codex:default", "Codex", true);
registerProfile("agent-profile:hermes:default", "Hermes", true);
registerProfile("agent-profile:prime-agent:default", "Prime Agent", true);
registerProfile("agent-profile:antigravity:default", "Antigravity", true);
registerProfile("agent-profile:pi:default", "Pi", true);

export function mapRelayChannelToRawChannel(rc: any): RawChannel {
  const isDm = rc.id.startsWith("topic:dm~") || rc.kind === "dm";
  const members = rc.members || [];
  const memberPubkeys = members.map((m: any) =>
    registerProfile(m.id, m.displayName, m.kind === "agent")
  );

  if (rc.lastMessage?.senderId) {
    registerProfile(
      rc.lastMessage.senderId,
      rc.lastMessage.senderDisplayName,
      rc.lastMessage.senderKind === "agent"
    );
  }

  return {
    id: rc.id,
    name: rc.title || rc.id,
    channel_type: isDm ? "dm" : "stream",
    visibility: rc.visibility === "private" ? "private" : "open",
    description: rc.title || "",
    topic: rc.title || null,
    purpose: null,
    member_count: memberPubkeys.length || 1,
    member_pubkeys: memberPubkeys.length ? memberPubkeys : [OPERATOR_PUBKEY],
    last_message_at: rc.lastMessage?.createdAt || null,
    archived_at: rc.archived ? new Date().toISOString() : null,
    participants: members.map((m: any) => m.displayName || m.id),
    participant_pubkeys: memberPubkeys.length ? memberPubkeys : [OPERATOR_PUBKEY],
    is_member: true,
    ttl_seconds: null,
    ttl_deadline: null,
  };
}

// In-memory caches for raw messages and parsed AgentRunRecords
const channelRawMessages = new Map<string, ChannelMessage[]>();
const channelRunRecords = new Map<string, Map<string, AgentRunRecord>>();

function formatDurationLabel(ms: number): string {
  if (ms <= 0) return "<1s";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
}

function extractFilesTouched(card: AgentDetailCardV2): string[] {
  const files: string[] = [];
  if (card.path && typeof card.path === "string") {
    files.push(card.path);
  }
  if (card.kind === "diff" && card.title && typeof card.title === "string" && !card.path) {
    files.push(card.title);
  }
  if (card.content) {
    const text = typeof card.content === "string" ? card.content : JSON.stringify(card.content);
    const matches = text.matchAll(/"(?:AbsolutePath|file_path|filePath|path)"\s*:\s*"([^"]+)"/g);
    for (const match of matches) {
      if (match[1] && !files.includes(match[1])) {
        files.push(match[1]);
      }
    }
    const fileRedirectMatches = text.matchAll(/(?:>|>>)\s*([/\w.-]+\.[a-zA-Z0-9_-]+)/g);
    for (const match of fileRedirectMatches) {
      if (match[1] && !files.includes(match[1])) {
        files.push(match[1]);
      }
    }
  }
  return files;
}

/**
 * Determine if a ChannelMessage is principal prose to display in the main room timeline.
 * Detail items (tool calls, diffs, thoughts, intermediate outputs, internal turn system messages)
 * are filtered out of room altitude and surfaced only in the Agent Run View.
 */
export function channelMessageIsPrincipalProse(msg: ChannelMessage): boolean {
  if (msg.meta?.deletedAt) {
    return false;
  }
  // Human messages are always principal
  if (msg.sender?.kind === "human") {
    return true;
  }
  // Detail card items belong exclusively in Run View drill-in
  if (msg.agentDetail !== undefined) {
    return false;
  }
  // System messages related to turns or approval requests belong in Run View drill-in
  if (msg.kind === "system") {
    if (msg.meta?.approvalRequestId || msg.meta?.approvalState || msg.source?.turnId) {
      return false;
    }
    // Other system messages (e.g. general room events) are shown in room
    return true;
  }
  // Agent message: must be kind "message" with non-empty body text
  if (msg.sender?.kind === "agent") {
    return Boolean(msg.body?.text && msg.body.text.trim().length > 0);
  }
  return true;
}

/**
 * Rebuild agent runs from channel messages
 */
export function rebuildChannelRuns(
  channelId: string,
  rawMessages: ChannelMessage[]
): Map<string, AgentRunRecord> {
  const runMap = new Map<string, AgentRunRecord>();
  const turnIdToRunId = new Map<string, string>();

  // 1. First pass: establish run identifiers for turns & explicit asyncRuns
  for (const msg of rawMessages) {
    const asyncRunId = msg.asyncRun?.runId;
    const turnId = msg.source?.turnId;
    if (asyncRunId && turnId) {
      turnIdToRunId.set(turnId, asyncRunId);
    }
  }

  // 2. Second pass: group messages into runs
  const runMessages = new Map<string, ChannelMessage[]>();
  let lastHumanMessage: ChannelMessage | null = null;
  const runRequestMessages = new Map<string, ChannelMessage>();

  for (const msg of rawMessages) {
    if (msg.sender?.kind === "human") {
      lastHumanMessage = msg;
    }

    let runId = msg.asyncRun?.runId;
    const turnId = msg.source?.turnId;
    if (!runId && turnId) {
      runId = (turnIdToRunId.get(turnId) || `chrun:turn-${turnId}`) as `chrun:${string}`;
    }

    if (runId) {
      if (!runMessages.has(runId)) {
        runMessages.set(runId, []);
        if (lastHumanMessage) {
          runRequestMessages.set(runId, lastHumanMessage);
        }
      }
      runMessages.get(runId)!.push(msg);
    } else if (msg.sender?.kind === "agent" && channelMessageIsPrincipalProse(msg)) {
      // Standalone agent prose without turnId or asyncRun
      const syntheticRunId = `chrun:single-${msg.id}` as `chrun:${string}`;
      if (!runMessages.has(syntheticRunId)) {
        runMessages.set(syntheticRunId, []);
        if (lastHumanMessage) {
          runRequestMessages.set(syntheticRunId, lastHumanMessage);
        }
      }
      runMessages.get(syntheticRunId)!.push(msg);
    }
  }

  // 3. Third pass: calculate metrics and assemble AgentRunRecord for each run
  for (const [runId, msgs] of runMessages.entries()) {
    const requestMessage = runRequestMessages.get(runId);
    const principalMessage = msgs.find(
      (m) => m.sender?.kind === "agent" && channelMessageIsPrincipalProse(m)
    );
    const agentSender =
      principalMessage?.sender ||
      msgs.find((m) => m.sender?.kind === "agent")?.sender ||
      msgs[0]?.sender || { id: "agent:unknown", kind: "agent" };

    const agentPubkey = registerProfile(
      agentSender.id,
      agentSender.displayName,
      agentSender.kind === "agent"
    );
    const agentName = agentSender.displayName || agentSender.id.split(":").pop() || "Agent";

    let toolCallCount = 0;
    const filesTouchedSet = new Set<string>();
    let pendingApproval = false;

    for (const m of msgs) {
      if (m.agentDetail?.card) {
        if (m.agentDetail.card.kind === "tool_call") {
          toolCallCount++;
        }
        const extracted = extractFilesTouched(m.agentDetail.card);
        for (const f of extracted) {
          filesTouchedSet.add(f);
        }
      }
      if (
        m.meta?.approvalRequestId ||
        m.meta?.approvalState === "requested" ||
        m.meta?.status === "approval-pending"
      ) {
        pendingApproval = true;
      }
    }

    const allOrderedMessages: ChannelMessage[] = [];
    if (requestMessage && !msgs.some((m) => m.id === requestMessage.id)) {
      allOrderedMessages.push(requestMessage);
    }
    allOrderedMessages.push(...msgs);
    allOrderedMessages.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const startTime = new Date(
      requestMessage?.createdAt || msgs[0]?.createdAt || new Date().toISOString()
    ).getTime();
    const lastMsg = msgs[msgs.length - 1];
    const endTime = new Date(
      principalMessage?.completedAt ||
        principalMessage?.createdAt ||
        lastMsg?.completedAt ||
        lastMsg?.createdAt ||
        new Date().toISOString()
    ).getTime();

    const durationMs = Math.max(0, endTime - startTime);
    const durationLabel = formatDurationLabel(durationMs);

    let status: AgentRunMetrics["status"] = "completed";
    if (pendingApproval) {
      status = "input-required";
    } else if (
      principalMessage?.status === "streaming" ||
      (!principalMessage && msgs.some((m) => m.status === "streaming"))
    ) {
      status = "working";
    } else if (
      principalMessage?.status === "failed" ||
      principalMessage?.status === "interrupted"
    ) {
      status = "failed";
    }

    const filesTouched = Array.from(filesTouchedSet);
    const metrics: AgentRunMetrics = {
      durationMs,
      durationLabel,
      toolCallCount,
      filesTouchedCount: filesTouched.length,
      filesTouched,
      pendingApproval,
      status,
    };

    const record: AgentRunRecord = {
      runId,
      channelId,
      agentId: agentSender.id,
      agentPubkey,
      agentName,
      createdAt: new Date(startTime).toISOString(),
      completedAt: new Date(endTime).toISOString(),
      status,
      metrics,
      messages: allOrderedMessages,
      requestMessage,
      principalMessage,
    };

    runMap.set(runId, record);
    // Also index by turnId if known
    for (const m of msgs) {
      if (m.source?.turnId) {
        runMap.set(m.source.turnId, record);
      }
    }
  }

  channelRunRecords.set(channelId, runMap);
  return runMap;
}

export function getAgentRunsForChannel(
  channelId: string,
  agentPubkey?: string
): AgentRunSummary[] {
  const runMap = channelRunRecords.get(channelId);
  if (!runMap) return [];

  const uniqueRuns = new Map<string, AgentRunRecord>();
  for (const record of runMap.values()) {
    uniqueRuns.set(record.runId, record);
  }

  let list = Array.from(uniqueRuns.values());
  if (agentPubkey) {
    const pkNorm = agentPubkey.toLowerCase();
    const filtered = list.filter(
      (r) =>
        r.agentPubkey.toLowerCase() === pkNorm ||
        r.agentId.toLowerCase() === pkNorm
    );
    if (filtered.length > 0) {
      list = filtered;
    }
  }

  // Sort newest first
  list.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return list.map((r) => ({
    runId: r.runId,
    channelId: r.channelId,
    agentId: r.agentId,
    agentPubkey: r.agentPubkey,
    agentName: r.agentName,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    status: r.status,
    metrics: r.metrics,
    requestSnippet: r.requestMessage?.body?.text?.slice(0, 100),
    responseSnippet: r.principalMessage?.body?.text?.slice(0, 100),
  }));
}

export function getRunDetails(
  channelId: string,
  runId: string
): AgentRunRecord | null {
  const runMap = channelRunRecords.get(channelId);
  if (!runMap) return null;
  return runMap.get(runId) || null;
}

export function mapRelayMessageToNostrEvent(
  msg: any,
  runRecord?: AgentRunRecord
): RelayEvent {
  const senderId = msg.sender?.id || "human:operator";
  const authorPubkey = registerProfile(
    senderId,
    msg.sender?.displayName,
    msg.sender?.kind === "agent"
  );

  let content = msg.body?.text ?? "";
  if (!content && msg.agentDetail?.card) {
    const card = msg.agentDetail.card;
    content = `> **[${card.kind ?? "agent"}] ${card.title ?? ""}**\n\n${card.content ?? ""}`;
  }

  const createdAtSec = Math.floor(new Date(msg.createdAt).getTime() / 1000);
  const tags: string[][] = [
    ["h", msg.channelId],
    ["p", authorPubkey],
  ];
  if (msg.threadId) {
    tags.push(["e", stringToPubkey(msg.threadId), "", "root"]);
  }
  if (msg.parentMessageId) {
    tags.push(["e", stringToPubkey(msg.parentMessageId), "", "reply"]);
  }

  if (runRecord) {
    tags.push(["run_id", runRecord.runId]);
    tags.push(["run_duration", runRecord.metrics.durationLabel]);
    tags.push(["tool_call_count", String(runRecord.metrics.toolCallCount)]);
    tags.push(["files_touched_count", String(runRecord.metrics.filesTouchedCount)]);
    tags.push(["pending_approval", runRecord.metrics.pendingApproval ? "1" : "0"]);
    tags.push(["run_status", runRecord.status]);
  }

  const kind = msg.kind === "system" ? 40099 : 9;
  const eventId = stringToPubkey(msg.id);

  return {
    id: eventId,
    pubkey: authorPubkey,
    created_at: createdAtSec,
    kind,
    tags,
    content,
    sig: "00".repeat(64),
  };
}

// WebSocket connection management for live updates
type WsHandler = (messages: Array<{ type: string; data?: string }>) => void;

function resolveWsHandler(handler: any): WsHandler {
  if (typeof handler === "function") {
    return (msgs) => handler(msgs);
  }
  if (handler && typeof handler.send === "function") {
    return (msgs) => handler.send(msgs);
  }
  if (handler && typeof handler.onmessage === "function") {
    return (msgs) => handler.onmessage(msgs);
  }
  return () => {};
}

function sendWsFrame(handler: WsHandler, data: unknown[]) {
  handler([{ type: "Text", data: JSON.stringify(data) }]);
}

interface ActiveWsConnection {
  wsId: number;
  handler: WsHandler;
  activeSubs: Map<string, { kinds?: number[]; "#h"?: string[]; since?: number }>;
  channelSockets: Map<string, WebSocket>;
}

const activeWsConnections = new Map<number, ActiveWsConnection>();
let nextWsId = 1000;

function connectChannelWs(conn: ActiveWsConnection, channelId: string) {
  if (conn.channelSockets.has(channelId)) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/channels/${encodeURIComponent(channelId)}`;
  
  console.log(`[RelayBridge] Connecting live WS for channel: ${channelId} at ${wsUrl}`);
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log(`[RelayBridge] Live WS connected for ${channelId}`);
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      console.log(`[RelayBridge] WS event on ${channelId}:`, data.type);
      if (data.type === "channel-message-created-v1" || data.type === "channel-message-updated-v1") {
        const msg = data.message as ChannelMessage;
        if (!msg) return;

        // Update raw messages cache
        const existing = channelRawMessages.get(channelId) || [];
        const idx = existing.findIndex((m) => m.id === msg.id);
        if (idx >= 0) {
          existing[idx] = msg;
        } else {
          existing.push(msg);
        }
        channelRawMessages.set(channelId, existing);

        // Rebuild runs
        const runMap = rebuildChannelRuns(channelId, existing);

        // Only dispatch to room timeline if it's principal prose
        if (channelMessageIsPrincipalProse(msg)) {
          let runRecord: AgentRunRecord | undefined;
          if (msg.sender?.kind === "agent") {
            const runId =
              msg.asyncRun?.runId ||
              (msg.source?.turnId ? runMap.get(msg.source.turnId)?.runId : undefined);
            if (runId) {
              runRecord = runMap.get(runId);
            } else {
              runRecord = runMap.get(`chrun:single-${msg.id}`);
            }
          }
          const relayEvent = mapRelayMessageToNostrEvent(msg, runRecord);
          // Find matching subscriptions
          for (const [subId, filter] of conn.activeSubs.entries()) {
            const filterChannels = filter["#h"];
            if (!filterChannels || filterChannels.includes(channelId)) {
              console.log(`[RelayBridge] Dispatching live EVENT to sub ${subId}:`, relayEvent.id);
              sendWsFrame(conn.handler, ["EVENT", subId, relayEvent]);
            }
          }
        } else {
          console.log(
            `[RelayBridge] Suppressed detail message from room altitude:`,
            msg.id,
            msg.agentDetail?.card?.kind
          );
        }
      }
    } catch (err) {
      console.error("[RelayBridge] Error processing channel WS message:", err);
    }
  };

  ws.onerror = (err) => {
    console.warn(`[RelayBridge] Live WS error for ${channelId}:`, err);
  };

  ws.onclose = () => {
    console.log(`[RelayBridge] Live WS closed for ${channelId}`);
    conn.channelSockets.delete(channelId);
  };

  conn.channelSockets.set(channelId, ws);
}

// Cached channels
let cachedChannels: RawChannel[] = [];
let cachedLastMessages: Record<string, string> = {};

export async function fetchAgentProfilesFromRelay(): Promise<void> {
  try {
    const res = await fetch("/agent-profiles", {
      headers: { "x-relay-capabilities": CAPABILITIES_HEADER },
      credentials: "include",
    });
    if (res.ok) {
      const data = await res.json();
      const profiles = data.profiles || [];
      for (const p of profiles) {
        const displayName =
          p.displayName ||
          (p.providerId
            ? p.providerId.charAt(0).toUpperCase() + p.providerId.slice(1)
            : p.id);
        registerProfile(p.id, displayName, true);
      }
    }
  } catch (err) {
    console.warn("[RelayBridge] Error fetching agent profiles:", err);
  }
}

export async function fetchChannelRoster(channelId: string): Promise<ProfileInfo[]> {
  try {
    const res = await fetch(`/channels/${encodeURIComponent(channelId)}/roster`, {
      headers: { "x-relay-capabilities": CAPABILITIES_HEADER },
      credentials: "include",
    });
    if (res.ok) {
      const data = await res.json();
      const roster = data.roster || [];
      const registered: ProfileInfo[] = [];
      for (const item of roster) {
        const pubkey = registerProfile(item.id, item.displayName, true);
        const info = profileRegistry.get(pubkey);
        if (info) registered.push(info);
      }
      return registered;
    }
  } catch (err) {
    console.warn(`[RelayBridge] Error fetching roster for ${channelId}:`, err);
  }
  return [];
}

export async function authenticateRelay(hubUrl?: string, pin = "4242"): Promise<boolean> {
  try {
    const endpoint = hubUrl ? `${hubUrl.replace(/\/$/, "")}/auth` : "/auth";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
      credentials: "include",
    });
    console.log("[RelayBridge] Authenticated with Relay:", res.status);
    if (res.ok) {
      await fetchAgentProfilesFromRelay();
      return true;
    }
    return false;
  } catch (err) {
    console.error("[RelayBridge] Auth failed:", err);
    return false;
  }
}

export async function fetchChannelsFromRelay(): Promise<{ channels: RawChannel[]; lastMessages: Record<string, string> }> {
  try {
    await fetchAgentProfilesFromRelay();
    const res = await fetch("/channels", {
      headers: { "x-relay-capabilities": CAPABILITIES_HEADER },
      credentials: "include",
    });
    if (!res.ok) {
      console.error("[RelayBridge] Failed to fetch channels:", res.status, await res.text());
      return { channels: cachedChannels, lastMessages: cachedLastMessages };
    }
    const data = await res.json();
    const channelList = Array.isArray(data) ? data : (data.channels || []);
    const rawChannels = channelList.map(mapRelayChannelToRawChannel);
    const lastMessages: Record<string, string> = {};
    for (const ch of channelList) {
      if (ch.lastMessage?.createdAt) {
        lastMessages[ch.id] = ch.lastMessage.createdAt;
      }
      // Pre-fetch roster for known channels
      if (ch.id) {
        void fetchChannelRoster(ch.id);
      }
    }
    cachedChannels = rawChannels;
    cachedLastMessages = lastMessages;
    return { channels: rawChannels, lastMessages };
  } catch (err) {
    console.error("[RelayBridge] Error fetching channels:", err);
    return { channels: cachedChannels, lastMessages: cachedLastMessages };
  }
}

export async function fetchMessagesFromRelay(channelId: string): Promise<RelayEvent[]> {
  try {
    const res = await fetch(`/channels/${encodeURIComponent(channelId)}/messages?limit=500`, {
      headers: { "x-relay-capabilities": CAPABILITIES_HEADER },
      credentials: "include",
    });
    if (!res.ok) {
      console.error("[RelayBridge] Failed to fetch messages for", channelId, res.status);
      return [];
    }
    const data = await res.json();
    const rawList: ChannelMessage[] = Array.isArray(data) ? data : (data.messages || []);
    channelRawMessages.set(channelId, rawList);

    const runMap = rebuildChannelRuns(channelId, rawList);

    // Filter to only principal prose messages for room altitude
    const filteredEvents: RelayEvent[] = [];
    for (const msg of rawList) {
      if (!channelMessageIsPrincipalProse(msg)) {
        continue;
      }
      let runRecord: AgentRunRecord | undefined;
      if (msg.sender?.kind === "agent") {
        const runId =
          msg.asyncRun?.runId ||
          (msg.source?.turnId ? runMap.get(msg.source.turnId)?.runId : undefined);
        if (runId) {
          runRecord = runMap.get(runId);
        } else {
          runRecord = runMap.get(`chrun:single-${msg.id}`);
        }
      }
      filteredEvents.push(mapRelayMessageToNostrEvent(msg, runRecord));
    }
    return filteredEvents;
  } catch (err) {
    console.error("[RelayBridge] Error fetching messages:", err);
    return [];
  }
}

export async function postMessageToRelay(channelId: string, text: string): Promise<any> {
  const res = await fetch(`/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-relay-capabilities": CAPABILITIES_HEADER,
    },
    body: JSON.stringify({ text }),
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

export function installRelayBridge(): void {
  console.log("[RelayBridge] Installing Relay bridge mockIPC...");
  mockWindows("main");

  mockIPC(async (command: string, payload: any) => {
    switch (command) {
      case "get_identity":
        return {
          pubkey: OPERATOR_PUBKEY,
          display_name: "Operator",
          storage: "keychain",
        };

      case "get_nsec":
        return "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9u3y9e";

      case "get_profile":
        return {
          pubkey: OPERATOR_PUBKEY,
          display_name: "Operator",
          avatar_url: null,
          about: "Relay Hub Operator",
          nip05_handle: null,
          owner_pubkey: null,
          has_profile_event: true,
        };

      case "get_user_profile": {
        const pk = payload?.pubkey || OPERATOR_PUBKEY;
        const profile = profileRegistry.get(pk);
        return {
          pubkey: pk,
          display_name: profile?.displayName ?? "Agent",
          avatar_url: profile?.avatarUrl ?? null,
          about: null,
          nip05_handle: null,
          owner_pubkey: null,
          has_profile_event: true,
        };
      }

      case "get_users_batch": {
        const pubkeys: string[] = payload?.pubkeys || [];
        const profiles: Record<string, any> = {};
        for (const pk of pubkeys) {
          const p = profileRegistry.get(pk);
          profiles[pk] = {
            display_name: p?.displayName ?? "Agent",
            name: p?.name ?? "Agent",
            avatar_url: p?.avatarUrl ?? null,
            nip05_handle: null,
            owner_pubkey: null,
            is_agent: p?.isAgent ?? false,
          };
        }
        return { profiles, missing: [] };
      }

      case "search_users": {
        const query = (payload?.query || "").toLowerCase();
        const matches = Array.from(profileRegistry.values())
          .filter(
            (p) =>
              p.displayName.toLowerCase().includes(query) ||
              p.name.toLowerCase().includes(query)
          )
          .map((p) => ({
            pubkey: p.pubkey,
            display_name: p.displayName,
            name: p.name,
            avatar_url: p.avatarUrl,
            nip05_handle: null,
            owner_pubkey: null,
            is_agent: p.isAgent,
          }));
        return { users: matches, next_cursor: null };
      }

      case "get_channels": {
        const { channels, lastMessages } = await fetchChannelsFromRelay();
        return {
          hash: "h-" + Date.now(),
          channels,
          last_messages: lastMessages,
        };
      }

      case "get_open_channel_directory": {
        const { channels } = await fetchChannelsFromRelay();
        return channels;
      }

      case "get_channel_details": {
        const channelId = payload?.channelId;
        const channel = cachedChannels.find((c) => c.id === channelId);
        const detail: RawChannelDetail = channel
          ? {
              ...channel,
              created_by: OPERATOR_PUBKEY,
              created_at: new Date(0).toISOString(),
              updated_at: new Date().toISOString(),
              topic_set_by: null,
              topic_set_at: null,
              purpose_set_by: null,
              purpose_set_at: null,
              topic_required: false,
              max_members: null,
              nip29_group_id: null,
            }
          : {
              id: channelId,
              name: channelId,
              channel_type: "stream",
              visibility: "open",
              description: "",
              topic: null,
              purpose: null,
              member_count: 1,
              member_pubkeys: [OPERATOR_PUBKEY],
              last_message_at: null,
              archived_at: null,
              participants: ["Operator"],
              participant_pubkeys: [OPERATOR_PUBKEY],
              is_member: true,
              ttl_seconds: null,
              ttl_deadline: null,
              created_by: OPERATOR_PUBKEY,
              created_at: new Date(0).toISOString(),
              updated_at: new Date().toISOString(),
              topic_set_by: null,
              topic_set_at: null,
              purpose_set_by: null,
              purpose_set_at: null,
              topic_required: false,
              max_members: null,
              nip29_group_id: null,
            };
        return detail;
      }

      case "get_channel_window": {
        const channelId = payload?.channelId;
        const cursor = payload?.cursor;
        const events = await fetchMessagesFromRelay(channelId);
        const sortedEvents = [...events].sort((a, b) =>
          a.created_at !== b.created_at
            ? b.created_at - a.created_at
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0
        );
        const cursorCreatedAt = cursor?.created_at ?? cursor?.createdAt;
        const cursorEventId = cursor?.event_id ?? cursor?.eventId;
        const suffix = cursor && cursorCreatedAt != null && cursorEventId
          ? `${cursorCreatedAt}:${cursorEventId.toLowerCase()}`
          : "head";
        const boundsKey = `${channelId.toLowerCase()}:${suffix}`;
        const boundsEvent: RelayEvent = {
          id: stringToPubkey(`bounds-${boundsKey}`),
          pubkey: OPERATOR_PUBKEY,
          created_at: Math.floor(Date.now() / 1000),
          kind: 39006, // KIND_CHANNEL_WINDOW_BOUNDS
          tags: [["d", boundsKey]],
          content: JSON.stringify({ has_more: false, next_cursor: null }),
          sig: "00".repeat(64),
        };
        return [...sortedEvents, boundsEvent];
      }

      case "get_channel_messages_before": {
        const channelId = payload?.channelId;
        const events = await fetchMessagesFromRelay(channelId);
        const sortedEvents = [...events].sort((a, b) =>
          a.created_at !== b.created_at
            ? b.created_at - a.created_at
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0
        );
        return {
          events: sortedEvents,
          next_cursor: null,
        };
      }

      case "get_agent_runs": {
        const channelId = payload?.channelId;
        const agentPubkey = payload?.agentPubkey;
        if (channelId && !channelRunRecords.has(channelId)) {
          await fetchMessagesFromRelay(channelId);
        }
        const runs = getAgentRunsForChannel(channelId, agentPubkey);
        return { runs };
      }

      case "get_run_details": {
        const channelId = payload?.channelId;
        const runId = payload?.runId;
        if (channelId && !channelRunRecords.has(channelId)) {
          await fetchMessagesFromRelay(channelId);
        }
        const details = getRunDetails(channelId, runId);
        return details;
      }

      case "get_run_rows": {
        const channelId = payload?.channelId;
        const runId = payload?.runId;
        if (channelId && !channelRunRecords.has(channelId)) {
          await fetchMessagesFromRelay(channelId);
        }
        const details = getRunDetails(channelId, runId);
        return { messages: details?.messages || [] };
      }

      case "nip44_encrypt_to_self":
        return payload?.plaintext ?? "";
      case "nip44_decrypt_from_self":
        return payload?.ciphertext ?? "";
      case "unread_catch_up":
        return { channels: [] };

      case "get_channel_members": {
        const channelId = payload?.channelId;
        if (channelId) {
          try {
            await fetchChannelRoster(channelId);
          } catch {
            // ignore
          }
        }
        const channel = cachedChannels.find((c) => c.id === channelId);
        const memberPubkeys = new Set<string>(channel?.member_pubkeys || [OPERATOR_PUBKEY]);
        for (const p of profileRegistry.values()) {
          if (p.isAgent) {
            memberPubkeys.add(p.pubkey);
          }
        }
        return {
          members: Array.from(memberPubkeys).map((pk) => {
            const p = profileRegistry.get(pk);
            return {
              pubkey: pk,
              role: pk === OPERATOR_PUBKEY ? "owner" : (p?.isAgent ? "bot" : "member"),
              is_agent: p?.isAgent ?? false,
              joined_at: new Date(0).toISOString(),
              display_name: p?.displayName ?? (pk === OPERATOR_PUBKEY ? "Operator" : "Agent"),
            };
          }),
          next_cursor: null,
        };
      }

      case "send_channel_message": {
        const { channelId, content, parentEventId, rootEventId } = payload;
        const msg = await postMessageToRelay(channelId, content);
        const relayEvent = mapRelayMessageToNostrEvent(msg);

        // Update cache
        const existing = channelRawMessages.get(channelId) || [];
        existing.push(msg);
        channelRawMessages.set(channelId, existing);
        rebuildChannelRuns(channelId, existing);

        // Notify active websocket subscriptions
        for (const conn of activeWsConnections.values()) {
          for (const [subId, filter] of conn.activeSubs.entries()) {
            const filterChannels = filter["#h"];
            if (!filterChannels || filterChannels.includes(channelId)) {
              sendWsFrame(conn.handler, ["EVENT", subId, relayEvent]);
            }
          }
        }

        return {
          event_id: relayEvent.id,
          parent_event_id: parentEventId ?? null,
          root_event_id: rootEventId ?? null,
          depth: 0,
          created_at: relayEvent.created_at,
        };
      }

      case "sign_event": {
        const ev = payload;
        const id = stringToPubkey(JSON.stringify(ev) + Date.now());
        return JSON.stringify({
          id,
          pubkey: OPERATOR_PUBKEY,
          created_at: ev.createdAt ?? Math.floor(Date.now() / 1000),
          kind: ev.kind,
          tags: ev.tags ?? [],
          content: ev.content ?? "",
          sig: "00".repeat(64),
        });
      }

      case "create_auth_event": {
        const id = stringToPubkey("auth-" + Date.now());
        return JSON.stringify({
          id,
          pubkey: OPERATOR_PUBKEY,
          created_at: Math.floor(Date.now() / 1000),
          kind: 22242,
          tags: [
            ["relay", payload.relayUrl],
            ["challenge", payload.challenge],
          ],
          content: "",
          sig: "00".repeat(64),
        });
      }

      case "get_presence": {
        const pubkeys: string[] = payload?.pubkeys || [];
        const presence: Record<string, string> = {};
        for (const pk of pubkeys) {
          presence[pk] = "online";
        }
        return presence;
      }

      case "get_relay_self":
        return OPERATOR_PUBKEY;

      case "get_relay_ws_url":
        return `ws://${window.location.host}/ws`;

      case "plugin:websocket|connect": {
        const wsId = ++nextWsId;
        const handler = resolveWsHandler(payload.onMessage);
        const conn: ActiveWsConnection = {
          wsId,
          handler,
          activeSubs: new Map(),
          channelSockets: new Map(),
        };
        activeWsConnections.set(wsId, conn);
        console.log("[RelayBridge] plugin:websocket|connect wsId:", wsId);
        setTimeout(() => {
          sendWsFrame(handler, ["AUTH", `relay-challenge-${wsId}`]);
        }, 10);
        return wsId;
      }

      case "plugin:websocket|send": {
        const { id, message } = payload as {
          id: number;
          message: { type: string; data: string };
        };
        const conn = activeWsConnections.get(id);
        if (!conn) {
          console.warn("[RelayBridge] Unknown ws id:", id);
          return null;
        }
        if (message.type === "Text") {
          try {
            const parsed = JSON.parse(message.data);
            const [verb, subId, filter] = parsed;
            if (verb === "AUTH") {
              sendWsFrame(conn.handler, ["OK", parsed[1]?.id || "auth", true, ""]);
            } else if (verb === "REQ") {
              console.log("[RelayBridge] REQ subId:", subId, filter);
              conn.activeSubs.set(subId, filter);
              const channelIds = filter?.["#h"] || [];
              for (const chId of channelIds) {
                connectChannelWs(conn, chId);
              }
              // Immediately send EOSE
              sendWsFrame(conn.handler, ["EOSE", subId]);
            } else if (verb === "CLOSE") {
              conn.activeSubs.delete(subId);
            } else if (verb === "EVENT") {
              sendWsFrame(conn.handler, ["OK", parsed[1]?.id || "", true, ""]);
            }
          } catch (e) {
            console.error("[RelayBridge] Failed to parse websocket message:", e);
          }
        }
        return null;
      }

      case "plugin:websocket|disconnect": {
        const { id } = payload as { id: number };
        const conn = activeWsConnections.get(id);
        if (conn) {
          for (const ws of conn.channelSockets.values()) {
            ws.close();
          }
          activeWsConnections.delete(id);
        }
        return null;
      }

      case "plugin:websocket|disconnect_all": {
        for (const conn of activeWsConnections.values()) {
          for (const ws of conn.channelSockets.values()) {
            ws.close();
          }
        }
        activeWsConnections.clear();
        return null;
      }

      case "apply_workspace":
        return null;
      case "is_shared_identity":
        return false;
      case "get_relay_http_url":
        return `http://${window.location.host}`;
      case "get_media_proxy_port":
        return null;
      case "resolve_persisted_identity":
        return { pubkey: OPERATOR_PUBKEY, display_name: "Operator" };
      case "get_default_relay_url":
        return `ws://${window.location.host}/ws`;
      case "auto_connect_default_relay_enabled":
        return true;

      case "ensure_starter_channels": {
        const { channels } = await fetchChannelsFromRelay();
        return channels;
      }
      case "take_pending_navigation_deep_link":
      case "take_pending_entity_deep_link":
        return null;
      case "discover_acp_providers":
        return [];
      case "get_agent_models":
        return { models: [] };
      case "fetch_acp_runtime_catalog":
        return [];
      case "list_personas":
        return [];
      case "list_teams":
        return [];
      case "announce_archive_sync_epoch":
        return Date.now();
      case "start_archive_sync":
      case "merge_save_subscription_kinds":
        return null;
      case "get_os_idle_seconds":
        return 0;
      case "get_huddle_state":
        return null;
      case "relay_requires_membership":
        return false;
      case "get_global_agent_config":
        return {};
      case "create_channel": {
        const id = "topic:" + Date.now();
        const ch: RawChannel = {
          id,
          name: payload?.name || id,
          channel_type: payload?.channelType || "stream",
          visibility: payload?.visibility || "open",
          description: payload?.description || "",
          topic: null,
          purpose: null,
          member_count: 1,
          member_pubkeys: [OPERATOR_PUBKEY],
          last_message_at: null,
          archived_at: null,
          participants: ["Operator"],
          participant_pubkeys: [OPERATOR_PUBKEY],
          is_member: true,
          ttl_seconds: null,
          ttl_deadline: null,
        };
        cachedChannels.push(ch);
        return ch;
      }

      // Harmless stubs
      case "get_tts_settings":
        return { tts_enabled: false, pocket_voice: null };
      case "list_voice_registry":
        return [];
      case "list_channel_templates":
        return [];
      case "agent_access_owner_only":
        return false;
      case "observer_archive_default_enabled":
        return false;
      case "agent_metric_archive_default_enabled":
        return false;
      case "is_auto_update_supported":
        return false;
      case "fetch_persona_catalog":
        return [];
      case "fetch_team_catalog":
        return [];
      case "revalidate_relay_agents":
        return payload?.pubkeys || [];
      case "attach_managed_agent_to_channel":
      case "provision_channel_managed_agent":
      case "create_channel_managed_agent":
      case "add_channel_members":
      case "remove_channel_member":
      case "start_managed_agent":
      case "stop_managed_agent":
      case "restart_managed_agent":
      case "delete_managed_agent":
      case "channel_head_cache_store":
        return null;
      case "save_relay_last_seen":
        return null;
      case "get_channel_workflows":
      case "get_channels_workflows":
        return [];
      case "list_custom_emoji":
        return [];
      case "get_channel_unread_watermarks":
        return {};
      case "read_all_thread_state":
        return [];
      case "list_managed_agents": {
        const agents: any[] = [];
        for (const p of profileRegistry.values()) {
          if (p.isAgent) {
            agents.push({
              pubkey: p.pubkey,
              name: p.displayName,
              personaId: null,
              runtime: null,
              relayUrl: `ws://${window.location.host}/ws`,
              acpCommand: "",
              agentCommand: "",
              agentCommandOverride: null,
              agentArgs: [],
              mcpCommand: "",
              turnTimeoutSeconds: 300,
              idleTimeoutSeconds: null,
              maxTurnDurationSeconds: null,
              parallelism: 1,
              systemPrompt: null,
              avatarUrl: p.avatarUrl,
              model: null,
              modelSource: null,
              provider: null,
              personaOutOfDate: false,
              personaOrphaned: false,
              needsRestart: false,
              restartDiff: [],
              envVars: {},
              status: "deployed",
              pid: null,
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date().toISOString(),
              lastStartedAt: null,
              lastStoppedAt: null,
              lastExitCode: null,
              lastError: null,
              lastErrorCode: null,
              logPath: "",
              startOnAppLaunch: false,
              autoRestartOnConfigChange: false,
              backend: { type: "local" },
              backendAgentId: null,
              respondTo: "anyone",
              respondToAllowlist: [],
            });
          }
        }
        return agents;
      }
      case "list_relay_agents": {
        const allChannelIds = cachedChannels.map((c) => c.id);
        const agents: any[] = [];
        for (const p of profileRegistry.values()) {
          if (p.isAgent) {
            agents.push({
              pubkey: p.pubkey,
              ownerPubkey: null,
              name: p.displayName,
              agentType: "relay",
              channels: allChannelIds,
              channelIds: allChannelIds,
              capabilities: [],
              status: "online",
              respondTo: "anyone",
              respondToAllowlist: [],
            });
          }
        }
        return agents;
      }
      case "get_home_feed":
        return {
          feed: {
            mentions: [],
            needs_action: [],
            activity: [],
            agent_activity: [],
          },
          meta: { since: 0, total: 0, generated_at: Date.now() },
        };
      case "get_feed":
        return {
          feed: {
            mentions: [],
            needs_action: [],
            activity: [],
            agent_activity: [],
          },
          meta: { since: 0, total: 0, generated_at: Date.now() },
        };
      case "plugin:window|show":
      case "plugin:window|unminimize":
      case "plugin:window|set_focus":
      case "plugin:window|set_badge_count":
      case "plugin:window|set_badge_label":
      case "plugin:opener|open_url":
      case "plugin:updater|check":
        return null;

      default:
        console.warn(`[RelayBridge] Unhandled command: ${command}`, payload);
        return null;
    }
  }, { shouldMockEvents: true });
}

