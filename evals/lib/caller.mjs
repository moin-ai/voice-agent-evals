// A caller who listens.
//
// Scripted caller turns cannot answer a question they were not written for.
// Fixing the agent's ordering — so it offers a time before asking for a name —
// left the eval score identical, because every scripted third line still
// answered "what's your name?", a question the agent had stopped asking. The
// agent got better and the number did not move. A harness that cannot tell
// those apart is not measuring anything.
//
// So the caller is played by the same cheap model, given a persona, a set of
// facts, and a goal. It answers what it is actually asked and hangs up when it
// is done. Temperature 0: the agent under test is the thing allowed to vary.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MAX_TOKENS = 150;

/** The caller says this and nothing else when the call is over. */
const HANGUP = "[HANGUP]";

/**
 * The default transport: Anthropic's Messages API, same as the agent under
 * test calls, just a different model and a `system` string instead of tools.
 */
export async function anthropicCallerTransport({ apiKey, model, system, messages }) {
  const response = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, temperature: 0, system, messages }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`caller model (Anthropic) ${response.status}: ${body.slice(0, 300)}`);
  }

  const body = await response.json();
  return (body.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Groq's OpenAI-compatible endpoint. The caller has no tools and no blind
 * spots to protect, so any decent chat model can play it — and a caller
 * phrased by a model other than the one under test is a fairer read on
 * whether the agent copes with real people, not a mirror of its own habits.
 *
 * A failure here must throw, never fall back to Anthropic quietly: a caller
 * that silently switched transports mid-suite would burn the Anthropic
 * balance Step 6 needs and nobody would know why until it ran out again.
 */
export async function groqCallerTransport({ apiKey, model, system, messages }) {
  const response = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`caller model (Groq) ${response.status}: ${body.slice(0, 300)}`);
  }

  const body = await response.json();
  return (body.choices?.[0]?.message?.content ?? "").trim();
}

function systemPromptFor({ persona, facts, goal }) {
  const known = Object.entries(facts ?? {})
    .map(([label, value]) => `- ${label}: ${value}`)
    .join("\n");

  return [
    "You are a person phoning a business. Stay in character at all times.",
    "",
    `WHO YOU ARE: ${persona}`,
    known ? `WHAT YOU KNOW ABOUT YOURSELF:\n${known}` : "",
    `WHAT YOU WANT FROM THIS CALL: ${goal}`,
    "",
    "How to behave:",
    "- Answer only what you were just asked. One or two short sentences.",
    "- Talk like someone on a phone call, not like someone writing.",
    "- Never invent facts about yourself beyond the ones listed above. If you",
    "  are asked something not listed, say you are not sure.",
    "- Do not be unnaturally helpful. Do not volunteer everything at once.",
    `- When you have got what you wanted, or it is clear you cannot, say a short`,
    `  goodbye and then output ${HANGUP} on its own line.`,
    `- If you are asked nothing and there is nothing left to say, output ${HANGUP}.`,
    "",
    "Output only the words you speak. No stage directions, no quotation marks.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds a `NextCallerLine` for `runScenario`.
 *
 * The caller sees the transcript from its own side: the agent's turns are
 * `user` messages to it, its own are `assistant`. That inversion is the whole
 * trick — no second orchestration loop is needed.
 */
export function createSimulatedCaller({ apiKey, model, caller, transport = anthropicCallerTransport }) {
  const system = systemPromptFor(caller);

  return async function nextCallerLine(turns) {
    // An injection payload or a scripted opening question has to arrive word
    // for word — paraphrasing it tests a different attack. So the first line
    // can be fixed while everything after it adapts.
    if (caller.opening && !turns.some((turn) => turn.role === "caller")) {
      return caller.opening;
    }

    const messages = turns.map((turn) => ({
      role: turn.role === "agent" ? "user" : "assistant",
      content: turn.content,
    }));

    // The transcript always opens with the agent's greeting, so the first
    // message is already a `user` one from the caller model's point of view.
    const said = await transport({ apiKey, model, system, messages });

    if (said.includes(HANGUP)) {
      const parting = said.replace(HANGUP, "").trim();
      // A goodbye still gets spoken — the agent's last chance to capture the
      // job is the turn it takes in response to it.
      return parting.length > 0 ? parting : null;
    }

    return said.length > 0 ? said : null;
  };
}
