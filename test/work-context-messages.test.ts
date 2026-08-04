import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkContextMessageRouter } from '../server/features/work-context-message-router.js';
import { attachAuthenticatedCliGatewayActorCredential } from '../server/cli-gateway-actor-auth.js';
import {
  createWorkContextMessageStore,
  type WorkContextMessageStore,
} from '../server/work-context-messages.js';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';

const cleanup: Array<() => void> = [];

function tempDb(name: string): string {
  return path.join(os.tmpdir(), `relay-work-context-messages-${process.pid}-${Date.now()}-${name}.db`);
}

function messageInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workContextId: 'wc:949',
    kind: 'handoff',
    sender: { kind: 'agent', id: 'agent:ebi', displayName: 'Ebi' },
    audience: [{ kind: 'role', id: 'qa' }],
    summary: 'implementation handoff for #949',
    payloadSchema: 'relay.pipeline.handoff.v1',
    refs: {
      taskRefs: [{ kind: 'github-issue', id: '949', title: 'WorkContext messages' }],
      repo: { ownerRepo: 'donovan-yohan/relay-ide', branchName: 'ebi/949-workcontext-messages' },
      external: [{ kind: 'github-pr', id: '951', url: 'https://github.com/donovan-yohan/relay-ide/pull/951' }],
    },
    payload: {
      mediaType: 'application/json',
      encoding: 'json',
      body: {
        arbitraryContract: { ok: true },
        token: 'must-redact',
        access_token: 'must-redact-snake-case',
        raw_transcript: 'must-redact-raw-transcript',
        nested: { password: 'must-redact-too', keep: 'safe' },
      },
    },
    ...overrides,
  };
}

function withStore(name: string): WorkContextMessageStore {
  const store = createWorkContextMessageStore(tempDb(name));
  cleanup.push(() => store.close());
  return store;
}

