import type { AgentSettings } from "../agent/config.ts";
import { sanitiseBooking } from "../booking/book.ts";
import type { FoundJob } from "../booking/lookup.ts";
import {
  availabilityReply,
  bookingOutcome,
  findAppointmentReply,
  rescheduleReply,
  type SlotPreference,
} from "../booking/replies.ts";
// Type-only: reschedule.ts has no runtime export this file needs, only the
// outcome shape rescheduleReply expects. Safe even though replies.ts already
// imports reschedule.ts's type the same way to avoid a cycle — Node's type
// stripping erases both before anything runs.
import type { MoveOutcome } from "../booking/reschedule.ts";
import type { PendingToolCall } from "./runner.ts";
import type { EvalToolCall } from "./assertions.ts";

/**
 * Local stand-ins for the tool routes, calling the same `availabilityReply`,
 * `bookingOutcome`, `findAppointmentReply` and `rescheduleReply` the routes
 * call — so the model under test is judged against the real rules and the
 * real wording, not a copy that can drift. Only the database is replaced:
 * appointments are held in memory instead of read from `appointments`.
 */

export const captureJobTool = (call: PendingToolCall) => ({
  content: "Got it, that's written down.",
  // Recorded before sanitising, on purpose: an assertion checking for empty
  // arguments must see what the model actually sent.
  recorded: { name: "capture_job", args: call.args } as EvalToolCall,
});

/** One appointment held in memory for the length of a scenario run. */
type SeedAppointment = {
  /**
   * Present only for a job `find_appointment` can see — the simulated
   * caller's own. Absent for a plain busy block (23-fully-booked-day's other
   * callers' jobs filling a day), which must never surface as "their
   * appointment" the way a real block from `busy_blocks` or a synced
   * calendar never does either.
   */
  id?: string;
  starts_at: string;
  ends_at: string;
  service_type?: string;
  address?: string;
  status?: "scheduled" | "cancelled";
};

