/**
 * Turning a tenant row into what the agent needs to know.
 *
 * Pure — no DB, no network — so the business-hours logic can be tested against
 * real timezones rather than mocked.
 */

import type { BusinessHours, Service } from "../booking/hours.ts";

// Re-exported: `BusinessHours` and `Service` moved to `booking/hours.ts` —
// booking's own vocabulary shouldn't live in the file that reads it aloud —
// but every existing importer of this module still gets both from here.
export type { BusinessHours, Service };

export type AgentSettings = {
  agentName: string;
  businessName: string;
  greeting: string;
  services: Service[];
  hours: BusinessHours;
  serviceArea: string | null;
  /** Null when the tenant has recording switched off. */
  recordingDisclosure: string | null;
  /** Null disables it. Spoken in the greeting, before the model runs. */
  aiDisclosure: string | null;
  timezone: string;
  /**
   * Where to send a caller who asks for a person. Null disables transfer, and
   * null is the default: pushing callers at a number nobody agreed to is worse
   * than the message-taking this replaces.
   */
  transferE164: string | null;
};

export type TenantRow = {
  name: string;
  business_name: string | null;
  agent_name: string;
  greeting: string | null;
  services: Service[];
  business_hours: BusinessHours;
  service_area: string | null;
  record_calls: boolean;
  recording_disclosure: string | null;
  ai_disclosure?: string | null;
  timezone: string;
  transfer_e164?: string | null;
  /** Null means the tenant has not given us an address to notify. */
  notify_email?: string | null;
  /** Cost breaker. Null or 0 means uncapped. */
  max_concurrent_calls?: number | null;
  /** When jobs may be scheduled. Null or empty falls back to business hours. */
  booking_hours?: BusinessHours | null;
  /** YYYY-MM-DD in this tenant's timezone. */
  blackout_dates?: string[] | null;
  calendar_url?: string | null;
  calendar_busy?: unknown;
  calendar_synced_at?: string | null;
  calendar_sync_error?: string | null;
  /** Count from the last successful sync; 0 means nothing to say. The
   * settings screen renders the copy — this is the fact, not the sentence. */
  calendar_sync_unresolved_zones?: number | null;
  default_job_minutes?: number | null;
};

export function resolveAgentSettings(tenant: TenantRow): AgentSettings {
  const businessName = tenant.business_name || tenant.name;
  return {
    agentName: tenant.agent_name,
    businessName,
    greeting:
      tenant.greeting ||
      `Thanks for calling ${businessName}, this is ${tenant.agent_name}. How can I help?`,
    services: tenant.services ?? [],
    hours: tenant.business_hours ?? {},
    serviceArea: tenant.service_area,
    // No recording, nothing to disclose — and saying otherwise would be a lie
    // to the caller.
    aiDisclosure: tenant.ai_disclosure ?? null,
    transferE164: tenant.transfer_e164 ?? null,
    recordingDisclosure: tenant.record_calls
      ? tenant.recording_disclosure
      : null,
    timezone: tenant.timezone,
  };
}

export function isWithinBusinessHours(
  hours: BusinessHours,
  at: Date,
  timezone: string,
): boolean {
  // Read the wall-clock day and time as the business experiences it. Doing this
  // in UTC would put a Chicago shop's Monday morning on Sunday night.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday").toLowerCase().slice(0, 3);

  const day = hours[weekday];
  // An unconfigured day is closed. Defaulting to open would have the agent
  // promise visits on days nobody works.
  if (!day) return false;

  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= toMinutes(day.open) && minutes < toMinutes(day.close);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}
