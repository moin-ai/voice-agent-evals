/**
 * Turning the agent's booking calls into reads and writes on an appointment.
 *
 * Same posture as `capture_job`: the model is steered by caller speech, so its
 * arguments are allow-listed and clamped, and it may only pick a slot the
 * server already offered — never a time it made up. `appointment_id` gets the
 * same treatment: it names an existing row, so a malformed one must never
 * reach a query, the same reason `slot_start` may only be one of the values
 * the server itself handed out.
 */

import { isUuid } from "../uuid.ts";

const MAX_TEXT = 2000;

/** The three-letter keys `BusinessHours` and `proposeSlots`'s `weekday` option
 * use — same list `booking/settings.ts` validates against for the same reason. */
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export type BookInput = {
  slot_start?: string;
  appointment_id?: string;
  caller_name?: string;
  callback_e164?: string;
  service_type?: string;
  address?: string;
  notes?: string;
  preferred_day?: string;
  after_date?: string;
  [key: string]: unknown;
};

/** The five tools the booking endpoint answers for. */
export const BOOKING_TOOLS = [
  "check_availability",
  "book_appointment",
  "find_appointment",
  "reschedule_appointment",
  "cancel_appointment",
] as const;
export type BookingTool = (typeof BOOKING_TOOLS)[number];

export function parseBookingCall(body: unknown) {
  const message = (
    body as {
      message?: {
        type?: string;
        call?: { id?: string; phoneNumberId?: string };
        toolCallList?: {
          id?: string;
          function?: { name?: string; arguments?: unknown };
        }[];
      };
    }
  )?.message;

  if (message?.type !== "tool-calls") return null;

  const call = message.toolCallList?.find((entry) =>
    BOOKING_TOOLS.includes(entry.function?.name as BookingTool),
  );
  if (!call?.id) return null;

  const toolName = call.function?.name as BookingTool;

  let args: BookInput = {};
  try {
    args =
      typeof call.function?.arguments === "string"
        ? (JSON.parse(call.function.arguments) as BookInput)
        : ((call.function?.arguments ?? {}) as BookInput);
  } catch {
    // A model that emits malformed JSON should not take the process with it.
    args = {};
  }

  return {
    toolName,
    toolCallId: call.id,
    args,
    providerCallId: message.call?.id ?? null,
    dialledPhoneId: message.call?.phoneNumberId ?? null,
  };
}

/** Allow-list. Anything not named here never reaches the database. */
export function sanitiseBooking(input: BookInput) {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, MAX_TEXT)
      : undefined;

  // preferred_day and after_date come from a speech-to-text model transcribing
  // whatever the caller said, same as every field above — but unlike those,
  // they flow into proposeSlots's weekday/onOrAfter options rather than a text
  // column, so "not a real weekday" or "not a real date" has to be discarded
  // outright rather than clamped and passed on.
  const weekday = (value: unknown) => {
    const day = text(value)?.toLowerCase();
    return day && WEEKDAYS.includes(day) ? day : undefined;
  };
  const isoDate = (value: unknown) => {
    const date = text(value);
    if (!date || !DATE.test(date)) return undefined;
    // Catches 2026-02-31, which the regex alone allows — same check
    // booking/settings.ts uses for blackout dates.
    return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
      ? date
      : undefined;
  };

  // Same speech-to-text provenance as everything else here, but this one
  // names a row rather than filling a column: a caller has no legitimate way
  // to say a uuid aloud, so anything that isn't one is a model inventing an
  // id, not a caller stating one, and it must be discarded before it reaches
  // a query rather than clamped and passed on.
  const appointmentId = (value: unknown) => {
    const id = text(value);
    return id && isUuid(id) ? id : undefined;
  };

  return {
    caller_name: text(input.caller_name),
    callback_e164: text(input.callback_e164),
    service_type: text(input.service_type),
    address: text(input.address),
    notes: text(input.notes),
    preferred_day: weekday(input.preferred_day),
    after_date: isoDate(input.after_date),
    appointment_id: appointmentId(input.appointment_id),
  };
}

/**
 * The slot the caller agreed to, but only if the server actually offered it.
 *
 * The model is not permitted to invent a time. Matching against the offered
 * list is what stops a confident hallucination — "great, we'll see you Sunday
 * at 6am" — from becoming a row in `appointments` and a van that never arrives.
 */
export function matchOfferedSlot(
  requested: string | undefined,
  offered: Date[],
): Date | null {
  if (!requested) return null;

  const wanted = new Date(requested).getTime();
  if (Number.isNaN(wanted)) return null;

  return offered.find((slot) => slot.getTime() === wanted) ?? null;
}
