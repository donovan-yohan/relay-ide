import React from 'react';
import type { GitHubIssue, JiraIssue, AnyIssue, BranchLink } from '../lib/types.js';
import { deriveColor } from '../lib/colors.js';
import { StatusDot } from './StatusDot.js';
import './TicketCard.css';

const PRIORITY_COLORS: Record<string, string> = {
  Highest: '#ff5630',
  High: '#ff7452',
  Medium: '#ffab00',
  Low: '#36b37e',
  Lowest: '#6b778c',
};

function simpleJiraStatus(status: string): 'in-progress' | 'code-review' | 'ready-for-qa' | 'unmapped' {
  const lower = status.toLowerCase();
  if (lower.includes('progress') || lower.includes('doing') || lower.includes('development')) return 'in-progress';
  if (lower.includes('review') || lower.includes('pr')) return 'code-review';
  if (lower.includes('qa') || lower.includes('test') || lower.includes('done') || lower.includes('resolved')) return 'ready-for-qa';
  return 'unmapped';
}

function isGitHub(issue: AnyIssue, source: 'github' | 'jira'): issue is GitHubIssue {
  return source === 'github';
}

function isJira(issue: AnyIssue, source: 'github' | 'jira'): issue is JiraIssue {
  return source === 'jira';
}

export interface TicketCardProps {
  issue: AnyIssue;
  source: 'github' | 'jira';
  branchLinks?: BranchLink[];
  onStartWork?: (issue: AnyIssue) => void;
}

export function TicketCard({ issue, source, branchLinks = [], onStartWork }: TicketCardProps) {
  const linkedBranch = branchLinks.length > 0 ? branchLinks[0] : null;
  const hasActiveSession = linkedBranch?.hasActiveSession ?? false;
  const hasStartWork = !!onStartWork;

  return (
    <div className="ticket-card">
      <div className="ticket-left">
        <div className="ticket-title-line">
          {isGitHub(issue, source) ? (
            <StatusDot status={issue.state === 'OPEN' ? 'open' : 'closed'} />
          ) : isJira(issue, source) ? (
            <StatusDot status={simpleJiraStatus(issue.status)} />
          ) : null}
          <a className="ticket-title-link" href={issue.url} target="_blank" rel="noopener noreferrer">
            {issue.title}
          </a>
        </div>
        <div className="ticket-meta">
          {isGitHub(issue, source) ? (
            <>
              <span
                className="repo-chip"
                style={{ background: deriveColor(issue.repoName) }}
                title={issue.repoPath ?? issue.repoName}
              >
                {issue.repoName}
              </span>
              <span className="ticket-sep">·</span>
              <span className="ticket-number">#{issue.number}</span>
              {issue.labels.slice(0, 3).map((label) => (
                <span
                  key={label.name}
                  className="label-chip"
                  style={{ background: `#${label.color}` }}
                  title={label.name}
                >
                  {label.name}
                </span>
              ))}
            </>
          ) : isJira(issue, source) ? (
            <>
              <span className="ticket-key">{issue.key}</span>
              <span className="ticket-sep">·</span>
              <span className="status-badge">{issue.status}</span>
              {issue.priority ? (
                <>
                  <span className="ticket-sep">·</span>
                  <span className="priority-badge" style={{ color: PRIORITY_COLORS[issue.priority] ?? 'var(--text-muted)' }}>
                    {issue.priority}
                  </span>
                </>
              ) : null}
              {issue.sprint ? (
                <>
                  <span className="ticket-sep">·</span>
                  <span className="sprint-chip">{issue.sprint}</span>
                </>
              ) : null}
              {issue.storyPoints != null ? (
                <>
                  <span className="ticket-sep">·</span>
                  <span className="points-badge">{issue.storyPoints}pt</span>
                </>
              ) : null}
            </>
          ) : null}
          {linkedBranch ? (
            <>
              <span className="ticket-sep">·</span>
              <span className="branch-chip">
                {hasActiveSession ? <StatusDot status="running" size={6} /> : null}
                {linkedBranch.branchName}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <div className="ticket-actions">
        <button
          className={['start-work-btn', hasStartWork && 'start-work-btn--active'].filter(Boolean).join(' ')}
          onClick={() => onStartWork?.(issue)}
          disabled={!hasStartWork}
        >
          Start Work
        </button>
      </div>
    </div>
  );
}

export default TicketCard;
