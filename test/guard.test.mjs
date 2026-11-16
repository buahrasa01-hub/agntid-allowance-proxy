/**
 * Guard unit tests — fully offline.
 *
 * The guard takes injected `deps` ({ getAllowance, attemptSpend }), so
 * every money/contract case runs against fake allowance states and a fake
 * spender. No test touches the network or the filesystem beyond the local
 * demo docs (which the doc tests read, never write).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decide, execute, TOOL_VERBS } from '../src/guard.mjs';
import { nearToYocto } from '../src/near.mjs';

const READ_TASK = {
  name: 't-read',
  tools: ['readDoc', 'writeDoc', 'deleteDoc', 'spendNear'],
  intent: { verbs: ['read'], resources: ['doc-a'] },
};
const PAY_TASK = {
  name: 't-pay',
  tools: ['readDoc', 'writeDoc', 'deleteDoc', 'spendNear'],
  intent: { verbs: ['spend'], resources: ['payee.aag7734b.testnet'] },
};

function allowance(over = {}) {
  return {
    agent: 'agent.aag7734b.testnet',
    cap: '1000000000000000000000000', // 1 NEAR
    spent: '250000000000000000000000', // 0.25 NEAR
    remaining: '750000000000000000000000',
    expires_at: (BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n).toString(),
    allowlist: ['payee.aag7734b.testnet'],
    revoked: false,
    ...over,
  };
}
const depsWith = (a) => ({ getAllowance: async () => a });

describe('policy stage', () => {
  it('DENYs a tool not in the task tool list', async () => {
    const task = { name: 't', tools: ['readDoc'], intent: { verbs: [], resources: [] } };
    const r = await decide(task, { tool: 'deleteDoc', args: { name: 'doc-a' } });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.stage, 'policy');
  });

  it('passes policy when the tool is listed', async () => {
    const task = { name: 't', tools: ['readDoc'], intent: { verbs: ['read'], resources: ['doc-a'] } };
    const r = await decide(task, { tool: 'readDoc', args: { name: 'doc-a' } });
    assert.equal(r.decision, 'ALLOW');
  });
});

describe('intent stage', () => {
  it('DENYs a verb outside the intent verbs', async () => {
    const r = await decide(READ_TASK, { tool: 'deleteDoc', args: { name: 'doc-a' } });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.stage, 'intent');
    assert.match(r.reason, /verb 'delete' not in intent verbs/);
  });

  it('DENYs a resource outside the intent resources', async () => {
    const r = await decide(READ_TASK, { tool: 'readDoc', args: { name: 'doc-b' } });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.stage, 'intent');
    assert.match(r.reason, /resource 'doc-b' not in intent resources/);
  });

  it('ALLOWs a call whose verb and resource both match', async () => {
    const r = await decide(READ_TASK, { tool: 'readDoc', args: { name: 'doc-a' } });
    assert.equal(r.decision, 'ALLOW');
    assert.equal(r.stage, 'intent');
  });

  it('maps tool names to verbs as documented', () => {
    assert.equal(TOOL_VERBS.readDoc, 'read');
    assert.equal(TOOL_VERBS.writeDoc, 'write');
    assert.equal(TOOL_VERBS.deleteDoc, 'delete');
    assert.equal(TOOL_VERBS.spendNear, 'spend');
  });
});

describe('money stage (fake allowance)', () => {
  it('DENYs when no allowance exists', async () => {
    const r = await decide(
      PAY_TASK,
      { tool: 'spendNear', args: { to: 'payee.aag7734b.testnet', amountNear: '0.01' } },
      { getAllowance: async () => null },
    );
    assert.equal(r.decision, 'DENY');
    assert.equal(r.stage, 'money');
    assert.match(r.reason, /no allowance exists/);
  });

  it('DENYs a revoked allowance', async () => {
    const r = await decide(
      PAY_TASK,
      { tool: 'spendNear', args: { to: 'payee.aag7734b.testnet', amountNear: '0.01' } },
      depsWith(allowance({ revoked: true })),
    );
    assert.equal(r.decision, 'DENY');
    assert.equal(r.stage, 'money');
    assert.match(r.reason, /allowance has been revoked/);
  });

  it('DENYs an expired allowance', async () => {
    const past = (BigInt(Date.now()) * 1_000_000n - 1_000_000_000n).toString();
    const r = await decide(
      PAY_TASK,
      { tool: 'spendNear', args: { to: 'payee.aag7734b.testnet', amountNear: '0.01' } },
      depsWith(allowance({ expires_at: past })),
    );
    assert.equal(r.decision, 'DENY');
    assert.equal(r.stage, 'money');
    assert.match(r.reason, /allowance has expired/);
  });

  it('DENYs a recipient outside the contract allowlist (in-intent, but not allowlisted on-chain)', async () => {
    // Intent resources include the stranger, so intent passes; the money
    // stage must still deny because the CONTRACT allowlist does not.
    const task = {
      name: 't-pay-wide',
      tools: ['spendNear'],
      intent: { verbs: ['spend'], resources: ['stranger.testnet'] },
    };
    const r = await decide(
      task,
      { tool: 'spendNear', args: { to: 'stranger.testnet', amountNear: '0.01' } },
      depsWith(allowance()),
    );
    assert.equal(r.decision, 'DENY');
    assert.equal(r.stage, 'money');
    assert.match(r.reason, /not on allowlist/);
  });

  it('DENYs an amount above the remaining cap and names the numbers', async () => {
    const r = await decide(
      PAY_TASK,
      { tool: 'spendNear', args: { to: 'payee.aag7734b.testnet', amountNear: '0.80' } },
      depsWith(allowance()),
    );
    assert.equal(r.decision, 'DENY');
    assert.equal(r.stage, 'money');
    assert.match(r.reason, /exceeds remaining allowance 0\.75 NEAR/);
  });

  it('ALLOWs an in-cap spend at the money stage', async () => {
    const r = await decide(
      PAY_TASK,
      { tool: 'spendNear', args: { to: 'payee.aag7734b.testnet', amountNear: '0.10' } },
      depsWith(allowance()),
    );
    assert.equal(r.decision, 'ALLOW');
    assert.equal(r.stage, 'money');
  });

  it('reports every failing check at once (revoked + over-cap)', async () => {
    const r = await decide(
      PAY_TASK,
      { tool: 'spendNear', args: { to: 'payee.aag7734b.testnet', amountNear: '0.80' } },
      depsWith(allowance({ revoked: true })),
    );
    assert.equal(r.decision, 'DENY');
    assert.match(r.reason, /allowance has been revoked/);
    assert.match(r.reason, /exceeds remaining allowance 0\.75 NEAR/);
  });
});

describe('contract stage (fake spender)', () => {
  it('DENYs at contract stage with the panic text when the chain refuses', async () => {
    const deps = {
      ...depsWith(allowance()),
      attemptSpend: async () => ({ ok: false, panic: 'allowance has been revoked' }),
    };
    const r = await execute(
      PAY_TASK,
      { tool: 'spendNear', args: { to: 'payee.aag7734b.testnet', amountNear: '0.10' } },
      deps,
    );
    assert.equal(r.decision, 'DENY');
    assert.equal(r.stage, 'contract');
    assert.match(r.reason, /allowance has been revoked/);
  });

  it('ALLOWs at contract stage when the chain accepts', async () => {
    const deps = {
      ...depsWith(allowance()),
      attemptSpend: async () => ({ ok: true, txHash: 'deadbeef' }),
    };
    const r = await execute(
      PAY_TASK,
      { tool: 'spendNear', args: { to: 'payee.aag7734b.testnet', amountNear: '0.10' } },
      deps,
    );
    assert.equal(r.decision, 'ALLOW');
    assert.equal(r.stage, 'contract');
    assert.equal(r.result.txHash, 'deadbeef');
  });
});

describe('NEAR amount conversion', () => {
  it('converts 0.80 NEAR to exactly 0.8e24 yocto (no float error)', () => {
    assert.equal(nearToYocto('0.80'), '800000000000000000000000');
    assert.equal(nearToYocto('0.01'), '10000000000000000000000');
    assert.equal(nearToYocto('1'), '1000000000000000000000000');
  });
});
