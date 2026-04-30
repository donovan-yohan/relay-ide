import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  const bufferRef = useRef<HTMLDivElement | null>(null);
  const [bufferEl, setBufferEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setBufferEl(bufferRef.current);
  }, []);

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

  const [warmed, setWarmed] = useState<ReadonlySet<WorkspaceTabId>>(
    () => new Set()
  );

  useEffect(() => {
    setWarmed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const { tabId, isActive } of placements) {
        if (isActive && !next.has(tabId)) {
          next.add(tabId);
          changed = true;
        }
      }
      const liveIds = new Set(placements.map((p) => p.tabId));
      for (const id of next) {
        if (!liveIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [placements]);

  const shouldMount = (placement: TabPlacement): boolean => {
    if (placement.tab.kind === 'session') return true;
    return warmed.has(placement.tabId);
  };

  return (
    <>
      <div ref={bufferRef} className="ws-content-buffer" aria-hidden />
      {placements.map((placement) => {
        if (!shouldMount(placement)) return null;
        const { tab, tabId, paneId, isActive } = placement;
        const target = isActive ? (paneEls.get(paneId) ?? bufferEl) : bufferEl;
        if (!target) return null;
        return createPortal(
          <div className="ws-tab-content-host" data-ws-tab={tabId}>
            {renderTab(tab)}
          </div>,
          target,
          tabId
        );
      })}
    </>
  );
}

export default WorkspaceContentLayer;
