import { describe, it, expect } from 'vitest';
import { markdownToAdf, splitMentions } from './markdown-to-adf.js';
import type { AdfMark, AdfNode } from './markdown-to-adf.js';

const ACCOUNT_ID = '712020:e130b750-b09b-4d24-95b9-d72d503e4911';
const OTHER_ACCOUNT_ID = '5b10ac8d82e05b22cc7d4ef5';

const doc = (...content: AdfNode[]) => ({ type: 'doc', version: 1, content });
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const t = (text: string, ...marks: AdfMark[]): AdfNode => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const mention = (id: string): AdfNode => ({ type: 'mention', attrs: { id } });
const hardBreak: AdfNode = { type: 'hardBreak' };
const mark = (type: string, attrs?: Record<string, unknown>): AdfMark => ({ type, ...(attrs ? { attrs } : {}) });
const link = (href: string) => mark('link', { href });
const item = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content });
const bullets = (...items: AdfNode[]): AdfNode => ({ type: 'bulletList', content: items });
const cell = (type: 'tableHeader' | 'tableCell', ...content: AdfNode[]): AdfNode => ({ type, content: [p(...content)] });

const convert = (markdown: string) => markdownToAdf(markdown).content;

describe('splitMentions', () => {
  it('turns tokens into mention nodes and keeps the text around them', () => {
    expect(splitMentions(`Hi [~accountid:${ACCOUNT_ID}], and [~accountid:${OTHER_ACCOUNT_ID}]!`)).toEqual([
      t('Hi '),
      mention(ACCOUNT_ID),
      t(', and '),
      mention(OTHER_ACCOUNT_ID),
      t('!'),
    ]);
  });

  it('returns a single text node when there is no token', () => {
    expect(splitMentions('Just text [~notamention] [~accountid:]')).toEqual([t('Just text [~notamention] [~accountid:]')]);
  });

  it('leaves an unclosed token as text', () => {
    expect(splitMentions('see [~accountid:abc for details')).toEqual([t('see [~accountid:abc for details')]);
  });

  it('returns no nodes for an empty string, so no empty text node is produced', () => {
    expect(splitMentions('')).toEqual([]);
  });

  it('keeps back-to-back tokens without empty text between them', () => {
    expect(splitMentions('[~accountid:a][~accountid:b]')).toEqual([mention('a'), mention('b')]);
  });
});

describe('markdownToAdf blocks', () => {
  it('wraps the result in a version 1 doc', () => {
    expect(markdownToAdf('Hello')).toEqual(doc(p(t('Hello'))));
  });

  it('turns blank-line separated text into paragraphs', () => {
    expect(convert('First\n\nSecond')).toEqual([p(t('First')), p(t('Second'))]);
  });

  it.each([1, 2, 3, 4, 5, 6])('converts a level %i heading', (level) => {
    expect(convert(`${'#'.repeat(level)} Title`)).toEqual([
      { type: 'heading', attrs: { level }, content: [t('Title')] },
    ]);
  });

  it('converts a bullet list', () => {
    expect(convert('- one\n- two')).toEqual([bullets(item(p(t('one'))), item(p(t('two'))))]);
  });

  it('converts an ordered list and keeps its start number', () => {
    expect(convert('3. three\n4. four')).toEqual([
      {
        type: 'orderedList',
        attrs: { order: 3 },
        content: [item(p(t('three'))), item(p(t('four')))],
      },
    ]);
  });

  it('nests bullet and ordered lists inside list items', () => {
    expect(convert('- top\n  1. first\n  2. second\n     - deep\n- next')).toEqual([
      bullets(
        item(
          p(t('top')),
          {
            type: 'orderedList',
            attrs: { order: 1 },
            content: [item(p(t('first'))), item(p(t('second')), bullets(item(p(t('deep')))))],
          },
        ),
        item(p(t('next'))),
      ),
    ]);
  });

  it('keeps several blocks inside one list item', () => {
    expect(convert('- intro\n\n  more\n\n  ```js\n  run()\n  ```')).toEqual([
      bullets(
        item(
          p(t('intro')),
          p(t('more')),
          { type: 'codeBlock', attrs: { language: 'js' }, content: [t('run()')] },
        ),
      ),
    ]);
  });

  it('converts a fenced code block with its language', () => {
    expect(convert('```ts\nconst a = 1;\nconst b = 2;\n```')).toEqual([
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;\nconst b = 2;')] },
    ]);
  });

  it('uses only the first word of the fence info string as the language', () => {
    expect(convert('```js title=x\nrun()\n```')).toEqual([
      { type: 'codeBlock', attrs: { language: 'js' }, content: [t('run()')] },
    ]);
  });

  it('omits the language attr and the content when the fence has neither', () => {
    expect(convert('```\n```')).toEqual([{ type: 'codeBlock' }]);
    expect(convert('```\nplain\n```')).toEqual([{ type: 'codeBlock', content: [t('plain')] }]);
  });

  it('converts a blockquote, including a list inside it', () => {
    expect(convert('> quoted\n>\n> - a')).toEqual([
      { type: 'blockquote', content: [p(t('quoted')), bullets(item(p(t('a'))))] },
    ]);
  });

  it('converts a horizontal rule', () => {
    expect(convert('above\n\n---\n\nbelow')).toEqual([p(t('above')), { type: 'rule' }, p(t('below'))]);
  });
});

