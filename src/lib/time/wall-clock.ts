/**
 * Wall-clock timezone arithmetic and the calendar sync window.
 *
 * `booking/slots.ts` and `calendar/parse.ts` both need `fromWallClock`;
 * `booking/availability.ts` and `calendar/sync.ts` both need `syncWindow`. Kept
 * here rather than in either domain, so booking and calendar can each import
 * this without importing each other.
 */

/**
 * `Intl.DateTimeFormat` instances for `offsetMs`, keyed by timezone.
 *
 * `offsetMs` runs on every slot proposal, every ICS occurrence expanded by
 * `calendar/parse.ts`, and the week grid — constructing two fresh formatters
 * per call measured at 314µs each, against ~25µs once cached. Same reasoning
 * as `ianaValidity` in `calendar/parse.ts`: IANA zone names are a closed set
 * of roughly 600, so an unbounded `Map` here needs no eviction policy either.
 * Unlike that cache, there is nothing to keep *out* of this one — every
 * caller reaches `offsetMs` with a tenant's own stored timezone or a TZID
 * `calendar/parse.ts` already ran through `isIanaZone`, never a raw
 * attacker-controlled string, so there is no path that lets a hostile input
 * grow this map with garbage. Do not add unvalidated keys here without the
 * same eviction reasoning `ianaValidity` asks for.
 *
 * Formatters are stateless for `formatToParts` — the same instance reused
 * across calls with different `Date`s and no shared mutable state between
 * them, which is the documented, widely-relied-on behaviour of
 * `Intl.DateTimeFormat` (MDN recommends exactly this reuse for performance).
 */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
function offsetFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(timezone, formatter);
  }
  return formatter;
}

/** The offset a timezone is at for a given instant, in milliseconds. */
function offsetMs(at: Date, timezone: string): number {
  const parts = offsetFormatter(timezone).formatToParts(at);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  // Intl gives 24 for midnight in some engines; Date.UTC handles the rollover.
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asIfUtc - at.getTime();
}

/** The instant at which a given wall-clock time occurs in a timezone. */
export function fromWallClock(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timezone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minutes);
  // Two passes: the offset itself depends on the instant, and the first guess
  // can land on the wrong side of a DST transition.
  const first = new Date(naive - offsetMs(new Date(naive), timezone));
  const settled = new Date(naive - offsetMs(first, timezone));
  return settled;
}

const LOOKBACK_DAYS = 7;
const LOOKAHEAD_DAYS = 90;

export function syncWindow(now: Date): { from: Date; until: Date } {
  return {
    from: new Date(now.getTime() - LOOKBACK_DAYS * 86400000),
    until: new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000),
  };
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The weekday an instant falls on in a given timezone — the reverse
 * direction from `fromWallClock`. Verified against a real UTC-day-boundary
 * crossing (2026-08-24T02:30Z is Monday in UTC, Sunday in
 * America/Chicago) before this was written, not assumed.
 */
export function localWeekday(
  at: Date,
  timezone: string,
): "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun" {
  let formatter = weekdayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" });
    weekdayFormatters.set(timezone, formatter);
  }
  return formatter.format(at) as ReturnType<typeof localWeekday>;
}
