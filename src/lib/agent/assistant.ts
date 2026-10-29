import { isWithinBusinessHours, type AgentSettings } from "./config.ts";
// Explicit .ts extension: Node's type stripping resolves runtime relative
// imports literally, and the tests import this module directly. Type-only
// imports are erased so they do not need it.
import { buildSystemPrompt } from "./prompt.ts";

/**
 * The Vapi assistant payload, built fresh for each incoming call so a config
 * change takes effect on the next call rather than needing a re-sync.
 *
 * ⚠️ These field names come from Vapi's documentation, not from observed
 * traffic — the same caveat that applies to src/lib/voice/vapi.ts. Confirm them
 * against one real call (Phase 1 Task 9) before trusting the mapping.
 */

export const URGENCY = [
  "emergency",
  "same_day",
  "this_week",
  "flexible",
] as const;

/**
 * Which voice speaks, as config rather than a code change.
 *
 * The voice is the pitch — a prospect who thinks it sounds synthetic is lost
 * before any dashboard is opened — so this is not a decision to make from a
 * price table. It is here to make the comparison *cheap*: point a demo tenant
 * at another provider, ring it, and judge with your ears.
 *
 * What is actually at stake: ElevenLabs Flash bills through a monthly
 * credit subscription with a floor (~$99 at the tier a real tenant needs),
 * while Deepgram Aura is pay-as-you-go at roughly a third of the per-character
 * rate. The floor lands entirely on the first few customers, which is exactly
 * when cash is tightest. If Aura sounds good enough, that floor disappears and
 * TTS drops from ~$0.033/min to ~$0.012.
 *
 * Defaults to ElevenLabs, so an unset environment behaves exactly as before.
 */
/**
 * Deliberately loose: Vapi speaks to eighteen TTS providers and the whole
 * value of this seam is trying them without a deploy per experiment. A union
 * of the two we happen to have tried would mean editing this file every time
 * a voice is worth auditioning, which is exactly the friction that stops the
 * audition happening.
 *
 * `model` is optional and omitted unless asked for, because it is not
 * universal — ElevenLabs needs one, Deepgram rejects the assistant outright
 * if a stray field appears on its voice config.
 */
export type VoiceChoice = {
  provider: string;
  voiceId: string;
  model?: string;
  version?: number;
};

/**
 * Aura-1's professional male voice. Bare name, not Deepgram's qualified
 * `aura-2-orpheus-en` form — **verified against real traffic 2026-08-27**:
 * `asteria` connected and spoke, `aura-2-orpheus-en` did not. Vapi's own docs
 * claim Aura-2 support but only ever show a bare id, and their voice library
 * lists "more than 12" voices, which is exactly Aura-1's count.
 *
 * Do not "upgrade" this to the qualified form without ringing the number
 * first. It reads like a more precise identifier and it is the one Deepgram's
 * own API takes; it simply is not what Vapi accepts.
 *
 * Aura-1 is also half Aura-2's rate ($15 vs $30 per 1M characters), so the
 * form that works is also the cheaper one.
 */
const DEEPGRAM_DEFAULT_VOICE = "orpheus";
const ELEVENLABS_DEFAULT_VOICE = "burt";

/**
 * Vapi's own voice, chosen by ear on 2026-08-27 after auditioning ElevenLabs
 * Flash (`burt`), Deepgram Aura-1 (`asteria`, `orpheus`) and this.
 *
 * Version 2 explicitly: Vapi's V1 voices are both worse and dearer, and the
 * generation is selected by a `version` field rather than by the voice id, so
 * omitting it silently gets the old one.
 *
 * Also the cheapest thing auditioned by an order of magnitude — $0.0025/min
 * against ElevenLabs' $0.020–0.033 — with no monthly credit floor and no
 * extra vendor. The floor mattered: it was the difference between ~79% and
 * ~88% gross margin on the first customer, since $99/month is $99 whether it
 * serves one tenant or five.
 */
const VAPI_DEFAULT_VOICE = "Elliot";
const VAPI_DEFAULT_VERSION = 2;

/** A plain record rather than `NodeJS.ProcessEnv`, so a test can pass a
 * two-key object literal without casting through `unknown`. */
type Env = Record<string, string | undefined>;

