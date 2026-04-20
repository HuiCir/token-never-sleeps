import { format, addHours, addMinutes, addSeconds, differenceInSeconds, parseISO } from "date-fns";
import { toZonedTime } from "date-fns-tz";

export function utcNow(): Date {
  return new Date();
}

export function iso(dt: Date): string {
  return dt.toISOString();
}

export function currentWindow(manifest: { refresh_anchor_at: string; refresh_hours: number; refresh_minutes: number | null; refresh_seconds: number | null }): { index: number; start: Date; end: Date } {
  const anchor = parseISO(manifest.refresh_anchor_at);
  const windowSeconds = refreshWindowSeconds(manifest);

  const now = utcNow();
  const secondsSinceAnchor = differenceInSeconds(now, anchor);
  const windowIndex = Math.floor(secondsSinceAnchor / windowSeconds);

  const windowStart = new Date(anchor.getTime() + windowIndex * windowSeconds * 1000);
  const windowEnd = new Date(windowStart.getTime() + windowSeconds * 1000);

  return {
    index: windowIndex,
    start: windowStart,
    end: windowEnd,
  };
}

export function refreshWindowSeconds(manifest: { refresh_hours: number; refresh_minutes: number | null; refresh_seconds: number | null }): number {
  let seconds = manifest.refresh_hours * 3600;
  if (manifest.refresh_minutes) seconds += manifest.refresh_minutes * 60;
  if (manifest.refresh_seconds) seconds += manifest.refresh_seconds;
  return seconds;
}

export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export function formatIso(dt: Date): string {
  return format(dt, "yyyy-MM-dd'T'HH:mm:ss.SSSxxx");
}
