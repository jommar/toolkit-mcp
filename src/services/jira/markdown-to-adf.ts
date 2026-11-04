import { lexer } from 'marked';
import type { Token, Tokens } from 'marked';

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
}

export interface AdfDocument {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

const MENTION_TOKEN = /\[~accountid:([^\]]+)\]/g;
const LINKABLE_HREF = /^(https?:|mailto:)/i;
const HTML_LINE_BREAK = /^<br\s*\/?>$/i;

const EMPHASIS_MARKS: Record<string, string> = { strong: 'strong', em: 'em', del: 'strike' };

/** Block types ADF accepts directly inside a list item or a blockquote. */
const NESTABLE_BLOCKS = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock']);

const OPEN_TASK = '[ ] ';
const CHECKED_TASK = '[x] ';

const textNode = (text: string): AdfNode => ({ type: 'text', text });
const hardBreak = (): AdfNode => ({ type: 'hardBreak' });
const paragraph = (content: AdfNode[] = []): AdfNode => ({ type: 'paragraph', content });

/** Split text on `[~accountid:<id>]` tokens into text and mention nodes; empty text yields no nodes. */
export function splitMentions(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_TOKEN)) {
    if (match.index > cursor) nodes.push(textNode(text.slice(cursor, match.index)));
    nodes.push({ type: 'mention', attrs: { id: match[1] } });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(textNode(text.slice(cursor)));
  return nodes;
}

/** Convert Markdown (GFM) to an ADF document; mention tokens become mention nodes wherever inline text is allowed. */
export function markdownToAdf(markdown: string): AdfDocument {
  return { type: 'doc', version: 1, content: lexer(markdown).flatMap(blockNodes) };
}

function blockNodes(token: Token): AdfNode[] {
  switch (token.type) {
    case 'space':
    case 'checkbox':
      return [];
    case 'paragraph':
    case 'text':
      return textBlock('paragraph', token.tokens ?? []);
    case 'heading':
      return textBlock('heading', token.tokens ?? [], { level: token.depth });
    case 'code':
      return [codeBlock(token as Tokens.Code)];
    case 'blockquote':
      return [{ type: 'blockquote', content: nestedBlocks(token.tokens ?? []) }];
    case 'list':
      return [listNode(token as Tokens.List)];
    case 'hr':
      return [{ type: 'rule' }];
    case 'table':
      return [tableNode(token as Tokens.Table)];
    default:
      return [literalParagraph(token)];
  }
}

/** Keep the source of a token as plain text when ADF has no node for it (raw HTML, unsupported nesting). */
function literalParagraph(token: Token): AdfNode {
  return paragraph(textNodes(token.raw.trim(), []));
}

function textBlock(type: string, tokens: Token[], attrs?: Record<string, unknown>): AdfNode[] {
  const content = inlineNodes(tokens);
  return content.length ? [{ type, ...(attrs ? { attrs } : {}), content }] : [];
}

function nestedBlocks(tokens: Token[]): AdfNode[] {
  return tokens.flatMap((token) => {
    const nodes = blockNodes(token);
    return nodes.every((node) => NESTABLE_BLOCKS.has(node.type)) ? nodes : [literalParagraph(token)];
  });
}

function codeBlock(token: Tokens.Code): AdfNode {
  const language = token.lang?.split(/\s+/)[0];
  return {
    type: 'codeBlock',
    ...(language ? { attrs: { language } } : {}),
    ...(token.text ? { content: [textNode(token.text)] } : {}),
  };
}

function listNode(list: Tokens.List): AdfNode {
  const content = list.items.map(listItemNode);
  return list.ordered
    ? { type: 'orderedList', attrs: { order: Number(list.start) }, content }
    : { type: 'bulletList', content };
}

function listItemNode(item: Tokens.ListItem): AdfNode {
  const blocks = nestedBlocks(item.tokens);
  const content = item.task ? withTaskMarker(blocks, Boolean(item.checked)) : blocks;
  return { type: 'listItem', content: content.length ? content : [paragraph()] };
}

/** ADF task lists need ids and state attrs, so a task item stays a bullet that starts with its `[ ]` / `[x]` marker. */
function withTaskMarker(blocks: AdfNode[], checked: boolean): AdfNode[] {
  const marker = textNode(checked ? CHECKED_TASK : OPEN_TASK);
  const [first, ...rest] = blocks;
  return first?.type === 'paragraph'
    ? [paragraph([marker, ...(first.content ?? [])]), ...rest]
    : [paragraph([marker]), ...blocks];
}

function tableNode(table: Tokens.Table): AdfNode {
  const row = (cells: Tokens.TableCell[]): AdfNode => ({ type: 'tableRow', content: cells.map(cellNode) });
  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content: [row(table.header), ...table.rows.map(row)],
  };
}

function cellNode(cell: Tokens.TableCell): AdfNode {
  return { type: cell.header ? 'tableHeader' : 'tableCell', content: [paragraph(inlineNodes(cell.tokens))] };
}

function inlineNodes(tokens: Token[], marks: AdfMark[] = []): AdfNode[] {
  const nodes: AdfNode[] = [];
  let pending = '';
  const flushText = () => {
    nodes.push(...textNodes(pending, marks));
    pending = '';
  };
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape':
        pending += token.text;
        break;
      case 'codespan':
        flushText();
        nodes.push({ type: 'text', text: token.text, marks: codeMarks(marks) });
        break;
      case 'strong':
      case 'em':
      case 'del':
        flushText();
        nodes.push(...inlineNodes(token.tokens ?? [], [...marks, { type: EMPHASIS_MARKS[token.type] }]));
        break;
      case 'link':
        flushText();
        nodes.push(...inlineNodes(token.tokens ?? [], withLink(marks, token.href)));
        break;
      case 'image':
        flushText();
        nodes.push(...textNodes(token.text || token.href, withLink(marks, token.href)));
        break;
      case 'br':
        flushText();
        nodes.push(hardBreak());
        break;
      default:
        if (token.type === 'html' && HTML_LINE_BREAK.test(token.raw)) {
          flushText();
          nodes.push(hardBreak());
        } else {
          pending += token.raw;
        }
    }
  }
  flushText();
  return nodes;
}

/** Text with each newline as a hardBreak and mention tokens as mention nodes (which cannot carry marks). */
function textNodes(text: string, marks: AdfMark[]): AdfNode[] {
  return text.split('\n').flatMap((line, index) => [
    ...(index ? [hardBreak()] : []),
    ...splitMentions(line).map((node) => (node.type === 'text' && marks.length ? { ...node, marks } : node)),
  ]);
}

/** ADF lets inline code combine only with a link, so other active marks are dropped. */
function codeMarks(marks: AdfMark[]): AdfMark[] {
  return [{ type: 'code' }, ...marks.filter((mark) => mark.type === 'link')];
}

function withLink(marks: AdfMark[], href: string): AdfMark[] {
  return LINKABLE_HREF.test(href) ? [...marks, { type: 'link', attrs: { href } }] : marks;
}
