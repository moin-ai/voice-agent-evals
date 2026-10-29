import type { VapiAssistant } from "../agent/assistant.ts";
import type { ModelMessage, ModelTurn, PendingToolCall } from "./runner.ts";

/**
 * Vapi's tool schema wrapped in `{type:"function", function:{...}}` is
 * OpenAI's shape — Vapi translates it to Anthropic's native tool format
 * (`{name, description, input_schema}`, no wrapper) before it ever reaches
 * Claude. The eval harness bypasses Vapi and calls Anthropic directly, so it
 * has to do that translation itself.
 *
 * Converting `buildAssistant()`'s own output — rather than hand-writing a
 * second copy of the tool definitions — is what keeps the eval honest: it
 * tests the exact tools shipped to Vapi, not a parallel set that could drift.
 */
export function toAnthropicTools(tools: VapiAssistant["model"]["tools"]) {
  // Function tools only. `transferCall` is Vapi's own built-in — it is handled
  // inside Vapi and never reaches the model as a callable schema, so there is
  // nothing here to hand Anthropic. Filtering rather than asserting keeps the
  // eval honest about what the model actually sees on a real call.
  return tools
    .filter((tool): tool is Extract<typeof tool, { function: unknown }> => "function" in tool)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

/**
 * Anthropic requires every `tool_result` produced in response to one
 * assistant turn to arrive as content blocks on a single following user
 * message, not as separate messages. `runner.ts` records one `tool_result`
 * entry per tool call, so consecutive ones here are merged back into one.
 *
 * The system message is dropped: Anthropic takes it as a separate top-level
 * `system` parameter, not as a message in the list.
 */
export function toAnthropicMessages(history: ModelMessage[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  for (const entry of history) {
    if (entry.role === "system") continue;

    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.content });
      continue;
    }

    if (entry.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (entry.text) blocks.push({ type: "text", text: entry.text });
      for (const call of entry.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }

    // tool_result — append to the trailing user message if the previous entry
    // was also a tool_result, otherwise start a new one.
    const block: AnthropicContentBlock = {
      type: "tool_result",
      tool_use_id: entry.toolCallId,
      content: entry.content,
    };
    const last = messages.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      messages.push({ role: "user", content: [block] });
    }
  }

  return messages;
}

/** The shape of one Anthropic Messages API response, trimmed to what is used. */
export type AnthropicResponse = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
};

export function fromAnthropicResponse(response: AnthropicResponse): ModelTurn {
  let text = "";
  const toolCalls: PendingToolCall[] = [];

  for (const block of response.content) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
  }

  return { text, toolCalls };
}
