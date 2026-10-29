import type { BusinessHours } from "./hours.ts";
import { matchOfferedSlot } from "./book.ts";
import type { FoundJob } from "./lookup.ts";
// Type-only: reschedule.ts imports `bookingOutcome` from this file, so a
// value import here would be circular. Node's type stripping erases type-only
// imports before anything runs, so this one is safe.
import type { MoveOutcome } from "./reschedule.ts";
import {
  describeSlot,
  proposeSlots,
  type BookedRange,
  type SlotOptions,
} from "./slots.ts";

/**
 * What the booking tools say back to the agent.
 *
 * Pure, and shared by the route and the eval harness. They were separate
 * copies — including a verbatim-duplicated prompt string — which meant editing
 * one silently stopped the eval from testing what production actually says,
 * the single thing that harness exists to prevent.
 */

/** A phone call is not a list: offer a few, validate against many. */
const OFFER_LIMIT = 3;
const VALIDATE_LIMIT = 200;

type Context = {
  /** What the shop tells callers it is open. */
  hours: BusinessHours;
  /** When jobs may actually be scheduled. Null or empty falls back to hours. */
  bookingHours?: BusinessHours | null;
  /** YYYY-MM-DD in the tenant's timezone. */
  blackoutDates?: string[];
  /** How long this particular job takes. */
  slotMinutes?: number;
  /** Dead time held either side of a booked job, so the van can get there. */
  bufferMinutes?: number;
  /** How much warning the shop needs. Absent keeps proposeSlots' own default. */
  leadMinutes?: number;
  booked: BookedRange[];
  now: Date;
  timezone: string;
};

/**
 * Booking hours when set, business hours otherwise. An empty object is treated
 * as unset: a tenant who has never opened the settings screen must not end up
 * with a shop that can never be booked.
 */
function bookable(context: Context): BusinessHours {
  const booking = context.bookingHours;
  return booking && Object.keys(booking).length > 0 ? booking : context.hours;
}

/** What a caller asked `check_availability` to narrow down to. */
export type SlotPreference = {
  weekday?: string;
  onOrAfter?: string;
};

/** Full names for the reply — `weekday` itself is the three-letter form
 * `proposeSlots` matches against `BusinessHours` keys. */
const WEEKDAY_NAMES: Record<string, string> = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

/** How a preference reads to a caller: "Saturday", or "on or after 2026-08-20". */
function preferenceLabel(preference: SlotPreference): string {
  if (preference.weekday) return WEEKDAY_NAMES[preference.weekday] ?? preference.weekday;
  if (preference.onOrAfter) return `on or after ${preference.onOrAfter}`;
  return "that";
}

const NOTHING_FREE =
  "I don't have anything free in the next couple of weeks. Someone will call you back to sort a time.";

/**
 * The spoken offer: each window plus the exact instant it is worth as
 * `slot_start`, and — when `slots` holds more than we show — a nudge toward a
 * narrower ask instead of reading a list down the phone.
 */
function offer(slots: Date[], context: Context, heading: string): string {
  const truncated = slots.length > OFFER_LIMIT;
  const shown = truncated ? slots.slice(0, OFFER_LIMIT) : slots;

  // Spoken form plus the exact instant, so the model repeats a real time and
  // hands back an identifier it cannot fudge.
  const spoken = shown
    .map((slot) => `${describeSlot(slot, context.timezone, context.now)} (${slot.toISOString()})`)
    .join("; ");

  const length = context.slotMinutes ?? 120;
  const howLong = length >= 60 && length % 60 === 0
    ? `${length / 60} hour${length === 60 ? "" : "s"}`
    : `${length} minutes`;

  const more = truncated
    ? " There's more than this — ask about a specific day or a later date if none of these work."
    : "";

  // The model is never told the date anywhere else, so it cannot turn "tomorrow"
  // or "next Monday" into a weekday to search on. On 2026-08-19 it guessed:
  // asked for tomorrow, it searched Wednesday — which was that same day — and
  // booked a van for an afternoon the caller thought was the next one.
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: context.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(context.now);

  return `Today is ${today}. ${heading}, each ${howLong}: ${spoken}.${more} Offer these in plain language, one or two at a time, and pass the exact value in brackets as slot_start when they choose.`;
}

