/**
 * Everything that makes an hour unavailable, gathered in one place.
 *
 * Three sources, one shape. The slot generator already takes a list of busy
 * ranges and does not care where they came from, so this is only about asking
 * for all three rather than one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Service } from "./hours.ts";
// Reused rather than re-declared: matching Task 4's own 7-day lookback means
// the two never quietly drift apart, and the 90-day lookahead doubles as a
// fail-closed ceiling below, comfortably past proposeSlots' default 14 days.
import { syncWindow } from "../time/wall-clock.ts";
import type { BookedRange } from "./slots.ts";

const DEFAULT_MINUTES = 120;

/** Trailing whitespace and casing are how a speech-to-text model says a name. */
const key = (value: string) => value.trim().toLowerCase();

export function jobMinutes(
  services: Service[],
  serviceType: string | undefined,
  fallback: number | null | undefined,
): number {
  const match = serviceType
    ? services.find((service) => key(service.name) === key(serviceType))
    : undefined;

  return match?.minutes ?? fallback ?? DEFAULT_MINUTES;
}

/**
 * `cached` is `tenants.calendar_busy` — already parsed, never fetched here.
 * A caller is on the phone; this function does not touch the network.
 */
export async function busyFor(
  db: SupabaseClient,
  tenantId: string,
  from: Date,
  cached: unknown,
): Promise<BookedRange[]> {
  // A job in progress when the call comes in is still busy even though it
  // *started* before `from` — filtering on `starts_at >= from` alone drops
  // any range that started earlier but hasn't ended, and the 120-minute lead
  // time means that window opens up fast: a 240-minute job (this file's own
  // "Full install" fixture) goes invisible just over an hour after it starts.
  // `ends_at` is nullable, so filtering on it instead would trade this bug
  // for a quieter one. The lower bound below only keeps the query small —
  // proposeSlots does the real overlap check — so it is widened rather than
  // tightened, far enough back that nothing plausibly still running is missed.
  const { from: since, until } = syncWindow(from);
  const sinceIso = since.toISOString();

  const [appointments, blocks] = await Promise.all([
    db
      .from("appointments")
      // `id` too — so a caller rescheduling one specific job can filter it
      // out of its own busy list instead of colliding with itself.
      .select("id, starts_at, ends_at")
      .eq("tenant_id", tenantId)
      .neq("status", "cancelled")
      .gte("starts_at", sinceIso),
    db
      .from("busy_blocks")
      .select("starts_at, ends_at")
      .eq("tenant_id", tenantId)
      .gte("starts_at", sinceIso),
  ]);

  // Offering a window on top of a job the query couldn't see is exactly the
  // failure this file exists to prevent — so a failed query must not resolve
  // to "nothing busy". Fail closed instead: report the whole synced window
  // busy, which starves proposeSlots of anything to offer until the next
  // successful read. Identifiers and the code only; a Postgres message quotes
  // the values, and those values can be a caller's name and address.
  if (appointments.error || blocks.error) {
    console.error(
      `[busyFor query failed] tenant_id=${tenantId} appointments_code=${
        appointments.error?.code ?? "ok"
      } blocks_code=${blocks.error?.code ?? "ok"}`,
    );
    return [{ starts_at: sinceIso, ends_at: until.toISOString() }];
  }

  // No lower bound on the cached calendar, deliberately. The two queries above
  // are bounded only to keep them small; this list is already in memory, so a
  // bound here buys nothing and costs the entry most worth keeping. An
  // appointment is hours long, so a 7-day floor is generous for one — a
  // calendar entry is routinely days or weeks ("Vacation", 1–15 August), and
  // filtering on `starts_at >= since` drops it on the 9th and books a van into
  // it. A range already in the past is a no-op regardless: proposeSlots offers
  // nothing before `now + leadMinutes` and does a real overlap check, so a
  // range that ended before then can never clash with anything it offers.
  // The shape guard stays — this is jsonb, and a malformed entry would throw
  // inside proposeSlots rather than here.
  const calendar = Array.isArray(cached)
    ? (cached as BookedRange[]).filter((range) => range?.starts_at)
    : [];

  return [...(appointments.data ?? []), ...(blocks.data ?? []), ...calendar];
}
