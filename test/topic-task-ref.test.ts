import { describe, expect, it } from 'vitest';

import { taskRefFromDraft } from '../frontend/src/lib/topic-task-ref.js';

describe('topic task ref parsing', () => {
  it('keeps arbitrary prompts with digits external', () => {
    expect(taskRefFromDraft('Fix bug in v2', 'Fix bug')).toEqual({
      kind: 'external',
      id: 'Fix bug in v2',
      title: 'Fix bug',
    });

    expect(taskRefFromDraft('task 999', 'Task phrase')).toEqual({
      kind: 'external',
      id: 'task 999',
      title: 'Task phrase',
    });
  });

  it('keeps ticket-like non-GitHub refs external', () => {
    expect(taskRefFromDraft('JIRA-123', 'Jira task')).toEqual({
      kind: 'external',
      id: 'JIRA-123',
      title: 'Jira task',
    });
  });

  it('parses explicit hash issue refs as GitHub issues', () => {
    expect(taskRefFromDraft('#1045', 'GitHub task')).toEqual({
      kind: 'github-issue',
      id: '1045',
      title: 'GitHub task',
    });
  });

  it('parses GitHub issue URLs as GitHub issues with the source URL', () => {
    const url = 'https://github.com/donovan-yohan/relay-ide/issues/1045';

    expect(taskRefFromDraft(url, 'Issue URL')).toEqual({
      kind: 'github-issue',
      id: '1045',
      title: 'Issue URL',
      url,
    });
  });

  it('parses explicit issues path refs as GitHub issues', () => {
    expect(taskRefFromDraft('issues/1045', 'Issue path')).toEqual({
      kind: 'github-issue',
      id: '1045',
      title: 'Issue path',
    });
  });

  it('parses pure numeric issue ids as GitHub issues', () => {
    expect(taskRefFromDraft('1045', 'Numeric issue')).toEqual({
      kind: 'github-issue',
      id: '1045',
      title: 'Numeric issue',
    });
  });
});
