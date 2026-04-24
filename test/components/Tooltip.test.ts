import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, beforeEach, expect, it } from 'vitest';
import Tooltip from '../../frontend/src/components/Tooltip.js';
import TuiButton from '../../frontend/src/components/TuiButton.js';
import {
  _resetForTesting,
  registerGlobal,
} from '../../frontend/src/lib/actions/registry.js';
import type { Action } from '../../frontend/src/lib/actions/types.js';

function registerAction(action: Action) {
  _resetForTesting();
  registerGlobal([action]);
}

describe('Tooltip', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('uses command registry labels and shortcut formatting for action tooltips', () => {
    registerAction({
      id: 'workspace.open-diff-view',
      label: 'open review pane',
      description: 'open the review utility pane for changed files',
      category: 'workspace',
      shortcut: { key: 'mod+d' },
      handler: () => {},
    });

    const html = renderToStaticMarkup(
      React.createElement(
        Tooltip,
        { actionId: 'workspace.open-diff-view' },
        React.createElement('button', { type: 'button' }, 'review')
      )
    );

    expect(html).toContain('open review pane');
    expect(html).toContain('open the review utility pane for changed files');
    expect(html).toMatch(/⌘D|ctrl\+D/);
    expect(html).not.toContain('title=');
  });

  it('lets TuiButton expose the same tooltip contract', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        TuiButton,
        { tooltip: 'refresh PR data', tooltipShortcut: 'mod+r' },
        'refresh'
      )
    );

    expect(html).toContain('refresh PR data');
    expect(html).toMatch(/⌘R|ctrl\+R/);
    expect(html).toContain('tui-tooltip');
  });
});
