/**
 * NEAR helpers for the AgntID demo.
 *
 * All view calls go through @near-js/providers (the raw-curl RPC path was
 * observed returning stale nulls for get_allowance on 16 Nov 2026, while
 * @near-js returned the correct record — so @near-js is the trusted path).
 *
 * Signing uses ONLY the agent key, read at runtime from NEAR_KEYS_DIR
 * (default: the original NEAR work dir). Keys are never written into this
 * repo. Only the two demo spend attempts ever sign.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { JsonRpcProvider } from '@near-js/providers';
import { Account } from '@near-js/accounts';
import { KeyPairSigner } from '@near-js/signers';
import { parseNearAmount } from '@near-js/utils';

export const CONTRACT_ID = process.env.NEAR_CONTRACT_ID || 'guard.aag7734b.testnet';
export const AGENT_ID = process.env.AGENT_ID || 'agent.aag7734b.testnet';
export const PAYEE_ID = process.env.PAYEE_ID || 'payee.aag7734b.testnet';
export const KEYS_DIR =
  process.env.NEAR_KEYS_DIR || '/home/hatch/workspace/near-hackathon/.near-keys';

const provider = new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' });

/** Exact NEAR -> yoctoNEAR conversion (decimal string math, no floats). */
export function nearToYocto(amountNear) {
  return parseNearAmount(String(amountNear));
}

/** Exact yoctoNEAR -> NEAR display string (trims trailing zeros). */
export function yoctoToNear(yocto) {
  const s = BigInt(yocto).toString().padStart(25, '0');
  const whole = s.slice(0, -24) || '0';
  const frac = s.slice(-24).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function loadAgentSigner() {
  const keyPath = join(KEYS_DIR, 'agent.json');
  if (!existsSync(keyPath)) {
    throw new Error(
      `Agent key not found at ${keyPath}. Set NEAR_KEYS_DIR to the directory ` +
        `holding agent.json (account_id + private_key).`,
    );
  }
  const cred = JSON.parse(readFileSync(keyPath, 'utf8'));
  if (cred.account_id !== AGENT_ID) {
    throw new Error(`agent.json is for ${cred.account_id}, expected ${AGENT_ID}`);
  }
  return KeyPairSigner.fromSecretKey(cred.private_key);
}

function viewAccount(accountId, signer = null) {
  return new Account(accountId, provider, signer);
}

async function view(method, args) {
  // JsonRpcProvider.callFunction is the view path the original repo uses
  // (Account has no .view method in @near-js v2).
  return provider.callFunction(CONTRACT_ID, method, args ?? {});
}

/** Live allowance record for an agent, or null when none exists. */
export async function getAllowance(agentId = AGENT_ID) {
  const result = await view('get_allowance', { agent_id: agentId });
  return result || null;
}

/** Append-only on-chain spend log. */
export async function getSpendLog(fromIndex = 0, limit = 100) {
  const result = await view('get_spend_log', {
    from_index: fromIndex,
    limit,
  });
  return result || [];
}

/** Contract vault balance (yoctoNEAR decimal string). */
export async function getVaultBalance() {
  const result = await view('vault_balance', {});
  return result || '0';
}

/** Extract the contract panic text from a thrown error or a Failure outcome. */
export function panicTextOf(errOrOutcome) {
  const haystacks = [];
  if (errOrOutcome && typeof errOrOutcome === 'object') {
    if (typeof errOrOutcome.message === 'string') haystacks.push(errOrOutcome.message);
    const status = errOrOutcome.status ?? errOrOutcome.transaction_outcome?.outcome?.status;
    if (status && typeof status === 'object' && 'Failure' in status) {
      haystacks.push(JSON.stringify(status.Failure));
    }
    for (const r of errOrOutcome.receipts_outcome ?? []) {
      const s = r?.outcome?.status;
      if (s && typeof s === 'object' && 'Failure' in s) haystacks.push(JSON.stringify(s.Failure));
    }
    try {
      haystacks.push(JSON.stringify(errOrOutcome));
    } catch {
      /* ignore */
    }
  } else if (typeof errOrOutcome === 'string') {
    haystacks.push(errOrOutcome);
  }
  const joined = haystacks.join(' ');
  const m = joined.match(/Smart contract panicked:\s*([^\n\\"]+)/);
  if (m) return m[1].trim();
  const m2 = joined.match(/assertion failed:\s*([^\n\\"]+)/);
  if (m2) return m2[1].trim();
  return joined.slice(0, 300) || 'unknown contract failure';
}

/**
 * Attempt a spend() call as the agent. Returns { ok: true, txHash } on
 * success or { ok: false, panic } when the contract panics. A panic moves
 * no funds; it only costs a little testnet gas.
 */
export async function attemptSpend({ to, amountYocto }) {
  const signer = loadAgentSigner();
  const account = viewAccount(AGENT_ID, signer);
  try {
    // callFunctionRaw returns the FinalExecutionOutcome (status + receipts),
    // which attemptSpend needs to detect a contract panic; callFunction
    // returns only the decoded return value.
    const outcome = await account.callFunctionRaw({
      contractId: CONTRACT_ID,
      methodName: 'spend',
      args: { to, amount: String(amountYocto) },
      gas: BigInt('30000000000000'),
    });
    const status = outcome?.status ?? outcome?.transaction_outcome?.outcome?.status;
    if (status && typeof status === 'object' && 'Failure' in status) {
      return { ok: false, panic: panicTextOf(outcome) };
    }
    for (const r of outcome?.receipts_outcome ?? []) {
      const s = r?.outcome?.status;
      if (s && typeof s === 'object' && 'Failure' in s) {
        return { ok: false, panic: panicTextOf(outcome) };
      }
    }
    return { ok: true, txHash: outcome.transaction.hash };
  } catch (err) {
    return { ok: false, panic: panicTextOf(err) };
  }
}
