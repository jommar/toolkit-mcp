export interface Settled<T> {
  value?: T;
  error?: any;
  threw: boolean;
}

export async function settle<T>(run: () => T | Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await run(), threw: false };
  } catch (error) {
    return { error, threw: true };
  }
}
