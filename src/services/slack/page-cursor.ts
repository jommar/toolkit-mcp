import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface CursorFields {
  target: string;
  position?: string;
  skip?: number;
  upper?: string;
}

export interface CursorPayload {
  target: string;
  position?: string;
  skip: number;
  upper?: string;
}

export type CursorDecoding =
  | { ok: true; payload: CursorPayload }
  | { ok: false; error: { code: 'invalid_cursor'; message: string } };

interface CursorRecord extends CursorPayload {
  tool: string;
}

const CURSOR_SEPARATOR = '.';
const INVALID_CURSOR_MESSAGE =
  'This cursor is not valid for this tool and target. Request the first page again without a cursor.';

// Held in memory only: an edited cursor fails the check, and a restarted server rejects cursors it issued before.
const SIGNING_KEY = randomBytes(32);

function signBody(body: string): string {
  return createHmac('sha256', SIGNING_KEY).update(body).digest('base64url');
}

export function encodeCursor(tool: string, fields: CursorFields): string {
  const record: CursorRecord = {
    tool,
    target: fields.target,
    position: fields.position,
    skip: fields.skip ?? 0,
    upper: fields.upper,
  };
  const body = Buffer.from(JSON.stringify(record)).toString('base64url');
  return `${body}${CURSOR_SEPARATOR}${signBody(body)}`;
}

function signatureMatches(body: string, signature: string): boolean {
  const expected = Buffer.from(signBody(body));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function openRecord(cursor: string): CursorRecord | undefined {
  const [body, signature, ...extra] = cursor.split(CURSOR_SEPARATOR);
  if (!body || !signature || extra.length > 0 || !signatureMatches(body, signature)) return undefined;
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorRecord;
}

export function decodeCursor(tool: string, cursor: string, target?: string): CursorDecoding {
  const record = openRecord(cursor);
  if (!record || record.tool !== tool || (target !== undefined && record.target !== target)) {
    return { ok: false, error: { code: 'invalid_cursor', message: INVALID_CURSOR_MESSAGE } };
  }
  return {
    ok: true,
    payload: { target: record.target, position: record.position, skip: record.skip, upper: record.upper },
  };
}