export function createBookingTools(
  settings: AgentSettings,
  now: Date,
  // A scenario's own `existing` field — the "fully booked day" case needs
  // appointments on the books before the call even starts, and the
  // reschedule/cancel/find scenarios need one with an id the caller "already
  // has" — which an in-memory list that only grows during the run cannot
  // express on its own.
  existing: SeedAppointment[] = [],
) {
  const appointments: SeedAppointment[] = existing.map((a) => ({ ...a }));

  // Same rules `moveAppointment`/`loadJobContext` apply: a cancelled job
  // never blocks availability, and the job being moved is excluded from its
  // own busy list so a reschedule never collides with itself.
  const context = (excludeId?: string) => {
    const active = appointments.filter(
      (a) => a.status !== "cancelled" && (!excludeId || a.id !== excludeId),
    );
    return {
      hours: settings.hours,
      booked: active.map(({ id, starts_at, ends_at }) => ({ id, starts_at, ends_at })),
      now,
      timezone: settings.timezone,
    };
  };

  return {
    check_availability: (call: PendingToolCall) => {
      // Same allow-list and the same SlotPreference construction the real
      // route uses (route.ts) — this stand-in existed to test the real rules,
      // but until now it silently dropped preferred_day/after_date on the
      // floor, so a scenario asking about a day was tested against a tool
      // that could never have answered it.
      const { preferred_day, after_date } = sanitiseBooking(call.args);
      const preference: SlotPreference | undefined =
        preferred_day || after_date
          ? { weekday: preferred_day, onOrAfter: after_date }
          : undefined;
      return {
        content: availabilityReply(context(), preference),
        recorded: { name: "check_availability", args: call.args } as EvalToolCall,
      };
    },

    book_appointment: (call: PendingToolCall) => {
      const { slot, reply } = bookingOutcome(
        context(),
        call.args.slot_start as string | undefined,
      );
      if (!slot) return { content: reply };

      // Held in memory so a booking made mid-scenario disappears from the next
      // availability check, exactly as the route's re-query does.
      appointments.push({
        starts_at: slot.toISOString(),
        ends_at: new Date(slot.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      });

      return {
        content: reply,
        recorded: { name: "book_appointment", args: call.args } as EvalToolCall,
      };
    },

    // Before this task, a caller ringing back to move or check a job they
    // already had was tested against a harness with no way to have "already
    // had" one — every scenario started from an empty slate. The three tools
    // below exist so the eval can actually replay the 2026-08-19 call.
    find_appointment: (call: PendingToolCall) => {
      const jobs: FoundJob[] = appointments
        .filter(
          (a) =>
            a.id && a.status !== "cancelled" && new Date(a.starts_at).getTime() >= now.getTime(),
        )
        .map((a) => ({
          id: a.id as string,
          startsAt: new Date(a.starts_at),
          endsAt: a.ends_at ? new Date(a.ends_at) : null,
          serviceType: a.service_type ?? null,
          address: a.address ?? null,
        }))
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

      return {
        content: findAppointmentReply(jobs, settings.timezone, now),
        recorded: { name: "find_appointment", args: call.args } as EvalToolCall,
      };
    },

    reschedule_appointment: (call: PendingToolCall) => {
      const { appointment_id } = sanitiseBooking(call.args);
      const job = appointment_id
        ? appointments.find((a) => a.id === appointment_id)
        : undefined;

      let outcome: MoveOutcome;
      if (!job) {
        outcome = { ok: false, reason: "not found" };
      } else {
        // Same 2-hour cutoff route.ts enforces on the phone path
        // (`withinHours: 2`) — the owner may move their own diary freely from
        // the dashboard; a caller minutes from a tech's arrival may not.
        const cutoff = new Date(job.starts_at).getTime() - 2 * 60 * 60 * 1000;
        if (now.getTime() > cutoff) {
          outcome = { ok: false, reason: "too late" };
        } else {
          const ctx = context(job.id);
          const { slot } = bookingOutcome(ctx, call.args.slot_start as string | undefined);
          if (!slot) {
            // Same recompute-with-nothing-busy trick reschedule.ts uses, so a
            // time that would never be offered at all can be told apart from
            // one something else already holds.
            const { slot: wouldOffer } = bookingOutcome(
              { ...ctx, booked: [] },
              call.args.slot_start as string | undefined,
            );
            outcome = { ok: false, reason: wouldOffer ? "taken" : "not offered" };
          } else {
            const ends = new Date(slot.getTime() + 2 * 60 * 60 * 1000);
            job.starts_at = slot.toISOString();
            job.ends_at = ends.toISOString();
            job.status = "scheduled";
            outcome = { ok: true, startsAt: slot, endsAt: ends };
          }
        }
      }

      const content = rescheduleReply(outcome, settings.timezone, now);
      // Same convention as book_appointment above: recorded only when it
      // actually took effect, so an assertion reading `toolCalls` sees a
      // refused move as nothing having changed.
      if (!outcome.ok) return { content };
      return {
        content,
        recorded: { name: "reschedule_appointment", args: call.args } as EvalToolCall,
      };
    },

    cancel_appointment: (call: PendingToolCall) => {
      const { appointment_id } = sanitiseBooking(call.args);
      const job = appointment_id
        ? appointments.find((a) => a.id === appointment_id && a.status !== "cancelled")
        : undefined;

      if (!job) {
        // Same words route.ts speaks for a missing or already-gone id — that
        // text lives inline in the route rather than in replies.ts, so it is
        // repeated here rather than imported.
        return {
          content: "I can't find that appointment for this caller. Use find_appointment to look it up again.",
        };
      }

      job.status = "cancelled";
      return {
        // Same words route.ts's cancel arm speaks on success.
        content: "Cancelled. Confirm that back to the caller.",
        recorded: { name: "cancel_appointment", args: call.args } as EvalToolCall,
      };
    },
  };
}
