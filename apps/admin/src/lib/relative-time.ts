/** "2h ago" / "in 3 days" — coarse on purpose; for glanceable timestamps. */
export function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60_000) return fmt.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return fmt.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return fmt.format(Math.round(diff / 3_600_000), "hour");
  return fmt.format(Math.round(diff / 86_400_000), "day");
}