/**
 * Below this many characters, the system prompt may not reach Haiku 4.5's
 * 4,096-token prompt-cache minimum — and a prompt that does not cache costs
 * **four times** as much, silently.
 *
 * Why it matters more than it looks: the API is stateless, so the whole
 * system prompt is resent on every turn of every call. It is ~88% of all
 * input tokens. Cached, that portion bills at 10%; uncached, full price.
 * Across 750 minutes that is roughly $4 against $16 on Haiku, or $12 against
 * $49 on Sonnet.
 *
 * The trap is that the prompt is built per tenant, from their services and
 * hours — so a small shop with two services renders a shorter prompt than a
 * big one, drops under the floor, and quadruples its own LLM cost with no
 * error anywhere. The smallest customers are the ones who break it.
 *
 * 4 characters per token is the pessimistic end of the usual 3.5–4.0 range
 * for English prose. Erring that way means the occasional needless warning
 * rather than a missed one, and a warning costs a log line while a miss
 * costs money nobody can attribute.
 */
const MIN_CACHEABLE_PROMPT_CHARS = 4096 * 4;

/**
 * Warns when a tenant's prompt is short enough to fall out of the cache.
 *
 * Deliberately does not throw: a short prompt still produces a working agent
 * that answers calls correctly, just expensively. Taking the phone line down
 * over a billing inefficiency would be the worse failure by far.
 *
 * Logs the tenant's name and a length, never the prompt body — it carries
 * the business's own configuration, and this codebase logs identifiers, not
 * contents.
 */
export function warnIfUncacheable(prompt: string, businessName: string): void {
  if (prompt.length >= MIN_CACHEABLE_PROMPT_CHARS) return;
  console.warn(
    `[prompt below cache floor] business=${businessName} chars=${prompt.length} ` +
      `min=${MIN_CACHEABLE_PROMPT_CHARS} — likely under Haiku's 4096-token cache ` +
      `minimum, which bills this tenant's LLM usage at roughly 4x`,
  );
}

/**
 * The brain, as config — so Haiku and Sonnet can be compared on a real call
 * rather than argued about.
 *
 * Haiku stays the default because `decisions.md` chose it for **latency**,
 * not cost: adaptive thinking is fatal for conversational pacing, and a
 * laggy agent kills a demo worse than a slightly less capable one. The cost
 * half of that decision has since evaporated — measured against this
 * codebase's own prompt, Sonnet 4.6 runs about $8/month more per customer at
 * 750 minutes, under one point of gross margin — so what remains to be
 * settled is whether it *sounds* slower on the phone.
 *
 * Worth settling, because the failures on record are reasoning failures: a
 * real call on 2026-08-18 lost a $40k kitchen lead by claiming a free
 * Saturday was unavailable, `capture_job` has fired with empty arguments
 * after collecting everything, and a callback number came back with an extra
 * digit. See docs/runbook.md's voice tuning log.
 *
 * ⚠️ The id must be whatever **Vapi** accepts, which is not always what
 * Anthropic's SDK documents. Vapi rejected the unversioned
 * `claude-haiku-4-5` outright and required the dated snapshot below
 * (confirmed against a real call 2026-08-11), while Anthropic's own current
 * convention is bare ids with no date suffix. Which form Sonnet needs is
 * unknown until someone rings the number — hence a whole-string env var
 * rather than a model shortname this code expands.
 */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export function modelChoice(env: Env = process.env): string {
  return env.AGENT_MODEL?.trim() || DEFAULT_MODEL;
}

/** Only for the two providers actually rung on a real number. Anything else
 * must name its own voice — guessing an id for an unaudited provider just
 * moves the failure to the phone call. */
const KNOWN_DEFAULT_VOICE: Record<string, string> = {
  vapi: VAPI_DEFAULT_VOICE,
  "11labs": ELEVENLABS_DEFAULT_VOICE,
  deepgram: DEEPGRAM_DEFAULT_VOICE,
};

export function voiceChoice(env: Env = process.env): VoiceChoice {
  const requested = env.VOICE_TTS_PROVIDER?.trim();

  // An unfamiliar provider with no voice named for it has nothing usable to
  // build from — fall back *whole* to the chosen default. The shape to avoid
  // is a real provider name carrying another provider's voice id: a config
  // that looks valid here and fails on the phone call instead.
  const provider =
    requested && (KNOWN_DEFAULT_VOICE[requested] || env.VOICE_TTS_VOICE_ID)
      ? requested
      : "vapi";

  const model = env.VOICE_TTS_MODEL?.trim();
  const requestedVersion = Number(env.VOICE_TTS_VERSION);
  // Vapi's own voices select their generation with `version`, not `model` —
  // a different field, not a different spelling. V2 is both better and
  // cheaper, and is not the default at Vapi's end, so it is pinned here.
  const version =
    Number.isInteger(requestedVersion) && requestedVersion > 0
      ? requestedVersion
      : provider === "vapi"
        ? VAPI_DEFAULT_VERSION
        : undefined;

  return {
    provider,
    voiceId: env.VOICE_TTS_VOICE_ID ?? KNOWN_DEFAULT_VOICE[provider],
    // Included only when asked for. ElevenLabs needs a model; Deepgram and
    // Vapi reject the whole assistant if an unexpected field turns up on
    // their voice config, so this cannot default to anything.
    ...(model ? { model } : provider === "11labs" ? { model: "eleven_flash_v2_5" } : {}),
    ...(version === undefined ? {} : { version }),
  };
}

