import { describe, expect, it } from 'vitest';
import {
  buildHermesCreateExtra,
  buildTicketInitialPrompt,
  validateTicketContext,
} from '../server/index.js';
import type { TicketContext } from '../server/types.js';

// #1062: ticketContext + the ticket-derived initial prompt never reached
// Hermes web-mode sessions because the web-mode branch of POST /sessions
// returned early (via buildHermesCreateExtra) before the PTY-only ticket
// validation/prompt block ran. These tests cover the fix at the level of the
// pure functions the route now shares across both mode branches, mirroring
// how buildHermesInstructions (#1090) is unit tested rather than exercised
// through a full gateway round trip.

const ticket: TicketContext = {
  ticketId: 'GH-42',
  title: 'Fix the thing',
  description: 'Full repro steps here.',
  url: 'https://github.com/donovan-yohan/relay-ide/issues/42',
  source: 'github',
  repoPath: '/configured/repo',
  repoName: 'relay-ide',
};

describe('buildHermesCreateExtra (#1062 ticket context for web mode)', () => {
  it('returns {} for non-hermes agents even with ticket context set', () => {
    expect(
      buildHermesCreateExtra('claude', {
        ticketContext: ticket,
        initialPrompt: 'start here',
      })
    ).toEqual({});
  });

  it('returns {} for hermes when there is no context to attach', () => {
    expect(buildHermesCreateExtra('hermes', {})).toEqual({});
  });

  it('tags the conversation with ticket metadata and carries the initial prompt as one-shot initialInstructions', () => {
    const result = buildHermesCreateExtra('hermes', {
      repoPath: ticket.repoPath,
      ticketContext: ticket,
      initialPrompt: 'You are working on ticket GH-42: Fix the thing.',
    });
    expect(result).toMatchObject({
      extra: {
        metadata: {
          relay_repo_path: ticket.repoPath,
          relay_ticket_id: 'GH-42',
          relay_ticket_source: 'github',
          relay_ticket_url: ticket.url,
        },
        initialInstructions: 'You are working on ticket GH-42: Fix the thing.',
      },
    });
    // The ticket kickoff is one-shot (delivered by the adapter on turn 1
    // only, see hermes-adapter.test.ts), so it must NOT be folded into the
    // persistent `instructions` field alongside channel promptDefaults.
    expect(
      (result as { extra: { instructions?: string } }).extra.instructions
    ).toBeUndefined();
  });

  it('keeps channel promptDefaults instructions (persistent) separate from the ticket initial prompt (one-shot)', () => {
    const result = buildHermesCreateExtra('hermes', {
      workspaceTopic: {
        id: 'topic-1',
        promptDefaults: { instructions: 'Prefer terse answers.' },
      },
      ticketContext: ticket,
      initialPrompt: 'You are working on ticket GH-42.',
    });
    expect(result).toMatchObject({
      extra: {
        instructions: 'Prefer terse answers.',
        initialInstructions: 'You are working on ticket GH-42.',
      },
    });
  });

  it('omits ticket metadata fields when there is no ticketContext', () => {
    const result = buildHermesCreateExtra('hermes', {
      repoPath: '/configured/repo',
      initialPrompt: 'plain initial prompt, no ticket',
    });
    expect(result).toMatchObject({
      extra: { initialInstructions: 'plain initial prompt, no ticket' },
    });
    const metadata = (
      result as { extra: { metadata?: Record<string, string> } }
    ).extra.metadata;
    expect(metadata?.['relay_ticket_id']).toBeUndefined();
  });
});

describe('validateTicketContext + buildTicketInitialPrompt (shared by both mode branches)', () => {
  const configuredWorkspaces = [ticket.repoPath];

  it('accepts a well-formed github ticket context', () => {
    expect(validateTicketContext(ticket, configuredWorkspaces)).toBeNull();
  });

  it('rejects a malformed github ticketId the same way regardless of the caller', () => {
    const bad: TicketContext = { ...ticket, ticketId: '42' };
    expect(validateTicketContext(bad, configuredWorkspaces)).toBe(
      'ticketContext.ticketId for github must match GH-<number>'
    );
  });

  it('rejects a repoPath that is not a configured workspace', () => {
    expect(validateTicketContext(ticket, [])).toBe(
      'ticketContext.repoPath is not a configured workspace'
    );
  });

  it('renders the initial prompt template with ticket fields', () => {
    const prompt = buildTicketInitialPrompt(ticket, undefined);
    expect(prompt).toContain('GH-42');
    expect(prompt).toContain('Fix the thing');
    expect(prompt).toContain(ticket.url);
  });
});
