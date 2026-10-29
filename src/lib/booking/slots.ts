import type { BusinessHours } from "./hours.ts";
import { fromWallClock } from "../time/wall-clock.ts";

// Re-exported: the calendar week screen and `week.ts` still import this from
// here, and moving it to `time/wall-clock.ts` should not force edits on call
// sites that only want the wall-clock primitive.
export { fromWallClock };

/**
 * Which arrival windows a caller can actually be offered.
 *
 * Pure on purpose. The agent never invents a time — it picks from a list the
 * server computed, the same reasoning that keeps `capture_job`'s arguments
 * allow-listed. A model asked to reason about opening hours and timezones will
 * eventually offer someone a 2am arrival window, and the caller will believe it.
 *
 * Everything here is computed in the tenant's wall clock and returned as UTC
 * instants, because "9am" means 9am where the van is, not where the server is.
 */

export type BookedRange = {
  /** Present when the range came from `appointments`, so a caller can
   * exclude one specific job (e.g. rescheduling it) from its own busy list. */
  id?: string;
  starts_at: string | Date;
  ends_at?: string | Date | null;
};

export type SlotOptions = {
  /** Length of an arrival window. Home services quote windows, not minutes. */
  slotMinutes?: number;
  /** Nothing sooner than this — someone has to drive there. */
  leadMinutes?: number;
  /**
   * Dead time held either side of every existing job, so the van can get
   * from one to the next.
   *
   * Padding on the *clash* check, not on the job itself: a 2-hour job with a
   * 30-minute buffer still occupies 2 hours of the diary, it just blocks
   * anything starting within 30 minutes of either end. Lengthening the job
   * instead would push its own end time out and misreport when the crew is
   * actually free.
   *
   * 0 is the old exact-overlap behaviour, and is the default so existing
   * callers are unaffected.
   */
  bufferMinutes?: number;
  /**
   * How far ahead to look before giving up. Capped by what the caller can
   * actually check against: `busyFor`'s fail-closed block spans `syncWindow`'s
   * 90 days, so raising this past 90 would offer windows nothing has verified.
   */
  daysAhead?: number;
  /** How many to offer. A phone call is not a list. */
  limit?: number;
  /**
   * Whole days the shop is closed — holidays, a week off, van in the shop.
   * `YYYY-MM-DD` in the tenant's timezone, because "closed 25 December" means
   * the shop's 25th.
   */
  blackoutDates?: string[];
  /**
   * Only offer windows on this weekday, e.g. "sat". A caller who asks for
   * Saturday and gets told "nothing this week" because Tuesday and Wednesday
   * already filled `limit` before the walk reached Saturday is a real lost
   * job, not a hypothetical — hence this option exists.
   */
  weekday?: string;
  /** Only offer windows on or after this date. `YYYY-MM-DD`, tenant's timezone. */
  onOrAfter?: string;
};

/** The tenant-local calendar date of an instant. */
function wallDate(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: get("weekday").toLowerCase().slice(0, 3),
  };
}

function toMinutes(hhmm: string): number {
  const [hours, mins] = hhmm.split(":").map(Number);
  return hours * 60 + (mins || 0);
}

export function proposeSlots(
  hours: BusinessHours,
  existing: BookedRange[],
  from: Date,
  timezone: string,
  options: SlotOptions = {},
): Date[] {
  const {
    slotMinutes = 120,
    leadMinutes = 120,
    bufferMinutes = 0,
    daysAhead = 14,
    limit = 3,
    blackoutDates = [],
    weekday: onlyWeekday,
    onOrAfter,
  } = options;

  const blackout = new Set(blackoutDates);

  const earliest = from.getTime() + leadMinutes * 60 * 1000;

  // The buffer is applied here, once, by widening each busy range — so every
  // clash test below gets it for free and none can forget it. Negative input
  // is floored at 0 rather than allowed to shrink a range, which would offer
  // a window that genuinely overlaps a booked job.
  const padding = Math.max(bufferMinutes, 0) * 60 * 1000;

  const busy = existing.map((range) => {
    const start = new Date(range.starts_at).getTime();
    const end = range.ends_at
      ? new Date(range.ends_at).getTime()
      : start + slotMinutes * 60 * 1000;
    return { start: start - padding, end: end + padding };
  });

  const slots: Date[] = [];

  for (let dayOffset = 0; dayOffset <= daysAhead; dayOffset++) {
    if (slots.length >= limit) break;

    // Step a day at a time in the tenant's calendar, not in UTC.
    const cursor = new Date(from.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const { year, month, day, weekday } = wallDate(cursor, timezone);

    // The tenant's own calendar date, so a blackout closes their day rather
    // than a UTC one.
    const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (blackout.has(isoDate)) continue;

    // Same tenant-local date string as the blackout check, compared
    // lexicographically — safe because it is always zero-padded YYYY-MM-DD.
    if (onOrAfter && isoDate < onOrAfter) continue;

    // Skip the whole day before any slot on it is generated, so `limit` is
    // spent only on days that match. Filtering the output of an
    // already-limited walk instead reproduces the 18 August bug one level
    // down: the walk fills its quota on Tuesday and Wednesday and never
    // looks at Saturday at all.
    if (onlyWeekday && weekday !== onlyWeekday) continue;

    const open = hours[weekday];
    if (!open) continue;

    const opensAt = toMinutes(open.open);
    const closesAt = toMinutes(open.close);
    // Misconfigured hours should produce nothing, not a day-long window.
    if (!(closesAt > opensAt)) continue;

    for (
      let minutes = opensAt;
      minutes + slotMinutes <= closesAt;
      minutes += slotMinutes
    ) {
      if (slots.length >= limit) break;

      const start = fromWallClock(year, month, day, minutes, timezone);
      if (start.getTime() < earliest) continue;

      const end = start.getTime() + slotMinutes * 60 * 1000;
      const clashes = busy.some(
        (range) => start.getTime() < range.end && end > range.start,
      );
      if (clashes) continue;

      slots.push(start);
    }
  }

  return slots;
}

/** How a slot should be said out loud, in the tenant's timezone. */
/** Whole calendar days between two instants, counted in the tenant's own dates. */
function daysBetween(from: Date, to: Date, timezone: string): number {
  const a = wallDate(from, timezone);
  const b = wallDate(to, timezone);
  // Compared as dates, never as elapsed hours: a slot at 9pm tonight is still
  // today even though it is more than 24 hours from this morning in some
  // timezones, and a DST boundary makes a day 23 or 25 hours long.
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/**
 * How a receptionist would name the slot out loud.
 *
 * This returned a bare weekday until a real call on 2026-08-19 booked the wrong
 * day with it. The model is told the time but never the date, so "Wednesday"
 * could not be told from next Wednesday: it denied same-day availability while
 * holding a 2pm slot four hours away, called today "tomorrow", and booked a van
 * for today while the caller rang off expecting it tomorrow.
 *
 * Naming the day relative to now removes the arithmetic instead of asking a
 * model with no calendar to do it.
 */
export function describeSlot(at: Date, timezone: string, now: Date): string {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(at);

  const days = daysBetween(now, at, timezone);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(at);

  // Past six days the weekday comes round again and stops identifying a day on
  // its own — which is the exact ambiguity that sent a van out on the wrong
  // Wednesday. Anything that far out says which one.
  if (days > 1 && days < 7) return `${weekday} at ${time}`;

  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "long",
    day: "numeric",
  }).format(at);
  return `${weekday} ${date} at ${time}`;
}
