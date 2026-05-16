import type { SessionSummary } from './types.js';
import type { ConfirmationChallenge } from './api.js';

export interface ConfirmationRetryRegistration {
  challenge: ConfirmationChallenge;
  label: string;
  paramsHash: string;
  retry: (confirmationToken: string) => Promise<SessionSummary | unknown>;
}

const retryRegistrations = new Map<string, ConfirmationRetryRegistration>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of Array.from(listeners)) listener();
}

export function registerConfirmationRetry(registration: ConfirmationRetryRegistration): void {
  retryRegistrations.set(registration.challenge.challengeId, registration);
  emitChange();
}

export function getConfirmationRetry(challengeId: string): ConfirmationRetryRegistration | undefined {
  return retryRegistrations.get(challengeId);
}

export function clearConfirmationRetry(challengeId: string): void {
  if (retryRegistrations.delete(challengeId)) emitChange();
}

export function subscribeConfirmationRetries(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function retryConfirmedOperation(
  challenge: ConfirmationChallenge,
  confirmationToken: string
): Promise<SessionSummary | unknown> {
  const registration = retryRegistrations.get(challenge.challengeId);
  if (!registration) {
    throw new Error('no local retry is registered for this confirmation challenge');
  }
  if (registration.paramsHash !== challenge.canonicalParamsHash) {
    throw new Error('registered retry params no longer match the confirmation challenge hash');
  }
  const result = await registration.retry(confirmationToken);
  clearConfirmationRetry(challenge.challengeId);
  return result;
}
