import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatChannelSearchScope,
  useChannelSearchPanelStore,
} from '../../frontend/src/lib/stores/channel-search-panel.js';

beforeEach(() => {
  useChannelSearchPanelStore.setState({
    open: false,
    query: '',
    autoSeeded: true,
    seedPrefix: '',
    boundChannelId: null,
  });
});

describe('channel search panel state', () => {
  it('formats human aliases and scopes a fresh search to the active channel', () => {
    expect(formatChannelSearchScope('relay-ide')).toBe('in:relay-ide ');
    expect(formatChannelSearchScope('Release Notes')).toBe(
      'in:"Release Notes" '
    );

    useChannelSearchPanelStore
      .getState()
      .openForAlias('Release Notes', 'topic:release');
    expect(useChannelSearchPanelStore.getState()).toMatchObject({
      open: true,
      query: 'in:"Release Notes" ',
      seedPrefix: 'in:"Release Notes" ',
      autoSeeded: true,
      boundChannelId: 'topic:release',
    });
  });

  it('keeps the exact channel binding while terms are appended', () => {
    const store = useChannelSearchPanelStore.getState();
    store.openForAlias('relay-ide', 'topic:relay');
    useChannelSearchPanelStore
      .getState()
      .setQuery('in:relay-ide pagination anchor');

    expect(useChannelSearchPanelStore.getState()).toMatchObject({
      autoSeeded: true,
      seedPrefix: 'in:relay-ide ',
      boundChannelId: 'topic:relay',
    });
  });

  it('drops the hidden channel binding when the generated scope is edited', () => {
    useChannelSearchPanelStore
      .getState()
      .openForAlias('relay-ide', 'topic:relay');
    useChannelSearchPanelStore
      .getState()
      .setQuery('in:another-project pagination');

    expect(useChannelSearchPanelStore.getState()).toMatchObject({
      autoSeeded: false,
      seedPrefix: '',
      boundChannelId: null,
    });
  });

  it('preserves edits during an open search and reseeds after close', () => {
    useChannelSearchPanelStore
      .getState()
      .openForAlias('first chat', 'topic:first');
    useChannelSearchPanelStore.getState().setQuery('in:"first chat" anchor');
    useChannelSearchPanelStore
      .getState()
      .openForAlias('second chat', 'topic:second');
    expect(useChannelSearchPanelStore.getState().query).toBe(
      'in:"first chat" anchor'
    );

    useChannelSearchPanelStore.getState().close();
    useChannelSearchPanelStore
      .getState()
      .openForAlias('second chat', 'topic:second');
    expect(useChannelSearchPanelStore.getState()).toMatchObject({
      query: 'in:"second chat" ',
      boundChannelId: 'topic:second',
    });
  });
});