describe('markdownToAdf tables', () => {
  it('converts a GFM table with a header row, bold cells and a mention', () => {
    const markdown = [
      '| AC | Result | Evidence |',
      '| -- | ------ | -------- |',
      `| **AC1** | PASS | Printed [~accountid:${ACCOUNT_ID}] the block |`,
      '| **AC2** | NOT VERIFIED | One role only |',
    ].join('\n');

    expect(convert(markdown)).toEqual([
      {
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: [
          {
            type: 'tableRow',
            content: [
              cell('tableHeader', t('AC')),
              cell('tableHeader', t('Result')),
              cell('tableHeader', t('Evidence')),
            ],
          },
          {
            type: 'tableRow',
            content: [
              cell('tableCell', t('AC1', mark('strong'))),
              cell('tableCell', t('PASS')),
              cell('tableCell', t('Printed '), mention(ACCOUNT_ID), t(' the block')),
            ],
          },
          {
            type: 'tableRow',
            content: [
              cell('tableCell', t('AC2', mark('strong'))),
              cell('tableCell', t('NOT VERIFIED')),
              cell('tableCell', t('One role only')),
            ],
          },
        ],
      },
    ]);
  });

  it('wraps an empty cell in an empty paragraph and pads short rows', () => {
    const [table] = convert('| a | b |\n|---|---|\n| 1 |');

    expect(table.content![1]).toEqual({
      type: 'tableRow',
      content: [cell('tableCell', t('1')), { type: 'tableCell', content: [p()] }],
    });
  });

  it('reads an escaped pipe, in text or in code, as a literal pipe in the cell', () => {
    const [table] = convert('| h |\n|---|\n| a \\| b `c\\|d` |');

    expect(table.content![1].content![0]).toEqual(cell('tableCell', t('a | b '), t('c|d', mark('code'))));
  });

  it('turns <br> inside a cell into a hardBreak', () => {
    const [table] = convert('| h |\n|---|\n| one<br>two |');

    expect(table.content![1].content![0]).toEqual(cell('tableCell', t('one'), hardBreak, t('two')));
  });

  it('keeps a table with no body rows', () => {
    const [table] = convert('| a |\n|---|');

    expect(table.content).toEqual([{ type: 'tableRow', content: [cell('tableHeader', t('a'))] }]);
  });
});

describe('markdownToAdf inline marks', () => {
  it('converts bold, italic, strikethrough and inline code', () => {
    expect(convert('**b** *i* ~~s~~ `c`')).toEqual([
      p(
        t('b', mark('strong')),
        t(' '),
        t('i', mark('em')),
        t(' '),
        t('s', mark('strike')),
        t(' '),
        t('c', mark('code')),
      ),
    ]);
  });

  it('stacks marks for nested emphasis', () => {
    expect(convert('**bold *and italic***')).toEqual([
      p(t('bold ', mark('strong')), t('and italic', mark('strong'), mark('em'))),
    ]);
  });

  it('converts a link to a link mark', () => {
    expect(convert('see [the docs](https://example.com/a?b=1)')).toEqual([
      p(t('see '), t('the docs', link('https://example.com/a?b=1'))),
    ]);
  });

  it('keeps emphasis marks on link text', () => {
    expect(convert('[**docs**](https://example.com)')).toEqual([p(t('docs', link('https://example.com'), mark('strong')))]);
  });

  it('links bare urls and mailto links', () => {
    expect(convert('go to https://example.com/x or [mail](mailto:a@example.com)')).toEqual([
      p(t('go to '), t('https://example.com/x', link('https://example.com/x')), t(' or '), t('mail', link('mailto:a@example.com'))),
    ]);
  });

  it('keeps only the text of a link whose target is not an absolute http(s) or mailto url', () => {
    expect(convert('[rel](docs/readme.md) and [jump](#section)')).toEqual([p(t('rel'), t(' and '), t('jump'))]);
  });

  it('keeps a link on inline code and drops other marks from it', () => {
    expect(convert('[`code`](https://example.com) **`bold code`**')).toEqual([
      p(t('code', mark('code'), link('https://example.com')), t(' '), t('bold code', mark('code'))),
    ]);
  });

  it('turns an image into a link to its source', () => {
    expect(convert('![diagram](https://example.com/d.png)')).toEqual([
      p(t('diagram', link('https://example.com/d.png'))),
    ]);
  });
});

