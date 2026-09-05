import * as React from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  FileCode,
  History,
  Layers,
  Loader2,
  Sparkles,
  Terminal,
  User,
  Wrench,
  X,
} from 'lucide-react';
import { invokeTauri } from '@/shared/api/tauri';
import { UserAvatar } from '@/shared/ui/UserAvatar';
import { Button } from '@/shared/ui/button';
import { cn } from '@/shared/lib/cn';
import {
  AuxiliaryPanel,
  AuxiliaryPanelBody,
  AuxiliaryPanelHeader,
  AuxiliaryPanelHeaderActions,
  AuxiliaryPanelHeaderGroup,
  type AuxiliaryPanelLayout,
} from '@/shared/layout/AuxiliaryPanel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import type {
  AgentRunRecord,
  AgentRunSummary,
} from '../types';
import { AgentDetailCard } from './AgentDetailCard';
import { AssistantMarkdown } from './AssistantMarkdown';

export interface AgentRunViewPanelProps {
  channelId?: string | null;
  agentPubkey: string;
  initialRunId?: string | null;
  onClose: () => void;
  onBack?: () => void;
  widthPx?: number;
  layout?: AuxiliaryPanelLayout;
  isSinglePanelView?: boolean;
  transparentChrome?: boolean;
}

export const AgentRunViewPanel: React.FC<AgentRunViewPanelProps> = ({
  channelId,
  agentPubkey,
  initialRunId,
  onClose,
  onBack,
  widthPx = 480,
  layout = 'standalone',
  isSinglePanelView = false,
  transparentChrome = false,
}) => {
  const [runs, setRuns] = React.useState<AgentRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(initialRunId ?? null);
  const [activeRunRecord, setActiveRunRecord] = React.useState<AgentRunRecord | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Sync initialRunId when prop changes
  React.useEffect(() => {
    if (initialRunId) {
      setSelectedRunId(initialRunId);
    }
  }, [initialRunId]);

  // Load runs list for this agent in this channel
  React.useEffect(() => {
    let cancelled = false;
    async function loadRuns() {
      if (!channelId) return;
      try {
        setIsLoading(true);
        setError(null);
        const res: any = await invokeTauri('get_agent_runs', {
          channelId,
          agentPubkey,
        });
        if (cancelled) return;
        const runsList = res?.runs || [];
        setRuns(runsList);

        // If no selectedRunId or selectedRunId not in list, select the newest run
        if (!selectedRunId && runsList.length > 0) {
          setSelectedRunId(runsList[0].runId);
        } else if (selectedRunId && !runsList.some((r: any) => r.runId === selectedRunId) && runsList.length > 0) {
          // If specified run not found in list, still try to load it directly
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[AgentRunViewPanel] Failed to fetch agent runs:', err);
          setError('Failed to load agent runs');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }
    loadRuns();
    return () => {
      cancelled = true;
    };
  }, [channelId, agentPubkey]);

  // Load details for selected run
  React.useEffect(() => {
    let cancelled = false;
    async function loadRunDetails() {
      if (!channelId || !selectedRunId) return;
      try {
        const details: any = await invokeTauri('get_run_details', {
          channelId,
          runId: selectedRunId,
        });
        if (cancelled) return;
        if (details) {
          setActiveRunRecord(details);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[AgentRunViewPanel] Failed to fetch run details:', err);
        }
      }
    }
    loadRunDetails();
    return () => {
      cancelled = true;
    };
  }, [channelId, selectedRunId]);

  const currentRunSummary = runs.find((r) => r.runId === selectedRunId) || runs[0];
  const agentDisplayName = activeRunRecord?.agentName || currentRunSummary?.agentName || 'Agent';

  const status = activeRunRecord?.status || currentRunSummary?.status || 'completed';
  const isWorking = status === 'working' || status === 'running';
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';
  const isInputRequired = status === 'input-required' || status === 'auth-required';

  const metrics = activeRunRecord?.metrics || currentRunSummary?.metrics;
  const messages = activeRunRecord?.messages || [];

  return (
    <AuxiliaryPanel
      className="agent-run-view-panel"
      isSinglePanelView={isSinglePanelView}
      layout={layout}
      onClose={onClose}
      transparentChrome={transparentChrome}
      widthPx={widthPx}
      header={
        <AuxiliaryPanelHeader
          backdrop={layout !== "split"}
          backdropSurface="soft"
          inset={layout !== "split" ? "wide" : "default"}
        >
          <AuxiliaryPanelHeaderGroup align="start" onBack={onBack}>
            <UserAvatar
              displayName={agentDisplayName}
              avatarUrl={null}
              shape="squircle"
              size="sm"
              className="size-8 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-semibold text-sm truncate">{agentDisplayName}</span>
                <span
                  className={cn(
                    'px-1.5 py-0.2 text-[10px] font-mono rounded-full font-medium shrink-0',
                    isCompleted && 'bg-emerald-500/10 text-emerald-500',
                    isWorking && 'bg-amber-500/10 text-amber-500 animate-pulse',
                    isFailed && 'bg-red-500/10 text-red-500',
                    isInputRequired && 'bg-purple-500/10 text-purple-500 font-bold'
                  )}
                >
                  {isInputRequired ? 'Approval Required' : status}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                Turn execution process
              </p>
            </div>
          </AuxiliaryPanelHeaderGroup>

          <AuxiliaryPanelHeaderActions>
            {runs.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs font-mono gap-1 px-2"
                  >
                    <History className="h-3.5 w-3.5" />
                    <span>Runs ({runs.length})</span>
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  {runs.map((r, idx) => (
                    <DropdownMenuItem
                      key={r.runId}
                      onClick={() => setSelectedRunId(r.runId)}
                      className={cn(
                        'flex flex-col items-start gap-1 py-1.5 cursor-pointer',
                        r.runId === selectedRunId && 'bg-muted font-medium'
                      )}
                    >
                      <div className="flex items-center justify-between w-full text-xs">
                        <span className="font-mono">
                          Run #{runs.length - idx} {r.runId === selectedRunId ? '(active)' : ''}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {r.metrics?.durationLabel || ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        <span>·</span>
                        <span>{r.metrics?.toolCallCount ?? 0} tools</span>
                        <span>·</span>
                        <span className="capitalize">{r.status}</span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            <Button
              aria-label="Close run view"
              className="shrink-0"
              onClick={onClose}
              size="icon"
              variant="ghost"
            >
              <X className="h-4 w-4" />
            </Button>
          </AuxiliaryPanelHeaderActions>
        </AuxiliaryPanelHeader>
      }
    >
      <AuxiliaryPanelBody
        className="overflow-y-auto px-4 pb-4 flex flex-col gap-4"
        panelPadding
      >
        {/* Run metrics summary bar */}
        {metrics ? (
          <div className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-card/60 text-xs font-mono">
            <div className="flex items-center gap-1 text-muted-foreground">
              <Clock className="h-3.5 w-3.5 text-primary/70" />
              <span className="text-foreground font-medium">{metrics.durationLabel}</span>
            </div>
            <div className="h-3 w-px bg-border" />
            <div className="flex items-center gap-1 text-muted-foreground">
              <Wrench className="h-3.5 w-3.5 text-primary/70" />
              <span className="text-foreground font-medium">{metrics.toolCallCount}</span>
              <span>{metrics.toolCallCount === 1 ? 'tool' : 'tools'}</span>
            </div>
            {metrics.filesTouchedCount > 0 ? (
              <>
                <div className="h-3 w-px bg-border" />
                <div className="flex items-center gap-1 text-muted-foreground">
                  <FileCode className="h-3.5 w-3.5 text-primary/70" />
                  <span className="text-foreground font-medium">{metrics.filesTouchedCount}</span>
                  <span>{metrics.filesTouchedCount === 1 ? 'file' : 'files'}</span>
                </div>
              </>
            ) : null}
            {metrics.pendingApproval ? (
              <>
                <div className="h-3 w-px bg-border" />
                <div className="flex items-center gap-1 text-amber-500 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>Approval Pending</span>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {/* Previous runs selector tabs if available */}
        {runs.length > 1 ? (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            <span className="text-[11px] font-mono text-muted-foreground mr-1 shrink-0">Runs:</span>
            {runs.map((r, i) => {
              const isCurrent = r.runId === selectedRunId;
              const runNum = runs.length - i;
              return (
                <button
                  key={r.runId}
                  onClick={() => setSelectedRunId(r.runId)}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-mono border transition-all shrink-0 cursor-pointer',
                    isCurrent
                      ? 'border-primary/60 bg-primary/10 text-foreground font-semibold shadow-xs'
                      : 'border-border bg-background/50 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                  )}
                >
                  <span>#{runNum}</span>
                  <span className="text-[10px] opacity-70">({r.metrics?.durationLabel || 'done'})</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Execution process list */}
        {isLoading && !activeRunRecord ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <span className="text-xs font-mono">Loading turn execution...</span>
          </div>
        ) : error && !activeRunRecord ? (
          <div className="p-4 rounded-md border border-destructive/50 bg-destructive/10 text-destructive text-xs">
            {error}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground text-xs gap-1">
            <Layers className="h-8 w-8 stroke-1 opacity-40 mb-1" />
            <p className="font-semibold text-foreground">No detailed trace rows found</p>
            <p className="text-[11px]">This turn contains principal prose output only.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between text-xs font-mono text-muted-foreground px-1">
              <span>Turn Execution Trace</span>
              <span>{messages.length} {messages.length === 1 ? 'item' : 'items'}</span>
            </div>

            {messages.map((msg, index) => {
              const isHuman = msg.sender?.kind === 'human';
              const isSystem = msg.kind === 'system';
              const isDetail = msg.agentDetail !== undefined;
              const card = msg.agentDetail?.card;
              const isProse = !isDetail && !isSystem && !isHuman && msg.body?.text;

              if (isHuman) {
                return (
                  <div
                    key={msg.id || `msg-${index}`}
                    className="p-3 rounded-md border border-border/80 bg-muted/30 flex flex-col gap-1.5"
                  >
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                      <User className="h-3.5 w-3.5" />
                      <span className="font-semibold text-foreground">{msg.sender?.displayName || 'Operator'}</span>
                      <span className="text-[10px]">
                        {msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString() : ''}
                      </span>
                    </div>
                    <div className="text-xs whitespace-pre-wrap font-sans text-foreground/90 pl-5">
                      {msg.body?.text}
                    </div>
                  </div>
                );
              }

              if (isDetail && card) {
                return (
                  <div key={msg.id || `detail-${index}`} className="my-0.5">
                    <AgentDetailCard
                      card={card}
                      itemId={msg.id || `card-${index}`}
                    />
                  </div>
                );
              }

              if (isSystem) {
                const isApproval = msg.meta?.approvalRequestId || msg.meta?.approvalState === 'requested';
                return (
                  <div
                    key={msg.id || `sys-${index}`}
                    className={cn(
                      'p-2.5 rounded-md border text-xs font-mono flex items-start gap-2',
                      isApproval
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                        : 'border-border bg-muted/20 text-muted-foreground'
                    )}
                  >
                    {isApproval ? (
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
                    ) : (
                      <Terminal className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                    )}
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold">{isApproval ? 'Approval Request' : 'System Event'}</span>
                      <span className="text-[11px] whitespace-pre-wrap text-foreground/80">{msg.body?.text || JSON.stringify(msg.meta)}</span>
                    </div>
                  </div>
                );
              }

              if (isProse) {
                return (
                  <div
                    key={msg.id || `prose-${index}`}
                    className="p-3.5 rounded-md border border-primary/30 bg-primary/5 flex flex-col gap-2 my-1"
                  >
                    <div className="flex items-center gap-1.5 text-xs font-mono text-primary/80">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      <span className="font-semibold">{msg.sender?.displayName || agentDisplayName} Final Response</span>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        {msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString() : ''}
                      </span>
                    </div>
                    <div className="text-xs text-foreground">
                      <AssistantMarkdown text={msg.body.text} keyPrefix={msg.id} />
                    </div>
                  </div>
                );
              }

              return null;
            })}
          </div>
        )}
      </AuxiliaryPanelBody>
    </AuxiliaryPanel>
  );
};

export default AgentRunViewPanel;
