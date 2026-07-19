import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import type {
  AgentAssistantMessageItemV2,
  AgentProviderV2,
  AgentSessionV2,
} from '../../shared/agent-chat-protocol-v2.js';
import claudeFixture from '../../test/fixtures/agent-detail/claude.js';
import codexFixture from '../../test/fixtures/agent-detail/codex.js';
import hermesFixture from '../../test/fixtures/agent-detail/hermes.js';
import './App.css';
import './components/chat/ChatView.css';
import './test-agent-detail-rows.css';
import { useAgentTimelineScroll } from './components/chat/ChatView.js';
import { Turn } from './components/chat/Turn.js';

const fixtures = {
  claude: claudeFixture,
  codex: codexFixture,
  hermes: hermesFixture,
} as const;

type FixtureProvider = keyof typeof fixtures;
type FixtureLayout = 'default' | 'card-near-bottom';

function providerFromQuery(): FixtureProvider {
  const raw = new URLSearchParams(window.location.search).get('provider');
  return raw === 'claude' || raw === 'codex' || raw === 'hermes'
    ? raw
    : 'claude';
}

function layoutFromQuery(): FixtureLayout {
  return new URLSearchParams(window.location.search).get('layout') ===
    'card-near-bottom'
    ? 'card-near-bottom'
    : 'default';
}

function anchorItems(provider: AgentProviderV2): AgentAssistantMessageItemV2[] {
  return Array.from({ length: 48 }, (_, index) => ({
    id: `${provider}-anchor-${String(index + 1).padStart(2, '0')}`,
    type: 'assistantMessage',
    status: 'completed',
    text: `synthetic anchor row ${String(index + 1).padStart(2, '0')}`,
  }));
}

function withAnchorRows(
  session: AgentSessionV2,
  layout: FixtureLayout
): AgentSessionV2 {
  const turn = session.turns[0];
  if (!turn) return session;
  const anchors = anchorItems(session.provider);
  const items =
    layout === 'card-near-bottom'
      ? [...anchors.slice(0, 44), ...turn.items, ...anchors.slice(44)]
      : [...turn.items, ...anchors];
  return {
    ...session,
    turns: [
      {
        ...turn,
        items,
      },
    ],
  };
}

function Fixture(): React.ReactElement {
  const [provider, setProvider] = useState(providerFromQuery);
  const layout = layoutFromQuery();
  const session = useMemo(
    () => withAnchorRows(fixtures[provider].session, layout),
    [layout, provider]
  );
  const turn = session.turns[0]!;
  const itemCount = turn.items.length;
  const {
    containerRef,
    contentRef,
    bottomRef,
    handleTimelineScroll,
    prepareUserReflow,
    scrollToBottom,
    showJumpToLatest,
  } = useAgentTimelineScroll({ timelineId: session.id, itemCount });

  return (
    <main
      className="agent-detail-fixture"
      data-fixture-provider={provider}
      data-fixture-layout={layout}
    >
      <div className="agent-detail-fixture__label">
        <span>{provider} · hand-sanitized structural replay</span>
        <span className="agent-detail-fixture__switches">
          {(Object.keys(fixtures) as FixtureProvider[]).map((candidate) => (
            <button
              type="button"
              key={candidate}
              disabled={candidate === provider}
              onClick={() => setProvider(candidate)}
            >
              show {candidate} fixture
            </button>
          ))}
        </span>
      </div>
      <div
        ref={containerRef}
        className="tl"
        role="log"
        aria-label="agent detail timeline"
        onScroll={handleTimelineScroll}
      >
        <div ref={contentRef} className="tl-content">
          <Turn
            turn={turn}
            index={0}
            session={session}
            onApprove={() => {}}
            onAnswer={() => {}}
            onDetailCardToggle={prepareUserReflow}
          />
        </div>
        <div ref={bottomRef} />
      </div>
      {showJumpToLatest ? (
        <button
          type="button"
          className="tl-jump-latest"
          onClick={scrollToBottom}
        >
          jump to latest
        </button>
      ) : null}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(<Fixture />);
