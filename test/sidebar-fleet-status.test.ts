import { describe, expect, it } from 'vitest';
import { deriveSessionFleetStatus } from '../frontend/src/components/RepoItem.js';
import { makeSession } from './helpers/frontend-factories.js';

const activeToolSession = makeSession({
  currentActivity: { tool: 'Bash', detail: 'npm run build' },
});

describe('deriveSessionFleetStatus', () => {
  it('surfaces running current activity as a compact active status', () => {
    expect(deriveSessionFleetStatus('running', [activeToolSession])).toEqual({
      label: 'running · bash: npm run build',
      tone: 'active',
      title: 'fleet status: running · bash: npm run build',
    });
  });

  it('uses explicit waiting labels for approval and answer states', () => {
    expect(deriveSessionFleetStatus('permission', [activeToolSession])).toMatchObject({
      label: 'approval needed',
      tone: 'attention',
    });
    expect(deriveSessionFleetStatus('needs-answer', [activeToolSession])).toMatchObject({
      label: 'answer needed',
      tone: 'attention',
    });
  });

  it('keeps completed unread sessions attention-worthy', () => {
    expect(deriveSessionFleetStatus('unseen-idle', [makeSession()])).toMatchObject({
      label: 'done unread',
      tone: 'attention',
    });
  });

  it('normalizes noisy activity details before showing them in the sidebar', () => {
    const status = deriveSessionFleetStatus('running', [
      makeSession({
        currentActivity: {
          tool: 'Very Long Tool Name That Should Be Cut Down',
          detail: 'editing\nfrontend/src/components/RepoItem.tsx with extra trailing text',
        },
      }),
    ]);

    expect(status.label).toBe(
      'running · very long tool na…: editing frontend/src/components…'
    );
  });
});
