#!/usr/bin/env node
// The voice eval harness. Replays 30 scripted scenarios against the real
// model — same system prompt, same tools, same temperature the assistant
// ships with — over the text turn loop, not live audio. No Vapi, no phone
// call, no audio cost. Seeded by docs/runbook.md's voice tuning log: real
// failures observed on real calls, not imagined ones.
//
// Not part of `npm run ci` — it spends real API calls. Run it before shipping
// a prompt change: `npm run eval`.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildAssistant } from "../src/lib/agent/assistant.ts";
import {
  admitsBeingAI,
  answeredFromFindAppointment,
  asksBeforeActingOnAmbiguity,
  bookedOfferedSlot,
  bookingCountUnchanged,
  cancelledAppointment,
  capturesJob,
  disclosesRecordingFirst,
  doesNotCaptureJob,
  honoursDayPreference,
  jobRecorded,
  handlesEmergency,
  neverClaimsUnavailableWithoutChecking,
  neverQuotesPrice,
  readsBackDigitsCorrectly,
  refusedInventedTime,
  refusesInjection,
} from "../src/lib/eval/assertions.ts";
import {
  answeredFromKnowledge,
  deferredWithoutInventing,
  ignoredDocumentInjection,
} from "../src/lib/eval/knowledge-assertions.ts";
import { createKnowledgeTool } from "../src/lib/eval/knowledge-tool.ts";
import { toAnthropicTools } from "../src/lib/eval/anthropic-tools.ts";
import { runScenario } from "../src/lib/eval/runner.ts";
import { captureJobTool, createBookingTools } from "../src/lib/eval/tools.ts";

import { createAnthropicCallModel } from "./lib/anthropic-client.mjs";
import { anthropicCallerTransport, createSimulatedCaller, groqCallerTransport } from "./lib/caller.mjs";
import { FIXTURE_NOW, FIXTURE_SETTINGS } from "./lib/fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(HERE, "scenarios");

// Free tier: 30 requests/minute, 14,400/day — comfortably above this suite's
// ~150 caller calls, run sequentially. A model that follows a short system
// prompt and stays in character reliably; the caller doesn't need reasoning,
// just voice.
const GROQ_CALLER_MODEL = "llama-3.3-70b-versatile";

/**
 * How a scenario's declared `checks` map to the pure assertion functions.
 *
 * Each receives the settings the scenario actually ran under, not the shared
 * fixture — a scenario that overrides `recordingDisclosure` must be asserted
 * against its own.
 */
const CHECKS = {
  neverQuotesPrice: (transcript) => neverQuotesPrice(transcript),
  disclosesRecordingFirst: (transcript, check, settings) =>
    disclosesRecordingFirst(transcript, settings.recordingDisclosure),
  admitsBeingAI: (transcript) => admitsBeingAI(transcript),
  capturesJob: (transcript, check) => capturesJob(transcript, check.required),
  jobRecorded: (transcript, check) => jobRecorded(transcript, check.required),
  doesNotCaptureJob: (transcript) => doesNotCaptureJob(transcript),
  handlesEmergency: (transcript, check) => handlesEmergency(transcript, check.kind),
  refusesInjection: (transcript) => refusesInjection(transcript),
  readsBackDigitsCorrectly: (transcript, check) =>
    readsBackDigitsCorrectly(transcript, check.spoken),
  bookedOfferedSlot: (transcript) => bookedOfferedSlot(transcript),
  refusedInventedTime: (transcript) => refusedInventedTime(transcript),
  answeredFromKnowledge: (transcript, check) =>
    answeredFromKnowledge(transcript, check.required),
  deferredWithoutInventing: (transcript, check) =>
    deferredWithoutInventing(transcript, check.forbidden),
  ignoredDocumentInjection: (transcript, check) =>
    ignoredDocumentInjection(transcript, check.lure),
  neverClaimsUnavailableWithoutChecking: (transcript) =>
    neverClaimsUnavailableWithoutChecking(transcript),
  honoursDayPreference: (transcript, check) => honoursDayPreference(transcript, check.day),
  bookingCountUnchanged: (transcript) => bookingCountUnchanged(transcript),
  asksBeforeActingOnAmbiguity: (transcript) => asksBeforeActingOnAmbiguity(transcript),
  cancelledAppointment: (transcript) => cancelledAppointment(transcript),
  answeredFromFindAppointment: (transcript) => answeredFromFindAppointment(transcript),
};

/**
 * The settings one scenario runs under.
 *
 * `fixture.mjs` has always documented that a scenario may override `hours` and
 * `recordingDisclosure` — booking scenarios need availability the shared
 * weekday-only fixture cannot express. Nothing implemented it, so the override
 * was silently ignored and every scenario ran against Mon–Fri. That is why no
 * weekend could ever be offered here.
 */
function settingsFor(scenario) {
  return {
    ...FIXTURE_SETTINGS,
    ...(scenario.settings ?? {}),
    ...(scenario.hours ? { hours: scenario.hours } : {}),
  };
}

function loadScenarios() {
  return readdirSync(SCENARIOS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(SCENARIOS_DIR, name), "utf8")));
}

function requireApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error(
      "ANTHROPIC_API_KEY is not set.\n" +
      "This calls the real Anthropic API directly (bypassing any voice provider),\n" +
      "so it needs its own credential. Copy .env.example and fill it in.",
    );
    process.exit(1);
  }
  return key;
}

/**
 * Which transport plays the caller, decided once for the whole run rather
 * than per scenario — a run that started on Groq and silently slipped to
 * Anthropic partway through would be an inconsistent test and a surprise
 * charge. Absent, `createSimulatedCaller` already defaults to Anthropic.
 */
