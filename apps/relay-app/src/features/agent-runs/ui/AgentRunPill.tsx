import * as React from 'react';
import { AlertTriangle, Clock, FileCode, PlayCircle, Wrench } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export interface AgentRunPillProps {
  runId?: string;
  durationLabel?: string | null;
  toolCallCount?: number;
  filesTouchedCount?: number;
  pendingApproval?: boolean;
  status?: string;
  onClick?: () => void;
  className?: string;
}

export const AgentRunPill: React.FC<AgentRunPillProps> = ({
  runId,
  durationLabel,
  toolCallCount = 0,
  filesTouchedCount = 0,
  pendingApproval = false,
  status,
  onClick,
  className,
}) => {
  if (!runId && !durationLabel && toolCallCount === 0 && !pendingApproval) {
    return null;
  }

  const isWorking = status === 'working' || status === 'running';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className={cn(
        'group inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-background/80 px-2.5 py-0.5 text-xs font-mono text-muted-foreground shadow-xs transition-all hover:border-primary/50 hover:bg-muted/50 hover:text-foreground cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
        pendingApproval && 'border-amber-500/60 bg-amber-500/10 text-amber-500 font-semibold',
        isWorking && 'border-amber-500/40 bg-amber-500/5 text-amber-500 animate-pulse',
        className
      )}
      title="Open agent run details"
      aria-label="Open agent run details"
    >
      <span className="flex items-center gap-1 text-[11px]">
        {pendingApproval ? (
          <span className="flex items-center gap-1 text-amber-500">
            <AlertTriangle className="h-3 w-3 fill-amber-500/20 text-amber-500" />
            <span>Approval Required</span>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <PlayCircle className="h-3 w-3 text-primary/70 group-hover:text-primary" />
            <span className="font-medium text-foreground/80 group-hover:text-foreground">Run</span>
          </span>
        )}

        {durationLabel ? (
          <span className="flex items-center gap-0.5 ml-1 text-muted-foreground group-hover:text-foreground/80">
            <Clock className="h-2.5 w-2.5 opacity-70" />
            <span>{durationLabel}</span>
          </span>
        ) : null}

        {toolCallCount > 0 ? (
          <span className="flex items-center gap-0.5 ml-1 text-muted-foreground group-hover:text-foreground/80">
            <Wrench className="h-2.5 w-2.5 opacity-70" />
            <span>{toolCallCount} {toolCallCount === 1 ? 'tool' : 'tools'}</span>
          </span>
        ) : null}

        {filesTouchedCount > 0 ? (
          <span className="flex items-center gap-0.5 ml-1 text-muted-foreground group-hover:text-foreground/80">
            <FileCode className="h-2.5 w-2.5 opacity-70" />
            <span>{filesTouchedCount} {filesTouchedCount === 1 ? 'file' : 'files'}</span>
          </span>
        ) : null}
      </span>
    </button>
  );
};

export default AgentRunPill;