function tempRepo(name: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `relay-message-template-${process.pid}-${name}-`));
  fs.mkdirSync(path.join(repo, '.relay', 'messages'), { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  cleanup.push(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

function scopedCredential(workContextIds: string[]): ScopedActorCredentialRecord {
  return {
    id: 'credential:test',
    actor: { type: 'agent', id: 'agent:scoped', displayName: 'Scoped Agent' },
    issuer: { id: 'operator:test' },
    audience: 'relay:cli-gateway:v1',
    capabilities: ['context:read', 'context:write'],
    scope: { workContextIds },
    issuedAt: '2026-06-13T00:00:00.000Z',
    expiresAt: '2026-06-14T00:00:00.000Z',
    correlationId: 'corr-test',
  } as ScopedActorCredentialRecord;
}

async function startRouter(
  store: WorkContextMessageStore | null,
  credential?: ScopedActorCredentialRecord
) {
  const events: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  app.use(
    createWorkContextMessageRouter({
      store,
      requireAuth: (req, _res, next) => {
        if (credential) attachAuthenticatedCliGatewayActorCredential(req, credential);
        next();
      },
      events: {
        publish: (event) => {
          events.push(event as unknown as Record<string, unknown>);
          return event as never;
        },
      },
    })
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  cleanup.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, events };
}

async function jsonFetch(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-relay-capabilities': 'context:read,context:write',
      ...(init.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json() };
}

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe('WorkContext message store', () => {
  it('appends opaque payloads, redacts forbidden keys, indexes refs, and threads replies', () => {
    const store = withStore('store');
    const first = store.append(messageInput());
    expect(first.id).toMatch(/^wcm:/);
    expect(first.refs.threadId).toBe(first.id);
    expect(first.payload.body).toEqual({
      arbitraryContract: { ok: true },
      nested: { keep: 'safe' },
    });
    expect(first.redaction.omittedKeys).toEqual([
      'payload.body.token',
      'payload.body.access_token',
      'payload.body.raw_transcript',
      'payload.body.nested.password',
    ]);
    expect(first.payload.byteCount).toBe(Buffer.byteLength(JSON.stringify(first.payload), 'utf8'));

    const reply = store.append(
      messageInput({
        kind: 'question',
        summary: 'qa question',
        payloadSchema: 'relay.qa.question.v1',
        parentMessageId: first.id,
        refs: { taskRefs: [{ kind: 'github-issue', id: '949' }] },
      })
    );
    expect(reply.refs.parentMessageId).toBe(first.id);
    expect(reply.refs.threadId).toBe(first.id);
    expect(store.list({ threadId: first.id }).map((msg) => msg.id)).toEqual([reply.id, first.id]);
    expect(store.list({ refKind: 'task.github-issue', refValue: '949' })).toHaveLength(2);
    expect(store.list({ payloadSchema: 'relay.pipeline.handoff.v1' })[0]?.id).toBe(first.id);
  });

  it('owns ids and timestamps even when append input supplies provenance fields', () => {
    const store = withStore('provenance');
    const message = store.append(
      messageInput({ id: 'wcm:caller-controlled', createdAt: '2000-01-01T00:00:00.000Z' })
    );

    expect(message.id).toMatch(/^wcm:/);
    expect(message.id).not.toBe('wcm:caller-controlled');
    expect(message.createdAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(message.updatedAt).toBe(message.createdAt);
  });

  it('rejects deeply nested payloads and incomplete filter pairs', () => {
    const store = withStore('defensive-validation');
    store.append(messageInput());
    let body: unknown = 'leaf';
    for (let index = 0; index < 55; index += 1) body = { child: body };

    expect(() =>
      store.append(messageInput({ payload: { mediaType: 'application/json', encoding: 'json', body } }))
    ).toThrow(/deeply nested/);
    expect(() => store.list({ workContextId: 'wc:949', refKind: 'task.github-issue' })).toThrow(/refKind/);
    expect(() => store.list({ workContextId: 'wc:949', audienceId: 'qa' })).toThrow(/audienceKind/);
  });

  it('derives thread roots server-side instead of trusting caller-provided threadId', () => {
    const store = withStore('thread-spoof');
    const first = store.append(messageInput({ workContextId: 'wc:first' }));
    const second = store.append(
      messageInput({
        workContextId: 'wc:second',
        refs: { threadId: first.id, taskRefs: [{ kind: 'github-issue', id: '949' }] },
      })
    );

    expect(second.refs.threadId).toBe(second.id);
    expect(store.list({ threadId: first.id }).map((msg) => msg.id)).toEqual([first.id]);
  });
});

describe('WorkContext message router', () => {
  it('exposes append/list/show/query and emits a redacted metadata event', async () => {
    const store = withStore('router');
    const { baseUrl, events } = await startRouter(store);

    const appended = await jsonFetch(`${baseUrl}/work-context-messages`, {
      method: 'POST',
      body: JSON.stringify(messageInput()),
    });
    expect(appended.status).toBe(201);
    const messageId = appended.body.message.id as string;
    expect(appended.body.message.payload.body.token).toBeUndefined();
    expect(events).toMatchObject([
      {
        topic: 'context',
        type: 'work-context-message.appended',
        workContextId: 'wc:949',
        payload: { messageId, kind: 'handoff' },
      },
    ]);

    const listed = await jsonFetch(`${baseUrl}/work-context-messages?workContextId=wc%3A949`);
    expect(listed.status).toBe(200);
    expect(listed.body.messages.map((msg: { id: string }) => msg.id)).toEqual([messageId]);

    const shown = await jsonFetch(`${baseUrl}/work-context-messages/${encodeURIComponent(messageId)}`);
    expect(shown.status).toBe(200);
    expect(shown.body.message.id).toBe(messageId);

    const queried = await jsonFetch(`${baseUrl}/work-context-messages/query`, {
      method: 'POST',
      body: JSON.stringify({ refKind: 'task.github-issue', refValue: '949' }),
    });
    expect(queried.status).toBe(200);
    expect(queried.body.messages).toHaveLength(1);
  });

  it('applies repo-local templates to append inputs and exposes template discovery routes', async () => {
    const repo = tempRepo('router');
    fs.mkdirSync(path.join(repo, 'packages', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'packages', '.relay', 'messages'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.relay', 'messages', 'qa-handoff.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'relay.qa.handoff',
        name: 'QA handoff',
        kind: 'qa-handoff',
        payloadSchema: 'relay.qa.handoff.v1',
        mediaType: 'application/json',
        encoding: 'json',
        bodyGuide: { required: ['exactHead'] },
      })
    );
    fs.writeFileSync(
      path.join(repo, 'packages', '.relay', 'messages', 'qa-handoff-override.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'relay.qa.handoff',
        name: 'Package QA handoff',
        kind: 'package-qa-handoff',
        payloadSchema: 'relay.package.qa.handoff.v1',
        mediaType: 'application/json',
        encoding: 'json',
      })
    );
    const store = withStore('template-router');
    const { baseUrl } = await startRouter(store);

    const listed = await jsonFetch(
      `${baseUrl}/work-context-message-templates?repoPath=${encodeURIComponent(path.join(repo, 'packages', 'nested'))}`
    );
    expect(listed.status).toBe(200);
    expect(listed.body.templates).toMatchObject([
      { id: 'relay.qa.handoff', kind: 'package-qa-handoff', payloadSchema: 'relay.package.qa.handoff.v1' },
    ]);

    const shown = await jsonFetch(
      `${baseUrl}/work-context-message-templates/${encodeURIComponent('relay.qa.handoff')}?repoPath=${encodeURIComponent(path.join(repo, 'packages', 'nested'))}`
    );
    expect(shown.status).toBe(200);
    expect(shown.body.template).toMatchObject({
      id: 'relay.qa.handoff',
      kind: 'package-qa-handoff',
      payloadSchema: 'relay.package.qa.handoff.v1',
    });

    const rendered = await jsonFetch(`${baseUrl}/work-context-message-templates/render`, {
      method: 'POST',
      body: JSON.stringify({
        repoPath: repo,
        template: 'relay.qa.handoff',
        templateData: { exactHead: 'abc1234' },
        message: { workContextId: 'wc:949', summary: 'qa handoff requested' },
      }),
    });
    expect(rendered.status).toBe(200);
    expect(rendered.body.messageInput).toMatchObject({
      kind: 'qa-handoff',
      payloadSchema: 'relay.qa.handoff.v1',
      payload: {
        mediaType: 'application/json',
        encoding: 'json',
        body: { exactHead: 'abc1234' },
      },
    });

    const renderedFromEnvelopeBody = await jsonFetch(`${baseUrl}/work-context-message-templates/render`, {
      method: 'POST',
      body: JSON.stringify({
        repoPath: repo,
        template: 'relay.qa.handoff',
        templateData: { exactHead: 'def5678' },
        workContextId: 'wc:949',
        summary: 'qa handoff requested',
      }),
    });
    expect(renderedFromEnvelopeBody.status).toBe(200);
    expect(renderedFromEnvelopeBody.body.messageInput).toMatchObject({
      workContextId: 'wc:949',
      summary: 'qa handoff requested',
      kind: 'qa-handoff',
      payload: { body: { exactHead: 'def5678' } },
    });
    expect(renderedFromEnvelopeBody.body.messageInput).not.toHaveProperty('repoPath');
    expect(renderedFromEnvelopeBody.body.messageInput).not.toHaveProperty('template');
    expect(renderedFromEnvelopeBody.body.messageInput).not.toHaveProperty('templateData');

    const appended = await jsonFetch(`${baseUrl}/work-context-messages`, {
      method: 'POST',
      body: JSON.stringify({
        repoPath: repo,
        template: 'qa-handoff',
        workContextId: 'wc:949',
        summary: 'qa handoff requested',
        payload: { body: { exactHead: 'abc1234' } },
      }),
    });
    expect(appended.status).toBe(201);
    expect(appended.body.message).toMatchObject({
      kind: 'qa-handoff',
      payloadSchema: 'relay.qa.handoff.v1',
      payload: {
        mediaType: 'application/json',
        encoding: 'json',
        body: { exactHead: 'abc1234' },
      },
    });
  });

  it('rejects caller-selected template repo paths for WorkContext-scoped actor credentials', async () => {
    const repo = tempRepo('scoped-template-router');
    fs.writeFileSync(
      path.join(repo, '.relay', 'messages', 'qa-handoff.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'relay.qa.handoff',
        name: 'QA handoff',
        kind: 'qa-handoff',
        payloadSchema: 'relay.qa.handoff.v1',
        mediaType: 'application/json',
        encoding: 'json',
      })
    );
    const store = withStore('scoped-template-router');
    const { baseUrl } = await startRouter(store, scopedCredential(['wc:949']));

    const listed = await jsonFetch(
      `${baseUrl}/work-context-message-templates?repoPath=${encodeURIComponent(repo)}`
    );
    expect(listed.status).toBe(403);
    expect(listed.body.error.details.reasonCode).toBe('CLI_ACTOR_REPO_PATH_SELECTOR_FORBIDDEN');

    const appended = await jsonFetch(`${baseUrl}/work-context-messages`, {
      method: 'POST',
      body: JSON.stringify({
        repoPath: repo,
        template: 'qa-handoff',
        workContextId: 'wc:949',
        summary: 'qa handoff requested',
      }),
    });
    expect(appended.status).toBe(403);
    expect(appended.body.error.details.reasonCode).toBe('CLI_ACTOR_REPO_PATH_SELECTOR_FORBIDDEN');
  });

  it('fails closed when queries are unbounded or the store is unavailable', async () => {
    const store = withStore('errors');
    const { baseUrl } = await startRouter(store);
    const unbounded = await jsonFetch(`${baseUrl}/work-context-messages`);
    expect(unbounded.status).toBe(400);
    expect(unbounded.body.error.code).toBe('INVALID_ARGUMENT');

    const partialRef = await jsonFetch(`${baseUrl}/work-context-messages?workContextId=wc%3A949&refKind=task.github-issue`);
    expect(partialRef.status).toBe(400);
    expect(partialRef.body.error.message).toMatch(/refKind and refValue/);

    const partialAudience = await jsonFetch(`${baseUrl}/work-context-messages?workContextId=wc%3A949&audienceId=qa`);
    expect(partialAudience.status).toBe(400);
    expect(partialAudience.body.error.message).toMatch(/audienceKind/);

    const unavailable = await startRouter(null);
    const response = await jsonFetch(`${unavailable.baseUrl}/work-context-messages?workContextId=wc%3A949`);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVER_UNAVAILABLE');
  });

  it('derives scoped actor senders and enforces WorkContext scope after ref-only queries', async () => {
    const store = withStore('scoped-router');
    store.append(messageInput({ workContextId: 'wc:other' }));
    const { baseUrl } = await startRouter(store, scopedCredential(['wc:949']));

    const appended = await jsonFetch(`${baseUrl}/work-context-messages`, {
      method: 'POST',
      body: JSON.stringify(
        messageInput({
          sender: { kind: 'agent', id: 'agent:spoofed' },
        })
      ),
    });
    expect(appended.status).toBe(201);
    expect(appended.body.message.sender).toMatchObject({
      kind: 'agent',
      id: 'agent:scoped',
      displayName: 'Scoped Agent',
    });

    const allowed = await jsonFetch(`${baseUrl}/work-context-messages/query`, {
      method: 'POST',
      body: JSON.stringify({ refKind: 'task.github-issue', refValue: '949', workContextId: 'wc:949' }),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.messages.map((msg: { workContextId: string }) => msg.workContextId)).toEqual([
      'wc:949',
    ]);

    const denied = await jsonFetch(`${baseUrl}/work-context-messages/query`, {
      method: 'POST',
      body: JSON.stringify({ refKind: 'task.github-issue', refValue: '949' }),
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.reasonCode).toBe('CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE');
  });
});
