import React, { useCallback, useState } from 'react';
import ReactDOM from 'react-dom/client';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';
import './App.css';
import './components/chat/ChannelView.css';
import './test-channel-timeline.css';
import { ChannelTimeline } from './components/chat/ChannelTimeline.js';

function message(
  seq: number,
  text = `timeline row ${seq}`,
  sender: ChannelMessage['sender'] = seq % 2 === 0
    ? { kind: 'human', id: 'human:operator' }
    : { kind: 'agent', id: 'agent-profile:codex:default', providerId: 'codex' }
): ChannelMessage {
  const createdAt = new Date(Date.UTC(2026, 6, 18, 10, seq)).toISOString();
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId: 'topic:scroll-fixture',
    seq,
    kind: 'message',
    status: 'complete',
    sender,
    body: { text, format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function truncatedMessage(seq: number): ChannelMessage {
  return {
    ...message(seq, 'partial terminal report'),
    status: 'truncated',
    meta: { truncationReason: 'missing-terminal' },
  };
}

function detailMessage(
  seq: number,
  card: NonNullable<ChannelMessage['agentDetail']>['card']
): ChannelMessage {
  return {
    ...message(seq, '', {
      kind: 'agent',
      id: 'agent-profile:codex:default',
      providerId: 'codex',
    }),
    agentDetail: { itemId: `detail-${seq}`, card },
  };
}

const LARGE_OUTPUT = Array.from(
  { length: 500 },
  (_, index) => `const fixtureLine${index + 1} = ${index + 1};`
).join('\n');
const LARGE_DIFF = [
  '--- a/frontend/src/channel-card.ts',
  '+++ b/frontend/src/channel-card.ts',
  '@@ -1,250 +1,250 @@',
  ...Array.from({ length: 250 }, (_, index) => `-old line ${index + 1}`),
  ...Array.from({ length: 250 }, (_, index) => `+new line ${index + 1}`),
].join('\n');

const INITIAL_MESSAGES = [
  ...Array.from({ length: 47 }, (_, index) => message(index + 21)),
  detailMessage(68, {
    kind: 'thought',
    title: 'inspect the channel renderer',
    status: 'completed',
    content: 'reasoning content persisted on the durable channel row',
  }),
  detailMessage(69, {
    kind: 'output',
    title: 'generate fixture output',
    status: 'completed',
    content: LARGE_OUTPUT,
    language: 'typescript',
    sizeBytes: new TextEncoder().encode(LARGE_OUTPUT).byteLength,
  }),
  detailMessage(70, {
    kind: 'diff',
    title: 'frontend/src/channel-card.ts',
    path: 'frontend/src/channel-card.ts',
    status: 'completed',
    content: LARGE_DIFF,
    language: 'diff',
    additions: 250,
    deletions: 250,
    sizeBytes: new TextEncoder().encode(LARGE_DIFF).byteLength,
  }),
];

function Fixture(): React.ReactElement {
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [fullSnapshotRevision, setFullSnapshotRevision] = useState(0);

  const append = useCallback((count: number, large = false) => {
    setMessages((current) => {
      const latest = current[current.length - 1]?.seq ?? 0;
      return [
        ...current,
        ...Array.from({ length: count }, (_, index) => {
          const seq = latest + index + 1;
          const text = large
            ? `oversized row ${seq}\n${'large append content\n'.repeat(80)}`
            : `incoming row ${seq}`;
          return message(seq, text);
        }),
      ];
    });
  }, []);

  const appendOwn = useCallback(() => {
    setMessages((current) => {
      const seq = (current[current.length - 1]?.seq ?? 0) + 1;
      return [
        ...current,
        {
          ...message(seq, 'did we open a PR?', {
            kind: 'human',
            id: 'human:operator',
          }),
          // This is intentionally markdown: MessageBody introduces the
          // cursor wrapper on this live path, which used to shrink user bubbles
          // down to their min-content width.
          body: { text: 'did we open a PR?', format: 'markdown' },
        },
      ];
    });
  }, []);

  const appendOwnLongToken = useCallback(() => {
    setMessages((current) => {
      const seq = (current[current.length - 1]?.seq ?? 0) + 1;
      return [
        {
          ...message(
            seq,
            'https://relay.example.dev/recover/conversation/this-token-must-wrap-without-overflowing-the-mobile-timeline',
            { kind: 'human', id: 'human:operator' }
          ),
          body: {
            text: 'https://relay.example.dev/recover/conversation/this-token-must-wrap-without-overflowing-the-mobile-timeline',
            format: 'markdown',
          },
        },
      ];
    });
  }, []);

  const appendTruncated = useCallback(() => {
    setMessages((current) => {
      const seq = (current[current.length - 1]?.seq ?? 0) + 1;
      return [...current, truncatedMessage(seq)];
    });
  }, []);

  const replaceSnapshot = useCallback((anchorSurvives: boolean) => {
    setMessages(
      anchorSurvives
        ? Array.from({ length: 530 }, (_, index) => message(index + 41))
        : Array.from({ length: 50 }, (_, index) => message(index + 600))
    );
    setHasMoreOlder(false);
    setFullSnapshotRevision((revision) => revision + 1);
  }, []);

  const growStream = useCallback(() => {
    setMessages((current) => {
      const last = current[current.length - 1];
      if (!last) return current;
      return [
        ...current.slice(0, -1),
        {
          ...last,
          status: 'streaming',
          body: {
            ...last.body,
            text: `${last.body.text}\n${'stream growth\n'.repeat(60)}`,
          },
        },
      ];
    });
  }, []);

  const applyDetailRowUpdate = useCallback(() => {
    setMessages((current) =>
      current.map((row) =>
        row.seq === 67
          ? {
              ...row,
              status: 'streaming',
              sender: {
                kind: 'agent',
                id: 'agent-profile:codex:default',
                providerId: 'codex',
              },
              body: { text: '', format: 'markdown' },
              agentDetail: {
                itemId: 'reason-live-browser',
                card: {
                  kind: 'thought',
                  title: 'thinking',
                  status: 'running',
                  content: 'authoritative debounced browser row',
                },
              },
            }
          : row
      )
    );
  }, []);

  const loadOlder = useCallback(async () => {
    if (!hasMoreOlder) return;
    setLoadingOlder(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    setMessages((current) => {
      const earliest = current[0]?.seq ?? 21;
      const latest = current[current.length - 1]?.seq ?? 70;
      const older = Array.from({ length: 20 }, (_, index) =>
        message(earliest - 20 + index)
      );
      // Deliberately append a catch-up row in the same commit. A total-height
      // delta anchor would incorrectly include its height and move the reader.
      return [
        ...older,
        ...current,
        message(latest + 1, 'concurrent catch-up', {
          kind: 'agent',
          id: 'agent-profile:codex:default',
          providerId: 'codex',
        }),
      ];
    });
    setHasMoreOlder(false);
    setLoadingOlder(false);
  }, [hasMoreOlder]);

  return (
    <div className="ch-scroll-fixture">
      <div className="ch-scroll-fixture__controls">
        <button data-testid="append-one" onClick={() => append(1)}>
          append one
        </button>
        <button data-testid="append-large" onClick={() => append(1, true)}>
          append large
        </button>
        <button data-testid="append-burst" onClick={() => append(3)}>
          append burst
        </button>
        <button data-testid="append-own" onClick={appendOwn}>
          append own
        </button>
        <button data-testid="append-own-long-token" onClick={appendOwnLongToken}>
          append own long token
        </button>
        <button data-testid="append-truncated" onClick={appendTruncated}>
          append truncated
        </button>
        <button data-testid="grow-stream" onClick={growStream}>
          grow stream
        </button>
        <button data-testid="update-detail-row" onClick={applyDetailRowUpdate}>
          update detail row
        </button>
        <button
          data-testid="snapshot-overlap"
          onClick={() => replaceSnapshot(true)}
        >
          snapshot overlap
        </button>
        <button
          data-testid="snapshot-gap"
          onClick={() => replaceSnapshot(false)}
        >
          snapshot gap
        </button>
      </div>
      <div className="ch-scroll-fixture__stage">
        <ChannelTimeline
          messages={messages}
          lastReadSeq={55}
          channelId="topic:scroll-fixture"
          channelTitle="scroll-fixture"
          hasMoreOlder={hasMoreOlder}
          loadingOlder={loadingOlder}
          loadOlder={loadOlder}
          fullSnapshotRevision={fullSnapshotRevision}
          needsCatchup={false}
          onResync={() => {}}
        />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(<Fixture />);
