import React from 'react';
import type { AgentProviderExtensionItemV2 } from '../../../../../shared/agent-chat-protocol-v2.js';
import { EnterPlanModeCard } from './claude/EnterPlanModeCard.js';
import { FastModeUnavailableCard } from './claude/FastModeUnavailableCard.js';
import { registerCodexRenderers } from './codex/index.js';

type ExtensionRenderer = (
  item: AgentProviderExtensionItemV2
) => React.ReactNode;

const registry = new Map<string, ExtensionRenderer>();

function payloadKind(item: AgentProviderExtensionItemV2): string {
  const { kind, subtype, type } = item.payload;
  if (typeof kind === 'string' && kind.length > 0) return kind;
  if (typeof subtype === 'string' && subtype.length > 0) return subtype;
  if (typeof type === 'string' && type.length > 0) return type;
  return 'unknown';
}

export function registerProviderExtensionRenderer(
  namespace: string,
  renderer: ExtensionRenderer
): void {
  registry.set(namespace, renderer);
}

export function renderProviderExtension(
  item: AgentProviderExtensionItemV2
): React.ReactNode {
  return (registry.get(item.namespace) ?? renderFallback)(item);
}

function renderFallback(item: AgentProviderExtensionItemV2): React.ReactNode {
  return (
    <details
      className="provider-extension"
      aria-label={`${item.namespace} extension`}
    >
      <summary className="provider-extension__h">
        {item.namespace}.{payloadKind(item)}
      </summary>
      <pre>{JSON.stringify(item.payload, null, 2)}</pre>
    </details>
  );
}

registerProviderExtensionRenderer('claude', (item) => {
  const kind = payloadKind(item).toLowerCase();
  if (kind === 'enterplanmode' || kind === 'enter_plan_mode') {
    return <EnterPlanModeCard item={item} />;
  }
  if (kind === 'fastmodeunavailable' || kind === 'fast_mode_unavailable') {
    return <FastModeUnavailableCard item={item} />;
  }
  return renderFallback(item);
});

registerCodexRenderers();
