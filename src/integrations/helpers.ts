// ---------------------------------------------------------------------------
// Paginated Response Shape
// ---------------------------------------------------------------------------
export interface PaginatedResponse<T> {
  items: T[];
  nextPageToken?: string;
  hasMore: boolean;
}

export function paginated<T>(items: T[], nextPageToken?: string): PaginatedResponse<T> {
  return { items, nextPageToken, hasMore: !!nextPageToken };
}

/** An error's message, or its string form when the thrown value is not an Error. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
