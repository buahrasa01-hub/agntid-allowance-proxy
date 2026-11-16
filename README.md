# AgntID Allowance Proxy

A working implementation of the **AgntID runtime access-control model** —
*Intent + Policy → Access Decision, evaluated per tool call at execution
time* — with the NEAR **Agent Allowance Guard** contract as the
money-enforcement backend.

Built for the **AgntID Agent Security Challenge** (Luma `voramom4`,
28 Nov 2026, 4-hour online hackathon, ₹75,000 cash, 3 winners).

## Honest framing — read this first

**This is an implementation of AgntID's published runtime model, not an
official integration.** AgntID (agntid.ai, Bengaluru) publishes the model —
every tool call evaluated at runtime against task intent and policy, with
scoped ephemeral credentials, enforced by an MCP proxy — but offers **no
public SDK or API** to call. There is nothing to "connect to" yet, so this
entry builds the guard itself and enforces money movement on-chain. Do not
present it as an AgntID product or partnership.

It is also **not** agnt.id (the `.agnt` identity layer on Ethereum/Base) —
a different product with a similar name. No `.agnt` name is used or
registered here.

## The problem

AI agents reason and choose tools at runtime, so static IAM cannot bound
them. AgntID's canonical example: the task is *"summarize Google Doc A"* —
if the agent gets overeager and starts reading Doc B, block it. If the
intent was *read* and it starts updating or deleting, block that too. If it
calls into Dropbox when the task named Google Docs, block it. In AgntID's
own experiment, a monitoring agent drifted into an AWS infrastructure
investigation in 10 of 15 runs: *"tool visibility is not tool
authorization."*

This repo demonstrates exactly that failure mode — and the guard that
stops it — with a second, harder enforcement layer for money: an agent
that tries to spend outside its allowance is stopped first by the proxy
and then, independently, by the smart contract.

## Architecture

```
                  task intent ("summarize Doc A")
                          |
agent loop (scripted) --> PROXY GUARD --> tools (read/write/delete docs)
                          |  1. policy: tool in this task's list?
                          |  2. intent: verb + resource match the intent?
                          |  3. money: live allowance pre-check (spends)
                          |  4. contract: spend() on NEAR (final enforcer)
                          |  5. audit: every decision logged
                          |
                    NEAR testnet: guard.aag7734b.testnet
                    (cap / expiry / allowlist / revoke / audit log)
```

The guard never trusts the agent's code: policy and intent are evaluated
from the *declared task*, and money is enforced by the chain, not by a
prompt.

## The guard: 5 stages

| Stage | Question | On fail |
|-------|----------|---------|
| 1. policy | Is the tool in this task's tool list? | DENY + reason |
| 2. intent | Is the tool's verb in the intent verbs AND its resource in the intent resources? (deterministic matcher) | DENY + reason naming the mismatch |
| 3. money | (spends only) Live allowance pre-check, in the contract's own order: exists → not revoked → not expired → recipient allowlisted → amount within remaining cap. Every failing check is reported. | DENY + all failing reasons |
| 4. contract | (spends that pass 1–3) Execute `spend()` on-chain; the contract enforces a final time. | DENY + the contract's panic text, verbatim |
| 5. audit | Every decision is appended to the audit log (`demo/audit-log.json`). | — |

The intent matcher is **deterministic** (verb/resource sets) so the demo is
reproducible. An LLM judge is deliberately not the decision-maker here: a
judge that can be prompt-injected is the wrong component to trust with the
verdict. (The guard's `decide()`/`execute()` accept injected `deps`, so an
LLM second opinion can be added as an advisory input without changing the
decision path.)

## The NEAR enforcement backend

