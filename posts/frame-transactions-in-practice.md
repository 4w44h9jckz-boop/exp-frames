# Frame Transactions in Practice: 22 Experiments on EIP-8141, Four Clients, and What We Would Change

## TLDR;

We took [EIP-8141 frame transactions](https://eips.ethereum.org/EIPS/eip-8141) at their word: *anything that uses ERC-4337 today should be expressible as a frame transaction*. So we built it, and measured it. We ran 21 experiments on the ethrex Hegota testnet, which runs EIP-8141 together with [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250) keyed nonces and [EIP-8272](https://eips.ethereum.org/EIPS/eip-8272) recent roots. They cover:
- the EIP's own examples;
- multisig and threshold (FROST) wallets;
- passkey, session-key, social-recovery, modular, EIP-7702 and post-quantum accounts;
- paymasters;
- a privacy pool that is its own sender;
- an ERC-4337 side-by-side.

A 22nd experiment probed four execution clients (geth, Nethermind, reth, ethrex) on ethpandaops' frames-devnet-0. Every mined transaction is kept as a test fixture. The wallet-facing parts are ported to Rust in a fork of the kohaku wallet reference implementation, and the two implementations check each other's transactions byte for byte.

The short version of the results:
- **Frames work, and are cheaper.** Every ERC-4337 use case we tried ports. A token transfer costs 48,435 gas against 116,735 through EntryPoint v0.8, 2.41 times less. The 54.8M gas of EntryPoint state, the bundler and the deposits are simply gone.
- **A privacy-pool withdrawal needs no signature, no relayer and no paymaster.** The pool is `tx.sender`, and its VERIFY frame checks the Groth16 proof. With the nullifier as an EIP-8250 nonce key and the root in an EIP-8272 frame, VERIFY reads no storage, and three withdrawals from the same sender landed in one block. But its VERIFY frame costs 245k to 249k gas, against the EIP's 100k `MAX_VERIFY_GAS`.
- **The four clients agree on the chain and disagree at the door.** On 50 of 50 heights they agree on hash, state root and receipts root, and 2,000 frame transactions built by all four re-encode, recover and settle under our independent implementation. That traffic covers 5 transaction shapes, none of them sponsored. At admission the clients use three values of `MAX_VERIFY_GAS` (100k, 300k, 500k), three orders of checks, and 21 of the 39 transaction JSON fields they serve are not served by all four.

What we would change, each argued below with its cost and the easier fix we are *not* proposing:
1. Allow `TIMESTAMP` only in a top-level expiry verifier frame. The current text also admits a call into the verifier from any VERIFY frame. That reading, which a client ships today, re-opens the EIP's own example DoS attack. If a not-before bound is wanted, put it in the expiry frame's data.
2. Meter the validation prefix in two dimensions, state access and pure computation, instead of moving the `MAX_VERIFY_GAS` floor. The workloads over 100k are privacy proofs, post-quantum signatures and large signer sets, and none of them reads much state.
3. Give a frame rolled back with its atomic batch its own status. Today it reports `SUCCESS` in every client while its logs and state are gone.
4. Choose new signature schemes by what only the protocol can do with them: aggregation and pre-execution validation. Start with BIP-340 Schnorr. Keep WebAuthn in the EVM.
5. Do not widen default code to new schemes without a key-rotation path.
6. Denominate `MAX_VERIFY_STATE_GAS` in state bytes.
7. Fix the order of the admission checks, and give admission errors structured reasons.

> Experiments, one branch each, with READMEs, scripts, contracts and mined fixtures: [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames) (start at the [tooling README](https://github.com/4w44h9jckz-boop/exp-frames/tree/tooling))
> Rust wallet ports (`kohaku-frame-kit`, `kohaku-frame-accounts`, `kohaku-frame-pool`): [kohaku-rs, branch `experiment/frames`](https://github.com/4w44h9jckz-boop/kohaku-rs/tree/experiment/frames)
> Related reading: Nero_eth, [Frame transactions and the three gates to privacy](https://ethresear.ch/t/frame-transactions-and-the-three-gates-to-privacy/24666)

## Introduction

A frame transaction (type `0x06`) replaces "one signature, one call" with:
- a `sender`, a nonce and fees;
- a list of signature entries `[scheme, signer, msg, signature]`, which the protocol validates before any EVM code runs (`SECP256K1`, `P256`), or leaves to the EVM (`ARBITRARY`);
- a list of frames. Each frame has a mode, a target, `[execution, state]` gas limits, flags and data:
  - `VERIFY` frames run read-only and may call `APPROVE` to accept execution (only on `tx.sender`), payment, or both;
  - `SENDER` frames run as the sender, once execution is approved;
  - `DEFAULT` frames run as the entry point `0xaa`, for deploys and post-ops.

A code-less account gets *default code*: it approves when the transaction carries a `SECP256K1` entry over the signature hash by the account's own key. A contract account brings its own VERIFY logic, and reads the rest of the transaction with introspection opcodes:
- `TXPARAM` and `FRAMEPARAM` for transaction and frame fields;
- `FRAMEDATALOAD` and `FRAMEDATACOPY` for other frames' data;
- `SIGPARAM` and `SIGDATACOPY` for signature entries.

Frames can be grouped into atomic batches, and each frame gets its own receipt.

```
 FRAME TX (type 0x06)   sender = S   nonce   fees   signatures = [[scheme, signer, msg, sig], ...]
 ------------------------------------------------------------------------------------------
 [0] VERIFY  -> S          APPROVE(EXECUTION)          \  validation prefix:
 [1] VERIFY  -> sponsor    APPROVE(PAYMENT)             |  simulated by every mempool node,
                                                        /  bounded by MAX_VERIFY_GAS
 [2] SENDER  -> token      approve(dex, x)     caller = S     \ atomic batch:
 [3] SENDER  -> dex        swap(x)             caller = S     / [2] is undone if [3] fails
 [4] DEFAULT -> sponsor    post_op()           caller = 0xaa  reads [2..3] via FRAMEPARAM
 ------------------------------------------------------------------------------------------
 receipt: payer, and per frame [status in {FAILURE, SUCCESS, SKIPPED}, gas_used, logs]
```

The public mempool admits a transaction only if its *validation prefix* (the leading VERIFY frames, and an optional deploy frame) is cheap and robust to simulate:
- it is bounded by `MAX_VERIFY_GAS` = 100,000 execution gas, signature validation included, and `MAX_VERIFY_STATE_GAS` = 500,000 state gas;
- it may read only the sender's storage;
- it may not use environment opcodes such as `TIMESTAMP`, `NUMBER` or `GAS` (except `GAS` right before a call);
- one transaction may be pending per sender.

Payers other than the sender are rationed:
- a non-canonical paymaster may have one pending transaction;
- the *canonical paymaster*, recognized by its runtime code hash, has its reservations tracked like a balance.

Three companion EIPs matter here:
- [EIP-8037](https://eips.ethereum.org/EIPS/eip-8037) meters state growth as a second gas dimension. With `CPSB` = 1,530 gas per state byte, a new account costs 183,600 state gas and a new storage slot 97,920.
- [EIP-7976](https://eips.ethereum.org/EIPS/eip-7976) floors every transaction at 64 gas per data byte. Signature entries count as data.
- EIP-8250 and EIP-8272 add keyed nonces and recent roots, which frames-devnet-1 is about to ship.

### Why build it

The EIP's motivation is that account abstraction belongs in the protocol, and that most of what an ERC-4337 bundle does is a list of frames. We took that literally. The repository's guiding rule was "anything that uses ERC-4337 today is a candidate experiment": port it, mine it, measure what changes. We also asked what frames can do that ERC-4337 cannot. That led to the privacy pool, protocol-validated signatures as a service, and cross-frame introspection.

### Setup

| Network | Clients | Spec | Used for |
|---|---|---|---|
| ethrex Hegota testnet (chain 8141) | ethrex `v23.0.0-hegota-testnet-hotfix-4738681` | EIP-8141 @ `b75cbe61` + EIP-8250 + EIP-8272, on Amsterdam gas (EIP-8037 state gas, cold account access 3,000). Its `MAX_VERIFY_GAS` is a node flag set to 500,000 | experiments 01 to 21 |
| ethpandaops frames-devnet-0 | geth, Nethermind, reth, ethrex behind one balancer | EIP-8141 @ `b75cbe61` alone (7-field envelope) | experiment 22 |

Methodology-wise:
- **One branch per experiment.** Each has a README of results, the scripts, and every mined transaction as a fixture. The fixtures pin the encoder, the signature hash and the gas model offline: 171 mined transactions across the branches.
- **A second implementation.** The TypeScript library was ported to Rust in kohaku-rs (`kohaku-frame-kit`, `kohaku-frame-accounts`, `kohaku-frame-pool`). Its tests rebuild 41 of the mined transactions byte for byte or frame for frame, and it sent experiments 01 to 05 and a privacy-pool withdrawal again from Rust alone.
- **Caveats.** Experiments 01 to 21 ran on one client, so their numbers are ethrex's. The testnet's 500k cap is what let the heavy experiments run at all. Gas numbers are for the Amsterdam schedule and will move with repricings.

## What we built, and what it cost

| # | Experiment | Headline number |
|---|---|---|
| 01 | ETH transfer, deploy, probes | 26,102 gas, calldata-floor bound: the 65-byte signature is priced as data, which a type-2 transaction does not pay |
| 02 | Account deployed at `tx.sender` in its own first transaction | 77-byte account, VERIFY 288 via `SIGPARAM` |
| 03 | Atomic approve + swap | a rolled-back frame keeps `SUCCESS`; approve + exact swap nets 0 state gas |
| 04 | ERC-20 gas sponsor with exact refund | a front-run costs the sponsor 218,760 gas |
| 05 | k-of-n multisig, secp256k1 and P256 owners | VERIFY 1,129 for 2 signers; a self-deployed account is capped at 206 bytes of code |
| 06 | Privacy pool as its own sender | VERIFY 244,808 to 248,991; three withdrawals from one sender in one block |
| 07 | 2-of-3 FROST group key | 26,794 per transfer for any threshold, against 35,622 for 05's 2-of-3 |
| 08 | Multisig operations | a fee bump needs all k signers again; a counterfactual proxy verifies in 4,262 |
| 09 | Canonical paymaster ([PR-12041](https://github.com/ethereum/EIPs/pull/12041)) and others | four users in one block through one instance; a copy one byte longer is refused |
| 10 | Expiry verifier frame | 3,051 gas (3,050 halts); deadlines are inclusive |
| 11 | Passkeys: raw P256 and WebAuthn | VERIFY 288 / 35,314 per transfer; VERIFY 15,542 / 41,444 |
| 12-14 | Session keys, social recovery, modular account | +21,600, +2,100, +5,300 gas per transaction |
| 15-16 | EIP-7702-delegated sender, subscriptions | both work in the public mempool |
| 17 | Post-quantum account (WOTS under a Merkle root) | 73,481 against 27,382 for ECDSA; `MAX_VERIFY_GAS` decides the Winternitz parameter |
| 18 | Introspection, every word from every mode | 731 words match a model of the EIP |
| 19 | Mempool rules, probed one at a time | `TIMESTAMP` through a nested call: see suggestion 1 |
| 20 | Protocol-validated signatures as a service | 10,288 per signature against 5,603 for `ecrecover` |
| 21 | ERC-4337 v0.8 side by side | 116,735 against 48,435, 2.41 times |
| 22 | Four clients on frames-devnet-0 | see the next part |

The rest of this part follows the numbers by theme. The privacy pool gets its own section.

### Gas-wise: frames against ERC-4337

The same ERC-20 transfer cost 116,735 through the reference ERC-4337 account and 48,435 through a frame account ([21](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/21-erc4337-side-by-side/experiments/21-erc4337-side-by-side)). The frame account costs 5,446 over a type-2 transaction; the ERC-4337 account costs 73,746 over it.

On a state-gas schedule the gap grows on first use. The EntryPoint's nonce and deposit slots are a per-sender entry fee of 195,840 that a frame sender never pays. The EntryPoint's own accounting drifts too: it fixes `actualGas` before the deposit slot is created, so it under-charged by about 80,000 on first use. Our bundler lost 121,482 gas over four operations, confirmed to the wei. And the infrastructure costs 54.8M gas of state (the npm build of EntryPoint v0.8 is 21,738 bytes) before the first operation. The frame rail needs nothing deployed.

The one thing frames price that legacy transactions do not is signature bytes. An ETH transfer from a default-code account costs 26,102, because its 65-byte signature entry sits under EIP-7976's floor at 64 gas per byte ([01](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/01-simple-tx/experiments/01-simple-tx)). We come back to why that is right.

### Signature-wise: who checks what

Protocol-validated entries are checked once, before execution, and contracts read only their metadata through `SIGPARAM`: the resolved signer, the scheme and `msg`. That made several things easy:
- a 77-byte self-deploying account verifies in 288 gas ([02](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/02-account-deployment/experiments/02-account-deployment));
- a k-of-n multisig counts distinct entries in 1,129 gas for two signers ([05](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/05-multisig/experiments/05-multisig));
- a P256 key signs through the protocol scheme with a VERIFY of 288 ([11](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/11-passkey/experiments/11-passkey)).

Three findings were less expected.

**Signatures as a service cost more, not less.** We had any contract accept "signer X signed digest D" by reading an explicit-`msg` entry with `SIGPARAM`, in place of `ecrecover` or `P256VERIFY` ([20](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/20-signature-service/experiments/20-signature-service)). It works. Each further signature cost:
- 10,288 gas against 5,603 for `ecrecover`;
- 18,220 gas against 11,267 for `P256VERIFY`.

The entry carries its signer (20 bytes) and digest (32 bytes) as well as the signature, and the floor prices every byte, while the EVM path recovers the signer and recomputes the digest. What the service buys is one code path for every present and future scheme, and holders that are only keys: a P256 address with no code and no ETH held and traded tokens.

**An explicit-digest entry is a bearer instrument.** The protocol checks that alice signed the digest, not that she agreed to the transaction it travels in. In [20](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/20-signature-service/experiments/20-signature-service) a third party lifted alice's entries from a pending transaction and filled her order herself. Only fields inside the digest protect the signer: a taker, a nonce, a deadline. This is EIP-712's rule again; what changes is that the entries cross the public mempool in the clear.

**The validation budget counts every entry.** Signature validation counts against `MAX_VERIFY_GAS` whether or not a frame reads the entry. With a 20k VERIFY, 100k admits 27 secp256k1 co-signers, or 11 P256 ones.

### Account-wise: what ported, and what bent

| Account | VERIFY gas | Transfer total | What bent |
|---|---|---|---|
| default-code EOA | 100 | 26,102 | nothing |
| 2-of-3 multisig (05) | 1,129 | 35,622 | a self-deployed account fits in 206 bytes of code under `MAX_VERIFY_STATE_GAS`, so counterfactual multisigs need a proxy (08: VERIFY 4,262, a cold `DELEGATECALL`) |
| 2-of-3 FROST (07) | 3,864 | 26,794 | the Schnorr signature is `ARBITRARY`, so it cannot sign for the canonical paymaster or a `SIGPARAM` service |
| P256 key (11) | 288 | 35,314 | default code accepts `SECP256K1` only, so a P256 key's own address cannot send |
| WebAuthn passkey (11) | 15,542 | 41,444 | the 783-byte account needs 1,381,590 state gas to self-deploy, over the 500k cap |
| WOTS, n16-w16 (17) | 39,659 | 73,481 | the floor (66,474) prices the 738-byte signature; verification hides under it |
| WOTS, n16-w256 (17) | 97,315 ground, 230,410 not | 126,809 | the work fits 100k only after $2^{18.7}$ tries of grinding |

Account-wise, the features that ERC-4337 accounts build ported with small overheads:
- session keys checked frame by frame, about 21,600 gas per transaction over the owner's own ([12](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/12-session-keys/experiments/12-session-keys));
- a rotatable owner with delayed guardian recovery, about 2,100 ([13](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/13-social-recovery/experiments/13-social-recovery));
- ERC-7579-style validator modules, about 5,300 ([14](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/14-modular-account/experiments/14-modular-account));
- an EIP-7702-delegated EOA as sender ([15](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/15-eip7702-sender/experiments/15-eip7702-sender));
- pull subscriptions on the merchant's own nonce key ([16](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/16-subscriptions/experiments/16-subscriptions)).

The places where it bent were time, state and schemes.

Time: VERIFY can bound time only from above, through the expiry frame. Recovery delays, subscription periods and session start times all wanted a lower bound. Experiment 19 found that ethrex provides one, by a reading of the EIP we argue against in suggestion 1.

State: `MAX_VERIFY_STATE_GAS` caps what a counterfactual account may deploy in its own first transaction. The cap is 206 bytes for a new account, or 326 if prefunded.

Schemes: everything that is not secp256k1 or P256 ECDSA lives in `ARBITRARY`. The post-quantum account showed what that means under the floor. Halving the hash length took the signature from 2,498 to 738 bytes and the transaction from 179,114 to 73,481 gas. At that point the work and the bytes cost about the same. And `MAX_VERIFY_GAS` picked the Winternitz parameter for us: $w = 256$ needs about 2,300 hash steps (200k gas or more) for a random digest. It fits 100k only by grinding the randomizer until the verification work is small: $2^{18.7}$ tries on average.

Key-and-nonce-wise, the post-quantum account showed something pleasant. The chain keeps the stateful scheme's counter, because the nonce selects the one-time key, so a restored backup cannot sign twice for the same nonce. What remains is signing twice *within* one nonce, for a fee bump or a re-sign after a crash. Fees are inside the signature hash, so every bump spends a key: we allot 4 keys per nonce. Simulation is publication: `eth_estimateGas`, simulation and submission all reveal the signature, so each spends a key.

### Sponsor-wise: who pays

Sponsor-wise, the experiments covered every tier the EIP defines ([04](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/04-sponsored-erc20/experiments/04-sponsored-erc20), [09](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/09-paymasters/experiments/09-paymasters)).
- **A code-less EOA sponsor** co-signs through its own default code; its VERIFY frame costs 3,000 gas, all of it cold account access. ethrex caps such a payer at one pending transaction, like a non-canonical paymaster. The EIP exempts it.
- **An ERC-20 sponsor** paid in tokens refunds exactly in a post-op that reads the earlier frames' gas. It cannot see token balances during VERIFY, which may read only the sender's storage. So a sender who empties their wallet first makes the sponsor eat 218,760 gas (simulated), 183,600 of it for creating the sender's account. This is the EIP's own front-running note, measured.
- **The canonical paymaster** of PR-12041 is a *verifying* paymaster: its signer co-signs each signature hash through `SIGPARAM`, with any non-`ARBITRARY` scheme. It served four users in one block from one instance, and it answers the ERC-20 sponsor's problem: a sponsor that cannot check a balance can decline to sign. Recognition is by code hash alone. A copy one unreachable byte longer fell under the generic trace rules, and there its read of its own signer slot is refused outright.

### Receipt-wise: success that did not persist

Receipt-wise, there is a gap. When an atomic batch fails, the frames that completed before the failing one are rolled back:
- their logs disappear;
- their state gas is refilled;
- their `status` stays `SUCCESS`.

A later frame reading them with `FRAMEPARAM(0x05)` sees success too ([03](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/03-atomic-batch/experiments/03-atomic-batch), [18](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/18-introspection/experiments/18-introspection)). ethrex's simulation RPC reports such a frame as `succeeded: true`. On frames-devnet-0, transaction `0x13dcebcf…` (block 99,563) has this shape:

```
 frames:   [0] VERIFY flags=3   [1] SENDER flags=4   [2] SENDER flags=4   [3] SENDER flags=0
 status:        1                    1 (3,000 gas)        0                    2
 meaning:   approved               ROLLED BACK          failed               skipped
```

All four clients serve frame 1 as status 1, as the EIP specifies.

## A privacy pool that is its own sender

The design is Nero_eth's, from *the three gates to privacy*. A Tornado-style pool is `tx.sender` of its own withdrawals, and its VERIFY frame checks the proof. The proof is the authorization: no signature appears anywhere in the transaction. We built it on Tornado's unchanged circuit, notes, trusted setup and Groth16 verifier, with proofs from kohaku-rs ([06](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/06-privacy-pool/experiments/06-privacy-pool)). We also built a second variant that uses EIP-8250 and EIP-8272 so that VERIFY reads no storage at all:

```
 KEYED POOL WITHDRAWAL     tx.sender = POOL   nonce_keys = [nullifierHash]   nonce_seq = 0   signatures = []
 -----------------------------------------------------------------------------------------------------
 [0] VERIFY -> 0x..8272   (source, slot, root)              protocol: root committed within 8,191 slots
 [1] VERIFY -> POOL       APPROVE(EXECUTION_AND_PAYMENT)    pool: exact layout, gas floors on [2],
                                                                  fee >= max_cost, Groth16(proof)
 [2] SENDER -> POOL       withdraw(proof, root, nf, recipient, relayer = POOL, fee)   caller = POOL
 -----------------------------------------------------------------------------------------------------
 double spend : same nf -> same nonce key -> a replacement, never a second spend   (protocol)
 seq check    : nonce_seq == 0, else a spent note passes the nonce check           (pool, today)
 who pays     : the pool, out of the note's fee; no relayer, no paymaster, no EOA
```

| Layout | VERIFY gas | Pending withdrawals per pool |
|---|---|---|
| storage (roots and nullifiers in pool storage), pool pays | 248,982 | one: every withdrawal shares a sender, and the prefix reads its storage |
| storage, sponsor pays | 248,991 | one |
| keyed (nullifier = nonce key, EIP-8272 root), pool pays | 244,808 | many: three from one sender landed in block 304,240 |
| keyed, sponsor pays | 244,817 | one per sponsor: the sponsor is a non-canonical paymaster |

Privacy-wise, several things come out of this.

**Concurrency is a property of what VERIFY reads.** In the storage design all users share one pending slot. A second withdrawal on the same nonce at double the fee *evicted the first user's withdrawal* from the pool. In the keyed design the prefix reads no sender storage, and ethrex then admits withdrawals on disjoint keys side by side. That is the condition [PR-12039](https://github.com/ethereum/EIPs/pull/12039) proposes for EIP-8250's mempool. A sponsor brings the bottleneck back, so the layout that scales is the one where the pool pays from the note's fee.

**The protocol's nonce check is not a nullifier check, yet.** A spent note sent with `nonce_seq = 1` passes the protocol's check, and only the pool's own `nonce_seq == 0` stops it being paid twice. [PR-12352](https://github.com/ethereum/EIPs/pull/12352)'s binary nonce type makes "unused or spent" a protocol property. Its rule that a single-use application MUST authenticate the full key set, and not only the first key, is one our pool already enforces by hand: a second nonce key besides the nullifier is refused, since payment approval would consume it too.

**How roots are kept decides which deposits invalidate pending withdrawals.**
- **Ring buffer** (Tornado keeps 30 roots): a pending proof turned invalid with no change of its own once enough deposits rotated its root out. Each older probe also costs 2,213 gas.
- **Append-only roots**: never invalidated.
- **EIP-8272 roots**: they expire by time, after 8,191 slots. But the predeploy keeps one root per source per slot, so a wallet must prove against the last root of a slot.

**No stock verifier passes admission.** Tornado's verifier and snarkjs's current template call the pairing precompiles with `staticcall(sub(gas(), 2000), ...)`. A `GAS` not followed by a call is banned in a validation trace. The fix is five bytes (`PUSH0 POP PUSH0 POP GAS`, forwarding all gas), and the failure appears only at mempool admission, never in a block or an `eth_call`.

**Groth16 does not fit the EIP's budget.** VERIFY is 245k to 249k gas, almost all of it 6 `ecMul`, 6 `ecAdd` and one 4-pair pairing. That is under the testnet's 500k and two and a half times the EIP's 100k. At 100k the node does not even report out-of-gas. The verifier executes `INVALID` when a precompile call fails, and `INVALID` is banned.

**Nothing binds the envelope but the pool.** With no signature, anyone holding a pending withdrawal can resubmit it with other fees, limits or frames. The proof binds recipient, relayer and fee. VERIFY must bind everything else: the exact layout, floors on the withdrawal frame's gas (so nobody can starve it after approval), `fee >= max_cost`, and in the keyed design the nonce key and sequence.

Chain-data-wise, an observer sees Tornado's withdrawal minus the relayer: the pool as sender and payer, plus the proof's public inputs. In the keyed design the nullifier hash appears a second time, as the nonce key. That reveals nothing new, but it is now permanent protocol state: one `NONCE_MANAGER` slot per spent note, 97,920 state gas each.

Against the three gates:
- **Mempool admission** passes on a 500k node and fails on a 100k one, and concurrency needs the keyed design.
- **FOCIL** we could not exercise.
- **Node capability** is the subject of the next part.

## Four clients, one chain

frames-devnet-0 runs geth, Nethermind, reth and ethrex behind one eRPC balancer, which can pin a request to one client ([22](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/22-cross-client/experiments/22-cross-client)). A measurement trap first: eRPC merges identical requests that are in flight together and answers all of them from whichever upstream served the first. Four concurrent pinned requests came back from one node, which would have made a cross-client comparison compare a client with itself. Our client now refuses an answer whose `x-erpc-upstream` header names another node, and asks the clients one at a time.

Our test account has no funds there (the faucet needs a human), so we asked what four clients can be asked without spending anything.

**Consensus-wise, they agree.**
- At 50 of 50 consecutive heights, the four served the same block hash, state root and receipts root.
- In 200 blocks the four built 48 to 55 blocks each. All 2,000 frame transactions in them re-encode to their hash under our implementation, every secp256k1 entry recovers over our signature hash, and every receipt's `gasUsed` equals our settlement of its frame receipts.

The coverage is narrower than the counts suggest. All 2,000 transactions are spamoor's `frametx` scenario in 5 shapes, every one self-relayed secp256k1. There was no sponsor or paymaster, no P256, `ARBITRARY` or explicit `msg`, no `DEFAULT` frame, no contract account or introspection, no state gas and no blob. Everything experiments 02 to 21 exercised has so far run on one client.

**Admission-wise, they do not.** We sent 49 probes, each breaking one rule, to each client, at a fee nobody can pay and again at zero fee. The table shows the probes on which the clients diverge:

| Probe | geth | Nethermind | reth | ethrex |
|---|---|---|---|---|
| any frame rule, unfunded sender | `insufficient funds` before any frame rule | the rule | the rule | the rule |
| one-frame cancel, `max_gas` 19,435 (valid for a funded EOA) | refused: 24,000 gas floor | funds | funds | funds |
| a blob-carrying frame transaction | refused: type not supported | refused for its malformed hash | refused for its malformed hash | refused for its malformed hash |
| validation prefix of 150,000 | funds | **funds: within its cap** | `MAX_VERIFY_GAS` | `MAX_VERIFY_GAS` |
| prefix state budget 600,000 | funds | the cap | the cap | reaches simulation |
| execution over EIP-7825's cap | funds | the cap | the cap | reaches simulation |
| wrong signature on an entry no frame reads | funds | signature | "prefix execution failed" | signature |
| zero-fee sponsored transaction | min tip | **accepted, and held** | prefix failed | min tip |

Bisecting each client's caps gave three values of one constant. `MAX_VERIFY_GAS` is 100,000 on reth and ethrex, 300,000 on Nethermind, and 500,000 on ethrex's Hegota build. `MAX_VERIFY_STATE_GAS` is 500,000 on Nethermind and reth. ethrex's devnet build enforces none before simulation, up to 16M.

Error-wise, "the validation prefix reverted" covers too much. An unfunded payer, an unbudgeted new-account charge (183,600 state gas, charged to whichever frame approves payment) and a missing signature entry come back identically from three clients, and reth adds wrong signatures and passed deadlines to the list. A wallet cannot tell "fund this account" from "budget account creation" from "sign entry 0".

JSON-wise, the transaction object has 39 fields across the four clients, and 21 are not served by all four:
- a frame's execution limit is `executionGas`, `executionGasLimit` or `gasLimit`;
- an absent signer is `"0x"`, omitted or `null`;
- reth's receipt `to` is the sender.

`gas` is the one that bites. geth serves `max_gas` (51,790), Nethermind the sum of frame limits (35,000), and reth and ethrex omit it. A wallet that bounds a fee as `gas * maxFeePerGas` gets two answers. [execution-apis PR-860](https://github.com/ethereum/execution-apis/pull/860) and [PR-907](https://github.com/ethereum/execution-apis/pull/907) are where these get settled.

## Insights

**1. `MAX_VERIFY_GAS` is a cryptography policy, whether or not it means to be one.** Everything ordinary fits with room to spare. What does not fit is a Groth16 privacy proof, a post-quantum signature at the parameter that minimizes its bytes, and a signer set of more than about 27 keys: the things privacy and post-quantum security need most.

```
 validation work: VERIFY frames + signature validation (1 # = 10k gas)

                                        0         100k                300k                500k
                                                  EIP, reth,          Nethermind          ethrex
                                                  ethrex                                  Hegota
 default-code EOA                 2,900 |#        |                   |                   |
 FROST 2-of-3                     3,964 |#        |                   |                   |
 multisig, 2 of 3 keys            6,729 |#        |                   |                   |
 WebAuthn passkey                15,642 |#        |                   |                   |
 WOTS n16-w16                    39,759 |###      |                   |                   |
 WOTS w=256, ground              97,415 |#########|                   |                   |
 40-key multisig              > 112,000 |#########|#                  |                   |
 WOTS w=256, as is              230,510 |#########|#############      |                   |
 Groth16 pool           248,982-250,387 |#########|###############    |                   |
```

**2. Concurrency, and therefore throughput for shared senders, is decided by what VERIFY reads.** The storage-design pool serializes all its users and lets them evict each other. The keyed design runs them concurrently. A non-canonical payer re-serializes everything it pays for. The protocol's tools for getting shared state out of VERIFY (keyed nonces, recent roots, protocol-validated signatures, the canonical paymaster) are the tools that make shared senders work, and each was needed by at least one of our experiments.

**3. Recognition by exact code hash is brittle; recognition by decidable property generalizes it.** One unreachable byte demoted a canonical paymaster copy from "many pending" to "refused". [PR-12328](https://github.com/ethereum/EIPs/pull/12328)'s egress-decidable paymaster decides the property that the code hash stood for. The same is true of the expiry verifier, whose recognition is where suggestion 1's ambiguity lives.

**4. Under the calldata floor, bytes price signatures, not verification.**
- WOTS verification hides under its own floor.
- Signatures as a service lose to `ecrecover` on bytes, not compute.
- A type-2 transaction gets 65 signature bytes for free that a frame transaction pays 4,160 gas for.

Moving a scheme into the protocol therefore saves little gas per transaction. What the protocol can do and the EVM cannot is *remove bytes*, by aggregation, and only for entries whose bytes the EVM cannot see.

**5. Clients agree on blocks and diverge at the door, and the door is where the EIP is underdetermined.** Block validity is specified as executable pseudocode, and four clients converge on it. Admission is specified as rules plus a Security Considerations section, and three orders, three caps and four error vocabularies came out. Most of the user-visible behaviour of frames is admission behaviour: whether a sponsored or private transaction propagates at all.

## Suggestions

For each: what we saw, what we suggest, what it costs, and the obvious fix we are *not* suggesting and why.

### 1. `TIMESTAMP` only in a top-level expiry verifier frame; a not-before bound, if wanted, in its data

**What we saw.** The EIP defines an expiry verifier frame as "a `VERIFY` frame whose `frame.target` equals `EXPIRY_VERIFIER`". Two sentences then disagree about where `TIMESTAMP` is allowed:
- the opcode list allows it "in an expiry verifier frame executing the canonical runtime code", a frame-level rule;
- the mempool section allows it "when executing the canonical expiry verifier runtime code at `EXPIRY_VERIFIER`", a code-level rule.

ethrex's Hegota build implements the code-level reading on purpose, at any call depth ([19](https://github.com/4w44h9jckz-boop/exp-frames/tree/exp/19-mempool-rules/experiments/19-mempool-rules), probes 29 and 30). So an account's own VERIFY can `STATICCALL` the verifier:
- requiring success gives it a deadline;
- requiring a revert gives it a not-before.

We mined the second: refused before its time, included after.

The hidden deadline is the EIP's own example attack. N pending transactions all call the verifier with deadline T, and at T all become invalid with no on-chain action. The node cannot see them coming. Its dependency set has "the block timestamp as read by an expiry verifier frame", and its drop rule looks at an expiry frame's deadline. [PR-12213](https://github.com/ethereum/EIPs/pull/12213) bounds what a block producer wastes on them afterwards; nothing stops the pool holding and gossiping them until then.

**Suggestion.** (a) State the frame-level rule in both places: `TIMESTAMP` is permitted only while executing a frame whose `frame.target` is `EXPIRY_VERIFIER`, and anywhere else in the validation prefix it is banned, including inside a call to `EXPIRY_VERIFIER`. (b) Separately, consider making the useful half explicit. The expiry frame's data could be 8 bytes (`not_after`) or 16 bytes (`not_before || not_after`), with admission refusing a transaction whose `not_before` the next block cannot meet.

A not-before only turns invalid into valid, so it creates no invalidation fan-out, no future queue and no new dependency. It gives frames the `validAfter` that ERC-4337 has and that our recovery delay (13), subscription (16) and session-key (12) experiments each worked around.

**Cost.** (a) costs a frame-index check in one client. (b) changes the verifier's runtime, and therefore its recognized code hash. With [PR-12387](https://github.com/ethereum/EIPs/pull/12387) deploying the verifier keylessly at a fixed address, the data format should be settled before that deployment. Otherwise a second verifier lives at a second address.

**Not suggested:** allowing `TIMESTAMP` in VERIFY generally, or keeping the code-level reading because it yields `validAfter`. Both readmit the attack the rule exists to stop.

### 2. Meter the validation prefix in two dimensions instead of moving the floor

**What we saw.** Insight 1's picture, and three deployed values of the constant. [PR-12301](https://github.com/ethereum/EIPs/pull/12301) makes 100k a propagation *floor*, derived from the weakest node profile. A node MAY admit more as local headroom, so heavier transactions diffuse through fewer nodes, "a natural gradient rather than a cutoff". That is an honest description of what frames-devnet-0 already does: Nethermind is a 300k-headroom node.

It also means that a Groth16 withdrawal, an unground $w = 256$ signature and a 40-key multisig propagate only through headroom nodes. Under FOCIL an includer lists what its own mempool holds. So the transactions with the most to lose from censorship would get the least of the inclusion-list guarantee.

**Not suggested: raising the floor to 250k or 500k.** That raises the worst case of *every* prefix. 250k of cold storage reads is about 119 `SLOAD`s from the sender's storage. That is the work the weakest node can least afford, and the work that has to be redone when state changes. PR-12301 itself notes that gas is an imperfect proxy at ingress: "signature checks parallelize across cores, cold state reads block rather than spin".

**Suggestion.** Split the prefix's work into the two resources it actually consumes, as EIP-8037 split execution from state for blocks:

$$\text{prefix work} = \underbrace{W_{\text{access}}}_{\text{cold account, code and storage accesses}} + \underbrace{W_{\text{compute}}}_{\text{everything else: arithmetic, hashing, memory, precompiles, signature validation}}$$

and bound them separately: $W_{\text{access}} \le$ `MAX_VERIFY_ACCESS_GAS` and $W_{\text{access}} + W_{\text{compute}} \le$ `MAX_VERIFY_GAS`. Each cap is a floor in PR-12301's sense. The access cap stays where the weakest profile's IO puts it, which is today's 100k at most. The total cap comes from a CPU benchmark of the same profile, and would be higher.

A frame declares one execution limit, so rule 6 keeps checking the declared total statically. The access cap is checked on the simulation trace, where the cold surcharges are already visible.

The workloads above split cleanly:

| Workload | $W_{\text{access}}$ | $W_{\text{compute}}$ |
|---|---|---|
| keyed Groth16 pool | a few cold accesses: the verifier's code | ~218k of precompiles at EIP-1108 prices, plus EVM |
| WOTS | the account's own code | hashing |
| a 40-key secp256k1 multisig | none: the owners are in its code | 112,000 of signature validation, plus VERIFY |

Compute is a pure function of the transaction bytes and code hashes that are already tracked dependencies. So it is also the part a node never has to redo on revalidation, and can cache as it caches signature verification today. Access is what revalidation is about.

It also fits where partially stateless nodes are headed: a prefix that is mostly compute is one such a node can validate, provided the code it calls is available to it.

**Cost.**
- A second counter in the tracer that clients already run. The gas schedule already distinguishes cold from warm, so the access counter is the cold surcharges.
- The total cap must come from a benchmark we have not run.
- The ingress attack surface grows with the total cap. The EIP removed ERC-7562's staking and reputation, so per-peer accounting, as for invalid signatures today, is the only defense against a peer that sends many compute-heavy prefixes that fail at the last step. Doubling the total cap doubles the work per hostile message.
- PR-12301's wire-protocol idea of announcing the rule-6 budget would announce two numbers.

**Also considered and not suggested now: proofs as protocol signature schemes** (a Groth16-over-BN254 scheme whose signer metadata is a verifying-key hash). They would be validated before execution, count as intrinsic, and could in principle aggregate. But every proof system would become consensus code forever, and verifying keys would become protocol objects. The two-dimensional budget gets most of the benefit as mempool policy, which is cheaper to get wrong.

### 3. A distinct status for frames rolled back with their batch

**What we saw.** A frame undone by its batch keeps `status = SUCCESS`, in receipts and in `FRAMEPARAM(0x05)`, on all four clients. To learn that it did not persist, a wallet, an indexer or a contract must re-derive it from the batch flags and the later statuses. ethrex's simulation RPC does not: it reports such frames as succeeded.

The receipt is *already* rewritten by the rollback in the other two fields: the logs are dropped and the state gas is refilled. The EIP already accepts that a completed frame's `gas_used.state` changes after completion. Only `status` is left as it was.

**Suggestion.** Add `status = 3`, ROLLED_BACK, for each frame of a failed batch that completed before the failing frame. `FRAMEPARAM(0x05)` returns the current value. No frame inside the batch can observe the change, because the frames after the failing one are skipped; frames after the batch see 3. The transaction-level status that interfaces derive ([PR-12061](https://github.com/ethereum/EIPs/pull/12061)), which execution-apis PR-860 defines as 1 if and only if every frame is 1, is unchanged in effect, since a rolled-back batch always contains a failed frame.

**Cost.** A fourth value in a field that goes into the receipts root, so it should be decided before frames-devnet-1. Consumers that test `status != 0` must learn 3, as they must already learn 2 (SKIPPED).

**Not suggested: marking rolled-back frames FAILURE.** That would conflate "my code failed" with "a later frame's code failed", which is exactly the distinction the batch receipt exists to keep.

### 4. Choose signature schemes by what only the protocol can do with them

**What we saw.** Three schemes now live in `ARBITRARY`:
- FROST/BIP-340 Schnorr, VERIFY 3,864 via the `ecrecover` trick (07);
- WebAuthn, VERIFY 15,542 (11);
- WOTS, VERIFY 39,659 (17).

All of them fit the budget except unground $w = 256$. What `ARBITRARY` costs them is not gas but *standing*. An `ARBITRARY` entry:
- cannot sign for the canonical paymaster (PR-12041 excludes it);
- cannot be read as a signer by a `SIGPARAM` service (`resolved_signer` halts);
- cannot satisfy default code;
- can never be aggregated, because its bytes are introspectable.

And by insight 4, protocol verification saves a post-quantum scheme little: the WOTS floor (66,474) is above its work.

**Suggestion.** Admit schemes to the registry ([PR-12253](https://github.com/ethereum/EIPs/pull/12253)) by what only the protocol can do with them: validate them before any state is read, and remove their bytes by aggregation. On that test:
- **BIP-340 Schnorr over secp256k1 comes first.** Threshold wallets (FROST, MuSig2) become first-class: canonical-paymaster signers, `SIGPARAM`-readable, default-code-eligible if suggestion 5 is ever taken up. Every client already links a secp256k1 library, and half-aggregation of Schnorr signatures is known. Today a threshold group that wants to sponsor must use threshold ECDSA, the harder protocol to run, purely because of the registry.
- **For post-quantum, prefer the scheme with a credible aggregation path over the one that verifies fastest,** because the floor makes bytes the cost. That argues for aligning with the hash-based signatures Ethereum's own post-quantum consensus work aggregates, rather than adding schemes one at a time for verification speed.
- **Keep WebAuthn in the EVM.** A protocol WebAuthn scheme would put `clientDataJSON` parsing, base64url and a browser-defined, evolving format into consensus. 15,542 gas in VERIFY is affordable.

  The narrower problem is real: the `P256` protocol scheme cannot carry a WebAuthn assertion. The assertion's challenge would have to be the signature hash. An explicit `msg` would be $\mathsf{sha256}(\mathsf{authData} \Vert \mathsf{sha256}(\mathsf{clientDataJSON}))$, which depends on the signature hash, which commits to `msg`. We do not suggest breaking that circle, for example by excluding the `msg` of `P256` entries from the signature hash: it would make every such entry a bearer instrument, and buy a few thousand gas.

**Cost.** Each scheme is consensus code forever, and aggregation itself is not yet specified. The point of the test is to spend that cost only where the protocol adds something the EVM cannot.

### 5. Do not widen default code without a key-rotation path

**What we saw.**
- A P256 key's own address cannot send: default code accepts `SECP256K1` only (11).
- The WebAuthn account cannot deploy itself through the public mempool.
- A P256 address can still hold and trade tokens through `SIGPARAM`-aware contracts without ever sending (20).

The tempting fix is to let default code accept any protocol-validated scheme whose resolved signer equals the sender: passkey and post-quantum "EOAs" with no deployment.

**Why we do not suggest it alone.** An address derived from a P256 or post-quantum key could never acquire code:
- EIP-7702 authorizations are secp256k1-only;
- `CREATE2` cannot target a key-derived address;
- EIP-8141's deploy-at-sender works only for counterfactual addresses.

It would be an account that can never rotate its key or add recovery. For a passkey, that is a device-bound or vendor-synced key as the permanent sole owner of funds. It would also fail closed in the ecosystem: `SignatureChecker`-style code treats a code-less address as an `ecrecover` signer, so the account could not use permits. A secp256k1 EOA at least has EIP-7702.

**Suggestion.** If default code widens, pair it with a scheme-generic code-installation authorization: an EIP-7702 equivalent signable by any registry scheme, so that every key-derived address keeps an upgrade path. Until then, the better route for passkeys is the counterfactual account, made cheap by suggestion 6 and by small proxies: 108 or 76 bytes self-deploy for any number of owners, with VERIFY 4,262 (08).

### 6. Denominate `MAX_VERIFY_STATE_GAS` in state bytes

**What we saw.** At `CPSB` = 1,530, 500,000 state gas buys:
- a new account plus 206 bytes of code, or 326 bytes if prefunded;
- or a new account plus two fresh nonce keys (379,440).

The 783-byte WebAuthn account needs 1,381,590. EIP-8037 fixes `CPSB` but says it "can be re-derived in a subsequent EIP" as gas limits rise. A re-derivation upward silently shrinks what this mempool rule admits: at $1.78 \times$ today's `CPSB`, a new sender with one fresh nonce key (281,520 today) no longer fits.

**Suggestion.** The rule's own rationale is bytes ("the cap bounds the state growth admitted through the public mempool"). So write it as `MAX_VERIFY_STATE_BYTES` × `CPSB`, or as named allowances: one account, $k$ nonce keys, $d$ bytes of code. Whether 326 bytes is the right allowance deserves its own discussion, given that state gas is paid for and the block's state budget already bounds growth. The units should be settled first.

**Cost.** It couples a mempool rule to the state accounting's byte counts, which is the coupling the rationale already claims. A change of state tree changes both together.

### 7. One order of admission checks, and reasons that say which check failed

**What we saw.**
- The Security Considerations ask a mempool to "perform all available structural and stateless checks before sender-state access", because a frame transaction *names* its sender rather than recovering it. geth refuses an unfunded transaction for its balance before it checks any frame rule, statically invalid ones included.
- [PR-12321](https://github.com/ethereum/EIPs/pull/12321)'s acceptance order puts the nonce read (step 3) before signature validation (step 7).
- [PR-12091](https://github.com/ethereum/EIPs/pull/12091) says `tx.sender` is not required to hold any balance.

Whether geth's balance check refuses sponsored transactions from empty senders, the main use of sponsorship, needs a funded sponsor to settle. We list it as the first thing to run on devnet-0.

**Suggestion.** Reconcile PR-12321 with the Security Considerations by stating the principle the order follows. A defensible one: decode and static checks, then one bounded read of the named sender's account (cheap, and it filters stale gossip before an expensive post-quantum verification), then signatures, then simulation. In no step is `tx.sender`'s balance an admission condition. Contract senders carry no protocol signature at all, so "signatures before state" cannot be universal and should not be written as if it were.

In execution-apis:
- give frame admission failures a small enum of reasons: payer unfunded, account-creation state budget, signature invalid (with its index), prefix did not approve, each cap;
- define `gas` for type `0x06`, or drop it;
- mirror the EIP's field names.

The simulation method of [execution-apis PR-894](https://github.com/ethereum/execution-apis/pull/894) takes only a signed envelope. A one-time-signature wallet spends a key per estimate (17), so an estimate mode for unsigned prefixes would serve it.

**Cost.** An enum is a commitment that client errors stay classifiable. A node could also reveal through it a policy it would rather not (its headroom), which PR-12301 already proposes to announce.

### Open PRs our measurements support

- **[PR-12352](https://github.com/ethereum/EIPs/pull/12352), binary nonce type.** It turns our pool's hand-written `nonce_seq == 0` into protocol, and lets partially stateless nodes treat spent nullifiers as write-once.
- **[PR-12039](https://github.com/ethereum/EIPs/pull/12039), keyed mempool concurrency.** Its conditions are exactly what made our keyed pool concurrent, measured on the one client that implements them.
- **[PR-12041](https://github.com/ethereum/EIPs/pull/12041), canonical paymaster through `SIGPARAM`.** It brings scheme agility for every protocol scheme. The Schnorr gap is suggestion 4.
- **[PR-12328](https://github.com/ethereum/EIPs/pull/12328), egress-decidable paymasters**, with a caveat. A sealed sponsor can never withdraw. Our pool's sponsor sweeps fees to its owner with a `CALL`, so it would not qualify. For a pool, the pool-pays layout already scales; the PR matters most for gas tanks that are meant to be one-way.
- **[PR-12109](https://github.com/ethereum/EIPs/pull/12109), no approval inside a batch.** ethrex already enforces it, and experiment 03 shows why: the nonce and fee survive the batch's failure.

## What we would not change

- **Fees inside the signature hash.** Every multisig signer re-signs a fee bump (08), and a one-time-signature account spends a key per bump (17). A fee-free hash would let anyone re-price a self-paid transaction. Accounts that want "signers authorize the intent, one key authorizes the fee" can already do it with explicit-`msg` entries, and wallets can sign fee ladders up front.
- **Signature bytes priced as data.** A discount for signature entries would reopen the per-block data bound that EIP-7976 and EIP-8037's per-dimension comparison protect, and post-quantum signatures are where the bytes will be.
- **Protocol signature bytes hidden from the EVM.** This is what keeps aggregation possible. Services read metadata, which is enough (20).
- **`GAS` only immediately before a call.** The rule is right. Fix the snarkjs verifier template instead: it subtracts 2,000 from the gas it forwards, an idiom that EIP-150's 63/64 rule made unnecessary.
- **No third-party storage in VERIFY,** even though it is what forced the ERC-20 sponsor's front-run risk (04). The answer was a sponsor that signs (09), not a weaker rule.
- **No staking and no reputation.** Code-hash recognition got the canonical paymaster to four users per block with neither, and decidable properties (PR-12328) extend it without either.

## Open questions, and what we run next

- **A funded devnet-0 run.** Every shape spamoor does not send, landed once and read back from four clients. Then: whose balance geth reads for a sponsored transaction; whether reth admits a bad entry no frame reads; whether ethrex admits a transaction over EIP-7825's cap; and whether a 150k prefix sent to Nethermind is gossiped and lands.
- **frames-devnet-1** (EIP-8250 and EIP-8272 across four clients): the keyed privacy pool and the subscriptions experiment, cross-client.
- **The CPU benchmark** that suggestion 2's total cap needs: pairings, keccak chains and signature validation against cold reads, on the weakest profile the floor is meant to protect.
- **The FOCIL gate**, which we did not reach.
- Our 171 mined transactions, one or more of each shape above, are available as cross-client test vectors to whoever is assembling them ([execution-specs discussion #3358](https://github.com/ethereum/execution-specs/discussions/3358)).

Every number above has a branch, a README, a command and a transaction hash behind it in [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames). Corrections are very welcome, especially where a client or the EIP's authors know something about intent that the text does not say.
