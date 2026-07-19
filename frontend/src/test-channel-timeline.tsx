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
    : { kind: 'agent', id: 'agent:codex', providerId: 'codex' }
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

const INITIAL_MESSAGES = Array.from({ length: 50 }, (_, index) =>
  message(index + 21)
);

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
        message(seq, 'my new message', {
          kind: 'human',
          id: 'human:operator',
        }),
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
          id: 'agent:codex',
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
        <button data-testid="append-truncated" onClick={appendTruncated}>
          append truncated
        </button>
        <button data-testid="grow-stream" onClick={growStream}>
          grow stream
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