Contract: **`guard.aag7734b.testnet`** (NEAR testnet), from the Agent
Allowance Guard built for the NEAR "Build Beyond Boundaries" hackathon
([repo](https://github.com/buahrasa01-hub/agent-allowance-guard)).
`spend(to, amount)` enforces 6 checks in order *before* any transfer is
scheduled; a failed check panics and no funds move. Every spend is written
to an append-only on-chain audit log.

Live state this demo was verified against (16 Nov 2026):

- Allowance for `agent.aag7734b.testnet`: cap **1 NEAR**, spent **0.25
  NEAR**, remaining **0.75 NEAR**, allowlist
  `[payee.aag7734b.testnet]`, **revoked = true**, expired 9 Nov 2026.
- Vault: **8.245 NEAR**. Spend log: exactly **1 entry** (0.25 NEAR
  agent → payee).
- Owner balance is 0.76 NEAR, so no fresh allowance was created for this
  demo — it runs on the recorded state above. That is a feature, not a
  gap: the revoked state is what scenes 4–5 exercise.

Recorded end-to-end evidence from the 9 Nov verification run
([e2e-results.json](https://github.com/buahrasa01-hub/agent-allowance-guard/blob/main/e2e-results.json)):

| Step | Outcome |
|------|---------|
| Allowed spend 0.25 NEAR → payee | succeeded, tx `9hhaiv48Q6nESBuURHDQ1KofVfnnsjtwWszhx7ASvNhm` |
| Spend 0.80 NEAR (over remaining 0.75) | panicked: `spending cap exceeded` |
| Spend to a non-allowlisted account | panicked: `recipient is not on the allowlist` |
| Spend after `revoke()` | panicked: `allowance has been revoked` (revoke tx `EgCmj9cv52QrE49KnXiL5LkiDZyjpZJjdyKCB1p49CGz`) |

The cap/allowlist panics are *recorded* evidence from when the allowance
was active. The demo's live spend attempts panic with `allowance has been
revoked`, because the revoked check fires first on the current state — the
demo records the real panic text verbatim and says so.

## The demo: 5 scenes

Run it: `npm install && npm run demo` (needs the agent key at
`NEAR_KEYS_DIR`, default `/home/hatch/workspace/near-hackathon/.near-keys`,
for the two live spend attempts; view-only scenes need no key).

| Scene | Attempt | Guard decision | Evidence |
|-------|---------|----------------|----------|
| 1 | Read Doc A ("summarize Doc A") | ALLOW | doc content returned |
| 2 | Read Doc B (private note) | DENY at intent — `resource 'doc-b' not in intent resources ['doc-a']` | Doc B never opened |
| 3 | Delete Doc A | DENY at policy — `tool 'deleteDoc' not in task allowlist [readDoc]` | Doc A intact afterwards |
| 4 | Spend 0.80 NEAR to payee | DENY at money — amount exceeds remaining 0.75 NEAR (and the allowance is revoked) | live on-chain attempt panics (verbatim panic recorded) |
| 5 | Spend 0.01 NEAR to payee after revoke | DENY at money — allowance revoked | live on-chain attempt panics `allowance has been revoked`; spend log still 1 entry |

The runner exits 0 only if every scene's actual decision AND stage match
the design and all post-conditions hold. The full transcript and audit log
land in `demo/audit-log.json`.

## Intent exploration matrix

`SCENARIOS.md` is the task × action matrix (3 tasks × 7 actions), computed
by running the guard — `npm run matrix` regenerates it from live decisions,
it is not hand-written. It shows, among other things, that adding a second
verb to a task does not widen the first resource's scope, and that the
money stage reports *every* failing check at once.

## Tests

`npm test` — 16 offline unit tests (`node:test` + `node:assert`): policy,
intent, money pre-checks against fake allowance states, contract-stage
handling with a fake spender, and exact NEAR↔yocto conversion. No test
touches the network.

## Limitations (stated plainly)

- NEAR testnet only; demo amounts are testnet tokens, not real money.
- The agent loop is **scripted** (deterministic drift, documented in
  `src/agent.mjs`) so the demo is reproducible; the guard is the product
  under test, not the agent.
- The intent matcher is deterministic rule-based matching, not an LLM
  judge.
- One allowance per agent; the live demo allowance is revoked, so the
  cap/allowlist panics are shown from the recorded e2e run, not live.
- The owner is a single account (no multisig) — same limitation as the
  underlying contract.

## Challenge categories targeted

1. **Best Real-World Agent Security Use Case** (primary) — a real agent
   loop, a real guard, real on-chain enforcement.
2. **Best Intent Exploration** — the computed matrix in `SCENARIOS.md`
   plus the drift/write/spend scenarios.
3. **Best Security Insight & Product Discovery** — the money stage
   reporting every failing check at once, and the deliberate
   policy-before-intent ordering that keeps a drifted agent from ever
   reaching a spend.

## Layout

```
src/guard.mjs    the proxy guard: decide() + execute(), audit log
src/near.mjs     NEAR view/sign helpers (@near-js, testnet)
src/tools.mjs    local doc tools (read/write/delete)
src/agent.mjs    scripted agent loop
demo/doc-a.md    the project brief (the assigned doc)
demo/doc-b.md    the private note (the drift target)
demo/run-demo.mjs   the 5-scene runner (live chain evidence)
demo/matrix.mjs     intent-matrix generator -> SCENARIOS.md
demo/audit-log.json the last demo run's transcript + audit log
test/guard.test.mjs 16 offline unit tests
SCENARIOS.md     computed intent-exploration matrix
SUBMISSION.md    draft submission notes for 28 Nov
```

## License

MIT.