export function availabilityReply(context: Context, preference?: SlotPreference): string {
  const search = (extra: SlotOptions) =>
    proposeSlots(bookable(context), context.booked, context.now, context.timezone, {
      // One more than we ever show, so a full page can be told apart from a
      // truncated one without a second query.
      limit: OFFER_LIMIT + 1,
      blackoutDates: context.blackoutDates,
      slotMinutes: context.slotMinutes,
      bufferMinutes: context.bufferMinutes,
      // `?? undefined` so an absent value falls through to proposeSlots' own
      // default rather than being passed as an explicit undefined-shaped 0.
      ...(context.leadMinutes === undefined ? {} : { leadMinutes: context.leadMinutes }),
      ...extra,
    });

  const preferred = preference ? search(preference) : [];

  if (preference && !preferred.length) {
    // The 18 August call: a caller asked for Saturday, the agent had no way to
    // learn the day itself was empty, and improvised rather than admit it.
    // That fact has to come from here — say it plainly, then answer with what
    // IS free, so the model never composes either half.
    const fallback = search({});
    if (!fallback.length) return NOTHING_FREE;
    return `Nothing free ${preference.weekday ? "on " : ""}${preferenceLabel(preference)}. ${offer(
      fallback,
      context,
      "Available windows",
    )}`;
  }

  const slots = preference ? preferred : search({});
  if (!slots.length) return NOTHING_FREE;

  const heading = preference ? `${preferenceLabel(preference)} windows` : "Available windows";
  return offer(slots, context, heading);
}

/**
 * Recomputes availability rather than trusting what was offered a moment ago —
 * which also re-checks against anything booked since. A model that confidently
 * agrees to a time nobody offered gets refused instead of dispatching a van.
 */
export function bookingOutcome(
  context: Context,
  requested: string | undefined,
): { slot: Date | null; reply: string } {
  const bookableSlots = proposeSlots(
    bookable(context),
    context.booked,
    context.now,
    context.timezone,
    {
      limit: VALIDATE_LIMIT,
      blackoutDates: context.blackoutDates,
      slotMinutes: context.slotMinutes,
      // Must match the offer above exactly. If validation used a different
      // buffer, the agent would offer a window and then refuse to book it.
      bufferMinutes: context.bufferMinutes,
      ...(context.leadMinutes === undefined ? {} : { leadMinutes: context.leadMinutes }),
    },
  );
  const slot = matchOfferedSlot(requested, bookableSlots);

  if (!slot) {
    return {
      slot: null,
      reply:
        "That time isn't available. Check availability again and offer one of the windows returned.",
    };
  }

  return {
    slot,
    reply: `Booked for ${describeSlot(slot, context.timezone, context.now)}. Confirm that back to the caller.`,
  };
}

/**
 * What `find_appointment` says back — the caller's own upcoming jobs, each
 * with the exact id in brackets so a follow-up `reschedule_appointment` or
 * `cancel_appointment` can pass it straight through, same convention as
 * `offer`'s bracketed `slot_start`.
 *
 * `jobs` must only ever be the caller's own — that is enforced by the route
 * resolving `contactId` from caller ID before calling `upcomingFor`, not
 * here. This function only decides how to say what it was handed.
 */
export function findAppointmentReply(jobs: FoundJob[], timezone: string, now: Date): string {
  if (!jobs.length) {
    // Plain, not a guess. The 2026-08-19 call this whole task exists to stop
    // started with the agent inventing "nothing's booked" and then booking a
    // second job on top of one it simply had no tool to see.
    return "I don't have anything booked for this number. Take a message rather than guessing there's nothing there.";
  }

  const describe = (job: FoundJob) => {
    const where = job.address ? ` at ${job.address}` : "";
    return `${job.serviceType ?? "their appointment"} ${describeSlot(job.startsAt, timezone, now)}${where} (${job.id})`;
  };

  if (jobs.length > 1) {
    return `They have ${jobs.length} upcoming: ${jobs
      .map(describe)
      .join("; ")}. Ask which one they mean, then pass its exact id in brackets as appointment_id.`;
  }

  return `They have ${describe(jobs[0])}. Read the address back to confirm it before changing anything, and pass the exact id in brackets as appointment_id.`;
}

/**
 * What `reschedule_appointment` says back. `taken` and `raced` share one
 * message on purpose — see `MoveOutcome`'s doc comment for why the dashboard
 * needs them apart and a caller does not: both mean "someone already has that
 * window," and the honest answer is to re-check and offer another, never to
 * promise a callback for a job that only needs a different time.
 */
export function rescheduleReply(outcome: MoveOutcome, timezone: string, now: Date): string {
  if (outcome.ok) {
    return `Moved to ${describeSlot(outcome.startsAt, timezone, now)}. Confirm that back to the caller.`;
  }

  switch (outcome.reason) {
    case "not found":
      return "I can't find that appointment for this caller. Use find_appointment to look it up again.";
    case "not offered":
      return "That time isn't available. Check availability again and offer one of the windows returned.";
    case "taken":
    case "raced":
      return "Someone else already has that window. Apologise, check availability again, and offer them one of the times it returns.";
    case "too late":
      return "That's too close to the appointment's start time to move over the phone. Apologise, and let them know someone will call to sort it.";
    case "failed":
      // Never framed as a scheduling problem — the write itself broke, and
      // saying "that time's gone" would send the caller chasing a conflict
      // that was never the issue.
      return "I couldn't make that change right now. Take their details and say someone will call.";
    default: {
      const exhaustive: never = outcome.reason;
      throw new Error(`unhandled MoveOutcome reason: ${exhaustive}`);
    }
  }
}
