// The one place in the eval harness that makes a real network call. Everything
// it depends on — the tool schema conversion, the message-history mapping, the
// response parsing — is pure TypeScript under src/lib/eval/ and unit tested
// there; this file is intentionally thin so there is as little here as
// possible that only a live API call could catch.

import {
  fromAnthropicResponse,
  toAnthropicMessages,
} from "../../src/lib/eval/anthropic-tools.ts";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

/**
 * Builds a `CallModel` (the seam `runScenario` calls) that hits the real
 * Anthropic Messages API with the exact model, temperature and tools the
 * assistant is actually built with.
 */
export function createAnthropicCallModel({ apiKey, model, temperature, systemPrompt, tools }) {
  return async function callModel(history) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature,
        system: systemPrompt,
        tools,
        messages: toAnthropicMessages(history),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 500)}`);
    }

    return fromAnthropicResponse(await response.json());
  };
}
