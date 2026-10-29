// The one tenant every scenario runs against, unless a scenario overrides
// `hours` (booking scenarios need real availability) or `recordingDisclosure`
// (the disclosure-off scenario). Fixed at a Thursday morning so booking
// scenarios have deterministic windows to offer.

export const FIXTURE_SETTINGS = {
  agentName: "Sam",
  businessName: "Acme Plumbing Co",
  greeting: "Thanks for calling Acme Plumbing, this is Sam. How can I help?",
  services: [
    { name: "Drain cleaning" },
    { name: "Water heater repair" },
    { name: "Leak repair" },
    { name: "Emergency plumbing" },
  ],
  hours: {
    mon: { open: "08:00", close: "17:00" },
    tue: { open: "08:00", close: "17:00" },
    wed: { open: "08:00", close: "17:00" },
    thu: { open: "08:00", close: "17:00" },
    fri: { open: "08:00", close: "17:00" },
  },
  serviceArea: "Austin, TX",
  recordingDisclosure: "This call may be recorded for quality purposes.",
  // Matches the production default: CA AB 2905 and TX TRAIGA require this.
  aiDisclosure: "You're speaking with an AI assistant.",
  timezone: "America/Chicago",
};

// Thursday 09:00 America/Chicago.
export const FIXTURE_NOW = new Date("2026-08-13T14:00:00Z");
