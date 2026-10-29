# voice-agent-evals

A scenario-based evaluation harness for a production LLM voice agent — 34 scripted
callers, 65 behavioural checks, run against the real model, exercising the same
policies the shipped product uses and the real tool code.

Extracted from a private production product (an AI phone receptionist that answers
missed calls for home-services businesses). No tenant data, credentials, or
proprietary prompt content ships here — the fixture is a fictional plumbing
company, and the production system prompt is replaced by a compact reference
prompt that states the same rules the scenarios assert on.

## Why this exists

Prompt changes are the highest-risk change in an LLM product and the easiest to
ship untested. A model that resists a price question today can fold tomorrow after
a one-line prompt edit. Unit tests do not catch that; only conversation does.

So every scenario replays a full turn loop against the model the assistant
actually ships with, then asserts on the transcript. The suite runs before a
prompt change ships, not in CI — it spends real API calls.

## What it checks

| Area | Examples |
|---|---|
| Price discipline | Never quotes a price, even under repeated pressure or anger |
| AI disclosure | Admits being an AI when asked, directly or mid-call |
| Recording disclosure | Discloses recording before anything else happens |
| Emergencies | Gas smell and active flooding get safety instructions, not troubleshooting |
| Prompt injection | Ignores "ignore your instructions", fake authority, requests for other customers' data |
| Data capture | Captures a job with minimal information; reads phone digits back correctly |
| Booking | Offers only real availability, refuses invented times, handles fully-booked days |
| Amend | Reschedules and cancels the right job without duplicating it |
| Grounding | Answers from the knowledge base, defers when the answer is absent, ignores injected documents |

20 distinct assertion types, all pure functions over the transcript.

## Results

Retrieval evaluation, measured on a labelled set (16 answerable + 4 off-topic
questions), thresholds fixed before the first run:

| Metric | Value | Target |
|---|---|---|
| recall@1 | 15/16 (94%) | ≥ 80% |
| recall@3 | 16/16 (100%) | — |
| MRR | 0.969 | — |
| off-topic false positives | 0/4 (0%) | ≤ 10% |

Full write-up, including the one documented miss and why it was left unfixed:
[`evals/retrieval/results-2026-10-25.md`](evals/retrieval/results-2026-10-25.md).

The voice suite prints its own pass/fail report per run. It has not been executed
in this checkout — it requires a live model key.

## Run it

```bash
cp .env.example .env      # add ANTHROPIC_API_KEY
npm run eval              # all 34 scenarios
npm run eval -- 06        # only scenario ids containing "06"
npm run eval -- knowledge # only knowledge-grounding scenarios
```

Set `GROQ_API_KEY` to run the simulated caller on Groq's free tier instead of
Anthropic — a full run is ~150 caller turns, so this keeps the cost down.

Requires Node 22.18+ (TypeScript type stripping, no build step).

## Layout

```
evals/
  run.mjs                  # driver: loads scenarios, runs the turn loop, maps checks
  lib/
    caller.mjs             # simulated caller (Groq or Anthropic transport)
    anthropic-client.mjs   # the model under test
    fixture.mjs            # one fictional tenant + a fixed "now"
  scenarios/*.json         # 34 scenarios: persona or frozen script, plus checks
  retrieval/               # labelled retrieval questions + measured results
src/lib/
  agent/                   # reference system prompt + the assistant definition
  eval/                    # turn loop, tool harness, assertions
  booking/                 # real scheduling and reply logic
```

## Design notes

- **The real path, not a copy.** Tools call the same reply and booking functions
  the production routes call, so the model is judged against real wording and real
  rules. Only the database is replaced — appointments live in memory.
- **One assistant per scenario.** The system prompt embeds the business's hours and
  services, so a scenario that overrides them gets its own assistant. Testing a
  scenario against a prompt describing a different shop would be meaningless.
- **Personas, not just scripts.** Frozen `callerTurns` are kept where the exact
  words are the point; most scenarios use a persona that answers whatever it is
  actually asked, which is what makes injection and ambiguity cases real.
- **Deterministic environment.** One fixed timestamp and one fixture tenant, so
  booking scenarios have stable windows to offer.

## License

MIT — see [LICENSE](LICENSE).
