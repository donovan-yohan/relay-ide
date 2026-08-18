import { describe, expect, it } from 'vitest';
import { resolvedChannelSearchAlias } from '../../frontend/src/lib/stores/channel-search-panel.js';

describe('channel search trigger alias', () => {
  it('uses only resolved human metadata and never the opaque channel id fallback', () => {
    expect(resolvedChannelSearchAlias(undefined, undefined)).toBeNull();
    expect(resolvedChannelSearchAlias('', '')).toBeNull();
    expect(resolvedChannelSearchAlias(undefined, 'release notes')).toBe(
      'release notes'
    );
    expect(resolvedChannelSearchAlias('live title', 'topic title')).toBe(
      'live title'
    );
  });
});
