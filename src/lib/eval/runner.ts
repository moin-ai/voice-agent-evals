import type { EvalToolCall, EvalTranscript, EvalTurn } from "./assertions.ts";

/** One tool call the model made, plus the seam gets to answer it. */
export type PendingToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

/** What the model returned for one turn: words to say, and/or tools to call. */
export type ModelTurn = {
  text: string;
  toolCalls: PendingToolCall[];
};

/**
 * The one seam that talks to a real model. Runner is otherwise pure, which is
 * what makes the turn-by-turn orchestration itself testable with a scripted
 * fake instead of spending an API call per assertion.
 */
export type CallModel = (history: ModelMessage[]) => Promise<ModelTurn>;

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: PendingToolCall[] }
  | { role: "tool_result"; toolCallId: string; content: string };

/** Executes one tool call locally and returns what the model should be told. */
export type ToolExecutor = (
  call: PendingToolCall,
) => { content: string; recorded?: EvalToolCall };

/**
 * Produces the caller's next line, or `null` when they hang up.
 *
 * A fixed list cannot respond to what the agent actually said, so any change
 * that alters the agent's questions puts the script out of sync and fails
 * checks for reasons that have nothing to do with the agent. That is not
 * hypothetical: fixing the agent's ordering left the score identical because
 * every scripted reply still answered the old questions.
 */
export type NextCallerLine = (turns: EvalTurn[]) => Promise<string | null>;

export type Scenario = {
  systemPrompt: string;
  /** The greeting Vapi would speak directly, before any model turn. */
  greeting: string;
  /** The caller's scripted lines, played in order. Mutually exclusive with `nextCallerLine`. */
  callerTurns?: string[];
  /** A caller that reacts to the agent. Ignored when `callerTurns` is given. */
  nextCallerLine?: NextCallerLine;
  /** Hard stop for a simulated caller, so a loop cannot run forever. */
  maxCallerTurns?: number;
  tools: Record<string, ToolExecutor>;
  /** Upper bound on model turns per caller line, so a tool-call loop cannot spin forever. */
  maxToolHopsPerTurn?: number;
};

/**
 * Plays a scripted caller against a real (or fake) model turn by turn,
 * executing whatever tools it calls locally, and returns the finished
 * transcript plus every tool call made — the shape every assertion reads.
 *
 * The greeting is recorded as the first agent turn without calling the model:
 * in production it is Vapi's static `firstMessage`, spoken before the model
 * ever runs. The model's first real turn is what comes after the caller
 * responds to it — which is exactly where the recording disclosure is supposed
 * to land.
 */
export async function runScenario(
  scenario: Scenario,
  callModel: CallModel,
): Promise<EvalTranscript> {
  const {
    systemPrompt,
    greeting,
    callerTurns,
    nextCallerLine,
    maxCallerTurns = 12,
    tools,
    maxToolHopsPerTurn = 4,
  } = scenario;

  // A scripted scenario is just a caller that ignores what it hears. Same loop
  // either way, so the orchestration below has one shape to reason about.
  const scripted = callerTurns !== undefined;
  let scriptIndex = 0;
  const nextLine: NextCallerLine = scripted
    ? async () => callerTurns[scriptIndex++] ?? null
    : (nextCallerLine ??
      (() => {
        throw new Error("scenario needs either callerTurns or nextCallerLine");
      }));

  // The greeting goes into the model's own history, not just the transcript.
  // Vapi speaks `firstMessage` and the model sees it as something it already
  // said; leaving it out of `history` is why the model greeted a second time
  // on its first real turn — a divergence from production that made every
  // scenario's opening turn worthless.
  const history: ModelMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "assistant", text: greeting, toolCalls: [] },
  ];
  // One counter shared by turns and tool calls, stamped at the moment each
  // actually happens in this loop — the loop already knows the true order,
  // so this is just recording it instead of throwing it away. It is what lets
  // an assertion ask "did this tool call happen before that claim" instead of
  // only "did it happen at all". See assertions.ts's
  // neverClaimsUnavailableWithoutChecking for the check this exists for.
  let seq = 0;
  const turns: EvalTurn[] = [{ role: "agent", content: greeting, seq: seq++ }];
  const toolCalls: EvalToolCall[] = [];

  for (let spoken = 0; spoken < maxCallerTurns; spoken++) {
    const line = await nextLine(turns);
    // Null is the caller hanging up — the end of a scripted list, or a
    // simulated caller deciding it is done. Either way the agent gets no
    // further turn, exactly as on a real call.
    if (line === null) break;

    history.push({ role: "user", content: line });
    turns.push({ role: "caller", content: line, seq: seq++ });

    for (let hop = 0; hop < maxToolHopsPerTurn; hop++) {
      const result = await callModel(history);
      history.push({
        role: "assistant",
        text: result.text,
        toolCalls: result.toolCalls,
      });

      if (result.text.trim()) {
        turns.push({ role: "agent", content: result.text.trim(), seq: seq++ });
      }

      if (result.toolCalls.length === 0) break;

      for (const call of result.toolCalls) {
        const executor = tools[call.name];
        const outcome = executor
          ? executor(call)
          : { content: `unknown tool: ${call.name}` };

        if (outcome.recorded) toolCalls.push({ ...outcome.recorded, seq: seq++ });

        history.push({
          role: "tool_result",
          toolCallId: call.id,
          content: outcome.content,
        });
      }
      // Loop again: a model that just received a tool result usually has
      // something to say next, and may chain a second tool call.
    }
  }

  return { turns, toolCalls };
}
