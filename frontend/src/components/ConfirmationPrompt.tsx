import React, { useEffect, useMemo, useState } from 'react';
import {
  approveConfirmationChallenge,
  fetchConfirmationChallenges,
  type ConfirmationChallenge,
  type ConfirmationDecision,
} from '../lib/api.js';
import {
  getConfirmationRetry,
  retryConfirmedOperation,
  subscribeConfirmationRetries,
} from '../lib/confirmation-retries.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import TuiButton from './TuiButton.js';
import './ConfirmationPrompt.css';

const APPROVER_STORAGE_KEY = 'relay-confirmation-approver-session';
const POLL_INTERVAL_MS = 3_000;

function loadApproverSession(): string {
  try {
    return localStorage.getItem(APPROVER_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveApproverSession(value: string): void {
  try {
    if (value.trim()) localStorage.setItem(APPROVER_STORAGE_KEY, value.trim());
    else localStorage.removeItem(APPROVER_STORAGE_KEY);
  } catch {
    /* localStorage may be unavailable */
  }
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function statusRank(status: ConfirmationChallenge['status']): number {
  if (status === 'pending') return 0;
  if (status === 'approved') return 1;
  return 2;
}

function challengeLabel(challenge: ConfirmationChallenge): string {
  const target = challenge.intent.target ? ` -> ${challenge.intent.target}` : '';
  return `${challenge.intent.action}${target}`;
}

function detailsFromError(error: unknown): { message: string; reasonCode?: string } {
  if (error && typeof error === 'object') {
    const maybe = error as { message?: unknown; details?: Record<string, unknown> };
    return {
      message: typeof maybe.message === 'string' ? maybe.message : String(error),
      ...(typeof maybe.details?.['reasonCode'] === 'string'
        ? { reasonCode: maybe.details['reasonCode'] }
        : {}),
    };
  }
  return { message: String(error) };
}

function shouldTreatDeniedAsHandled(decision: ConfirmationDecision, reasonCode?: string): boolean {
  return (
    (decision === 'deny' && reasonCode === 'CONFIRMATION_DENIED') ||
    (decision === 'deny_revoke' && reasonCode === 'CONFIRMATION_DENIED_REVOKE')
  );
}

export const ConfirmationPrompt: React.FC = () => {
  const [challenges, setChallenges] = useState<ConfirmationChallenge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [approverSession, setApproverSession] = useState(loadApproverSession);
  const [loading, setLoading] = useState<ConfirmationDecision | 'retry' | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, setRetryVersion] = useState(0);

  const refresh = async (): Promise<void> => {
    const next = await fetchConfirmationChallenges();
    setChallenges(next);
    setSelectedId((current) => {
      if (current && next.some((challenge) => challenge.challengeId === current)) {
        return current;
      }
      return next.find((challenge) => challenge.status === 'pending')?.challengeId ?? next[0]?.challengeId ?? null;
    });
  };

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await fetchConfirmationChallenges();
        if (!active) return;
        setChallenges(next);
        setSelectedId((current) => {
          if (current && next.some((challenge) => challenge.challengeId === current)) return current;
          return next.find((challenge) => challenge.status === 'pending')?.challengeId ?? next[0]?.challengeId ?? null;
        });
      } catch (error) {
        if (active) setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => subscribeConfirmationRetries(() => setRetryVersion((value) => value + 1)), []);

  const visibleChallenges = useMemo(
    () =>
      challenges
        .filter((challenge) => challenge.status === 'pending' || challenge.status === 'approved')
        .toSorted((a, b) => {
          const rank = statusRank(a.status) - statusRank(b.status);
          if (rank !== 0) return rank;
          return Date.parse(b.createdAt) - Date.parse(a.createdAt);
        }),
    [challenges]
  );

  const selected =
    visibleChallenges.find((challenge) => challenge.challengeId === selectedId) ?? visibleChallenges[0];
  const retryRegistration = selected ? getConfirmationRetry(selected.challengeId) : undefined;

  if (!selected) return null;

  const handleDecision = async (decision: ConfirmationDecision) => {
    setLoading(decision);
    setErrorMessage(null);
    setStatusMessage(null);
    saveApproverSession(approverSession);
    try {
      const result = await approveConfirmationChallenge(
        selected.challengeId,
        decision,
        approverSession
      );
      setChallenges((current) =>
        current.map((challenge) =>
          challenge.challengeId === result.challenge.challengeId ? result.challenge : challenge
        )
      );
      if (decision !== 'approve') {
        setStatusMessage(`challenge ${decision === 'deny' ? 'denied' : 'denied + revoke requested'}`);
        await refresh();
        return;
      }
      if (!result.confirmationToken) {
        setStatusMessage('challenge approved, but the hub did not return a token');
        await refresh();
        return;
      }
      const registration = getConfirmationRetry(result.challenge.challengeId);
      if (!registration) {
        setStatusMessage('challenge approved. no local retry is registered in this browser session.');
        await refresh();
        return;
      }
      if (registration.paramsHash !== result.challenge.canonicalParamsHash) {
        setErrorMessage('approved token was not retried: local params hash does not match the challenge');
        await refresh();
        return;
      }
      setLoading('retry');
      await retryConfirmedOperation(result.challenge, result.confirmationToken);
      await useSessionsStore.getState().refreshAll();
      setStatusMessage('approved and retried with the exact original params');
      await refresh();
    } catch (error) {
      const details = detailsFromError(error);
      if (shouldTreatDeniedAsHandled(decision, details.reasonCode)) {
        setStatusMessage(decision === 'deny' ? 'challenge denied' : 'challenge denied and revoke requested');
        await refresh();
      } else if (details.reasonCode === 'CONFIRMATION_SAME_SESSION') {
        setErrorMessage(`same-session approval blocked: ${details.message}`);
        await refresh();
      } else {
        setErrorMessage(details.message);
      }
    } finally {
      setLoading(null);
    }
  };

  const canonicalJson = JSON.stringify(selected.canonicalParams, null, 2);

  return (
    <aside className="confirmation-prompt" aria-live="polite" aria-label="confirmation challenge prompt">
      <div className="confirmation-prompt__header">
        <div>
          <div className="confirmation-prompt__eyebrow">operator confirmation</div>
          <h2>dangerous operation queued</h2>
        </div>
        <span className={`confirmation-prompt__status confirmation-prompt__status--${selected.status}`}>
          {selected.status}
        </span>
      </div>

      {visibleChallenges.length > 1 && (
        <label className="confirmation-prompt__field">
          challenge
          <select
            value={selected.challengeId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {visibleChallenges.map((challenge) => (
              <option key={challenge.challengeId} value={challenge.challengeId}>
                {challengeLabel(challenge)} [{challenge.status}]
              </option>
            ))}
          </select>
        </label>
      )}

      <dl className="confirmation-prompt__meta">
        <div>
          <dt>node</dt>
          <dd>{selected.nodeId}</dd>
        </div>
        <div>
          <dt>intent</dt>
          <dd>{challengeLabel(selected)}</dd>
        </div>
        {selected.sessionId && (
          <div>
            <dt>session</dt>
            <dd>{selected.sessionId}</dd>
          </div>
        )}
        <div>
          <dt>expires</dt>
          <dd>{formatDate(selected.expiresAt)}</dd>
        </div>
        <div>
          <dt>params hash</dt>
          <dd title={selected.canonicalParamsHash}>{selected.canonicalParamsHash.slice(0, 18)}…</dd>
        </div>
        <div>
          <dt>retry</dt>
          <dd>{retryRegistration ? `local: ${retryRegistration.label}` : 'not registered in this browser'}</dd>
        </div>
      </dl>

      <div className="confirmation-prompt__bits" aria-label="required capability bits">
        {[...new Set([...selected.requiredBits, ...selected.challengeBits])].map((bit) => (
          <span key={bit}>{bit}</span>
        ))}
      </div>

      <label className="confirmation-prompt__field">
        approver session label
        <input
          value={approverSession}
          onChange={(event) => setApproverSession(event.target.value)}
          placeholder="blank = current session, e.g. operator-1 = distinct"
        />
      </label>

      <details className="confirmation-prompt__params" open>
        <summary>canonical params</summary>
        <pre>{canonicalJson}</pre>
      </details>

      {selected.message && <p className="confirmation-prompt__message">{selected.message}</p>}
      {statusMessage && <p className="confirmation-prompt__message confirmation-prompt__message--ok">{statusMessage}</p>}
      {errorMessage && <p className="confirmation-prompt__message confirmation-prompt__message--error">{errorMessage}</p>}

      <div className="confirmation-prompt__actions">
        <TuiButton
          variant="danger"
          size="sm"
          disabled={loading !== null || selected.status !== 'pending'}
          onClick={() => void handleDecision('deny_revoke')}
        >
          deny + revoke
        </TuiButton>
        <TuiButton
          variant="ghost"
          size="sm"
          disabled={loading !== null || selected.status !== 'pending'}
          onClick={() => void handleDecision('deny')}
        >
          deny
        </TuiButton>
        <TuiButton
          variant="success"
          size="sm"
          disabled={loading !== null || selected.status !== 'pending'}
          onClick={() => void handleDecision('approve')}
        >
          {loading === 'retry' ? 'retrying…' : loading === 'approve' ? 'approving…' : 'approve + retry'}
        </TuiButton>
      </div>
    </aside>
  );
};

export default ConfirmationPrompt;
