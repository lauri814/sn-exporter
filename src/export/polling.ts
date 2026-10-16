export const DEFAULT_POLL_INTERVAL_SECONDS = 2;

export function pollingInterval(value: unknown): number {
  if (value === undefined) return DEFAULT_POLL_INTERVAL_SECONDS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 60) {
    throw new Error('Enter a whole-number status check interval from 1 to 60 seconds.');
  }
  return value;
}
