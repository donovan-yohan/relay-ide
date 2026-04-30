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

  const warmedRef = useRef<Set<WorkspaceTabId>>(new Set());

  const placements = useMemo<TabPlacement[]>(() => {
    const out: TabPlacement[] = [];
    const live = new Set<WorkspaceTabId>();
    const warmed = warmedRef.current;
    for (const pane of listPanes(layout)) {
      for (const tab of pane.tabs) {
        const tabId = workspaceTabId(tab);
        const isActive = pane.activeTabId === tabId;
        live.add(tabId);
        if (isActive) warmed.add(tabId);
        out.push({ tab, tabId, paneId: pane.id, isActive });
      }
    }
    for (const id of warmed) {
      if (!live.has(id)) warmed.delete(id);
    }
    return out;
  }, [layout]);

  const shouldMount = (placement: TabPlacement): boolean =>
    placement.tab.kind === 'session' || warmedRef.current.has(placement.tabId);

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
