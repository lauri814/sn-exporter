export function elapsedTime(startedAt: number | undefined, finishedAt: number | undefined, now: number, terminal = false): string {
  if (startedAt === undefined || !Number.isFinite(startedAt) || terminal && finishedAt === undefined) return 'Unavailable';
  const seconds = Math.floor(Math.max(0, (finishedAt ?? now) - startedAt) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}s` :
    minutes ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
}
