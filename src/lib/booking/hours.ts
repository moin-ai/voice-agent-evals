/**
 * Booking's two central nouns: what a service costs in time, and when the
 * shop is open. Moved out of `agent/config.ts`, which re-exports both so
 * every existing import keeps working.
 */

export type Service = {
  name: string;
  description?: string;
  /** How long this job takes. Absent falls back to default_job_minutes. */
  minutes?: number;
  /**
   * What this job is typically worth, in integer cents (hard rule 3 — never
   * a float). The owner's own figure, never one the model invents: it is what
   * turns a captured lead into the dashboard's recovered-revenue number.
   * Absent means this service is not priced, and a lead for it contributes
   * nothing to that number rather than a guess.
   */
  avgValueCents?: number;
};

/** Keyed mon..sun. A missing or null day means closed. */
export type BusinessHours = Record<
  string,
  { open: string; close: string } | null | undefined
>;

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/**
 * Whether the owner has actually told us when they are open.
 *
 * Load-bearing, and the reason it is a function rather than an
 * `Object.keys(...).length` check at each call site: `isWithinBusinessHours`
 * reads a missing day as CLOSED, which is right for the agent (never promise a
 * visit on a day nobody works) and catastrophic for `wouldBeMissed`, which
 * would then mark 100% of an unconfigured tenant's calls as rescued — including
 * the ones they answered themselves.
 *
 * `{ mon: null, tue: null }` is not configured. It has keys and says nothing.
 */
export function hoursConfigured(hours: BusinessHours | null | undefined): boolean {
  if (!hours) return false;
  return DAY_KEYS.some((day) => hours[day]?.open && hours[day]?.close);
}