describe('markdownToAdf line breaks', () => {
  it('turns a single newline inside a paragraph into a hardBreak', () => {
    expect(convert('line one\nline two\nline three')).toEqual([
      p(t('line one'), hardBreak, t('line two'), hardBreak, t('line three')),
    ]);
  });

  it('turns a trailing double space and a trailing backslash into one hardBreak each', () => {
    expect(convert('one  \ntwo\\\nthree')).toEqual([p(t('one'), hardBreak, t('two'), hardBreak, t('three'))]);
  });

  it('keeps a line break that follows a marked span', () => {
    expect(convert('**bold**\nnext')).toEqual([p(t('bold', mark('strong')), hardBreak, t('next'))]);
  });

  it('turns an inline <br> into a hardBreak', () => {
    expect(convert('a<br>b<br/>c')).toEqual([p(t('a'), hardBreak, t('b'), hardBreak, t('c'))]);
  });

  it('still separates blocks with a blank line rather than a hardBreak', () => {
    expect(convert('a\n\nb')).toEqual([p(t('a')), p(t('b'))]);
  });
});

describe('markdownToAdf mentions', () => {
  it('converts a mention token in a paragraph', () => {
    expect(convert(`Hi [~accountid:${ACCOUNT_ID}], please review.`)).toEqual([
      p(t('Hi '), mention(ACCOUNT_ID), t(', please review.')),
    ]);
  });

  it('converts mention tokens in a list item and in a heading', () => {
    expect(convert(`# Hello [~accountid:${ACCOUNT_ID}]\n\n- ping [~accountid:${OTHER_ACCOUNT_ID}] now`)).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [t('Hello '), mention(ACCOUNT_ID)] },
      bullets(item(p(t('ping '), mention(OTHER_ACCOUNT_ID), t(' now')))),
    ]);
  });

  it('converts several mention tokens in one paragraph', () => {
    expect(convert(`[~accountid:${ACCOUNT_ID}] and [~accountid:${OTHER_ACCOUNT_ID}]`)).toEqual([
      p(mention(ACCOUNT_ID), t(' and '), mention(OTHER_ACCOUNT_ID)),
    ]);
  });

  it('puts a mention inside bold or a link as a plain mention node, which cannot carry marks', () => {
    expect(convert(`**Hi [~accountid:${ACCOUNT_ID}]**`)).toEqual([p(t('Hi ', mark('strong')), mention(ACCOUNT_ID))]);
  });

  it('keeps a token as literal text inside inline code and code blocks', () => {
    const token = `[~accountid:${ACCOUNT_ID}]`;

    expect(convert(`\`${token}\`\n\n\`\`\`\n${token}\n\`\`\``)).toEqual([
      p(t(token, mark('code'))),
      { type: 'codeBlock', content: [t(token)] },
    ]);
  });

  it('does not let a mention token at the start of a line be read as a link reference definition', () => {
    expect(convert(`[~accountid:${ACCOUNT_ID}]: LGTM`)).toEqual([p(mention(ACCOUNT_ID), t(': LGTM'))]);
  });

  it('leaves a malformed token as plain text', () => {
    expect(convert('[~accountid:] and [~notamention]')).toEqual([p(t('[~accountid:] and [~notamention]'))]);
  });
});

