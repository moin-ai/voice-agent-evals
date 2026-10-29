/**
 * Where each thing sits in a week grid.
 *
 * Pure arithmetic, deliberately. A calendar library brings its own opinions
 * about state and styling for a job that is "which column, how far down, how
 * tall" — and positioning in the tenant's timezone rather than the browser's
 * is the only part that is actually hard.
 *
 * Every navigation and layout sum lives here rather than in the grid
 * component, because a client component cannot be tested in this repo and
 * these two both broke on the same thing: treating a local day as exactly
 * 86,400,000 milliseconds.
 */

import { fromWallClock } from "./slots.ts";

export type WeekItem = {
  id: string;
  kind: "job" | "block" | "calendar";
  startsAt: string;
  endsAt: string;
  label: string;
};

export type PositionedItem = WeekItem & {
  /** 0 = the first column of the rendered week. */
  dayIndex: number;
  topPercent: number;
  heightPercent: number;
  /**
   * Unique per drawn box, unlike `id`: one item can now produce a segment on
   * each day it covers, and React needs to tell those apart. `id` stays the
   * item's real identity, because that is what the click handlers send back.
   */
  key: string;
};

type Options = {
  weekStart: Date;
  timezone: string;
  dayStartMinutes: number;
  dayEndMinutes: number;
};

const MINUTES_PER_DAY = 1440;
/** Nothing shorter draws readably, and a zero-length item must still be seen. */
const MIN_MINUTES = 15;

/** The tenant-local date string of an instant, e.g. 2026-08-17. */
function localDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
}

/** Local midnight of a `YYYY-MM-DD` in the tenant's own clock. */
function midnightOf(isoDate: string, timezone: string): Date {
  return fromWallClock(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)),
    Number(isoDate.slice(8, 10)),
    0,
    timezone,
  );
}

/**
 * The `?week=` value `days` local calendar days from the one given.
 *
 * Local *days*, not `days × 86400000`. Adding seven fixed 24-hour spans to
 * local midnight lands at 23:00 the previous Sunday across the autumn DST
 * transition, and the page rounds that back to the same Monday — so during
 * the changeover week "Next →" did nothing at all, and there is no other
 * control. Date.UTC normalises the overflow, so ±7 needs no month or year
 * arithmetic of its own.
 */
export function shiftWeek(weekStart: Date, days: number, timezone: string): string {
  const from = localDate(weekStart, timezone);
  return localDate(
    fromWallClock(
      Number(from.slice(0, 4)),
      Number(from.slice(5, 7)),
      Number(from.slice(8, 10)) + days,
      0,
      timezone,
    ),
    timezone,
  );
}

/** Minutes past local midnight. */
function localMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/**
 * One box per day an item covers, clipped to that day.
 *
 * Not "the column the item starts in". `columns.indexOf(localDate(start))`
 * returns -1 for anything beginning outside the seven drawn columns, and
 * dropping those meant a fortnight's holiday, a multi-day job, or a block
 * running 22:00→02:00 rendered as nothing whatsoever — a grid showing a free
 * week, which is the screen an owner checks to confirm their calendar
 * imported. Hiding exactly the entries most worth seeing is what made the
 * cached-calendar bug invisible from the outside.
 */
export function layOutWeek(items: WeekItem[], options: Options): PositionedItem[] {
  const { weekStart, timezone, dayStartMinutes, dayEndMinutes } = options;
  const visible = Math.max(dayEndMinutes - dayStartMinutes, 1);

  // Eight local midnights: one opening each of the seven columns, plus the one
  // that closes the last. Stepped in calendar days, so the 23- and 25-hour
  // days in March and November are the right length.
  const bounds = Array.from({ length: 8 }, (_, offset) =>
    midnightOf(shiftWeek(weekStart, offset, timezone), timezone).getTime(),
  );

  const placed: PositionedItem[] = [];

  for (const item of items) {
    const start = new Date(item.startsAt).getTime();
    const rawEnd = new Date(item.endsAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(rawEnd)) continue;
    // A zero-length item is real — the calendar page substitutes `starts_at`
    // for a null `ends_at` — and must still draw something.
    const end = Math.max(rawEnd, start + MIN_MINUTES * 60000);

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const dayOpens = bounds[dayIndex];
      const dayCloses = bounds[dayIndex + 1];
      const segmentStart = Math.max(start, dayOpens);
      const segmentEnd = Math.min(end, dayCloses);
      if (segmentEnd <= segmentStart) continue;

      // Read as wall-clock minutes, not elapsed ones, because that is what the
      // hour labels down the side are. They differ by an hour on a DST day.
      const startMinutes =
        segmentStart <= dayOpens ? 0 : localMinutes(new Date(segmentStart), timezone);
      const endMinutes =
        segmentEnd >= dayCloses
          ? MINUTES_PER_DAY
          : Math.max(localMinutes(new Date(segmentEnd), timezone), startMinutes + MIN_MINUTES);

      // Clipped rather than clamped to zero height: an early-morning job should
      // still show at the top of the grid, not vanish or draw off it.
      const top = Math.max(startMinutes - dayStartMinutes, 0);
      const bottom = Math.min(endMinutes - dayStartMinutes, visible);
      if (bottom <= 0 || top >= visible) continue;

      placed.push({
        ...item,
        dayIndex,
        topPercent: (top / visible) * 100,
        heightPercent: ((bottom - top) / visible) * 100,
        key: `${item.id}-${dayIndex}`,
      });
    }
  }

  return placed;
}
