import React, { Activity, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listPanes,
  workspaceTabId,
  type WorkspaceTab,
  type WorkspaceTabId,
} from '../lib/workspace-layout.js';
import {
  getAllPaneBodyEls,
  subscribeToPaneBodyEls,
  useWorkspaceLayoutStore,
} from '../lib/stores/workspace-layout-store.js';
import './WorkspaceContentLayer.css';

function usePaneBodyEls(): ReadonlyMap<string, HTMLElement | null> {
  const [, force] = useState(0);
  useEffect(() => subscribeToPaneBodyEls(() => force((v) => v + 1)), []);
  return getAllPaneBodyEls();
}

interface TabPlacement {
  tab: WorkspaceTab;
  tabId: WorkspaceTabId;
  paneId: string;
  isActive: boolean;
}

export interface WorkspaceContentLayerProps {
  renderTab: (tab: WorkspaceTab) => React.ReactNode;
}

export function WorkspaceContentLayer({
  renderTab,
}: WorkspaceContentLayerProps): React.ReactElement {
  const layout = useWorkspaceLayoutStore((s) => s.layout);
  const paneEls = usePaneBodyEls();

  const placements = useMemo<TabPlacement[]>(() => {
    const out: TabPlacement[] = [];
    for (const pane of listPanes(layout)) {
      for (const tab of pane.tabs) {
        const tabId = workspaceTabId(tab);
        out.push({
          tab,
          tabId,
          paneId: pane.id,
          isActive: pane.activeTabId === tabId,
        });
      }
    }
    return out;
  }, [layout]);

  return (
    <>
      {placements.map((placement) => {
        const { tab, tabId, paneId, isActive } = placement;
        const target = paneEls.get(paneId);
        if (!target) return null;
        return createPortal(
          <Activity mode={isActive ? 'visible' : 'hidden'}>
            <div
              className="ws-tab-content-host"
              data-ws-tab={tabId}
              data-ws-active={isActive ? 'true' : 'false'}
            >
              {renderTab(tab)}
            </div>
          </Activity>,
          target,
          tabId
        );
      })}
    </>
  );
}

export default WorkspaceContentLayer;
