/**
 * A scripted stand-in for the knowledge route, used by the eval harness.
 *
 * The evals test the AGENT's behaviour — whether it looks something up before
 * answering, and whether it invents when there is nothing to find. They are not
 * a test of retrieval maths: ranking, the score floor and dimension handling
 * are pure functions with their own unit tests.
 *
 * Each scenario declares what its knowledge base contains:
 *
 *   "knowledge": [
 *     { "match": ["warranty"], "content": "Every repair is covered for 90 days." }
 *   ]
 *
 * No match, or no knowledge field at all, returns the same no-match payload the
 * real route returns — so a scenario with no knowledge doubles as the
 * empty-base case.
 */

import type { EvalToolCall } from "./assertions.ts";
import type { PendingToolCall } from "./runner.ts";

export type ScenarioKnowledge = {
  /** Lowercase substrings looked for in the query. */
  match?: string[];
  content: string;
};

export type KnowledgeScenario = {
  knowledge?: ScenarioKnowledge[];
};

export const NO_MATCH =
  "No matching information in the business knowledge base.";

export function createKnowledgeTool(
  scenario: KnowledgeScenario,
): (call: PendingToolCall) => { content: string; recorded: EvalToolCall } {
  const entries = Array.isArray(scenario.knowledge) ? scenario.knowledge : [];

  return (call: PendingToolCall) => {
    const query = String(call?.args?.query ?? "").toLowerCase();

    const entry = entries.find((candidate) =>
      (candidate.match ?? []).some((needle) =>
        query.includes(String(needle).toLowerCase()),
      ),
    );

    return {
      content: entry?.content ?? NO_MATCH,
      // Recorded so assertions can require that a lookup actually happened.
      // Without this a correct guess would pass the text check.
      recorded: { name: "lookup_knowledge", args: call?.args ?? {} } as EvalToolCall,
    };
  };
}