describe('markdownToAdf plain text edge cases', () => {
  it('returns an empty content array for empty and whitespace-only input', () => {
    expect(markdownToAdf('')).toEqual(doc());
    expect(markdownToAdf('  \n\n \t\n')).toEqual(doc());
  });

  it('keeps | outside a table, a lone *, intraword _ and an unmatched * as text', () => {
    expect(convert('a|b and 5 * 3 and snake_case_word and 2*3')).toEqual([
      p(t('a|b and 5 * 3 and snake_case_word and 2*3')),
    ]);
  });

  it('keeps backslash-escaped markers as literal text in one text node', () => {
    expect(convert('1 \\* 2 \\_ 3 \\| 4')).toEqual([p(t('1 * 2 _ 3 | 4'))]);
  });

  it('reads *x*, _x_ and **x** between words as emphasis, per Markdown', () => {
    expect(convert('a *b* c _d_ e')).toEqual([
      p(t('a '), t('b', mark('em')), t(' c '), t('d', mark('em')), t(' e')),
    ]);
  });

  it('keeps characters that look like markup but are not, such as > and &', () => {
    expect(convert('5 > 3 & 2 < 4')).toEqual([p(t('5 > 3 & 2 < 4'))]);
  });
});

describe('markdownToAdf fallbacks for markdown ADF cannot express', () => {
  it('keeps raw HTML as literal text', () => {
    expect(convert('<div>block</div>\n\ninline <b>bold</b> end')).toEqual([
      p(t('<div>block</div>')),
      p(t('inline <b>bold</b> end')),
    ]);
  });

  it('keeps a heading inside a list item as a literal paragraph', () => {
    expect(convert('- # not a heading')).toEqual([bullets(item(p(t('# not a heading'))))]);
  });

  it('keeps a table inside a blockquote as a literal paragraph', () => {
    expect(convert('> | a |\n> |---|\n> | 1 |')).toEqual([
      { type: 'blockquote', content: [p(t('| a |'), hardBreak, t('|---|'), hardBreak, t('| 1 |'))] },
    ]);
  });

  it('keeps a task list item as a bullet that starts with its marker', () => {
    expect(convert('- [ ] open\n- [x] done')).toEqual([
      bullets(item(p(t('[ ] '), t('open'))), item(p(t('[x] '), t('done')))),
    ]);
  });

  it('gives an empty list item an empty paragraph', () => {
    expect(convert('- \n- b')).toEqual([bullets(item(p()), item(p(t('b'))))]);
  });
});

describe('markdownToAdf output validity', () => {
  const LIST_ITEM_CHILDREN = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock']);
  const BLOCK_CHILDREN: Record<string, Set<string>> = {
    listItem: LIST_ITEM_CHILDREN,
    blockquote: LIST_ITEM_CHILDREN,
    tableCell: new Set(['paragraph']),
    tableHeader: new Set(['paragraph']),
  };

  function problems(node: AdfNode, path = node.type): string[] {
    const found: string[] = [];
    if (node.type === 'text') {
      if (!node.text) found.push(`${path}: empty text node`);
      const markTypes = (node.marks ?? []).map((m) => m.type);
      if (markTypes.includes('code') && markTypes.some((m) => m !== 'code' && m !== 'link')) {
        found.push(`${path}: code mark combined with ${markTypes.join(',')}`);
      }
    }
    if (node.type === 'mention' && node.marks) found.push(`${path}: mention carries marks`);
    const allowed = BLOCK_CHILDREN[node.type];
    for (const child of node.content ?? []) {
      if (allowed && !allowed.has(child.type)) found.push(`${path}: ${child.type} inside ${node.type}`);
      found.push(...problems(child, `${path}>${child.type}`));
    }
    return found;
  }

  const corpus: Record<string, string> = {
    sample: `**Result:** 2 pass\n\n| A | B |\n|---|---|\n| **x** | [~accountid:${ACCOUNT_ID}] |\n\n- a\n  - b\n1. c`,
    inlineCodeInEmphasis: '**`code` and *`more`***\n\n[`x`](https://example.com)',
    blocksInContainers: '- # h\n- > q\n- ---\n- | a |\n  |---|\n  | 1 |\n\n> # h\n> ---\n> > nested',
    emptyThings: '- \n-\n\n#\n\n| |\n|-|\n| |\n\n```\n```',
    tasks: '- [ ]\n- [x] a',
    html: '<br>\n\n<div>x</div> <br> <span>y</span>',
    mentions: `# [~accountid:${ACCOUNT_ID}]\n\n> [~accountid:${ACCOUNT_ID}] said\n\n**[~accountid:${ACCOUNT_ID}]**`,
    lineBreaks: 'a\nb  \nc\\\nd<br>e\n\n**x**\n*y*',
  };

  it.each(Object.entries(corpus))('has no empty text, invalid nesting or invalid marks: %s', (_name, markdown) => {
    const result = markdownToAdf(markdown);

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content.flatMap((node) => problems(node))).toEqual([]);
  });
});
