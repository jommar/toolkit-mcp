import { describe, it, expect } from 'vitest';
import { toSlimIssue, toSlimComment, toSlimAttachment, adfToText } from './slim.js';
import type { JiraIssue } from './jira/jira-client.js';

describe('toSlimIssue', () => {
  const fullIssue: JiraIssue = {
    id: '100',
    key: 'TRIPS-42',
    fields: {
      summary: 'Fix the bug',
      status: { name: 'In Progress' },
      issuetype: { name: 'Bug' },
      assignee: { displayName: 'Alice' },
      reporter: { displayName: 'Bob' },
      priority: { name: 'High' },
      labels: ['bug', 'frontend'],
      created: '2025-01-01T00:00:00Z',
      updated: '2025-01-02T00:00:00Z',
      parent: { key: 'EPIC-1' },
      subtasks: [
        { key: 'SUB-1' },
        { key: 'SUB-2' },
      ],
      description: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'This is a description' }] },
        ],
      },
      comment: {
        total: 2,
        comments: [
          { id: 'c1', author: { displayName: 'Alice' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First comment' }] }] }, created: '2025-01-01T00:00:00Z' },
          { id: 'c2', author: { displayName: 'Bob' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second comment' }] }] }, created: '2025-01-02T00:00:00Z' },
        ],
      },
      attachment: [
        {
          id: 'a1',
          filename: 'screenshot.png',
          author: { displayName: 'Alice' },
          created: '2025-01-01T00:00:00Z',
          size: 1024,
          mimeType: 'image/png',
          content: 'http://example.com/a1',
          thumbnail: 'http://example.com/a1_thumb',
        },
      ],
    },
  };

  it('flattens a full Jira issue correctly', () => {
    const slim = toSlimIssue(fullIssue);
    expect(slim.key).toBe('TRIPS-42');
    expect(slim.summary).toBe('Fix the bug');
    expect(slim.status).toBe('In Progress');
    expect(slim.type).toBe('Bug');
    expect(slim.assignee).toBe('Alice');
    expect(slim.reporter).toBe('Bob');
    expect(slim.priority).toBe('High');
    expect(slim.labels).toEqual(['bug', 'frontend']);
    expect(slim.created).toBe('2025-01-01T00:00:00Z');
    expect(slim.updated).toBe('2025-01-02T00:00:00Z');
    expect(slim.parent).toBe('EPIC-1');
    expect(slim.subtasks).toEqual(['SUB-1', 'SUB-2']);
    expect(slim.description).toBe('This is a description');
    expect(slim.comments).toHaveLength(2);
    // Comments are reversed (most recent first)
    expect(slim.comments[0].author).toBe('Bob');
    expect(slim.comments[0].body).toBe('Second comment');
    expect(slim.comments[1].author).toBe('Alice');
    expect(slim.comments[1].body).toBe('First comment');
    expect(slim.attachments).toHaveLength(1);
    expect(slim.attachments[0].filename).toBe('screenshot.png');
  });

  it('handles null fields gracefully', () => {
    const issue: JiraIssue = {
      id: '1',
      key: 'TEST-1',
      fields: {
        summary: undefined,
        status: null,
        issuetype: null,
        assignee: null,
        reporter: null,
        priority: null,
        labels: null,
        created: null,
        updated: null,
        parent: null,
        subtasks: null,
        description: null,
        comment: null,
        attachment: null,
      },
    };
    const slim = toSlimIssue(issue);
    expect(slim.summary).toBe('');
    expect(slim.status).toBeNull();
    expect(slim.type).toBeNull();
    expect(slim.assignee).toBeNull();
    expect(slim.reporter).toBeNull();
    expect(slim.priority).toBeNull();
    expect(slim.labels).toEqual([]);
    expect(slim.created).toBeNull();
    expect(slim.updated).toBeNull();
    expect(slim.parent).toBeNull();
    expect(slim.subtasks).toEqual([]);
    expect(slim.description).toBeNull();
    expect(slim.comments).toEqual([]);
    expect(slim.attachments).toEqual([]);
  });

  it('handles empty arrays for subtasks/comments/attachments', () => {
    const issue: JiraIssue = {
      id: '1',
      key: 'TEST-1',
      fields: {
        summary: 'Test',
        subtasks: [],
        comment: { total: 0, comments: [] },
        attachment: [],
      },
    };
    const slim = toSlimIssue(issue);
    expect(slim.subtasks).toEqual([]);
    expect(slim.comments).toEqual([]);
    expect(slim.attachments).toEqual([]);
  });

  it('comments are reversed (most recent first)', () => {
    const issue: JiraIssue = {
      id: '1',
      key: 'TEST-1',
      fields: {
        summary: 'Test',
        comment: {
          total: 2,
          comments: [
            { id: 'old', author: { displayName: 'A' }, body: null, created: '2025-01-01T00:00:00Z' },
            { id: 'new', author: { displayName: 'B' }, body: null, created: '2025-01-02T00:00:00Z' },
          ],
        },
      },
    };
    const slim = toSlimIssue(issue);
    expect(slim.comments[0].id).toBe('new');
    expect(slim.comments[1].id).toBe('old');
  });
});

