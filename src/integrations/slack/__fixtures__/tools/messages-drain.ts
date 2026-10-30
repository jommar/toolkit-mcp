export interface DrainedEntry {
  ts: string;
  is_bot?: boolean;
}

export interface DrainedResult {
  status: string;
  items: DrainedEntry[];
  hasMore: boolean;
  nextPageToken?: string;
}

export type PageRunner = (
  items: Array<Record<string, unknown>>,
) => Promise<{ results: DrainedResult[] }>;

export interface DrainOutcome {
  /** Every ts delivered for each input position, in delivery order. */
  timestamps: string[][];
  /** The number of entries on each page, per input position. */
  pageSizes: number[][];
  /** Statuses other than `ok` met on the way. */
  notOk: string[];
  botEntries: number;
  /** Input positions that still had a next page when the round limit was reached. */
  unfinished: number[];
}

/**
 * Runs the first page for `firstItems`, then keeps continuing with cursor-only items
 * for exactly the positions that still report a next page.
 */
export async function drainPages(
  runPage: PageRunner,
  firstItems: Array<Record<string, unknown>>,
  maxRounds = 12,
): Promise<DrainOutcome> {
  const outcome: DrainOutcome = {
    timestamps: firstItems.map(() => []),
    pageSizes: firstItems.map(() => []),
    notOk: [],
    botEntries: 0,
    unfinished: [],
  };
  let positions = firstItems.map((_, index) => index);
  let items = firstItems;

  for (let round = 0; round < maxRounds && items.length > 0; round += 1) {
    const body = await runPage(items);
    const nextPositions: number[] = [];
    const nextItems: Array<Record<string, unknown>> = [];
    body.results.forEach((result, resultIndex) => {
      const position = positions[resultIndex];
      if (result.status !== 'ok') outcome.notOk.push(result.status);
      outcome.timestamps[position].push(...result.items.map((entry) => entry.ts));
      outcome.pageSizes[position].push(result.items.length);
      outcome.botEntries += result.items.filter((entry) => entry.is_bot === true).length;
      if (result.hasMore && result.nextPageToken) {
        nextPositions.push(position);
        nextItems.push({ cursor: result.nextPageToken });
      }
    });
    positions = nextPositions;
    items = nextItems;
  }

  outcome.unfinished = positions;
  return outcome;
}
