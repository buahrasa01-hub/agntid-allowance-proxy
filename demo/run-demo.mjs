/**
 * Demo runner — the 5 AgntID scenes, run end-to-end against the LIVE
 * NEAR testnet state.
 *
 * Live state it was verified against (16 Nov 2026): the allowance for
 * agent.aag7734b.testnet is REVOKED, cap 1 NEAR, spent 0.25 NEAR,
 * remaining 0.75 NEAR, allowlist [payee.aag7734b.testnet], expired 9 Nov.
 * Vault 8.245 NEAR. Spend log: exactly 1 entry. Owner balance 0.76 NEAR,
 * so no fresh allowance was created — the demo runs on this recorded state.
 *
 * Scenes 4-5 therefore deny at the money stage (revoked) and ALSO attempt
 * the spend on-chain to record the contract's REAL panic verbatim. The
 * cap-exceeded and non-allowlist panics are RECORDED evidence from the
 * 9 Nov e2e run (see README), not live results — the demo says so.
 *
 * Exit 0 only when every scene's actual decision AND stage match the
 * design AND all post-conditions hold. Anything else exits non-zero.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgent, getAuditLog, clearAuditLog } from '../src/agent.mjs';
import {
  AGENT_ID,
  PAYEE_ID,
  getAllowance,
  getSpendLog,
  attemptSpend,
  nearToYocto,
  yoctoToNear,
} from '../src/near.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_PATH = join(HERE, 'audit-log.json');

const TASK_READ = {
  name: 'Summarize Doc A',
  tools: ['readDoc'],
  intent: { verbs: ['read'], resources: ['doc-a'] },
};
const TASK_PAY = {
  name: 'Pay the payee 0.1 NEAR',
  tools: ['spendNear'],
  intent: { verbs: ['spend'], resources: [PAYEE_ID] },
};

function docIntact(name, marker) {
  const p = join(HERE, `${name}.md`);
  if (!existsSync(p)) throw new Error(`${name}.md is gone`);
  if (marker && !readFileSync(p, 'utf8').includes(marker)) {
    throw new Error(`${name}.md content changed`);
  }
}

async function spendLogStillOne() {
  const log = await getSpendLog(0, 100);
  if (log.length !== 1) throw new Error(`spend log changed: ${log.length} entries (expected 1)`);
  return log;
}

const scenes = [
  {
    name: 'Scene 1 — read Doc A (in intent)',
    task: TASK_READ,
    attempts: [{ tool: 'readDoc', args: { name: 'doc-a' } }],
    expected: { decision: 'ALLOW', stage: 'intent' },
    post: () => docIntact('doc-a', 'Project Brief'),
  },
  {
    name: 'Scene 2 — read Doc B (drift outside intent)',
    task: TASK_READ,
    attempts: [{ tool: 'readDoc', args: { name: 'doc-b' } }],
    expected: { decision: 'DENY', stage: 'intent', reasonContains: "resource 'doc-b' not in intent resources" },
    post: () => {
      docIntact('doc-b', 'DO NOT SUMMARIZE');
      docIntact('doc-a', 'Project Brief');
    },
  },
  {
    name: 'Scene 3 — delete Doc A (tool not in this task\'s list)',
    task: TASK_READ,
    attempts: [{ tool: 'deleteDoc', args: { name: 'doc-a' } }],
    expected: { decision: 'DENY', stage: 'policy', reasonContains: "tool 'deleteDoc' not in task allowlist" },
    post: () => docIntact('doc-a', 'Project Brief'),
  },
  {
    name: 'Scene 4 — spend 0.80 NEAR (over the 0.75 NEAR remaining cap)',
    task: TASK_PAY,
    attempts: [{ tool: 'spendNear', args: { to: PAYEE_ID, amountNear: '0.80' } }],
    expected: {
      decision: 'DENY',
      stage: 'money',
      reasonContains: 'exceeds remaining allowance 0.75 NEAR',
    },
    liveEvidence: { to: PAYEE_ID, amountNear: '0.80', expectPanicContains: 'revoked' },
    post: async () => {
      await spendLogStillOne();
    },
  },
  {
    name: 'Scene 5 — spend 0.01 NEAR after revoke',
    task: TASK_PAY,
    attempts: [{ tool: 'spendNear', args: { to: PAYEE_ID, amountNear: '0.01' } }],
    expected: {
      decision: 'DENY',
      stage: 'money',
      reasonContains: 'allowance has been revoked',
    },
    liveEvidence: { to: PAYEE_ID, amountNear: '0.01', expectPanicContains: 'revoked' },
    post: async () => {
      const allowance = await getAllowance(AGENT_ID);
      if (!allowance?.revoked) throw new Error('allowance is not revoked');
      await spendLogStillOne();
    },
  },
];

async function main() {
  clearAuditLog();
  console.log('AgntID Allowance Proxy — 5-scene demo (live NEAR testnet state)');
  const allowance = await getAllowance(AGENT_ID);
  console.log(
    `Live allowance: cap ${yoctoToNear(allowance.cap)} NEAR, spent ` +
      `${yoctoToNear(allowance.spent)} NEAR, remaining ` +
      `${yoctoToNear(BigInt(allowance.cap) - BigInt(allowance.spent))} NEAR, ` +
      `revoked=${allowance.revoked}, allowlist=${JSON.stringify(allowance.allowlist)}`,
  );
  const log = await getSpendLog(0, 100);
  console.log(`Live spend log: ${log.length} entr${log.length === 1 ? 'y' : 'ies'}`);

  let failures = 0;
  const sceneResults = [];
  for (const scene of scenes) {
    console.log(`\n=== ${scene.name} ===`);
    const outcomes = await runAgent(scene.task, scene.attempts);
    const o = outcomes[0];
    const okDecision =
      o.decision === scene.expected.decision && o.stage === scene.expected.stage;
    const okReason = scene.expected.reasonContains
      ? o.reason.includes(scene.expected.reasonContains)
      : true;
    let sceneOk = okDecision && okReason;
    console.log(
      `  expected ${scene.expected.decision}/${scene.expected.stage} — ` +
        `got ${o.decision}/${o.stage} -> ${sceneOk ? 'MATCH' : 'MISMATCH'}`,
    );

    // Live on-chain evidence: attempt the spend directly and record the
    // contract's real panic verbatim. A panic moves no funds.
    let live = null;
    if (scene.liveEvidence) {
      const ev = scene.liveEvidence;
      console.log(`  on-chain evidence: spend(${ev.amountNear} NEAR -> ${ev.to}) ...`);
      const res = await attemptSpend({ to: ev.to, amountYocto: nearToYocto(ev.amountNear) });
      if (res.ok) {
        console.log(`  UNEXPECTED: on-chain spend SUCCEEDED (tx ${res.txHash})`);
        live = { attempted: true, unexpectedlySucceeded: true, txHash: res.txHash };
        sceneOk = false;
      } else {
        const match = res.panic.includes(ev.expectPanicContains);
        console.log(`  contract panicked (verbatim): "${res.panic}" -> ${match ? 'as expected' : 'UNEXPECTED TEXT'}`);
        live = { attempted: true, panic: res.panic, matched: match };
        if (!match) sceneOk = false;
      }
    }

    try {
      await scene.post();
      console.log('  post-conditions: PASS');
    } catch (err) {
      console.log(`  post-conditions: FAIL — ${err.message}`);
      sceneOk = false;
    }
    if (!sceneOk) failures += 1;
    sceneResults.push({ scene: scene.name, ok: sceneOk, outcomes, live });
  }

  const audit = {
    generatedAt: new Date().toISOString(),
    contract: 'guard.aag7734b.testnet',
    network: 'NEAR testnet',
    liveAllowanceBefore: {
      cap: allowance.cap,
      spent: allowance.spent,
      remaining: (BigInt(allowance.cap) - BigInt(allowance.spent)).toString(),
      revoked: allowance.revoked,
      allowlist: allowance.allowlist,
    },
    scenes: sceneResults,
    auditLog: getAuditLog(),
    summary: {
      scenes: scenes.length,
      passed: scenes.length - failures,
      failed: failures,
    },
  };
  writeFileSync(AUDIT_PATH, JSON.stringify(audit, null, 2));
  console.log(`\nAudit log written to demo/audit-log.json (${audit.auditLog.length} decisions)`);

  if (failures === 0) {
    console.log('\n=== ALL 5 SCENES PASSED ===');
    process.exit(0);
  }
  console.log(`\n=== ${failures} SCENE(S) FAILED ===`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Demo runner error:', err);
  process.exit(1);
});
