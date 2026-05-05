import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveSessionFleetStatus } from '../frontend/src/components/RepoItem.js';
import { makeSession } from './helpers/frontend-factories.js';

const repoItemCss = readFileSync(
  new URL('../frontend/src/components/RepoItem.css', import.meta.url),
  'utf8'
);

const activeToolSession = makeSession({
  currentActivity: { tool: 'Bash', detail: 'npm run build' },
});

describe('deriveSessionFleetStatus', () => {
  it('surfaces running current activity as a compact active status', () => {
    expect(deriveSessionFleetStatus('running', [activeToolSession])).toEqual({
      label: 'running · Bash: npm run build',
      tone: 'active',
      title: 'fleet status: running · Bash: npm run build',
    });
  });

  it('uses explicit waiting labels for approval and answer states', () => {
    expect(
      deriveSessionFleetStatus('permission', [activeToolSession])
    ).toMatchObject({
      label: 'approval needed',
      tone: 'attention',
    });
    expect(
      deriveSessionFleetStatus('needs-answer', [activeToolSession])
    ).toMatchObject({
      label: 'answer needed',
      tone: 'attention',
    });
  });

  it('keeps completed unread sessions attention-worthy', () => {
    expect(
      deriveSessionFleetStatus('unseen-idle', [makeSession()])
    ).toMatchObject({
      label: 'done unread',
      tone: 'attention',
    });
  });

  it('normalizes noisy activity details before showing them in the sidebar', () => {
    const status = deriveSessionFleetStatus('running', [
      makeSession({
        currentActivity: {
          tool: 'Very Long Tool Name That Should Be Cut Down',
          detail:
            'editing\nfrontend/src/components/RepoItem.tsx with extra trailing text',
        },
      }),
    ]);

    expect(status.label).toBe(
      'running · Very Long Tool Na…: editing frontend/src/components…'
    );
  });

  it('scopes attention row backgrounds away from selected rows', () => {
    expect(repoItemCss).toMatch(
      /\.session-row\.attention\.state-unseen-idle:not\(\.selected\)\s*\{\s*background:/
    );
    expect(repoItemCss).toMatch(
      /\.session-row\.attention\.state-permission:not\(\.selected\),\s*\.session-row\.attention\.state-needs-answer:not\(\.selected\),\s*\.session-row\.attention\.state-error:not\(\.selected\)\s*\{\s*background:/
    );
    expect(repoItemCss).not.toMatch(
      /\.session-row\.attention\.state-(?:unseen-idle|permission|needs-answer|error)(?!:not\(\.selected\))\s*(?:,|\{)/
    );
  });
});
