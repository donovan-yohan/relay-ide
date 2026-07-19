import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelMessageId } from '../../shared/channel-chat-protocol.js';
import './App.css';
import './test-channel-thread.css';
import { ChannelView } from './components/chat/ChannelView.js';
import { useUiStore } from './lib/stores/ui.js';

const channelId = new URLSearchParams(window.location.search).get('channelId');
const initialThreadRootId = new URLSearchParams(window.location.search).get(
  'threadRootId'
) as ChannelMessageId | null;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 0 },
  },
});

function Fixture(): React.ReactElement {
  useEffect(() => {
    useUiStore.getState().setActiveThreadRootId(initialThreadRootId);
    return () => useUiStore.getState().setActiveThreadRootId(null);
  }, []);
  if (!channelId) return <div role="alert">missing channelId</div>;
  return (
    <QueryClientProvider client={queryClient}>
      <div className="ch-thread-fixture">
        <ChannelView channelId={channelId} />
      </div>
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(<Fixture />);
