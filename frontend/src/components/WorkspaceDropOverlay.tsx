import { useDroppable } from '@dnd-kit/core';
import type {
  SplitDirection,
  SplitPlacement,
} from '../lib/workspace-layout.js';
import './WorkspaceDropOverlay.css';

type Edge = 'top' | 'bottom' | 'left' | 'right';

interface EdgeSpec {
  edge: Edge;
  direction: SplitDirection;
  placement: SplitPlacement;
}

const EDGES: EdgeSpec[] = [
  { edge: 'top', direction: 'vertical', placement: 'before' },
  { edge: 'bottom', direction: 'vertical', placement: 'after' },
  { edge: 'left', direction: 'horizontal', placement: 'before' },
  { edge: 'right', direction: 'horizontal', placement: 'after' },
];

interface EdgeZoneProps {
  paneId: string;
  edge: Edge;
  direction: SplitDirection;
  placement: SplitPlacement;
}

function EdgeZone({ paneId, edge, direction, placement }: EdgeZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `edge:${paneId}:${edge}`,
    data: { type: 'edge', paneId, direction, placement },
  });
  return (
    <div
      ref={setNodeRef}
      className={[
        'ws-drop-edge',
        `ws-drop-edge--${edge}`,
        isOver ? 'ws-drop-edge--over' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-hidden
    />
  );
}

export interface WorkspaceDropOverlayProps {
  paneId: string;
  active: boolean;
}

export function WorkspaceDropOverlay({
  paneId,
  active,
}: WorkspaceDropOverlayProps) {
  if (!active) return null;
  return (
    <div className="ws-drop-overlay" aria-hidden>
      {EDGES.map((spec) => (
        <EdgeZone
          key={spec.edge}
          paneId={paneId}
          edge={spec.edge}
          direction={spec.direction}
          placement={spec.placement}
        />
      ))}
    </div>
  );
}

export default WorkspaceDropOverlay;
