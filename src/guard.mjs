/**
 * AgntID MCP proxy guard.
 *
 * Implements the AgntID runtime model (agntid.ai): every tool call is
 * evaluated ONE BY ONE at execution time — Intent + Policy -> Access
 * Decision — with the NEAR Agent Allowance Guard contract as the final
 * money enforcer.
 *
 * Decision pipeline, in order:
 *   1. policy — is the tool in this task's tool allowlist?
 *   2. intent — deterministic matcher: the tool's verb must be in the
 *      task's intent verbs AND its resource in the intent resources.
 *   3. money  — spends only: read the LIVE allowance and pre-check, in
 *      the contract's own order (exists / not revoked / not expired /
 *      recipient allowlisted / amount within remaining cap).
 *   4. contract — spends that pass 1-3 are executed on-chain; the
 *      contract is the final enforcer and a panic is a DENY.
 *   5. audit  — every outcome is recorded.
 *
 * decide() only DECIDES (it reads the allowance for spends but executes
 * nothing). execute() decides and then runs the tool when ALLOWed.
 * Both take an optional `deps` object so tests can inject fakes and the
 * demo can run fully offline except for the two live spend attempts:
 *   deps = { getAllowance, attemptSpend, getSpendLog }
 */
import { readDoc, writeDoc, deleteDoc } from './tools.mjs';
import {
  AGENT_ID,
  PAYEE_ID,
  getAllowance as liveGetAllowance,
  attemptSpend as liveAttemptSpend,
  getSpendLog as liveGetSpendLog,
  nearToYocto,
  yoctoToNear,
} from './near.mjs';

/** Tool name -> intent verb. */
export const TOOL_VERBS = {
  readDoc: 'read',
  writeDoc: 'write',
  deleteDoc: 'delete',
  spendNear: 'spend',
};

/** Tool call -> the resource the call acts on. */
export function resourceOf(tool, args) {
  if (tool === 'spendNear') return args.to;
  return args.name;
}

const auditLog = [];
export function getAuditLog() {
  return auditLog;
}
export function clearAuditLog() {
  auditLog.length = 0;
}

function audit(entry) {
  const full = { timestamp: new Date().toISOString(), ...entry };
  auditLog.push(full);
  return full;
}

function deny(task, toolCall, stage, reason) {
  // Pure: decide() returns the outcome; execute() audits it exactly once.
  return { task: task.name ?? task, tool: toolCall, decision: 'DENY', stage, reason };
}

/**
 * Decide a single tool call. No tool is executed here.
 * Spends read the live allowance (or deps.getAllowance when injected).
 */