describe('toSlimComment', () => {
  it('includes id field', () => {
    const raw = { id: 'c1', author: { displayName: 'Alice' }, body: { type: 'doc', content: [] }, created: '2025-01-01T00:00:00Z' };
    const comment = toSlimComment(raw);
    expect(comment.id).toBe('c1');
  });

  it('handles null/undefined body', () => {
    const raw = { id: 'c2', author: null, body: null, created: null };
    const comment = toSlimComment(raw);
    expect(comment.id).toBe('c2');
    expect(comment.author).toBeNull();
    expect(comment.body).toBeNull();
    expect(comment.created).toBeNull();
  });

  it('handles missing id', () => {
    const comment = toSlimComment({});
    expect(comment.id).toBe('');
  });
});

describe('toSlimAttachment', () => {
  it('maps all fields', () => {
    const raw = {
      id: 'a1',
      filename: 'file.pdf',
      author: { displayName: 'Alice' },
      created: '2025-01-01T00:00:00Z',
      size: 5000,
      mimeType: 'application/pdf',
      content: 'http://example.com/file.pdf',
      thumbnail: 'http://example.com/thumb.png',
    };
    const att = toSlimAttachment(raw);
    expect(att.id).toBe('a1');
    expect(att.filename).toBe('file.pdf');
    expect(att.author).toBe('Alice');
    expect(att.created).toBe('2025-01-01T00:00:00Z');
    expect(att.size).toBe(5000);
    expect(att.mimeType).toBe('application/pdf');
    expect(att.content).toBe('http://example.com/file.pdf');
    expect(att.thumbnail).toBe('http://example.com/thumb.png');
  });

  it('handles missing optional fields', () => {
    const raw = { id: 'a1', filename: 'f.txt', content: '' };
    const att = toSlimAttachment(raw);
    expect(att.author).toBeNull();
    expect(att.created).toBeNull();
    expect(att.size).toBe(0);
    expect(att.mimeType).toBe('');
    expect(att.thumbnail).toBeNull();
  });
});

describe('adfToText', () => {
  it('handles null input', () => {
    expect(adfToText(null)).toBeNull();
    expect(adfToText(undefined)).toBeNull();
  });

  it('handles string input (passthrough)', () => {
    expect(adfToText('hello')).toBe('hello');
  });

  it('handles text node', () => {
    expect(adfToText({ type: 'text', text: 'hello' })).toBe('hello');
  });

  it('handles paragraph with text runs', () => {
    const node = {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ],
    };
    expect(adfToText(node)).toBe('Hello world');
  });

  it('handles heading with text', () => {
    const node = {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Title' }],
    };
    expect(adfToText(node)).toBe('Title');
  });

  it('handles doc with multiple paragraphs (newline separator)', () => {
    const node = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
      ],
    };
    expect(adfToText(node)).toBe('First paragraph\nSecond paragraph');
  });

  it('handles nested bullet list', () => {
    const node = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] },
              ],
            },
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToText(node)).toBe('Item 1\nItem 2');
  });

  it('handles empty doc', () => {
    expect(adfToText({ type: 'doc', version: 1, content: [] })).toBeNull();
  });

  it('handles nested content (blockquote)', () => {
    const node = {
      type: 'blockquote',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Quoted text' }] },
      ],
    };
    expect(adfToText(node)).toBe('Quoted text');
  });

  it('handles empty content array', () => {
    expect(adfToText({ type: 'paragraph', content: [] })).toBeNull();
  });

  it('handles mixed content with null entries', () => {
    const node = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
      ],
    };
    expect(adfToText(node)).toBe('A\nB');
  });
});
