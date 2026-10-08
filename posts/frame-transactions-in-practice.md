# Is EIP-8141 Done? Frame Transactions after 27 Experiments and Four Clients

## TLDR;

We built 27 experiments on [EIP-8141 frame transactions](https://eips.ethereum.org/EIPS/eip-8141), mined them on the ethrex Hegota testnet or ran them inside ethrex's own code, and probed four execution clients on ethpandaops' frames-devnet-0. The question this post answers is the one people keep asking: **are frame transactions done?**

**The execution layer is.** Four clients agree on every block we checked. An independent implementation re-encodes, re-verifies and re-settles 2,000 of their transactions. Every ERC-4337 use case we tried ports, at 2.41 times less gas for a token transfer.

**Frame transactions as something a user can rely on are not.** Whether a given frame transaction propagates, who may pay for it, whether an inclusion list protects it, and whether a post-quantum account can use it are all decided outside block execution. Every one of those layers has an open problem. Two of them failed live tests this round, and a third failed inside the one client that implements it:

1. **The EIP's own guidance for custom validation is exploitable.** It allows an account to "constrain every subsequent `SENDER` frame" in place of the canonical signature hash. We took that literally. A mempool observer then:
   - inserted a sandwich *inside the victim's own transaction* and replaced it; the transaction was mined, the victim got 3.0% less, and paid for the attacker's frames;
   - separately, relayed the same signature with a 10 gwei tip where the owner had signed for 1,000 wei.

   The fix is a rule: sign what you approve. The same rule, applied carefully, also gives "sign once, any payer". We wrote that half up as a draft ERC: an EIP-712 digest that a wallet with no frame support signs through `eth_signTypedData_v4`. A second sponsor's replacement was mined carrying the owner's typed-data signature byte for byte.
2. **Ether leaves an account through three doors, and two payer rules watch one.** The doors are an opcode, a key, and an approval of execution. [PR-12328](https://github.com/ethereum/EIPs/pull/12328)'s "egress-decidable" scan looks only at opcodes. A paymaster that passes it moved its whole balance out through a `SENDER` frame's `value`, mined, while a sponsorship admitted against that balance was pending; the sponsorship was dropped. The EIP's own exemption for code-less sponsors looks at none of the doors. We give a sound scan (it also cuts false positives from 28% to 0.9%) and measure the sealed pay frame the PR left unmeasured: 13,305 gas.
3. **As scheduled, inclusion lists protect no frame transaction, and where the profile that would protect them is built, its verdict depends on the order the lists arrive in.**
   - Hegota schedules EIP-7805 (FOCIL) and EIP-8141, and nothing else from the frame family. FOCIL's execution-layer check is written for an EOA's nonce and balance. [EIP-8369](https://eips.ethereum.org/EIPS/eip-8369) classes *every* frame transaction under a profile that needs an unscheduled extension, two unscheduled EIPs, and a redesign under ePBS. An EOA that moves from type-2 transactions to frame batching loses inclusion-list protection.
   - The one implementation of that profile fills a replay budget in the order the consensus layer delivers, and the consensus specification deduplicates the lists through a `set`. Eight runs of its own function gave eight orders, and eight different admitted sets.
   - One committee member listing transactions from a key that was never funded denies honest privacy withdrawals, for free.

   We propose the subset that needs no extension at all (68 of our 183 transactions), and a per-list budget that restores FOCIL's guarantee that one honest includer suffices.
4. **Validation state has three homes, and they disagree.** The mempool allows any slot of the sender. EIP-8369 allows slots 0 to 3. Account practice (ERC-1967, ERC-7201, ERC-7579, and EIP-7702 re-delegation) keeps state anywhere but there. A delegated EOA can be inclusion-list-eligible or re-delegation-safe, not both.
5. **Revocation and deadlines are punished.**
   - EIP-8272 roots cannot be withdrawn for 8,191 slots, and we measured that a later root revokes nothing.
   - The only way to bound a root's life is an expiry frame.
   - The EIP evicts the nearest deadline first, at any fee, so the transactions that declare when they stop being valid are the first to go.
6. **Post-quantum: a new account can be post-quantum, an EOA cannot leave ECDSA.**
   - EIP-7851 is declined for Hegota.
   - Default code and the canonical paymaster are secp256k1 only.
   - Every post-quantum signature is `ARBITRARY`, which the EIP itself makes non-aggregatable.
7. **The public mempool is a strict subset of ERC-7562.** That is a defensible choice, but it means frames replace the simple half of ERC-4337 at launch, not all of it. Gas-for-tokens sponsorship becomes either a live signer or unsecured credit. One limit could safely grow, and we timed it: compute. The worst work per gas runs at about 16 ns in ethrex, a Groth16 proof at 13, and a state read from memory at 1.4. A separate cap on state would admit a 245k-gas proof without raising the 47 cold reads a prefix may make.

Each finding comes with a suggestion, its cost, and the easier fix we are *not* proposing. The thread that runs through all of them: **every rule that widened the mempool safely is a declaration a node can index without executing anything; every rule that failed infers something from execution, or from the order things arrived in.**

> Experiments, one branch each, with READMEs, scripts, contracts and mined fixtures: [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames) (start at the [tooling README](https://github.com/4w44h9jckz-boop/exp-frames/tree/tooling)). This round: [23, approval scope](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/23-approval-scope/experiments/23-approval-scope), [24, sealed paymaster](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/24-sealed-paymaster/experiments/24-sealed-paymaster), [25, inclusion lists](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/25-inclusion-lists/experiments/25-inclusion-lists), [26, validation CPU](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/26-validation-cpu/experiments/26-validation-cpu) and [27, execution digest](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/27-execution-digest/experiments/27-execution-digest)
> Rust wallet ports: [kohaku-rs, branch `experiment/frames`](https://github.com/4w44h9jckz-boop/kohaku-rs/tree/experiment/frames)
> Companion studies we cite rather than repeat: [aa](https://github.com/4w44h9jckz-boop/aa) (account abstraction and the gas market for private transactions) and [crops-frame](https://github.com/4w44h9jckz-boop/crops-frame) (a composition framework for privacy protocols on frames)
> Related reading: Nero_eth, [Frame transactions and the three gates to privacy](https://ethresear.ch/t/frame-transactions-and-the-three-gates-to-privacy/24666); lightclient, [Mempool Strategies for EIP-8141](https://hackmd.io/@matt/frame-mempool)

## Is it done? A readiness map

Spec-wise, we read EIP-8141 at master on 2026-10-08, with EIP-8250 (keyed nonces), EIP-8272 (recent roots), EIP-7805 (FOCIL), EIP-8369 (VOPS profiles), ERC-7562 and the Hegota and Glamsterdam meta EIPs, and the consensus-specs and Engine API text that FOCIL runs on. Experiment-wise, every claim below has a mined transaction, a refusal message or a quoted sentence behind it.

| Layer | What it decides | State | Evidence | What is missing |
|---|---|---|---|---|
| Block execution | envelope, signature hash, frames, `APPROVE`, receipts, gas | **converged** | 4 clients, 50 of 50 heights; 2,000 transactions re-encoded and re-settled (22); 41 rebuilt byte for byte in Rust | a status for frames rolled back with their batch; cross-client coverage beyond 5 shapes |
| Approval semantics | what a custom `VERIFY` must authenticate | sig hash sound; **guidance exploitable** | sandwich and fee rewrite mined (23); an EIP-712 execution digest from an unmodified wallet call, mined under a second payer (27) | one paragraph of Security Considerations; an ERC for the digest, drafted (section 1) |
| Payers | who may sponsor many pending transactions | canonical paymaster works, for one secp256k1 signer; **two other rules unsafe as written** | 4 users in one block (09); scan-sealed paymaster drained with a sponsorship pending (24) | a fan-out invariant (section 2) |
| Public mempool | what propagates | specified, deliberately narrow; **clients diverge** | 3 values of `MAX_VERIFY_GAS`, 3 check orders (22); worst compute about 16 ns per gas, state from memory 1.4 (26) | caps, order and error vocabulary; a cap for state apart from compute (section 7) |
| Shared senders | privacy pools, multisig treasuries | **one pending transaction per sender** without EIP-8250, which is only Considered | storage pool serializes all users; keyed pool lands 3 per block (06) | scheduling, and keyed mempool rules ([PR-12039](https://github.com/ethereum/EIPs/pull/12039)) |
| Inclusion lists | censorship resistance | **undefined for type `0x06`; order-dependent where built** | 173 of 183 candidates under EIP-8369, 183 under EIP-8272's rule; 68 directly evaluable; 46 admitted sets from one set of lists (25) | a Profile 1 for directly evaluable frames; a per-list budget, with list boundaries in the Engine API (section 4) |
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
| **25** | **Inclusion lists for frame transactions, against ethrex's Profile 2** | **46 admitted sets from one set of lists; 2 privacy withdrawals per slot** |
| **26** | **What a gas cap on the validation prefix bounds, in time** | **about 16 ns per gas at worst; Groth16 13.1; a state read from memory 1.4** |
| **27** | **A shared layout for the execution digest, as a draft ERC** | **one typed-data signature, two payers, the second mined** |

188 mined transactions are kept as test fixtures. Experiments 01 to 21, 23, 24 and 27 ran on one client (ethrex `v23.0.0-hegota-testnet`, EIP-8141 pinned at `b75cbe61`, plus EIP-8250 and EIP-8272, with `MAX_VERIFY_GAS` raised to 500,000 by a node flag), so their numbers are ethrex's on the Amsterdam gas schedule. Experiments 25 to 27 also ran inside ethrex's own test tree, at [`c94964843d`](https://github.com/lambdaclass/ethrex/tree/c94964843d39d04914dff178e55e60daf7707089) of its `hegota-testnet` branch. Nothing in 25 or 26 sends a transaction.

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

Identity-wise, it moves what a transaction *is*. Across the two payers, $E$ stayed fixed while the signature hash and the transaction hash both changed. A wallet that tracks its operation by transaction hash lost it at the replacement. Bitcoin learned this with transaction malleability, and fixed it with a witness-free identifier for the thing the signer authorized (BIP 141's txid against wtxid). Frames need the same distinction in wallets and RPCs: the *intent* the sender signed, against the *envelope* that carries it. The ERC below makes it concrete. A wallet watches the nonce and recomputes $E$ of whatever consumed it, and a contract that wants an operation id recomputes $E$ rather than reading `TXPARAM(0x08)`.

**Suggestion 1: replace the paragraph.**

> A validation that grants `APPROVE_EXECUTION` must authenticate every frame other than pay frames, with its index, and the number of frames. A validation that grants `APPROVE_PAYMENT` must also authenticate the fees and the limits of every frame. Constraining only `SENDER` frames is not sufficient: `DEFAULT` frames placed between them run while the sender's operations are in flight, and every frame is paid for by the payer. The canonical signature hash satisfies both requirements.

**Cost.** One paragraph in the EIP. Wallets that build explicit digests also need a published layout for $E$, so that two wallets, an account and a sponsor agree on it byte for byte. That belongs in an ERC, not the EIP.

**We drafted that ERC** ([27](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/27-execution-digest/experiments/27-execution-digest), [`erc-draft.md`](https://github.com/4w44h9jckz-boop/exp-frames/blob/exp/27-execution-digest/experiments/27-execution-digest/erc-draft.md)). $E$ is EIP-712 typed data:

```
domain  = EIP712Domain("FrameExecution", "1", chain_id, verifyingContract = sender)
message = FrameExecution(nonceKeysHash, nonceSeq, Frame[] frames, bytes32[] blobVersionedHashes)
Frame   = (mode, flags, resolved target, execution limit, state limit, value, data)
          with target, both limits and data zeroed in the pay frame
```

The pay frame's mode, flags and value stay pinned: none can differ in a valid pay frame today, and pinning them means a future flag, or value on `VERIFY`, cannot reach the sender through an open field. A plain EIP-8141 envelope digests as `nonce_keys = [0]`, so both envelopes of one operation share one $E$.
- **Four implementations that share no code agree on it:** viem's typed-data encoder, a by-hand encoder, alloy's EIP-712 derive in kohaku-rs, and a 617-byte Yul account that recomputes $E$ by introspection.
- **Inside ethrex's validation-prefix simulation, every verdict matched:** 11 signed cases accepted and 8 refused. The refusals include an inserted or an appended `DEFAULT` frame, a lowered state limit, a retargeted transfer, a swapped blob, and the same signature on a second account.
- **On the testnet,** the owner's entry came out of viem's `signTypedData`, the call a wallet serves for `eth_signTypedData_v4`. A second sponsor replaced the first sponsor's copy with its own pay frame and 20% higher fees, reusing that entry byte for byte, and was mined (block 320,282). `VERIFY` cost 1,974 gas for three frames and 3,207 for six, about 411 per added transfer.

So a wallet that knows nothing about frames can authorize a sponsored frame transaction today. That is also why the draft makes an honest display of the typed data a MUST: the same interface carries permit phishing.

Writing the layout down turned up three things experiment 23 had not tested:
- **The relay can name the sender as payer.** $E$ leaves the pay frame's target open, so a relay may point it at the account itself. An account that approves `PAYMENT` because a valid owner entry exists, without requiring that entry to cover the fees, pays whatever fees the relay states. The draft's first account rule is that nothing approves payment on $E$, from any frame, and our account refused the case in ethrex and against the testnet's state.
- **Blobs.** `BLOBHASH` reads `blob_versioned_hashes` in every frame, and experiment 23's $E$ left them out. A relay could have swapped the blobs under a `SENDER` frame that posts them. $E$ pins them now.
- **The pay frame's limits must stay open.** EIP-8250 charges a keyed nonce's first use, 97,920 state gas per key, to the frame whose `APPROVE` grants payment. In the two-key vector the payer had to budget 195,840 state gas in its own frame. A layout that pinned the pay frame's limits would make the owner fix, before any payer is known, one budget for both the payer's own code and a charge the sender's keys cause.

**Not suggested: a protocol execution hash.** A reserved `msg` value meaning "the protocol's execution hash" would let plain EOAs sign execution-only, more cheaply, and visibly to RPCs. It would also be a second canonical hash, fixed forever, for a use not yet shown at scale. The explicit `msg` is the extension point EIP-8141 already has, and an ERC can be versioned.

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

## 4. Inclusion lists: absent for frames as scheduled, order-dependent where built

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
- "a single composed payload encoding and signature hash for EIP-8141, EIP-8250, and EIP-8272", a sentence older than EIP-8272's move to a canonical frame (below);
- under ePBS, to "move omission checks to a post-reveal duty or leave Profile 2 disabled".

**What it means.** As scheduled, no frame transaction is FOCIL-enforceable in Hegota. Three groups lose:
- **EOAs that adopt frames.** A user whose wallet moves from type-2 transactions to frame batches, the main UX benefit of the EIP, loses inclusion-list protection by doing so.
- **Sponsored and private transactions.** These are what the companion EIPs exist for, and the `aa` study's question 5 asks whether a shared payer can be protected at all.
- **Privacy pools, twice.** Without EIP-8250 a pool as its own sender has one pending withdrawal network-wide. Experiment 06 measured it: the storage design serializes every user, and a second withdrawal evicted the first. crops-frame's [P0005](https://github.com/4w44h9jckz-boop/crops-frame/blob/main/problems/records/P0005-a-shared-sender-has-a-one-transaction-mempool-ceiling.md) computes the ceiling at about 300 spends an hour.

**What we measured** ([25](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/25-inclusion-lists/experiments/25-inclusion-lists)). We classified the 183 frame transactions mined before experiment 25 under each rule:

| Rule | Eligible | Not |
|---|---:|---:|
| Profile 2 candidate, EIP-8369 as written | 173 | 10 |
| Profile 2 candidate, skipping both leading verifier frames (EIP-8272's rule, and ethrex's) | 183 | 0 |
| Profile 1 for directly evaluable frames (suggestion 5a below) | 68 | 115 |

The 10 that EIP-8369 leaves out are every transaction with an EIP-8272 recent-root frame: experiment 06's privacy withdrawals and experiment 24's sealed sponsorships. Its condition 2 ignores "the optional EIP-8141 expiry verifier frame for shape matching", but not the recent-root frame, so a prefix that starts with one matches none of its four shapes. Those are the transactions its own motivation names: "a privacy spend that checks recent roots and consumes each nullifier as a single-use EIP-8250 keyed nonce". EIP-8272 (master, changed 2026-10-08) already says "clients MUST skip both optional leading protocol verifier frames", and ethrex does. Two sentences of EIP-8369 predate that move to a canonical frame: recent roots as "references in the signed envelope", and the call for a composed payload encoding quoted above. The fix is editorial (smaller fixes, 14).

**Suggestion 5a: put the directly evaluable frame transactions in Profile 1.** EIP-8141 already names the set. Its *Direct Evaluation of Protocol-Defined Frames* section lists three frame species with no deployed code to discover:
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

It covers them from the day frames ship. It needs no AA-VOPS extension, no code corpus, no IL VERIFY budget, and none of the unscheduled EIPs, and it stands under ePBS exactly where Profile 1 stands. And because nothing about it is replayed, no budget rations it, so nothing in the next subsection applies to it.

**Cost.**
- Attesters decode frame transactions and verify `SECP256K1` entries over the frame signature hash, which is stateless work they already do for type-2 transactions in another encoding. We timed it with ethrex's own functions (25): decoding a default-code frame transaction and checking its signature takes 50 to 53 $\mu$s on one core, and recovering a type-2 sender takes 48. A full slot of them costs less than a full slot of type-2 transactions, because they are larger.
- The coverage is the EOA-equivalent subset: 68 of our 183 transactions. Contracts with their own `VERIFY`, privacy pools included, still need Profile 2.

**Not suggested: custom `VERIFY` in Profile 1.** Profile 2's claimed insertion index exists because a frame's validity can depend on state changed earlier in the payload. Checking it at the end of the payload brings back the iterative append loop that EIP-8369 removed. **Nor the canonical paymaster in Profile 1.** Its admission reads its own signer and withdrawal slots, which is Profile 2's surface.

### Where Profile 2 is built, the order decides

Profile 2 bounds what an attester replays with a VERIFY budget, `MAX_VERIFY_GAS_PER_IL` $= 2^{20}$ per list. A listed transaction is admitted while its declared cost fits, and only admitted transactions must be included: omitting one that was never admitted is excused. The one implementation is ethrex's `hegota-testnet` branch (`crates/blockchain/focil_profile2.rs` at `c94964843d`), the code of the testnet the rest of this post ran on. We ran its own fill function over lists built from our mined transactions, plus never-valid ones from a key nobody funds ([25](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/25-inclusion-lists/experiments/25-inclusion-lists)).

**Capacity-wise, the budget runs per payload, not per list.** The Engine API hands the execution layer one flat array, so ethrex has no list boundaries to fill against. Its spec says so and files it as spec feedback. A slot then protects:

| Kind (experiment) | Bytes | Declared budget | ethrex, $2^{20}$ per payload | EIP-8369, $2^{20}$ per list |
|---|---:|---:|---:|---:|
| self-relayed EOA (01) | 188 | 7,800 | 134 | 688 |
| sealed-paymaster sponsorship (24) | 702 | 67,800 | 15 | 176 |
| privacy withdrawal, keyed pool (06) | 747 | 410,000 | **2** | 32 |

The most expensive transactions get the least protection, and the most expensive are the privacy spends. Declared tightly, at the 250,387 gas it uses, a withdrawal fits 4 times per slot.

**Order-wise, the verdict is not a function of the lists.** The consensus specification's `get_inclusion_list_transactions` ends:

```python
    # Deduplicate inclusion list transactions. Order does not need to be preserved.
    return list(set(transactions))
```

ethrex's fill debits in the order it receives. We ran the specification's function itself, under eight hash seeds, on two lists holding 4 withdrawals, 3 sealed sponsorships and 4 EOA transactions. It delivered eight orders, and ethrex admitted eight different sets. Over 5,040 sampled orders of those 11 transactions there are 46 admitted sets, and each withdrawal is admitted in about 48% of them. Two attesters holding the same lists can therefore reach different verdicts on a payload that omits one withdrawal. That is the disagreement EIP-8369's "single eligibility boundary" exists to prevent.

**Attack-wise, denial is free.** A committee member lists transactions from a key that has never held ether, each declaring whatever VERIFY limit the attacker likes. The fill checks shape and signature before it debits, and both pass. Replay then finds the transaction invalid, so its own omission is excused, and it has spent the budget. A transaction that is never included pays no fee.
- One such transaction declaring $2^{20}$ denies every honest Profile 2 transaction of the slot in the orders where it comes first.
- Thirty at $2^{20}/30$ each, 4,800 bytes in one list, need no position at all: honest withdrawals were admitted in 26% of orders.
- The attacker needs one seat on a committee of 16. A fraction $p$ of validators holds one in a given slot with probability $1 - (1 - p)^{16}$, which is 15% at $p = 0.01$.

**Sorting fixes determinism and nothing else.** A canonical order, by declared cost and then hash, makes the verdict the same everywhere. But junk priced just under a withdrawal's cost still crowds it out: in our thirty-junk scenario it denied every withdrawal and every sponsorship. And the flat fill is not monotone in the lists, which no order repairs. FOCIL tolerates attesters that received different lists because more lists can only mean more to include; the builder's bid declares which lists it covered, in `inclusion_list_bits`. Under one shared budget an extra list can only add debits ahead of a transaction, so an attester that received the attacker's list excuses what one that did not would require.

**Suggestion 5b (consensus-specs, Engine API, EIP-8369): fill the budget per list, and carry the lists.** EIP-8369 already says the budget is per list, counted "per IL occurrence before deduplication". What is missing is the boundaries:
- `get_inclusion_list_transactions` returns the timely, non-equivocating lists in committee order, the order `InclusionListBits` already uses, each in its signed order;
- the Engine API carries them as an array of arrays, or as the flat array plus a parallel array of list indices;
- the execution layer fills each list's budget on its own, then deduplicates. A transaction is admitted if any list that carries it admits it.

Per-list admission is monotone, so a builder that satisfies the lists its bits declare satisfies every attester whose lists those bits include. An attacker's budget is its own. It can withhold its own list's protection, which it could always do by listing nothing, and it cannot spend anyone else's. In each multi-list scenario we ran, it admitted every honest transaction. That is FOCIL's guarantee that one honest includer suffices, restored for Profile 2.

**Cost.**
- **The Engine API changes shape.** It carries the same bytes, at most $16 \times 8$ KiB per call.
- **The replay bound is $16\,c_{\max}$ per slot.** One honest list must be able to protect a transaction of cost $c_{\max}$ whatever the other fifteen carry, and no fill does better without lowering the cap. That is $2^{24}$ gas at the candidate value, the bound EIP-8369 itself states. Keeping ethrex's $2^{20}$ per slot would mean a per-transaction cap of $2^{16} = 65{,}536$, below what a withdrawal uses. A cap that admits a tightly declared withdrawal needs $16 \times 250{,}387 \approx 4.0$M gas of replay per slot. At the worst compute rate we measured ([26](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/26-validation-cpu/experiments/26-validation-cpu), section 7), about 16 ns per gas, that is 64 ms, and $2^{24}$ is 270 ms, before any state read from disk. EIP-8369 says the number "requires full pipeline benchmarks", and it should be benchmarked before either value is fixed.

**Not suggested:**
- **A canonical order on the flat array.** It is deterministic and protects cheap transactions, and it leaves the verdict non-monotone and expensive transactions denied by cheaper junk.
- **Rationing per sender or per payer.** The attacker's keys are free and never funded, so rationing by key counts keys, not adversaries.
- **Ordering by fee, or by arrival.** A transaction that is never included never pays the fee it declares, and an includer who publishes first would choose the order, which is the attack.
- **Dropping the budget.** Attester replay becomes unbounded.

What per-list filling leaves is the paid grief ethrex's own security considerations record: a transaction that is valid when listed and invalidated by a cheaper conflicting one in the block. It now costs the attacker an entry in every honest list it must deny, each placed there through the public mempool, instead of one seat anywhere on the committee.

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

**What can safely grow is compute** ([26](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/26-validation-cpu/experiments/26-validation-cpu)). We timed ethrex's own admission check, `Blockchain::validate_transaction`, on prefixes that spend their gas on the most expensive work a prefix may legally do. The slowest work per gas is elliptic-curve arithmetic: alt_bn128 MUL at 16.0 ns per gas on one core, a BLS12-381 pairing at 15.9, ECDSA recovery at 14.3. So a cap of $C$ gas bounds compute at about $16\,C$ ns:

| Cap | Worst compute |
|---:|---:|
| 100,000 (`MAX_VERIFY_GAS`) | 1.6 ms |
| 250,000 (fits experiment 06's Groth16 prefix) | 4.0 ms |
| 500,000 (the Hegota testnet's node flag) | 8.0 ms |

- The prefixes that need more than 100,000 already run near that rate: Groth16 at 13.1 ns per gas, the 40-key multisig at 15.0. A cap set from the worst rate wastes little on them.
- Hash-based verification runs at about 5.7, so the same cap gives a hash-based post-quantum account three times the margin it needs.
- A cold state read from memory runs at 1.4, about 2.9 $\mu$s a slot. State becomes the binding resource only once a read from disk costs more than about 34 $\mu$s, and its other cost is fan-out (section 2), which is about the number of reads, not their time.
- Every admission also costs about 30 $\mu$s that no gas counts, about 1,900 gas at the worst rate.

So gas is a good enough unit for compute, and the reason not to simply raise the cap is state. At 250,000 the single cap allows 119 cold reads instead of 47. Two caps (smaller fixes, 9) let compute grow to 4 ms while the state allowance stays where it is.

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

**Implementation-wise, a gas price is a time bound only for clients built like the one that set it** ([26](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/26-validation-cpu/experiments/26-validation-cpu)). Two things we found inside ethrex:
- It verifies each protocol signature twice on admission, once over the signature list and again inside the prefix simulation. One `SECP256K1` entry adds 89 $\mu$s over an empty prefix, two recoveries' worth, for the 2,800 gas the protocol charges.
- Built without its assembly backend, the portable path its zkVM guest builds take, `P256VERIFY` runs at 36.0 ns per gas. That is 3.9 times its rate with the backend, and more than twice the slowest operation of a normal build.

## Smaller fixes

Rows 8 to 13 were argued in full in the previous version of this post, and 14 and 15 are new this round. In brief:

| # | Suggestion | Evidence | Not suggested |
|---|---|---|---|
| 8 | `TIMESTAMP` only while executing a frame whose target is `EXPIRY_VERIFIER`. Optionally, `not_before` in the expiry frame's data | ethrex admits a nested call to the verifier: a hidden deadline, the EIP's own example attack (19) | `TIMESTAMP` in `VERIFY` generally |
| 9 | Meter the prefix in two dimensions: cold state access, capped where today's floor is, and total, capped by a CPU benchmark | the workloads over 100k (Groth16, unground WOTS, 40-key multisigs) are compute, not state access (06, 17). The benchmark: the worst work runs at about 16 ns per gas, Groth16 at 13.1, state from memory at 1.4, so a total cap is a time budget over 16 ns, 4 ms at 250k (26, section 7) | raising the single cap, which raises the state-access worst case with it: from 47 cold reads to 119 at 250k |
| 10 | `status = 3` (ROLLED_BACK) for frames undone by their batch | all four clients report them `SUCCESS` while their logs and state are gone (03, 22) | marking them FAILURE |
| 11 | Denominate `MAX_VERIFY_STATE_GAS` in state bytes | a re-derivation of `CPSB` silently shrinks what the rule admits | |
| 12 | One stated order of admission checks; a small enum of rejection reasons; `gas` defined or dropped for type `0x06` | three orders, four error vocabularies (22) | |
| 13 | Reconcile the paymaster text: one sentence makes a transaction "eligible ... only if the `pay` frame targets a canonical paymaster instance", the next section admits non-canonical ones | EIP-8141 master | |
| 14 | EIP-8369's condition 2 skips both leading verifier frames, as EIP-8272 already says, and loses the two sentences that predate EIP-8272's canonical frame | as written it leaves out 10 of 183 transactions, exactly the recent-root ones its motivation names (25, section 4) | |
| 15 | The omission check's gas fit is EIP-8141's two-dimensional test, not one comparison against `T.gas` | 104 of 183 transactions declare state gas, median 97,920; the largest declares 30,070,620 for five contract creations. Under one dimension, a transaction that creates an account needs room in the dimension it does not use (25) | |

## What we would not change

- **Fees inside the canonical hash.** Section 1: outside it, the relay sets a self-payer's tip. Accounts that do not pay can already leave the fees out, through an explicit digest.
- **No third-party storage in `VERIFY`.** Section 7: it is the price of a validation surface small enough for inclusion lists.
- **No staking or reputation.** Code-hash recognition got the canonical paymaster to four users per block without either, and decidable properties extend it, once they decide the right property.
- **Protocol signature bytes hidden from the EVM.** It is what keeps aggregation possible.
- **Signature bytes priced as data.** A discount would reopen the per-block data bound, and post-quantum signatures are where the bytes will be.
- **EIP-8272's in-window immutability.** Section 3: revocation belongs to the consumer, by composition, not to a write that could invalidate pending references.
- **The explicit `msg` as the extension point.** Section 1: an execution-only digest needs no second protocol hash. An ERC can be versioned, and a canonical hash is fixed forever.
- **A VERIFY budget on Profile 2.** Section 4: without one, attester replay is unbounded. What has to change is where it is filled, not whether.

## Open questions, and what we run next

Last round's list asked for an attester cost model for suggestion 5, a CPU benchmark for suggestion 9, and an ERC for $E$. Experiments 25 to 27 are those three. What is left:
- **The Profile 2 replay bound.** Suggestion 5b makes an attester's worst case $16\,c_{\max}$ per slot, $2^{24}$ gas at the candidate value: about 270 ms of compute at the worst rate we measured, before disk. That needs a pipeline benchmark, and a decision on $c_{\max}$, before either is fixed.
- **Disk.** Experiment 26 read state from memory. The state half of suggestion 9 needs a cold read from disk, which is where state becomes the binding resource, above about 34 $\mu$s per slot.
- **A funded run on frames-devnet-0, and frames-devnet-1** (EIP-8250 and EIP-8272 across clients). Every shape spamoor does not send, including both paymasters of experiment 24 and the execution digest of experiment 27, read back from four clients.
- **Review of the ERC draft**, and whether a protocol execution hash is ever warranted: for RPCs that must show the operation's identity, or for EOAs that want execution-only signatures without a contract.

Every number above has a branch, a README, a command and a transaction hash behind it in [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames). Corrections are very welcome, especially from the EIP authors where we have read intent into text that does not state it.
