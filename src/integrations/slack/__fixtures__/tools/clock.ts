export interface FakeClock {
  now: () => number;
  advance: (milliseconds: number) => void;
  iso: () => string;
}

export const FIXTURE_START_ISO = '2031-01-01T00:00:00.000Z';

export function createClock(startIso: string = FIXTURE_START_ISO): FakeClock {
  let current = Date.parse(startIso);
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    iso: () => new Date(current).toISOString(),
  };
}
