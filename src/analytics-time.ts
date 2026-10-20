export function analyticsEvidenceTime(value: string): number | null {
  const time = Date.parse(value);
  const nextDay = (Math.floor(time / 86_400_000) + 1) * 86_400_000;
  return Number.isFinite(time) && Number.isFinite(new Date(nextDay).getTime()) ? time : null;
}

export function analyticsHourBucket(value: string): string {
  const time = analyticsEvidenceTime(value);
  return time !== null && new Date(time).toISOString() === value
    ? new Date(Math.floor(time / 3_600_000) * 3_600_000).toISOString() : `raw:${value}`;
}