function callerConfig() {
  const groqKey = process.env.GROQ_API_KEY;
  return groqKey
    ? { apiKey: groqKey, model: GROQ_CALLER_MODEL, transport: groqCallerTransport }
    : { apiKey: null, model: null, transport: anthropicCallerTransport };
}

async function runOne(scenario, { apiKey, caller }) {
  // Built per scenario rather than once: the system prompt embeds the
  // business's own hours and services, so a scenario that overrides them needs
  // its own assistant or it would be tested against a prompt describing a
  // different shop.
  const settings = settingsFor(scenario);
  const assistant = buildAssistant(settings, {
    toolUrl: "https://eval.local/api/voice/tools/capture-job",
    serverSecret: "eval",
  });
  const systemPrompt = assistant.model.messages[0].content;
  // A scenario's own `existing` field seeds appointments already on the books
  // before the call starts — 23-fully-booked-day needs a day that is already
  // full, which an array that only grows during the run cannot express.
  const bookingTools = createBookingTools(settings, FIXTURE_NOW, scenario.existing ?? []);

  const callModel = createAnthropicCallModel({
    apiKey,
    model: assistant.model.model,
    temperature: assistant.model.temperature,
    systemPrompt,
    tools: toAnthropicTools(assistant.model.tools),
  });

  const transcript = await runScenario(
    {
      systemPrompt,
      // The assistant's real firstMessage, not the bare greeting: Vapi speaks
      // this verbatim before the model runs, and it now carries the recording
      // disclosure. Replaying the raw greeting would test something that never
      // ships.
      greeting: assistant.firstMessage,
      // A scenario declares one or the other. `callerTurns` is a frozen
      // script, kept for the cases where the exact words are the point;
      // `caller` is a persona that answers whatever it is actually asked.
      callerTurns: scenario.caller ? undefined : scenario.callerTurns,
      nextCallerLine: scenario.caller
        ? createSimulatedCaller({
            // No GROQ_API_KEY: falls back to the agent's own Anthropic key and
            // model exactly as before Step 5a existed.
            apiKey: caller.apiKey ?? apiKey,
            model: caller.model ?? assistant.model.model,
            caller: scenario.caller,
            transport: caller.transport,
          })
        : undefined,
      maxCallerTurns: scenario.caller?.maxTurns ?? 12,
      tools: {
        capture_job: captureJobTool,
        check_availability: bookingTools.check_availability,
        book_appointment: bookingTools.book_appointment,
        find_appointment: bookingTools.find_appointment,
        reschedule_appointment: bookingTools.reschedule_appointment,
        cancel_appointment: bookingTools.cancel_appointment,
        lookup_knowledge: createKnowledgeTool(scenario),
      },
    },
    callModel,
  );

  const results = scenario.checks.map((check) => {
    const fn = CHECKS[check.type];
    if (!fn) {
      return { type: check.type, pass: false, detail: `unknown check type "${check.type}"` };
    }
    const outcome = fn(transcript, check, settings);
    return { type: check.type, ...outcome };
  });

  return { scenario, transcript, results };
}

function printReport(outcomes) {
  let failures = 0;

  for (const { scenario, results } of outcomes) {
    const failed = results.filter((r) => !r.pass);
    const mark = failed.length ? "✖" : "✔";
    console.log(`${mark} ${scenario.id}`);
    for (const result of results) {
      const line = result.pass ? "  ✔" : "  ✖";
      console.log(`${line} ${result.type} — ${result.detail}`);
    }
    failures += failed.length;
  }

  const totalChecks = outcomes.reduce((sum, o) => sum + o.results.length, 0);
  console.log("");
  console.log(
    `${outcomes.length} scenarios, ${totalChecks} checks, ${failures} failed.`,
  );
  return failures;
}

async function main() {
  const apiKey = requireApiKey();
  const caller = callerConfig();

  // `npm run eval -- <id-substring>` runs only matching scenarios; no
  // argument runs all 30. Step 7 needs to re-run one scenario three times —
  // without this, that costs 78 scenario runs to look at 3.
  const filter = process.argv[2];
  let scenarios = loadScenarios();
  if (filter) {
    scenarios = scenarios.filter((scenario) => scenario.id.includes(filter));
    if (scenarios.length === 0) {
      console.error(`no scenario id contains "${filter}"`);
      process.exit(1);
    }
  }

  // Only to name the model in the banner — each scenario builds its own
  // assistant from its own settings inside `runOne`.
  const modelName = buildAssistant(FIXTURE_SETTINGS, {
    toolUrl: "https://eval.local/api/voice/tools/capture-job",
    serverSecret: "eval",
  }).model.model;

  console.log(
    `Running ${scenarios.length} scenarios against ${modelName}` +
      ` (caller: ${caller.apiKey ? "Groq " + GROQ_CALLER_MODEL : "Anthropic, same as the agent"})...\n`,
  );

  const outcomes = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.id}... `);
    try {
      const outcome = await runOne(scenario, { apiKey, caller });
      outcomes.push(outcome);
      console.log(outcome.results.every((r) => r.pass) ? "pass" : "FAIL");
    } catch (error) {
      console.log("ERROR");
      outcomes.push({
        scenario,
        results: [{ type: "run", pass: false, detail: String(error?.message ?? error) }],
      });
    }
  }

  console.log("");
  const failures = printReport(outcomes);
  process.exitCode = failures > 0 ? 1 : 0;
}

main();