export type VapiAssistant = ReturnType<typeof buildAssistant>;

/**
 * What answers when a tenant's agent is paused — the kill switch.
 *
 * Not an error and not a hang-up: returning nothing useful from the assistant
 * lookup makes Vapi play its own failure message and drop the call, which is a
 * worse experience than the voicemail this replaces. Instead the caller gets a
 * short, honest greeting and space to leave a message, which the recording and
 * transcript capture the same as any other call — so the owner still sees who
 * rang while the agent is off the air.
 *
 * No tools at all: a paused agent must not book anything or write a job. That
 * is the whole point of pausing it.
 */
export function buildVoicemailAssistant(settings: AgentSettings) {
  return {
    name: `${settings.businessName} — paused`,
    // Paused or not, the disclosures still apply: it is still an AI, and it
    // is still recording if recording is on.
    firstMessage: [
      settings.aiDisclosure,
      settings.recordingDisclosure,
      `Thanks for calling ${settings.businessName}. Nobody's available to take your call right now — please leave your name, your number and what you need after the tone, and someone will get back to you.`,
    ]
      .filter(Boolean)
      .join(" "),
    recordingEnabled: settings.recordingDisclosure !== null,
    model: {
      provider: "anthropic",
      // Same model as the live agent, so a swap cannot leave the kill switch
      // running something the agent no longer does.
      model: modelChoice(),
      temperature: 0.3,
      messages: [
        {
          role: "system" as const,
          content: `You are an answering machine for ${settings.businessName}. Say nothing beyond acknowledging the caller briefly and letting them finish their message. Do not answer questions, do not give any information about the business, do not quote prices, and do not promise anything. If they ask a question, say someone will call them back. When they have finished, thank them and end the call.`,
        },
      ],
      tools: [],
    },
    voice: voiceChoice(),
    transcriber: { provider: "deepgram", model: "nova-3", language: "en-US" },
    // Same as the live agent — see there for why. It matters more here if
    // anything: scoring whether a voicemail "succeeded" is meaningless, and
    // a paused tenant is one already not making money.
    analysisPlan: { successEvaluationPrompt: "" },
    // Long enough to leave a real message, short enough that a silent line
    // does not burn minutes while the agent is meant to be off.
    silenceTimeoutSeconds: 15,
    maxDurationSeconds: 180,
  };
}