export async function decide(task, toolCall, deps = {}) {
  const { tool, args } = toolCall;
  const getAllowance = deps.getAllowance ?? liveGetAllowance;

  // Stage 1 — policy: tool must be in the task's tool allowlist.
  const allowedTools = task.tools ?? [];
  if (!allowedTools.includes(tool)) {
    return deny(
      task,
      toolCall,
      'policy',
      `tool '${tool}' not in task allowlist [${allowedTools.join(', ')}]`,
    );
  }

  // Stage 2 — intent: verb and resource must match the declared intent.
  const intent = task.intent ?? { verbs: [], resources: [] };
  const verb = TOOL_VERBS[tool] ?? tool;
  const resource = resourceOf(tool, args);
  if (intent.verbs?.length && !intent.verbs.includes(verb)) {
    return deny(
      task,
      toolCall,
      'intent',
      `verb '${verb}' not in intent verbs ${JSON.stringify(intent.verbs)}`,
    );
  }
  if (intent.resources?.length && resource && !intent.resources.includes(resource)) {
    return deny(
      task,
      toolCall,
      'intent',
      `resource '${resource}' not in intent resources ${JSON.stringify(intent.resources)}`,
    );
  }

  // Stage 3 — money: spends only, live allowance pre-check in the
  // contract's own check order (exists / revoked / expired / allowlist /
  // cap). Every failing check is reported, so a call that would fail for
  // several reasons shows all of them; the first one is the reason the
  // contract itself would hit first.
  if (tool === 'spendNear') {
    const amountYocto = BigInt(nearToYocto(args.amountNear));
    let allowance;
    try {
      allowance = await getAllowance(AGENT_ID);
    } catch (err) {
      return deny(task, toolCall, 'money', `allowance read failed: ${err.message}`);
    }
    if (!allowance) {
      return deny(task, toolCall, 'money', `no allowance exists for agent ${AGENT_ID}`);
    }
    const failures = [];
    if (allowance.revoked) {
      failures.push(
        `allowance has been revoked (revoke tx ` +
          `EgCmj9cv52QrE49KnXiL5LkiDZyjpZJjdyKCB1p49CGz)`,
      );
    }
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    if (BigInt(allowance.expires_at) <= nowNs) {
      failures.push(
        `allowance has expired (expired ${new Date(Number(BigInt(allowance.expires_at) / 1_000_000n)).toISOString()})`,
      );
    }
    if (!allowance.allowlist.includes(args.to)) {
      failures.push(
        `recipient '${args.to}' not on allowlist ${JSON.stringify(allowance.allowlist)}`,
      );
    }
    const remaining = BigInt(allowance.cap) - BigInt(allowance.spent);
    if (amountYocto > remaining) {
      failures.push(
        `amount ${args.amountNear} NEAR exceeds remaining allowance ` +
          `${yoctoToNear(remaining)} NEAR (cap ${yoctoToNear(allowance.cap)}, ` +
          `spent ${yoctoToNear(allowance.spent)})`,
      );
    }
    if (failures.length) {
      return deny(task, toolCall, 'money', failures.join('; '));
    }
    return {
      task: task.name ?? task,
      tool: toolCall,
      decision: 'ALLOW',
      stage: 'money',
      reason:
        `money pre-check passed: ${args.amountNear} NEAR within remaining ` +
        `${yoctoToNear(remaining)} NEAR (cap ${yoctoToNear(allowance.cap)}, ` +
        `spent ${yoctoToNear(allowance.spent)}); contract is the final enforcer`,
    };
  }

  return {
    task: task.name ?? task,
    tool: toolCall,
    decision: 'ALLOW',
    stage: 'intent',
    reason: `policy + intent passed (verb '${verb}', resource '${resource}')`,
  };
}

/**
 * Decide AND run a tool call. ALLOWed reads/writes run locally; ALLOWed
 * spends go on-chain, where the contract enforces a final time — a panic
 * becomes a DENY at stage 'contract' with the panic text as the reason.
 */
export async function execute(task, toolCall, deps = {}) {
  const attemptSpend = deps.attemptSpend ?? liveAttemptSpend;
  const decision = await decide(task, toolCall, deps);
  // Audit exactly once per attempted tool call: a DENY is final here.
  if (decision.decision === 'DENY') return audit(decision);

  const { tool, args } = toolCall;
  try {
    let result;
    if (tool === 'readDoc') {
      result = readDoc(args.name);
    } else if (tool === 'writeDoc') {
      result = writeDoc(args.name, args.text);
    } else if (tool === 'deleteDoc') {
      result = deleteDoc(args.name);
    } else if (tool === 'spendNear') {
      const out = await attemptSpend({
        to: args.to,
        amountYocto: nearToYocto(args.amountNear),
      });
      if (!out.ok) {
        return audit({
          task: task.name ?? task,
          tool: toolCall,
          decision: 'DENY',
          stage: 'contract',
          reason: `contract panicked: ${out.panic}`,
        });
      }
      result = { txHash: out.txHash };
    } else {
      throw new Error(`unknown tool '${tool}'`);
    }
    return audit({
      task: task.name ?? task,
      tool: toolCall,
      decision: 'ALLOW',
      stage: decision.stage === 'money' ? 'contract' : decision.stage,
      reason: decision.reason,
      result: typeof result === 'string' ? result.slice(0, 200) : result,
    });
  } catch (err) {
    return audit({
      task: task.name ?? task,
      tool: toolCall,
      decision: 'DENY',
      stage: 'contract',
      reason: `execution failed: ${err.message}`,
    });
  }
}

export { AGENT_ID, PAYEE_ID };
