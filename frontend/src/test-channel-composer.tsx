import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './App.css';
import './test-channel-composer.css';
import { ChannelComposer } from './components/chat/ChannelComposer.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Fixture(): React.ReactElement {
  return (
    <div className="ch-main ch-composer-fixture">
      <div className="ch-composer-fixture__timeline" data-testid="timeline">
        timeline
      </div>
      <ChannelComposer
        channelId="topic:composer-fixture"
        channelTitle="composer-fixture"
        members={[
          {
            kind: 'human',
            id: 'human:operator',
            joinedAt: '2026-08-07T00:00:00.000Z',
          },
        ]}
        onSend={() => Promise.resolve()}
        postPending={false}
        storeDown={false}
        archived={false}
        onRestore={() => {}}
        restorePending={false}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>
);