export function buildAssistant(
  settings: AgentSettings,
  opts: { toolUrl: string; serverSecret: string; bookingUrl?: string },
  now: Date = new Date(),
) {
  /**
   * Whether the agent can hand this caller to a person, decided per call.
   *
   * Two conditions, and the second is the one worth explaining: the tenant has
   * given us a number, AND it is currently their business hours. Transferring
   * at 11pm rings a phone nobody is holding, and a caller who has been told
   * "putting you through now" and then hears it ring out is worse off than one
   * who was never offered it — they have lost the message they would otherwise
   * have left. Outside hours the existing message-taking stands unchanged.
   *
   * Expressed by leaving the tool out entirely rather than by asking the model
   * to check the clock. A tool the model does not have is a tool it cannot
   * talk itself into using.
   */
  const canTransfer =
    Boolean(settings.transferE164) &&
    isWithinBusinessHours(settings.hours, now, settings.timezone);
  const bookingUrl = opts.bookingUrl ?? opts.toolUrl.replace(/\/[^/]+$/, "/booking");
  const knowledgeUrl = opts.toolUrl.replace(/\/[^/]+$/, "/knowledge");

  // Built once here rather than inline below, so its length can be checked
  // before it is sent. See warnIfUncacheable — a short prompt is a silent 4x
  // on this tenant's LLM bill.
  const systemPrompt = buildSystemPrompt(settings, { canTransfer });
  warnIfUncacheable(systemPrompt, settings.businessName);

  return {
    name: `${settings.businessName} — ${settings.agentName}`,
    // Disclosures lead, then the greeting — which ends by inviting the caller
    // to speak, so the call still opens naturally. They ride in the greeting
    // because Vapi speaks it verbatim before the model runs at all, and both
    // are legal requirements rather than stylistic choices:
    //
    // 1. Recording starts when the call connects. Leaving the disclosure to
    //    the model's first turn meant the caller had already spoken — and been
    //    recorded — before being told. Observed on the first real call.
    // 2. California AB 2905 and Texas TRAIGA require telling a caller they are
    //    speaking to an AI, unprompted. Texas is the market this sells into.
    // 3. An instruction in a prompt is something a model usually follows.
    //    "Usually" is not a standard to hold a customer's licence to.
    firstMessage: [
      settings.aiDisclosure,
      settings.recordingDisclosure,
      settings.greeting,
    ]
      .filter(Boolean)
      .join(" "),
    // Recording is derived from whether there is a disclosure to speak, so the
    // two cannot drift apart. Recording silently is the failure that matters in
    // all-party-consent states. See docs/threat-model.md §5.
    recordingEnabled: settings.recordingDisclosure !== null,
    model: {
      provider: "anthropic",
      // Vapi validates against Anthropic's full versioned model id — the
      // unversioned "claude-haiku-4-5" the plan used was rejected outright
      // with "assistant.model.model must be one of the following values...".
      // Confirmed against a real call 2026-08-11. See modelChoice.
      model: modelChoice(),
      // No `thinking` key at all — Anthropic's API has no "disabled" state,
      // only "enabled". Extended thinking is off by omission. Vapi validates
      // this strictly: `{ type: "disabled" }` was rejected outright with
      // "assistant.model.thinking.type must be one of the following values:
      // enabled". Confirmed against a real call 2026-08-11.
      //
      // Warm enough to sound human, tight enough not to improvise policy.
      temperature: 0.4,
      messages: [
        { role: "system" as const, content: systemPrompt },
      ],
      tools: [
        {
          type: "function" as const,
          function: {
            name: "capture_job",
            description:
              "Record what the caller needs. Call this once you know the problem, the caller's name and a callback number, before ending the call.",
            parameters: {
              type: "object" as const,
              properties: {
                caller_name: {
                  type: "string",
                  description: "The caller's name",
                },
                callback_e164: {
                  type: "string",
                  description:
                    "Callback number in E.164 format, e.g. +15551234567",
                },
                service_type: {
                  type: "string",
                  description: "Which service this is, in a few words",
                },
                urgency: { type: "string", enum: [...URGENCY] },
                address: {
                  type: "string",
                  description: "Service address including city",
                },
                description: {
                  type: "string",
                  description: "The problem in the caller's own words",
                },
                preferred_time: {
                  type: "string",
                  description: "When they would like someone to come out",
                },
              },
              // Enough for a technician to call back and win the work. Demanding
              // more would keep a caller on the phone for our benefit, not theirs.
              required: ["caller_name", "callback_e164", "description"],
            },
          },
          server: { url: opts.toolUrl, secret: opts.serverSecret },
        },
        {
          type: "function" as const,
          function: {
            name: "check_availability",
            description:
              "Get the real arrival windows that can be offered. Call this before suggesting any time. Never propose a time that did not come from here.",
            parameters: {
              type: "object" as const,
              properties: {
                service_type: {
                  type: "string",
                  description:
                    "Which service the caller wants, if they have said. Windows are sized to the job, so a quote visit and a full install get different lengths.",
                },
                preferred_day: {
                  type: "string",
                  enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
                  description:
                    "Set only if the caller names a specific day, e.g. \"do you have anything Saturday\". The three-letter form for that day, not the full word.",
                },
                after_date: {
                  type: "string",
                  description:
                    "Set only if the caller asks for a date or later, e.g. \"after the 20th\" or \"not until next week\". YYYY-MM-DD.",
                },
              },
              required: [],
            },
          },
          server: { url: bookingUrl, secret: opts.serverSecret },
        },
        {
          type: "function" as const,
          function: {
            name: "book_appointment",
            description:
              "Book one of the windows check_availability returned, once the caller has agreed to it.",
            parameters: {
              type: "object" as const,
              properties: {
                slot_start: {
                  type: "string",
                  description:
                    "The exact bracketed value from check_availability for the window the caller chose. Never a time you composed yourself.",
                },
                caller_name: { type: "string", description: "The caller's name" },
                callback_e164: {
                  type: "string",
                  description: "Callback number in E.164 format",
                },
                service_type: {
                  type: "string",
                  description: "Which service this is, in a few words",
                },
                address: {
                  type: "string",
                  description: "Service address including city",
                },
                notes: {
                  type: "string",
                  description: "Anything the technician should know before arriving",
                },
              },
              required: ["slot_start"],
            },
          },
          server: { url: bookingUrl, secret: opts.serverSecret },
        },
        {
          type: "function" as const,
          function: {
            name: "find_appointment",
            description:
              "Look up the jobs already booked for whoever is calling. Call this whenever the caller mentions an appointment they already have — asking when someone is coming, wanting to move a job, or wanting to cancel one — before booking anything new. Takes no arguments: the caller is identified by the number they're calling from, never by anything they say.",
            parameters: {
              type: "object" as const,
              properties: {},
              required: [],
            },
          },
          server: { url: bookingUrl, secret: opts.serverSecret },
        },
        {
          type: "function" as const,
          function: {
            name: "reschedule_appointment",
            description:
              "Move an existing appointment to a new time. Call find_appointment first for its id and check_availability for a real slot_start — never invent either. Refused inside 2 hours of the appointment's current start.",
            parameters: {
              type: "object" as const,
              properties: {
                appointment_id: {
                  type: "string",
                  description:
                    "The exact bracketed id from find_appointment for the job being moved. Never a value you composed yourself.",
                },
                slot_start: {
                  type: "string",
                  description:
                    "The exact bracketed value from check_availability for the new time. Never a time you composed yourself.",
                },
              },
              required: ["appointment_id", "slot_start"],
            },
          },
          server: { url: bookingUrl, secret: opts.serverSecret },
        },
        {
          type: "function" as const,
          function: {
            name: "cancel_appointment",
            description:
              "Cancel an existing appointment. Call find_appointment first for its id — never guess or invent one.",
            parameters: {
              type: "object" as const,
              properties: {
                appointment_id: {
                  type: "string",
                  description:
                    "The exact bracketed id from find_appointment for the job being cancelled. Never a value you composed yourself.",
                },
              },
              required: ["appointment_id"],
            },
          },
          server: { url: bookingUrl, secret: opts.serverSecret },
        },
        {
          type: "function" as const,
          function: {
            name: "lookup_knowledge",
            description:
              "Search what the business has written down before answering a question about services, brands, payment, warranty, coverage or fees. Returns reference text, or an explicit no-match.",
            parameters: {
              type: "object" as const,
              properties: {
                query: {
                  type: "string",
                  description:
                    "The caller''s question in their own words, a few words long.",
                },
              },
              required: ["query"],
            },
          },
          server: { url: knowledgeUrl, secret: opts.serverSecret },
        },
        // Vapi's own transfer tool, not one of ours: it is `type: "transferCall"`
        // at the top level with a `destinations` array, NOT a `type: "function"`
        // wrapper like the six above, and it never reaches our server — Vapi
        // performs the transfer itself. Shape confirmed against
        // docs.vapi.ai/tools/transfer-call 2026-08-31.
        //
        // No `transferPlan`, which means blind transfer: the caller is
        // connected without Vapi first speaking to the destination. A warm
        // transfer with a spoken summary needs Twilio-based telephony and our
        // number is Vapi-native, so it is not available to us today.
        ...(canTransfer
          ? [
              {
                type: "transferCall" as const,
                destinations: [
                  {
                    type: "number" as const,
                    number: settings.transferE164 as string,
                    description:
                      "The owner of the business. Use when the caller asks to speak to a person, the owner, or a human, or says the agent cannot help them.",
                    message: `Putting you through to ${settings.businessName} now.`,
                  },
                ],
              },
            ]
          : []),
      ],
    },
    voice: voiceChoice(),
    transcriber: { provider: "deepgram", model: "nova-3", language: "en-US" },
    // Keep the summary, drop the success evaluation.
    //
    // Both are extra LLM passes Vapi runs *after* the call. The summary is
    // read — `vapi.ts` maps `analysis.summary` onto `calls.summary`, which is
    // what the dashboard shows on every conversation row — and it is nearly
    // free (0.2% of a measured call).
    //
    // The success evaluation is not read anywhere in this codebase, and on a
    // real call on 2026-08-27 it was **14% of the total bill** — more than
    // transcription and more than the voice. Vapi runs it by default unless
    // an analysisPlan says otherwise, so it was being paid for silently since
    // the first call.
    //
    // An empty prompt is how Vapi disables it: there is no `enabled` boolean.
    // Leaving `summaryPrompt` unset keeps Vapi's own default summary, which
    // is what has been populating `calls.summary` all along — supplying one
    // here would quietly change the wording of every summary on the
    // dashboard, which is not what this change is for.
    analysisPlan: { successEvaluationPrompt: "" },
    // Long enough that a caller thinking is not cut off, short enough that a
    // dead line does not burn minutes.
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 600,
  };
}
