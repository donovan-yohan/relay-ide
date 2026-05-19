import React, { useEffect, useMemo, useState } from 'react';
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
  renderTab: (tab: WorkspaceTab, isActive: boolean) => React.ReactNode;
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

  const [mountedTabIds, setMountedTabIds] = useState<Set<WorkspaceTabId>>(
    () => new Set()
  );

  useEffect(() => {
    setMountedTabIds((prev) => {
      const liveIds = new Set(placements.map((p) => p.tabId));
      const next = new Set<WorkspaceTabId>();
      let changed = false;

      for (const id of prev) {
        if (liveIds.has(id)) next.add(id);
        else changed = true;
      }
      for (const placement of placements) {
        if (!placement.isActive) continue;
        if (!next.has(placement.tabId)) changed = true;
        next.add(placement.tabId);
      }

      return changed ? next : prev;
    });
  }, [placements]);

  return (
    <>
      {placements.map((placement) => {
        const { tab, tabId, paneId, isActive } = placement;
        const target = paneEls.get(paneId);
        if (!target || (!isActive && !mountedTabIds.has(tabId))) return null;
        return createPortal(
          <div
            className="ws-tab-content-host"
            data-ws-tab={tabId}
            data-ws-active={isActive ? 'true' : 'false'}
          >
            {renderTab(tab, isActive)}
          </div>,
          target,
          tabId
        );
      })}
    </>
  );
}

export default WorkspaceContentLayer;
