/**
 * Scripted agent loop.
 *
 * The agent is deliberately SCRIPTED (deterministic, documented as such in
 * the README): given a task, it produces a fixed sequence of attempted tool
 * calls — including the drift the guard is meant to catch — and routes
 * every call through the guard before anything executes. The guard is the
 * product under test, not the agent: a real LLM agent would produce the
 * same shapes of calls (read the assigned doc, drift to another doc, try a
 * write, try a spend), and the guard judges each one the same way.
 *
 * runAgent(task, attempts, deps) prints each attempt, its decision and its
 * reason, and returns the list of outcomes. The demo runner uses it for
 * the 5 scenes.
 */
import { execute, getAuditLog, clearAuditLog } from './guard.mjs';

export async function runAgent(task, attempts, deps = {}) {
  const outcomes = [];
  for (const attempt of attempts) {
    const outcome = await execute(task, attempt, deps);
    outcomes.push({ attempt, ...outcome });
    const argStr = JSON.stringify(attempt.args);
    console.log(`  ${attempt.tool}(${argStr}) -> ${outcome.decision} [${outcome.stage}]`);
    console.log(`    ${outcome.reason}`);
    if (outcome.result?.txHash) console.log(`    tx: ${outcome.result.txHash}`);
  }
  return outcomes;
}

export { getAuditLog, clearAuditLog };
