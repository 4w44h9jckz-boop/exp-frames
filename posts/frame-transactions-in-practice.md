# Is EIP-8141 Done? Frame Transactions after 24 Experiments and Four Clients

## TLDR;

We built 24 experiments on [EIP-8141 frame transactions](https://eips.ethereum.org/EIPS/eip-8141), mined them on the ethrex Hegota testnet, and probed four execution clients on ethpandaops' frames-devnet-0. The question this post answers is the one people keep asking: **are frame transactions done?**

**The execution layer is.** Four clients agree on every block we checked. An independent implementation re-encodes, re-verifies and re-settles 2,000 of their transactions. Every ERC-4337 use case we tried ports, at 2.41 times less gas for a token transfer.

**Frame transactions as something a user can rely on are not.** Whether a given frame transaction propagates, who may pay for it, whether an inclusion list protects it, and whether a post-quantum account can use it are all decided outside block execution. Every one of those layers has an open problem, and two of them failed live tests this round:

1. **The EIP's own guidance for custom validation is exploitable.** It allows an account to "constrain every subsequent `SENDER` frame" in place of the canonical signature hash. We took that literally. A mempool observer then:
   - inserted a sandwich *inside the victim's own transaction* and replaced it; the transaction was mined, the victim got 3.0% less, and paid for the attacker's frames;
   - separately, relayed the same signature with a 10 gwei tip where the owner had signed for 1,000 wei.

   The fix is a rule: sign what you approve. The same rule, applied carefully, also gives "sign once, any payer".
2. **Ether leaves an account through three doors, and two payer rules watch one.** The doors are an opcode, a key, and an approval of execution. [PR-12328](https://github.com/ethereum/EIPs/pull/12328)'s "egress-decidable" scan looks only at opcodes. A paymaster that passes it moved its whole balance out through a `SENDER` frame's `value`, mined, while a sponsorship admitted against that balance was pending; the sponsorship was dropped. The EIP's own exemption for code-less sponsors looks at none of the doors. We give a sound scan (it also cuts false positives from 28% to 0.9%) and measure the sealed pay frame the PR left unmeasured: 13,305 gas.
3. **As scheduled, no frame transaction is protected by inclusion lists.** Hegota schedules EIP-7805 (FOCIL) and EIP-8141, and nothing else from the frame family. FOCIL's execution-layer check is written for an EOA's nonce and balance. [EIP-8369](https://eips.ethereum.org/EIPS/eip-8369) classes *every* frame transaction under a profile that needs an unscheduled extension, two unscheduled EIPs, and a redesign under ePBS. An EOA that moves from type-2 transactions to frame batching loses inclusion-list protection. We propose the subset that needs no extension at all.
4. **Validation state has three homes, and they disagree.** The mempool allows any slot of the sender. EIP-8369 allows slots 0 to 3. Account practice (ERC-1967, ERC-7201, ERC-7579, and EIP-7702 re-delegation) keeps state anywhere but there. A delegated EOA can be inclusion-list-eligible or re-delegation-safe, not both.
5. **Revocation and deadlines are punished.**
   - EIP-8272 roots cannot be withdrawn for 8,191 slots, and we measured that a later root revokes nothing.
   - The only way to bound a root's life is an expiry frame.
   - The EIP evicts the nearest deadline first, at any fee, so the transactions that declare when they stop being valid are the first to go.
6. **Post-quantum: a new account can be post-quantum, an EOA cannot leave ECDSA.**
   - EIP-7851 is declined for Hegota.
   - Default code and the canonical paymaster are secp256k1 only.
   - Every post-quantum signature is `ARBITRARY`, which the EIP itself makes non-aggregatable.
7. **The public mempool is a strict subset of ERC-7562.** That is a defensible choice, but it means frames replace the simple half of ERC-4337 at launch, not all of it. Gas-for-tokens sponsorship becomes either a live signer or unsecured credit.

Each finding comes with a suggestion, its cost, and the easier fix we are *not* proposing. The thread that runs through all of them: **every rule that widened the mempool safely is a declaration a node can index without executing anything; every rule that failed infers something from execution.**

> Experiments, one branch each, with READMEs, scripts, contracts and mined fixtures: [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames) (start at the [tooling README](https://github.com/4w44h9jckz-boop/exp-frames/tree/tooling)). This round: [23, approval scope](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/23-approval-scope/experiments/23-approval-scope) and [24, sealed paymaster](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/24-sealed-paymaster/experiments/24-sealed-paymaster)
> Rust wallet ports: [kohaku-rs, branch `experiment/frames`](https://github.com/4w44h9jckz-boop/kohaku-rs/tree/experiment/frames)
> Companion studies we cite rather than repeat: [aa](https://github.com/4w44h9jckz-boop/aa) (account abstraction and the gas market for private transactions) and [crops-frame](https://github.com/4w44h9jckz-boop/crops-frame) (a composition framework for privacy protocols on frames)
> Related reading: Nero_eth, [Frame transactions and the three gates to privacy](https://ethresear.ch/t/frame-transactions-and-the-three-gates-to-privacy/24666); lightclient, [Mempool Strategies for EIP-8141](https://hackmd.io/@matt/frame-mempool)

## Is it done? A readiness map

Spec-wise, we read EIP-8141 at master on 2026-10-08, with EIP-8250 (keyed nonces), EIP-8272 (recent roots), EIP-7805 (FOCIL), EIP-8369 (VOPS profiles), ERC-7562 and the Hegota and Glamsterdam meta EIPs. Experiment-wise, every claim below has a mined transaction, a refusal message or a quoted sentence behind it.

| Layer | What it decides | State | Evidence | What is missing |
|---|---|---|---|---|
| Block execution | envelope, signature hash, frames, `APPROVE`, receipts, gas | **converged** | 4 clients, 50 of 50 heights; 2,000 transactions re-encoded and re-settled (22); 41 rebuilt byte for byte in Rust | a status for frames rolled back with their batch; cross-client coverage beyond 5 shapes |
| Approval semantics | what a custom `VERIFY` must authenticate | sig hash sound; **guidance exploitable** | sandwich and fee rewrite mined (23) | one paragraph of Security Considerations (section 1) |
| Payers | who may sponsor many pending transactions | canonical paymaster works, for one secp256k1 signer; **two other rules unsafe as written** | 4 users in one block (09); scan-sealed paymaster drained with a sponsorship pending (24) | a fan-out invariant (section 2) |
| Public mempool | what propagates | specified, deliberately narrow; **clients diverge** | 3 values of `MAX_VERIFY_GAS`, 3 check orders (22) | caps, order and error vocabulary |
| Shared senders | privacy pools, multisig treasuries | **one pending transaction per sender** without EIP-8250, which is only Considered | storage pool serializes all users; keyed pool lands 3 per block (06) | scheduling, and keyed mempool rules ([PR-12039](https://github.com/ethereum/EIPs/pull/12039)) |
| Inclusion lists | censorship resistance | **undefined for type `0x06`** | EIP-7805 and EIP-8369 text (section 4) | a profile for frame transactions that needs no extension |
| Partial statelessness | what a VOPS node can validate | Proposed; surface conflicts with account practice | 7579 module refused (14); storage outlives delegation (15) | a namespaced surface (section 5) |
| Time | deadlines, not-before, revocation | deadline yes; not-before no; **deadlines evicted first** | expiry frame (10); hidden not-before (19); irrevocable roots (24) | frame-level `TIMESTAMP`; eviction order (section 3) |
| Post-quantum | migration off ECDSA | new contract accounts only, at 2.7 times ECDSA's gas; **EOAs have no exit** | WOTS account (17); delegation adds a key, removes none (15) | scheme agility in default code and the canonical paymaster, with rotation (section 6) |
| Wallet interface | what an RPC returns | **21 of 39 transaction fields differ** across clients | (22) | [execution-apis PR-860](https://github.com/ethereum/execution-apis/pull/860), [PR-907](https://github.com/ethereum/execution-apis/pull/907) |

The pattern is that the closer a layer sits to the block, the more done it is, and the closer it sits to a user, the less. That is the expected order of work for a protocol change. But users never meet the block layer alone. A frame transaction that a wallet cannot price, a mempool will not carry, and an inclusion list does not protect is, to a user, not done.

## Frames in one page

A frame transaction (type `0x06`) replaces "one signature, one call" with:
- a `sender`, a nonce and fees;
- a list of signature entries `[scheme, signer, msg, signature]`. The protocol validates `SECP256K1` and `P256` entries before any EVM code runs, and leaves `ARBITRARY` entries to the EVM. An empty `msg` means "over the canonical signature hash"; an explicit `msg` is a digest of the account's choosing;
- a list of frames, each with a mode, a target, `[execution, state]` gas limits, flags and data:
  - `VERIFY` frames run read-only and may call `APPROVE` to accept execution (only on `tx.sender`), payment, or both;
  - `SENDER` frames run as the sender, once execution is approved, and may carry `value`;
  - `DEFAULT` frames run as the entry point `0xaa`.

A code-less account gets *default code*: it approves when the transaction carries a `SECP256K1` entry by its own key over the signature hash. A contract brings its own `VERIFY`, and reads the transaction with `TXPARAM`, `FRAMEPARAM`, `FRAMEDATALOAD`, `FRAMEDATACOPY`, `SIGPARAM` and `SIGDATACOPY`.

```
 FRAME TX (type 0x06)   sender = S   nonce   fees   signatures = [[scheme, signer, msg, sig], ...]
 ------------------------------------------------------------------------------------------
 [0] VERIFY  -> S          APPROVE(EXECUTION)          \  validation prefix:
 [1] VERIFY  -> sponsor    APPROVE(PAYMENT)             |  simulated by every mempool node,
                                                        /  bounded by MAX_VERIFY_GAS = 100k
 [2] SENDER  -> token      approve(dex, x)     caller = S     \ atomic batch:
 [3] SENDER  -> dex        swap(x)             caller = S     / [2] is undone if [3] fails
 [4] DEFAULT -> sponsor    post_op()           caller = 0xaa  reads [2..3] via FRAMEPARAM
 ------------------------------------------------------------------------------------------
 receipt: payer, and per frame [status in {FAILURE, SUCCESS, SKIPPED}, gas_used, logs]
```

The public mempool admits a transaction only if its validation prefix is cheap and robust to simulate:
- it fits `MAX_VERIFY_GAS` = 100,000 execution gas, signature validation included;
- it reads only the sender's storage;
- it uses no environment opcodes;
- one transaction is pending per sender.

Payers are rationed:
- the *canonical paymaster*, recognized by its exact runtime code, may back many pending transactions, reserved against its balance;
- any other paymaster may back `MAX_PENDING_TXS_USING_NON_CANONICAL_PAYMASTER` (one);
- a code-less sponsor is bounded by its balance alone.

Two companion EIPs carry much of the weight below:
- [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250) gives a transaction a set of nonce keys, so one sender can have independent nonces.
- [EIP-8272](https://eips.ethereum.org/EIPS/eip-8272) lets any address write a root to a predeploy, filed under `(source_id, slot)`, and lets a transaction name `(source_id, slot, root)` tuples in a canonical `VERIFY` frame that the protocol checks.

Both are only Considered for Hegota.

### What we ran

| # | Experiment | Headline number |
|---|---|---|
| 01-05 | EIP examples, account deployment, atomic batch, ERC-20 sponsor, k-of-n multisig | 26,102 gas for an ETH transfer, calldata-floor bound; a front-run costs an ERC-20 sponsor 218,760 gas |
| 06 | Privacy pool as its own sender (Tornado's circuit) | VERIFY 244,808 to 248,991; three withdrawals from one sender in one block, keyed design only |
| 07-08 | FROST threshold wallet, multisig operations | 26,794 per transfer at any threshold; counterfactual proxy VERIFY 4,262 |
| 09 | Paymasters ([PR-12041](https://github.com/ethereum/EIPs/pull/12041) canonical paymaster) | four users in one block through one instance; a copy one unreachable byte longer refused |
| 10-11 | Expiry verifier frame; passkeys, raw P256 and WebAuthn | 3,051 gas; WebAuthn VERIFY 15,542 |
| 12-16 | Session keys, social recovery, modular account, EIP-7702 sender, subscriptions | +21,600, +2,100, +5,300 gas per transaction over the owner's own |
| 17 | Post-quantum account (WOTS under a Merkle root) | 73,481 against 27,382 for ECDSA |
| 18-20 | Introspection, mempool rules one at a time, signatures as a service | 731 introspection words match a model; `TIMESTAMP` through a nested call admitted |
| 21 | ERC-4337 v0.8 side by side | 116,735 against 48,435, 2.41 times |
| 22 | Four clients on frames-devnet-0 | 50 of 50 heights agree; 49 admission probes diverge |
| **23** | **What an approval has to commit to** | **a sandwich inside the victim's own transaction, mined** |
| **24** | **A sealed paymaster, and a scan that calls the wrong one sealed** | **a scan-sealed paymaster emptied; sealed pay frame 13,305 gas** |

183 mined transactions are kept as test fixtures. Experiments 01 to 21, 23 and 24 ran on one client (ethrex `v23.0.0-hegota-testnet`, EIP-8141 pinned at `b75cbe61`, plus EIP-8250 and EIP-8272, with `MAX_VERIFY_GAS` raised to 500,000 by a node flag), so their numbers are ethrex's on the Amsterdam gas schedule.

## 1. An approval must commit to exactly what it approves

**What the EIP says.** Security Considerations, *Execution Approval Authorizes All Subsequent Sender Frames* (master, 2026-10-08):

> Custom validation contracts that grant `APPROVE_EXECUTION` should verify against the canonical signature hash, or otherwise constrain every subsequent `SENDER` frame, before approving.

**What we did** ([23](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/23-approval-scope/experiments/23-approval-scope)). A "literal" account takes the second branch at its word. Its owner signs an explicit digest $D$ of chain id, sender, nonce, and every `SENDER` frame in order: target, flags, both budgets, value and data. The owner signed `[self_verify, approve(pool, 10 A), swap(10 A, minOut)]`, with `minOut` 3% under the quote and a 1,000 wei tip.

A mempool observer kept the signature entry byte for byte, edited the frame list, raised the fees 20% so the copy counts as a replacement, and sent it within the same slot:

```
 honest (signed)                           attacked (same signature entry, same D)
 ------------------------------------      --------------------------------------------------
 [0] VERIFY  self   APPROVE(3)             [0] VERIFY  self   APPROVE(3)
 [1] SENDER  token  approve(pool, 10 A)    [1] SENDER  token  approve(pool, 10 A)
                                           [2] DEFAULT bot    front(15.42 A)     <- inserted
 [2] SENDER  pool   swap(10 A, minOut)     [3] SENDER  pool   swap(10 A, minOut)
                                           [4] DEFAULT bot    back()             <- appended
 fees: tip 1,000 wei                       fees: x 1.2  (a valid replacement)
```

The attacked copy was mined (block 315,369):
- the victim received 9.6040 B against a quote of 9.9010, exactly the slippage it allowed;
- the bot ended +0.3029 A;
- the victim, as payer, paid for the bot's 110,710 gas of execution.

Separately, the same honest transaction relayed with a 10 gwei tip was mined and cost the account 0.0011865 ETH, where the tip its owner signed would have cost about $10^{-7}$ of that.

**Why the second branch fails.** Constraining the `SENDER` frames leaves three things to whoever relays the transaction:
- the `DEFAULT` frames, which run between the sender's operations and trade against them;
- the positions and the number of frames, so frames can be inserted or appended;
- the fees, which the account pays when it also approves payment.

**The rule that works: sign what you approve.** Let $\mathcal{C}(s)$ be what a validation granting scope $s$ must authenticate, and call a *pay frame* a `VERIFY` frame whose allowed scope is `PAYMENT` alone:

$$\mathcal{C}(\mathsf{EXECUTION}) = \{\, (i, \mathsf{frame}_i) : \mathsf{frame}_i \text{ is not a pay frame} \,\} \cup \{\, n_{\text{frames}} \,\}$$

$$\mathcal{C}(\mathsf{PAYMENT}) = \mathcal{C}(\mathsf{EXECUTION}) \cup \{\, \text{fees}, \text{every frame's limits} \,\}$$

A frame approving both scopes may leave out nothing but signature bytes, and that is the canonical hash. The default code is right for exactly the cases it handles.

**The useful asymmetry.** An account that approves `EXECUTION` alone may leave out the pay frame and the fees. Our `ScopedAccount` signs the canonical hash when it pays, and otherwise an explicit digest $E$ of every frame but the payer's, with positions and count. On it:
- all three attacks were refused;
- one owner signature was completed by two sponsors. The second replaced the first, with another payer and higher fees, and was mined (block 315,376). A token fee went to whichever sponsor landed it;
- VERIFY cost 2,914 gas for six frames, against 351 for the canonical hash.

Fee-wise, this answers half of the `aa` study's [question 13](https://github.com/4w44h9jckz-boop/aa/blob/main/docs/06-findings/02-questions-for-the-specification-authors.md), which asks whether fees could leave the canonical hash. For a privacy design whose witness is a blind voucher, re-signing to re-price means a second contact with the issuer, and that contact links the spender. $E$ removes the need to re-sign at the account level, for sponsored transactions, without changing the EIP.

Identity-wise, it moves what a transaction *is*. Across the two payers, $E$ stayed fixed while the signature hash and the transaction hash both changed. A wallet that tracks its operation by transaction hash lost it at the replacement. Bitcoin learned this with transaction malleability, and fixed it with a witness-free identifier for the thing the signer authorized (BIP 141's txid against wtxid). Frames need the same distinction in wallets and RPCs: the *intent* the sender signed, against the *envelope* that carries it.

**Suggestion 1: replace the paragraph.**

> A validation that grants `APPROVE_EXECUTION` must authenticate every frame other than pay frames, with its index, and the number of frames. A validation that grants `APPROVE_PAYMENT` must also authenticate the fees and the limits of every frame. Constraining only `SENDER` frames is not sufficient: `DEFAULT` frames placed between them run while the sender's operations are in flight, and every frame is paid for by the payer. The canonical signature hash satisfies both requirements.

**Cost.** One paragraph. Wallets that build explicit digests need a published layout for $E$ so that two wallets agree on it. We would put that in an ERC, not the EIP.

**Not suggested: moving the fees out of the canonical hash,** which question 13 asks about. Our fee-rewrite result is exactly what that would allow for every self-paying account: whoever relays the transaction sets the tip, and the account pays it. The accounts that need fee freedom are the ones that do not pay, and they can already have it through $E$.

## 2. Ether leaves through three doors

### The invariant

A mempool is cheap to attack when one cheap on-chain action invalidates many admitted transactions. Each was validated at up to `MAX_VERIFY_GAS`, gossiped, and never paid for. Call the number an action $a$ invalidates its *fan-out*:

$$F(a) = \bigl|\{\, t \in \text{pool} : t \text{ valid before } a,\ t \text{ invalid after } a \,\}\bigr|$$

The public mempool stays safe if every action that costs $O(1)$ fees has $F(a) = O(1)$. Most of EIP-8141's mempool is that invariant, applied one mechanism at a time:

| Mechanism | Action that could invalidate | Fan-out |
|---|---|---|
| one pending transaction per sender | the sender transacts | 1 |
| keyed nonces, disjoint keys ([PR-12039](https://github.com/ethereum/EIPs/pull/12039)) | a key is used | 1 |
| EIP-8272 recent roots | none: an entry cannot be overwritten inside its window | 0 (time only, declared) |
| expiry frame | none: the deadline is in the transaction | 0 (time only, declared) |
| canonical paymaster | a withdrawal, delayed 86,400 s and subtracted while pending | 0 within the horizon (ethrex does not subtract pending withdrawals, 09) |
| non-canonical paymaster | anything | $\le 1$ (the cap) |
| **code-less sponsor (master)** | **one transfer by its key** | $\le \lfloor B / c_{\min} \rfloor$ |
| **PR-12328 "egress-decidable" scan, as written** | **one transaction by the paymaster as sender** | **unbounded (measured below)** |

The code-less sponsor's row is the EIP's own text: such a payer "is not a paymaster and is governed by the per-payer exposure rule alone", which bounds the summed maximum cost of its pending transactions by its balance $B$. That bounds the *amount* at risk, not the *count*. Suppose the smallest maximum cost a sponsored transaction can declare is $c_{\min} \approx 50{,}000$ gas at 2 gwei, that is $10^{-4}$ ETH. Then one ether backs about 10,000 pending transactions, each with its own fresh sender, and one 21,000-gas transfer invalidates them all (derived). The `aa` study raised the same row as [question 9](https://github.com/4w44h9jckz-boop/aa/blob/main/docs/06-findings/02-questions-for-the-specification-authors.md). ethrex does not implement the exemption, and caps such a sponsor at one (09).

### Three doors

What the two bad rows share is a model of where ether can leave an account. There are three doors:
1. **An opcode in its code**: `CALL`, `CALLCODE`, `DELEGATECALL`, `CREATE`, `CREATE2`, `SELFDESTRUCT`.
2. **A key**: an EOA, a default-code account, or an EIP-7702-delegated EOA. EIP-7851, which would let a delegated EOA retire its key, is declined for Hegota. So every EOA keeps this door open for good.
3. **An approval of execution**: an account whose code can reach `APPROVE` with an execution scope can be `tx.sender`, and a `SENDER` frame's `value` moves its ether with no opcode in its code at all. This door is new with EIP-8141.

PR-12328 proposes admitting any paymaster whose code shows that ether leaves only as approved gas. Its decidable form is a whole-code scan for door 1, and it waves door 3 through explicitly:

> `APPROVE` is not an egress instruction: its `offset`/`length` operands designate return data only, and the protocol collects at most the reserved `max_cost` through `APPROVE_PAYMENT` regardless of the approval scope, so no scan of the `APPROVE` operands is required.

The sentence is true of payment and false of execution. Door 2 passes vacuously: an account with no code has no forbidden opcode.

**What we did** ([24](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/24-sealed-paymaster/experiments/24-sealed-paymaster), E). `SelfSendingPaymaster` is the canonical paymaster's admission rule with the timelocked withdrawal deleted, plus the default code's rule for when it is the sender. Its 134-byte runtime has none of the scanned opcodes; PR-12328's scan calls it sealed. The script then sent two transactions in one slot:

```
 sponsorship (admitted, reserved against the paymaster's balance)
   sender = fresh user    [0] VERIFY user  APPROVE(EXECUTION)
                          [1] VERIFY PM    APPROVE(PAYMENT)        owner's entry 1
                          [2] SENDER token mint(user)
 drain (higher tip)
   sender = PM            [0] VERIFY PM    APPROVE(EXECUTION_AND_PAYMENT)   owner's entry 0
                          [1] SENDER owner value = balance - own max cost - a remainder
                                           below the sponsorship's max cost
```

The drain was the only transaction in block 316,423. The paymaster went from 0.009999861732475678 ETH to 580,965,481 wei, and the owner received 0.009999860728069323 ETH. The pending sponsorship left the pool, and re-sent it was refused: `validation prefix frame reverted`.

ethrex holds a non-canonical paymaster to one pending sponsorship, so one transaction was lost here. PR-12328 lifts that cap for paymasters its scan admits. Under it, every sponsorship pending against this balance would go the same way, for the price of one transaction.

On the way, block 316,413 was reorganized. Our first drain attempt's receipt said success; in the canonical replacement block the sponsorship came first and the drain's value frame failed for want of balance. Same two transactions, two orders, two outcomes (seen once on this testnet).

### A sealed paymaster that works

PR-12328's construction is good, and we built it ([24](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/24-sealed-paymaster/experiments/24-sealed-paymaster), A to D). `SealedPaymaster`:
- has no `CALL`-family opcode;
- approves only through the four instructions `PUSH1 1, PUSH0, PUSH0, APPROVE`, so its scope is the constant `PAYMENT`. The canonical paymaster's runtime uses the same four;
- holds the sponsor's EIP-8272 source id as an immutable, inside a `PUSH32`, so nothing trails the code;
- reads no storage and no balance.

The sponsor's policy is a Merkle tree of leaves

$$\mathsf{leaf} = \mathsf{keccak256}(\mathsf{target} \Vert \mathsf{selector} \Vert \mathsf{cap} \Vert \mathsf{notAfter})$$

whose root an EOA writes to EIP-8272. A sponsored transaction proves its leaf in the pay frame:

```
 SPONSORED MINT    sender = USER (no ETH, no code)    signatures = [USER over the sig hash]
 ----------------------------------------------------------------------------------------------
 [0] VERIFY -> 0x..8141   deadline                     protocol: block.timestamp <= deadline
 [1] VERIFY -> 0x..8272   (source_id, slot, root)      protocol: root committed, slot in window
 [2] VERIFY -> USER       APPROVE(EXECUTION)           default code
 [3] VERIFY -> SEALED     APPROVE(PAYMENT)             tuple names my source_id; the leaf for
                                                         frame 4's target and selector folds
                                                         to its root; max cost <= cap;
                                                         deadline <= notAfter; 5 frames
 [4] SENDER -> TOKEN      mint(USER, 1e18)
```

Three users with no ETH were sponsored. All seven malformed variants were refused at admission, among them a stranger publishing *the sponsor's own root* under its own source id. The predeploy proves only that someone wrote a root; binding it to a sponsor is the consumer's job.

Gas-wise, this answers the PR's open item, which was the recent-root frame's draw and the proof's:

| | expiry | recent root | `only_verify` | pay frame | prefix execution | proof bytes (calldata gas) |
|---|---|---|---|---|---|---|
| depth 4 | 3,051 | 5,579 | 100 | 4,575 | **13,305** | 288 B (2,808) |
| depth 20 | 3,051 | 5,579 | 100 | 7,631 | **16,361** | 800 B (11,000) |

- The pay frame costs $3{,}811 + 191d$ at tree depth $d$.
- With the user's signature, the prefix is 16,105 at depth 4, far inside 100,000.
- Proof bytes are outside `MAX_VERIFY_GAS`: rule 6 counts execution limits and signature validation. The payer pays them as intrinsic gas, and at depth 20 they cost more than the hashing. So the budget is not what limits tree depth; the calldata bill is.
- Against the canonical paymaster (pay frame 5,210 plus its signer's entry, 2,800 and about 90 bytes), the sealed path costs about 5,000 more execution and needs no signer online.

### Suggestions 2 and 3

**Suggestion 2 (PR-12328): scan all three doors, and only reachable code.** A runtime is sealed if:
1. it is not empty and not an EIP-7702 delegation indicator (door 2);
2. every reachable `APPROVE` is immediately preceded by `PUSH1 0x01, PUSH0, PUSH0`, with no `JUMPDEST` among them, so no jump can arrive with another scope (door 3);
3. no reachable instruction position holds a door-1 opcode. Reachable means from position 0 or a `JUMPDEST`, falling through until `STOP`, `RETURN`, `REVERT`, `INVALID`, `JUMP`, `SELFDESTRUCT` or `APPROVE`.

It is still one linear pass, the same one as `JUMPDEST` analysis, cacheable per code hash as the PR wants.

Reachability also fixes a false positive the PR's scan has. Solidity appends a CBOR trailer with a 32-byte IPFS digest after `INVALID`, and a linear scan reads the digest as instructions. Our own call-free `TestToken` fails the PR's scan on a `CALLCODE` byte in its digest. Over 100,000 seeded digests:

| Code | PR scan says sealed | amended scan says sealed |
|---|---:|---:|
| SealedPaymaster + `INVALID` + solc trailer | 72.17% | 99.08% |
| TestToken runtime + solc trailer | 71.66% | 99.05% |

The remaining 0.9% are digests with a `0x5b` byte at an instruction position. EOF's separation of code and data would have closed the question entirely.

**Suggestion 3 (EIP-8141): cap the code-less sponsor by count, as ERC-7562 caps unstaked entities.** ERC-7562 lets an unstaked entity back `SAME_UNSTAKED_ENTITY_MEMPOOL_COUNT` = 10 user operations. A count cap $k$ keeps fan-out at $k$ per transfer, while keeping the EIP's own use case, a user's "gas account" paying for their other accounts.

**Cost.**
- Suggestion 2 refuses some contracts a looser scan would admit: those whose `APPROVE` takes its scope from the stack even though they never approve execution. Their authors can emit the four-instruction form.
- Suggestion 3 limits a code-less market maker serving strangers to $k$ pending sponsorships; a canonical instance has no such limit.
- Neither changes consensus.

**What sealing costs a sponsor, so that nobody is surprised.**
- **The float is one-way.** The PR's property also admits ether that leaves "after a delay". But a timelocked withdrawal needs a `CALL` or an execution approval, and a whole-code scan forbids both. Under any such scan, an egress-decidable paymaster is a gas tank.
- **Liveness depends on the sponsor.** If the sponsor stops writing roots, then 8,191 slots after the last write no tuple can name a root, and the float is stranded for good.
- **Policies are irrevocable inside the window** (section 3).

**Not suggested: more exact code hashes.** The canonical paymaster is recognized by exact runtime match. One unreachable extra byte demoted a copy to "refused" (09). Every edit to the reference code orphans deployed instances, the versioning problem the `aa` study's question 14 raises. Recognition by a decidable property is the right direction. It only has to decide the right property.

**Not suggested: lifting the cap of one for every paymaster.** Staking and reputation are what ERC-7562 uses instead, and EIP-8141 removed both on purpose. The canonical paymaster's 86,400-second timelock is ERC-7562's `MIN_UNSTAKE_DELAY` of one day turned into code. A sealed paymaster is a stake that never unstakes.

## 3. Deadlines are declared, and then punished

**Revocation-wise** ([24](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/24-sealed-paymaster/experiments/24-sealed-paymaster), D). The sponsor published a policy, then a second root without one of its leaves, meaning to revoke it. A transaction proving the revoked leaf against the *first* root was mined after the second root was written. EIP-8272 keeps every root referenceable for 8,191 slots, about 27 hours at 12-second slots, so a later root adds a root and withdraws nothing.

That is the property that makes EIP-8272 safe for the mempool: no write can invalidate a pending reference. For a privacy pool's commitment tree it is also what the application wants, because the set only grows. For an *allow-list* it is not. Privacy Pools' association sets are allow-lists: a provider that removes a flagged deposit wants the removal to take effect. Under EIP-8272 the removed deposit stays provable against older roots for 8,191 slots, unless the consumer bounds a root's age itself.

The consumer can, by composition and with no protocol change:
1. put $\mathsf{notAfter}$ in the leaf, or publish $\mathsf{keccak256}(\mathsf{root} \Vert \mathsf{notAfter})$ as the root;
2. require an expiry frame whose deadline is at most $\mathsf{notAfter}$.

The sealed paymaster does exactly this. Once the policy's `notAfter` passed, a transaction with a later deadline was refused by the paymaster, and one with the old deadline by the protocol (`Frame transaction expiry deadline has passed`).

**Eviction-wise**, that composition costs something. EIP-8141's eviction order under resource pressure is:

> first transactions already invalid against the current head, then transactions with the nearest expiry deadline, then transactions with the lowest effective priority fee.

So a transaction that declares when it stops being valid is evicted before one that does not, *whatever it pays*. Who carries deadlines?
- privacy spends bounded as above;
- session keys (12);
- sponsored transactions whose sponsor wants a bounded exposure;
- every transaction whose wallet is careful.

A flood of deadline-free transactions at the minimum fee evicts all of them first (derived from the text; not measured, since filling a testnet mempool proves little). Experiments 10 and 19 also found that a deadline inside one slot is dropped silently.

**Suggestion 4: evict by fee, and use deadlines only near expiry.**
- Evict invalid transactions first, then the lowest effective priority fee.
- Treat a deadline as an eviction reason only once it falls within the node's revalidation margin. EIP-8272 already asks nodes not to admit references that would expire "almost immediately".

**Cost.** A node holds deadline-bearing transactions a little longer, and they are exactly the ones it can index without executing anything.

**Not suggested: ignoring deadlines in eviction altogether.** A transaction about to expire wastes gossip and builder attention, and dropping it first *near* its deadline is right. What is wrong is ranking a deadline a day away below a fee.

## 4. Inclusion lists do not cover frame transactions as scheduled

**What is scheduled.** EIP-8081 (Hegota, read 2026-10-08) has exactly two EIPs Scheduled for Inclusion: EIP-7805 (FOCIL) and EIP-8141.
- Considered: EIP-8250 and EIP-8272.
- Proposed: EIP-8369 (VOPS profiles for FOCIL eligibility) and EIP-8355 (ML-DSA precompiles).
- Declined: EIP-7851.

EIP-7773 (Glamsterdam) schedules EIP-7732, so ePBS comes first.

**What FOCIL checks.** EIP-7805's execution-layer rule, after the payload has run, for each IL transaction $T$ not in it:

> 3. Validate `T` against `S` by checking the nonce and balance of `T.origin`.

A frame transaction has no `T.origin` in that sense. Its validity is whatever its validation prefix decides, and its payer may not be its sender. The `aa` study's explainer 11 noted the gap. EIP-8369 is the proposal that fills it, and it puts *every* frame transaction in Profile 2:

> [EIP-8141](./eip-8141.md) frame transactions with an empty `blob_versioned_hashes` list are Profile 2 candidates.

Profile 2 needs:
- an AA-VOPS extension EIP, not yet written;
- EIP-8250 and EIP-8272 live;
- "a single composed payload encoding and signature hash for EIP-8141, EIP-8250, and EIP-8272";
- under ePBS, to "move omission checks to a post-reveal duty or leave Profile 2 disabled".

**What it means.** As scheduled, no frame transaction is FOCIL-enforceable in Hegota. Three groups lose:
- **EOAs that adopt frames.** A user whose wallet moves from type-2 transactions to frame batches, the main UX benefit of the EIP, loses inclusion-list protection by doing so.
- **Sponsored and private transactions.** These are what the companion EIPs exist for, and the `aa` study's question 5 asks whether a shared payer can be protected at all.
- **Privacy pools, twice.** Without EIP-8250 a pool as its own sender has one pending withdrawal network-wide. Experiment 06 measured it: the storage design serializes every user, and a second withdrawal evicted the first. crops-frame's [P0005](https://github.com/4w44h9jckz-boop/crops-frame/blob/main/problems/records/P0005-a-shared-sender-has-a-one-transaction-mempool-ceiling.md) computes the ceiling at about 300 spends an hour.

**Suggestion 5: put the directly evaluable frame transactions in Profile 1.** EIP-8141 already names the set. Its *Direct Evaluation of Protocol-Defined Frames* section lists three frame species with no deployed code to discover:
- default code;
- the expiry verifier;
- the canonical paymaster.

For the first two, the complete state dependency set is the sender's code hash, nonce and balance, the payer's code hash and balance, and the deadline. That is exactly base VOPS's `(nonce, balance, codeFlag)`, plus the block's timestamp.

The amendment to EIP-8369's Profile 1:

> A frame transaction is Profile 1 if every frame of its validation prefix is an expiry verifier frame or resolves to an account with empty code, and every signature those frames use is a `SECP256K1` entry with empty `msg`. Omission is justified if it does not fit the remaining payload gas, or if at the end of the payload the sender's nonce, the payer's balance or code classification, or the deadline makes it invalid.

This covers:
- an EOA's batch;
- an EOA's deploy-and-use;
- a friend's code-less sponsorship;
- a deadline-bounded transaction.

It covers them from the day frames ship. It needs no AA-VOPS extension, no code corpus, no IL VERIFY budget, and none of the unscheduled EIPs, and it stands under ePBS exactly where Profile 1 stands.

**Cost.**
- Attesters decode frame transactions and verify `SECP256K1` entries over the frame signature hash, which is stateless work they already do for type-2 transactions in another encoding.
- The coverage is the EOA-equivalent subset. Contracts with their own `VERIFY`, privacy pools included, still need Profile 2.

**Not suggested: custom `VERIFY` in Profile 1.** Profile 2's claimed insertion index exists because a frame's validity can depend on state changed earlier in the payload. Checking it at the end of the payload brings back the iterative append loop that EIP-8369 removed. **Nor the canonical paymaster in Profile 1.** Its admission reads its own signer and withdrawal slots, which is Profile 2's surface.

## 5. Validation state has three homes, and they disagree

**Where each rule says validation state may live:**
- EIP-8141's public mempool: any slot of `tx.sender`, and nothing else.
- EIP-8369 Profile 2: slots 0 to `AA_VOPS_SLOT_COUNT` $- 1$ (candidate 2 to 4) of sender and payer. "Ordinary privacy contract storage, nullifier mappings, commitment trees, and arbitrary external storage" are out.
- Account practice: anywhere but there.
  - ERC-1967 keeps the implementation at a keccak-derived slot.
  - ERC-7201 namespaces every storage struct at a keccak-derived base.
  - ERC-7579 validators keep their configuration in their own contract, keyed by account. EIP-8141 refuses that read outright (14: `StorageReadNonSender`), where ERC-7562 allows it as *associated storage*.

Delegation-wise, the conflict is sharp. Experiment 15 found that storage outlives delegation: a key registered under one delegation was valid again the moment the EOA re-delegated. Namespaced slots are what stop two *different* delegates reading each other's layout, and slots 0 to 3 are exactly where Solidity's default layout puts every contract's first variables. So:
- a delegated EOA that keeps its validation state where EIP-8369 can see it shares that region with whatever delegate comes next;
- one that namespaces its state, as EIP-7702 guidance recommends, is invisible to EIP-8369.

It can be inclusion-list-eligible or re-delegation-safe, not both.

What resolves it was measured in experiment 08: keep *one* commitment and carry the rest as a witness in `VERIFY` data.
- The commitment held in the proxy's code costs VERIFY 4,262.
- The same commitment in slot 0 costs 6,353, the difference being a cold `SLOAD`.

There is a price beyond gas. A prefix that reads any sender slot gave up keyed concurrency on ethrex: the storage proxy was refused a second pending transaction, the code proxy was not.

**Suggestion 6 (EIP-8369): define the surface as a namespaced base, not slots 0 to 3.**

$$\mathsf{base} = \mathsf{keccak256}(\texttt{"eip8369.aa-vops.validation"}) - 1, \qquad \text{surface} = \{\mathsf{base}, \ldots, \mathsf{base} + N - 1\}$$

The base is one constant for every account, so a VOPS node stores those $N$ slots exactly as cheaply as slots 0 to $N - 1$. It is a region no compiler uses by default, so ordinary state never lands in it by accident, and validation state written there is validation state by convention. $N = 1$ suffices for an account that stores a commitment, and a convention that the word commits to the validating code's identity lets a new delegate refuse an old delegate's state.

**Cost.**
- Account authors must write to a specific slot, which Solidity supports through ERC-7201-style layout annotations.
- The surface stops being "the first slots", which is easier to explain.

**Not suggested: admitting keccak-derived per-account slots (mappings) to the surface.** That is an unbounded surface, and keeping it bounded is the reason VOPS profiles exist.

## 6. Post-quantum: the account can move, the EOA cannot

**What a post-quantum user gets in Hegota as scheduled:**
- **A new contract account, post-quantum, works.** Experiment 17's WOTS account (1,024 one-time keys under a Merkle root, chosen by nonce) cost 73,481 gas per transfer, against 27,382 for ECDSA. At the Winternitz parameter that minimizes bytes ($w = 256$), the work fits 100,000 gas only after grinding the randomizer, $2^{18.7}$ tries on average.
- **Its signature is `ARBITRARY`, and stays unaggregatable.** The EIP keeps protocol-validated signature bytes out of the EVM "to allow future aggregation schemes", and `ARBITRARY` bytes are exactly the ones the EVM reads. [EIP-8288](https://eips.ethereum.org/EIPS/eip-8288)'s aggregation moves witnesses outside the transaction into mempool wrappers, a separate path (the `aa` study's question 6).
- **It cannot sponsor at scale.** The canonical paymaster in master "authorizes with a single secp256k1 signer via `ecrecover`". A post-quantum sponsor is non-canonical and capped at one pending transaction. PR-12041's `SIGPARAM` version admits any protocol scheme, but no post-quantum scheme is in the registry, and EIP-8355's ML-DSA precompiles are only Proposed.
- **An EOA cannot leave ECDSA.** Default code accepts `SECP256K1` only. EIP-7702 delegation adds keys and removes none: in experiment 15 the EOA key kept full power after delegation, signing legacy transactions and new authorizations. EIP-7851, which would let a delegated EOA disable its key, is declined.

The honest summary: Hegota makes post-quantum accounts possible and leaves every existing account on ECDSA, with no protocol path off it.

**Suggestion 7: scheme agility where the protocol recognizes code, with rotation.**
- Version the canonical paymaster to accept any registry scheme for its signer, as PR-12041 does.
- Admit new schemes to the registry by what only the protocol can do with them: pre-execution validation and aggregation. On that test BIP-340 Schnorr comes first, and among post-quantum schemes the one with a credible aggregation path beats the one that verifies fastest. Under the calldata floor, bytes are the cost: a 738-byte WOTS signature pays 66,474 gas of floor before any verification.
- Pair any widening of default code with a scheme-generic code-installation authorization, so a key-derived address can still rotate.

**Cost.** Each scheme is consensus code forever, and versioning the canonical paymaster is the migration problem of question 14.

**Not suggested: post-quantum schemes in default code without rotation.** That would make a key the permanent sole owner of an address that can never acquire code: the same dead end, one scheme later.

## 7. The public mempool is a strict subset of ERC-7562

| Rule | ERC-7562 (ERC-4337's mempool) | EIP-8141 public mempool |
|---|---|---|
| pending per sender | `SAME_SENDER_MEMPOOL_COUNT` = 4 | 1 (more only with EIP-8250 and PR-12039) |
| unstaked paymaster or factory | `SAME_UNSTAKED_ENTITY_MEMPOOL_COUNT` = 10 | 1 (non-canonical) |
| staked entities | unlimited, with reputation | none: code-hash recognition instead |
| storage outside the sender | associated storage allowed | none |
| validation gas | `MAX_VERIFICATION_GAS` = 500,000 | `MAX_VERIFY_GAS` = 100,000 |

Every row is narrower. That is a defensible design: a smaller surface is what makes frame validation cheap enough for inclusion lists and partial statelessness, and lightclient's [mempool strategies note](https://hackmd.io/@matt/frame-mempool) says plainly that "a restrictive policy is fine at launch".

But it means frames replace the *simple* half of ERC-4337 at launch, not all of it. The other half stays where it is:
- **ERC-20 gas sponsorship.** The paymaster cannot read the user's token balance during validation. So a sponsor paid in tokens either signs every transaction with an off-chain risk check (a live, keyed service that sees each transaction before it propagates), or bears credit risk: a sender who empties their wallet first cost our sponsor 218,760 gas (04).
- **ERC-7579 external validators**, which must be rewritten as `DELEGATECALL` modules with namespaced state in the account (14).
- **Validation over 100,000 gas.** A Groth16 privacy proof is 245k to 249k (06).

Wallet-wise, the migration path is not "frames instead of 4337". It is to move what fits, keep a 4337 path for what does not, and expect the gap to close by *declarations*: keyed nonces, recent roots, decidable payers. It will not close by reopening associated storage.

**Not suggested: associated storage for frames.** It is the one ERC-7562 rule that would bring ERC-20 sponsorship back, and it is the one that would break every VOPS surface above.

## Four clients, one chain

frames-devnet-0 runs geth, Nethermind, reth and ethrex behind one eRPC balancer ([22](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/22-cross-client/experiments/22-cross-client)). Our test account has no funds there, so we asked what four clients can be asked without spending anything.

**Consensus-wise, they agree.**
- At 50 of 50 heights they served the same block hash, state root and receipts root.
- All 2,000 frame transactions in 200 blocks re-encode to their hash under our implementation, every secp256k1 entry recovers over our signature hash, and every receipt's `gasUsed` equals our settlement of its frames.
- The coverage is narrow: 5 shapes, all self-relayed secp256k1, no sponsor, no contract account, no state gas.

**Admission-wise, they do not.** We sent 49 probes, each breaking one rule, to each client. The divergences:

| Probe | geth | Nethermind | reth | ethrex |
|---|---|---|---|---|
| any frame rule, unfunded sender | `insufficient funds` before any frame rule | the rule | the rule | the rule |
| validation prefix of 150,000 | funds | **funds: within its cap** | `MAX_VERIFY_GAS` | `MAX_VERIFY_GAS` |
| wrong signature on an entry no frame reads | funds | signature | "prefix execution failed" | signature |
| zero-fee sponsored transaction | min tip | **accepted, and held** | prefix failed | min tip |

Bisection gave three values of one constant: `MAX_VERIFY_GAS` is 100,000 on reth and ethrex, 300,000 on Nethermind, and 500,000 on ethrex's Hegota build. Of the 39 transaction JSON fields the four serve, 21 are not served by all four. `gas` alone has three meanings: `max_gas`, the sum of frame limits, or absent.

Error-wise, "the validation prefix reverted" covers too much. It covered an unfunded payer, an unbudgeted account-creation charge and a missing signature entry, from three clients. A wallet cannot tell "fund this account" from "budget account creation" from "sign entry 0".

## Smaller fixes, carried over from the first round

Each was argued in full in the previous version of this post. In brief:

| # | Suggestion | Evidence | Not suggested |
|---|---|---|---|
| 8 | `TIMESTAMP` only while executing a frame whose target is `EXPIRY_VERIFIER`. Optionally, `not_before` in the expiry frame's data | ethrex admits a nested call to the verifier: a hidden deadline, the EIP's own example attack (19) | `TIMESTAMP` in `VERIFY` generally |
| 9 | Meter the prefix in two dimensions: cold state access, capped where today's floor is, and total, capped by a CPU benchmark | the workloads over 100k (Groth16, unground WOTS, 40-key multisigs) are compute, not state access (06, 17) | raising the single cap, which raises the state-access worst case with it |
| 10 | `status = 3` (ROLLED_BACK) for frames undone by their batch | all four clients report them `SUCCESS` while their logs and state are gone (03, 22) | marking them FAILURE |
| 11 | Denominate `MAX_VERIFY_STATE_GAS` in state bytes | a re-derivation of `CPSB` silently shrinks what the rule admits | |
| 12 | One stated order of admission checks; a small enum of rejection reasons; `gas` defined or dropped for type `0x06` | three orders, four error vocabularies (22) | |
| 13 | Reconcile the paymaster text: one sentence makes a transaction "eligible ... only if the `pay` frame targets a canonical paymaster instance", the next section admits non-canonical ones | EIP-8141 master | |

## What we would not change

- **Fees inside the canonical hash.** Section 1: outside it, the relay sets a self-payer's tip. Accounts that do not pay can already leave the fees out, through an explicit digest.
- **No third-party storage in `VERIFY`.** Section 7: it is the price of a validation surface small enough for inclusion lists.
- **No staking or reputation.** Code-hash recognition got the canonical paymaster to four users per block without either, and decidable properties extend it, once they decide the right property.
- **Protocol signature bytes hidden from the EVM.** It is what keeps aggregation possible.
- **Signature bytes priced as data.** A discount would reopen the per-block data bound, and post-quantum signatures are where the bytes will be.
- **EIP-8272's in-window immutability.** Section 3: revocation belongs to the consumer, by composition, not to a write that could invalidate pending references.

## Open questions, and what we run next

- **Suggestion 5 needs an attester-side cost model.** Decoding frame transactions and verifying `SECP256K1` entries for up to 16 ILs per slot.
- **A funded run on frames-devnet-0, and frames-devnet-1** (EIP-8250 and EIP-8272 across clients). Every shape spamoor does not send, including both paymasters of experiment 24, read back from four clients.
- **The CPU benchmark** suggestion 9's total cap needs.
- **An ERC for explicit execution digests** (section 1), so that two wallets building $E$ agree byte for byte.

Every number above has a branch, a README, a command and a transaction hash behind it in [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames). Corrections are very welcome, especially from the EIP authors where we have read intent into text that does not state it.
