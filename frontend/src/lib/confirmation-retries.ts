import type { SessionSummary } from './types.js';
import type { ConfirmationChallenge } from './api.js';

export interface ConfirmationRetryRegistration {
  challenge: ConfirmationChallenge;
  label: string;
  paramsHash: string;
  retry: (confirmationToken: string) => Promise<SessionSummary | unknown>;
}

export interface ConfirmationRetryRegistry {
  registerConfirmationRetry(registration: ConfirmationRetryRegistration): void;
  getConfirmationRetry(challengeId: string): ConfirmationRetryRegistration | undefined;
  clearConfirmationRetry(challengeId: string): void;
  subscribeConfirmationRetries(listener: () => void): () => void;
  retryConfirmedOperation(
    challenge: ConfirmationChallenge,
    confirmationToken: string
  ): Promise<SessionSummary | unknown>;
}

export function createConfirmationRetryRegistry(): ConfirmationRetryRegistry {
  const retryRegistrations = new Map<string, ConfirmationRetryRegistration>();
  const listeners = new Set<() => void>();

  function emitChange(): void {
    for (const listener of Array.from(listeners)) listener();
  }

  function registerConfirmationRetry(registration: ConfirmationRetryRegistration): void {
    retryRegistrations.set(registration.challenge.challengeId, registration);
    emitChange();
  }

  function getConfirmationRetry(challengeId: string): ConfirmationRetryRegistration | undefined {
    return retryRegistrations.get(challengeId);
  }

  function clearConfirmationRetry(challengeId: string): void {
    if (retryRegistrations.delete(challengeId)) emitChange();
  }

  function subscribeConfirmationRetries(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function retryConfirmedOperation(
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

  return {
    registerConfirmationRetry,
    getConfirmationRetry,
    clearConfirmationRetry,
    subscribeConfirmationRetries,
    retryConfirmedOperation,
  };
}

const defaultConfirmationRetryRegistry = createConfirmationRetryRegistry();

export function registerConfirmationRetry(registration: ConfirmationRetryRegistration): void {
  defaultConfirmationRetryRegistry.registerConfirmationRetry(registration);
}

export function getConfirmationRetry(challengeId: string): ConfirmationRetryRegistration | undefined {
  return defaultConfirmationRetryRegistry.getConfirmationRetry(challengeId);
}

export function clearConfirmationRetry(challengeId: string): void {
  defaultConfirmationRetryRegistry.clearConfirmationRetry(challengeId);
}

export function subscribeConfirmationRetries(listener: () => void): () => void {
  return defaultConfirmationRetryRegistry.subscribeConfirmationRetries(listener);
}

export async function retryConfirmedOperation(
  challenge: ConfirmationChallenge,
  confirmationToken: string
): Promise<SessionSummary | unknown> {
  return defaultConfirmationRetryRegistry.retryConfirmedOperation(challenge, confirmationToken);
}
