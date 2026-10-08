# exp-frames: plan

> **This branch (`plan`) is never merged.** It holds the roadmap, status and working notes.
> Code and write-ups go on mergeable branches.

## Branch model

| Branch | Purpose | Merges into |
|---|---|---|
| `main` | Shared tooling plus every finished experiment | — |
| `plan` | This file: roadmap, status, notes | never |
| `tooling` | The shared frame-tx library (`src/frametx`), scripts, tests | `main` |
| `exp/NN-name` | One experiment: scripts, contracts, `experiments/NN-name/README.md` with results | `main` |

- Branch each experiment from `main` once `tooling` has merged. Until then, stack it on `tooling`.
  Experiments 01–04 are stacked that way. After `tooling` merges with a merge commit, each PR shows
  only its own commits. If `tooling` is squash-merged, rebase the experiment branches onto `main` first.
- Library changes an experiment needs go to `tooling` rather than into the experiment branch. That
  keeps experiment PRs about the experiment. Once `tooling` has merged, use `tooling-<topic>` follow-up
  branches. **Not** `tooling/<topic>`: git cannot hold a branch `tooling` and a branch `tooling/x` at once.
- Each experiment README records: the EIP section it reproduces, how to run it, tx hashes with explorer
  links, per-frame gas, and observations, including any divergence from the spec text.
- Mined txs worth keeping go in `test/fixtures/chain/` via `scripts/capture-fixture.ts`. The tests
  then pin the encoder and gas model to them, offline, so they survive a testnet relaunch. A fixture
  whose tx earned an EIP-3529 refund records it in `meta.refund`, because the RPC does not expose it.
- **Guiding principle (owner, 2026-10-07):** anything that uses ERC-4337 today is a candidate
  experiment here. Port it to frames, then measure what changes.

## Networks

| Network | Chain | Clients | Spec | Use |
|---|---|---|---|---|
| **ethrex Hegotá testnet** | `8141` | ethrex `v23.0.0-hegota-testnet-hotfix-4738681` | 8141@`b75cbe6115` + 8250 + 8272 (8-field envelope) | ✅ everything so far |
| **ethpandaops frames-devnet-0** | `7034189865` | geth, Nethermind (`v2.1.0-unstable+3c210d3c`), reth, ethrex behind one eRPC balancer | 8141@`b75cbe61`, **no 8250** (7-field envelope with a plain `nonce`) | ✅ cross-client probes (22), unfunded; funded runs wait for a human faucet claim |
| ethpandaops frames-devnet-1 | not set yet | geth, Nethermind, reth, ethrex | 8141@`88fa3e4` + 8250 + 8272 + 7906 | 💡 planned launch ~2026-10-15 (tests 10-12) |
| ethrex "Frames" testnet | `81410` | ethrex | 8141 only | 💡 used by the `aa` repo in Sept; liveness unchecked |
| JARDIN demo devnet | `1729` (stated) | ethrex | ? | 💡 `https://demo.eip-8141.ethrex.xyz/rpc`, unverified |
| Local Kurtosis | any | any | any | 💡 for spam/relaunch-heavy work |

### Hegotá (current target)

- RPC `https://rpc1.privacy.ethrex.xyz` (JSON-RPC batch limit 100), explorer `https://dora.privacy.ethrex.xyz`,
  faucet `https://faucet.privacy.ethrex.xyz` (`POST /api/claim {address}`, 1 ETH/hour/address).
- Client: ethrex `hegota-testnet` branch. Network spec: `docs/hegota-testnet-spec.md` in that branch.
  `debug_traceTransaction` is not available.
- Pins: EIP-8141 `b75cbe6115`, EIP-8250 `f3079a09e8`, EIP-8272 `824cbc0b0e`, EIP-7805 `9a345f96c2`,
  EIP-8369 `51dc7b939a`. All on top of Glamsterdam: EIP-8037 two-dimensional gas, EIP-7928 BALs, and
  Amsterdam cold account access of 3,000.
- **A relaunch voids everything.** This is the fourth genesis (2026-09-14). Balances, deployed
  contracts and tx hashes do not carry over. Re-run scripts rather than relying on addresses.

| Topic | Testnet | EIP-8141 master |
|---|---|---|
| Nonce | `nonce_keys, nonce_seq` (EIP-8250) in place of `nonce` | `nonce` |
| Expiry verifier | predeploy at `0x…8141` | keyless deploy at `0x81413f0c…FfFf` |
| Calldata floor | cites EIP-7623; same numbers as master (64 gas per data byte at the floor) | cites EIP-7976 |
| `MAX_VERIFY_GAS` (mempool) | 500,000 (node flag) | 100,000 |
| Mempool concurrency | Measured here: two nonce-key domains per sender, key 0 and every non-zero key. Txs on disjoint non-zero keys wait together (06, 16) when the prefix reads no sender storage (08). A key-0 tx and a keyed one do not, in either order (16), and no nonce gap is queued (10). This is the policy EIP-8250 says a future mempool MAY adopt. `aa`'s one-per-sender finding (2026-09-18) does not hold on this client | one pending tx per sender |
| Code-less payer | capped at one pending tx per payer, like a non-canonical paymaster: `aa` on 81410, confirmed here (09). Only a canonical-paymaster instance, recognised by code hash alone, carries many (09) | exempt from the cap; per-payer exposure rule only |
| `TIMESTAMP` in VERIFY | allowed at any call depth in code at `0x…8141`, so VERIFY can call the expiry verifier and get a lower bound on time (19) | only in a frame whose target is the expiry verifier |
| Recent roots | leading VERIFY frame to `0x…8272` (EIP-8272) | n/a |

ethrex keeps a consensus divergence ledger in `docs/hegota-testnet-divergences.md`. Check it before
relying on an edge case.

### frames-devnet-0

- RPC `https://rpc.frames-devnet-0.ethpandaops.io`. Each request goes to a random client unless it
  is pinned: `X-ERPC-Use-Upstream: *reth*` plus `X-ERPC-Skip-Cache-Read: true` (tooling
  `makeClient(url, 'reth')`). eRPC merges identical requests in flight and answers all of them from
  one upstream whatever each asked for, so a pinned client refuses an answer whose `x-erpc-upstream`
  header names another node (tooling `68929f9`), and cross-client reads go one client at a time.
  `debug_*` and `txpool_*` are blocked. Explorer `https://dora.frames-devnet-0.ethpandaops.io`.
- Faucet `https://faucet.frames-devnet-0.ethpandaops.io`: proof-of-work plus **hCaptcha**, so a human
  must claim. A GitHub login gives 100 ETH a day.
- Tooling (done in `9bcc0d2`; kept for reference):
  - An envelope variant: `0x06 || rlp([chain_id, nonce, sender, frames, signatures, fees, blob_versioned_hashes])`.
    The sig hash follows it, and there is no EIP-8250 nonce calldata in the data cost.
  - `nonce` from `eth_getTransactionCount`.
  - No `ethrex_simulateFrameTransaction` unless the balancer happens to pick an ethrex node, so
    probe for it and fall back to send-and-read-receipt.
  - Cross-check against [spamoor `txtypes/frame.go`](https://github.com/ethpandaops/spamoor/blob/master/txtypes/frame.go)
    (encodes both shapes) and EELS `tests-frames-devnet@v0.3.0` transaction tests.
- Known: geth issue #35783 (frame fields in RPC, receipt status) is still open. Receipts seen on
  2026-10-07 did carry `frameReceipts` and `payer`.

### Traps worth remembering

- secp256k1 signature bytes are `yParity ‖ r ‖ s` with yParity 0/1, never 27/28, and low s.
- `fees` is a nested 3-list and `limits` is a nested `[execution, state]` pair. Older encoders send
  flat fields and get `MalformedData`.
- State growth draws only from `limits.state`. When a frame "runs out of gas" with `stateGasUsed = 0`,
  the missing budget is usually state, not execution. Costs:
  - new account 183,600, charged to the frame whose `APPROVE(PAYMENT)` creates the sender;
  - fresh slot 97,920;
  - code deposit 1,530/byte.
- `ethrex_simulateFrameTransaction`'s `gasUsed` is before the EIP-3529 refund. A skipped frame reads
  `succeeded: false, gasUsed: 0`. A frame rolled back with its batch reads `succeeded: true`.
- A frame rolled back by its atomic batch keeps receipt `status = SUCCESS`: logs and state are gone,
  the status is not. Anything that trusts `FRAMEPARAM(status)` of a batched frame is fooled.
- Price fees on the *signed* tx: a 65-byte signature is up to 1,040 gas of calldata.
- Simple txs are often calldata-floor bound (64 gas per data byte at the floor; the 65-byte signature dominates).
- Yul: a helper that uses memory 0..32 (e.g. `CODECOPY` of a constant) clobbers calldata built there,
  if it is evaluated as an argument of the `call`. Yul evaluates arguments right to left, after the
  preceding statements. This cost one stranded sponsor in experiment 04.
- A contract whose code starts with `APPROVE` cannot receive plain ETH. Dispatch on `caller() == 0xaa`
  and the frame mode first.
- A pay frame declared at exactly its gas use can be admitted, given a hash, and never included
  ("silent drop", `aa` repo, measured on 81410). Keep a margin on VERIFY limits. Experiments 07 and
  15 each saw one more drop, both on the first tx after the sender's code changed, and neither
  reproduced. 16 traced a third to a receipt from a block that was then replaced; 19 confirmed such
  receipts but not that they cause drops.
- The default code accepts a SECP256K1 entry only (EIP text; 11 measured the refusal). A P256 key's
  own address cannot send until code is deployed there.
- A nonce key's first use creates a slot, 97,920 state gas, charged to the frame that approves
  PAYMENT: the sender's VERIFY when it pays (01, 08), the sponsor's when one pays (16).
- A replacement must raise both fees by at least 10%; one wei short is "underpriced" (09, 19). The
  fees are inside the sig hash, so every signer of a multisig signs the bump again (08).
- A receipt can name a block that is then replaced (19, round 24). Send what depends on a receipt
  only once a block is built on it.
- ethrex's `eth_estimateGas` refuses an account that cannot pay the block gas limit at the offered
  fee (21). Estimate from a funded account, or simulate.

## Roadmap

Status: ✅ done · 🔄 in progress · ⏳ next · 💡 idea

### Tooling

- ✅ Encode/decode, sig hash, tx hash, gas model, secp256k1 signing, simulate/send/receipt, faucet,
  inspector. Tests: the ethrex golden vector plus mined txs (hash, signature recovery, `gasUsed`): 14 on
  `tooling`, plus each experiment branch's own.
- ✅ Contract compilation (`solc` npm: Solidity, plus Yul with `verbatim_*` for `0xaa`, `0xb0–0xb5`)
  and CREATE2 deployment frames.
- ✅ Network profiles: the frames-devnet-0 envelope (no 8250), pinned per-client RPC, six devnet-0 fixtures
  (one per spamoor shape, built and served by different clients).
- ✅ P256 signing (scheme `0x2`; signer = `keccak(qx‖qy)[12:]`) and ordered multi-key signing (`signAll`).
- 💡 ARBITRARY entries + `SIGDATACOPY` helpers. Experiments 07 (FROST), 11 (WebAuthn) and 17 (WOTS)
  each carry their own encoder; none has moved into `tooling` yet.
- 💡 Gas-limit estimation: simulate with generous limits, tighten to observed usage plus a margin.
- 💡 Receipt log decoding against ABIs; EIP-7708 transfer logs (`0xff…fe`).

### Track A: the EIP's own examples ✅

| # | Branch | EIP example | Result |
|---|---|---|---|
| 01 | `exp/01-simple-tx` | 1, 1a | ✅ ETH transfer (new/existing account), CREATE2 deploy, probe call (CALLER/ORIGIN per mode), 9 rule violations. Simple transfers are calldata-floor bound. |
| 02 | `exp/02-account-deployment` | 1b | ✅ 77-byte Yul account deployed *at* `tx.sender` and used in the same tx (`DeploySelfVerify`). Validates from the protocol signature list with `SIGPARAM`, at 288 gas. Nonce 0 → 2. 7 rule violations. |
| 03 | `exp/03-atomic-batch` | 2 | ✅ Approve + swap. A failed batch rolls back and marks later frames SKIPPED, but rolled-back frames keep `SUCCESS`. Approve + exact swap nets 0 state gas plus a 10,000 refund. All 6 static batch rules enforced. |
| 04 | `exp/04-sponsored-erc20` | 3 | ✅ A user with zero ETH: EOA sponsor via default code (two signatures), then TokenSponsor (Yul) is paid in tUSD and refunds exactly in a post-op. Frontrun risk confirmed: an empty-wallet sender is still valid and the sponsor eats 218,760 gas. 12 cases. |

### Track B: multisig and MPC wallets ✅

Background from the owner's other repos (`aa`, `pmpc`, `crops-frame`):
- Threshold signing (FROST, threshold ECDSA) yields "a single ordinary signature; the chain cannot
  tell" (`pmpc/docs/01-background/12-…`).
- FROST cannot complete if a member stays silent (R32 not met), and resharing does not retire old
  shares (R35) (`pmpc/docs/02-requirements/03-disclosure-and-custody.md`).
- `pmpc` still owes "a k-of-n signature-set check, both naively and aggregated", inside a VERIFY frame.
- `aa` picked one t-of-n threshold blind-Schnorr key over per-funder keys, because which subset
  signed links spends (`aa/decisions/0026`).
- Fee fields are inside the sig hash, so a fee bump needs every signer again (`aa` Q13).
- ERC-8286 names two routes to authorisation material: `SIGPARAM` on protocol-validated entries,
  or a self-contained envelope in `data`.

Numbers 06 onward were shifted by one when the privacy pool (Track E) took 06. Plan item 05b ran
inside 08, and the proposed `exp/09-shared-payer` ran as `exp/09-paymasters`.

| # | Branch | Experiment | Measures |
|---|---|---|---|
| 05 | `exp/05-multisig` | ✅ **k-of-n multisig account**, owners in its code; VERIFY counts distinct protocol-validated SECP256K1/P256 entries via `SIGPARAM`. 2-of-3 secp256k1 and 2-of-3 secp256k1 + **P256** transfers mined. | VERIFY 1,129 gas for 2 signers. Under 100k: ~20 secp256k1 or ~10 P256 signers. **`MAX_VERIFY_STATE_GAS` caps a self-deployed account at 206 B of code** (326 B prefunded), so counterfactual multisigs need a proxy + owner commitment. Explicit-digest co-signatures are inside the sig hash (sign them first). |
| 05b | in `exp/08-multisig-ops` | ✅ Counterfactual multisig through the public mempool: a proxy plus an owner-set commitment, owners in the VERIFY frame's data. | 108 B or 76 B of code self-deploy whatever n is; VERIFY 4,262 against 05's 1,129 (a cold `DELEGATECALL`), plus 20 B of calldata per owner per tx. |
| 07 | `exp/07-threshold-wallet` | ✅ **MPC wallet as one key**: a 2-of-3 FROST group key behind one account, one 52-byte Schnorr signature in an `ARBITRARY` entry, verified with the `ecrecover` trick. | 26,794 gas per transfer whatever the threshold, against 35,622 for 05's 2-of-3; the chain cannot tell which members signed. An abort costs nothing on chain. Not a protocol scheme, so no canonical paymaster can sign with it (09). |
| 08 | `exp/08-multisig-ops` | ✅ **Multisig ergonomics**: parallel proposals on keyed nonces, fee bumps, cancellation, owner rotation. | Keyed nonces give an unordered queue. A fee bump needs all k signers again (a fee ladder signed up front is the workaround). Cancelling spends the nonce on chain. Rotation is one approved self-call. |
| 09 | `exp/09-paymasters` | ✅ **Paymasters in the public mempool**: the canonical paymaster (ethereum/EIPs#12041), a byte-longer copy, a code-less sponsor, a 2-of-3 treasury. | Recognition by code hash alone; only the canonical instance served four users in one block. It is a verifying paymaster, which answers 04's frontrun. A pending withdrawal is ignored by the reservation check. The payer can change on replacement. |

### Track C: ERC-4337 use cases ported to frames ✅

Most of what a 4337 bundle does is a frame list. Port each one, then compare gas and trust
assumptions with a 4337 run where useful. `aa` measured a 4337 self-paid transfer at 120,162 against
47,573 as frames on 81410.

- ✅ smart account + counterfactual deploy (02); ✅ batching (03); ✅ ERC-20 paymaster (04)
- ✅ **Verifying paymaster** (09): the canonical paymaster's signer co-signs each sig hash.
- ✅ **Passkey accounts** (11): a raw P256 key through the protocol scheme (VERIFY 288, 35,314 per
  transfer) and a browser passkey whose `WebAuthn` assertion the account checks with `P256VERIFY`
  (VERIFY 15,542, 41,444). The protocol scheme cannot carry a `WebAuthn` assertion.
- ✅ **Session keys** (12): one target, one selector, a deadline and a budget, checked frame by
  frame. The deadline comes from the expiry frame; the spend is written by a frame VERIFY makes sure
  cannot fail. About 21,600 gas per tx over the owner's own. Revocation overtakes a pending session
  tx by replacement.
- ✅ **Social recovery** (13): 2-of-3 salted guardians and a delay the owner can cancel. VERIFY can
  bound time from above only, under the EIP (19 found ethrex allows a lower bound). A rotatable
  owner costs about 2,100 gas per tx.
- ✅ **Modular account** (14): ERC-7579-style validator modules by `DELEGATECALL` or `STATICCALL`. A
  module keeps configuration only in the account and cannot keep counters; indirection costs
  about 5,300 gas per tx.
- ✅ **EIP-7702-delegated EOA** as sender (15): works in the public mempool; delegation switches the
  default code off, so the delegate must check the EOA's own key again.
- ✅ **Subscriptions** (16): the merchant pulls and pays from its own EOA, on its own nonce key; no
  paymaster, deposit or bundler.
- ✅ **Post-quantum account** (17): 1,024 one-time WOTS keys under a Merkle root, the key chosen by
  the nonce. 73,481 gas against 27,382 for ECDSA; `MAX_VERIFY_GAS` decides the Winternitz
  parameter, and $w = 256$ fits only the testnet's 500,000.

### Track E: what 8141 can do that 4337 cannot ✅

Owner's question (2026-10-07): beyond 4337's capability, what can 8141 demonstrate?

| Capability | Why 4337 can't | Demo | Status |
|---|---|---|---|
| **Privacy-pool withdrawal with the pool as `tx.sender`** | A 4337 paymaster that checks roots/nullifiers reads pool storage. kohaku-rs's Tornado paymaster runs `Tornado.withdraw` inside validation, and its tests run the alto bundler with `--safe-mode false`. | Layout from Nero_eth's *Frame transactions and the three gates to privacy* (ethresear.ch/t/24666): `VERIFY(EXECUTION)→pool` reads its own `acceptedRoots`/`nullifierHashes` and checks Groth16; `VERIFY(PAYMENT)→sponsor`; `SENDER→pool` marks the nullifier and pays out. Reference contract: `nerolation/eip-8141-pseudo-privacy-pool-contract`. Groth16 is ~250k gas: over the spec's 100k, under the testnet's 500k, so testable here. Also test the post's root-rotation mass-invalidation claim (ring buffer vs append-only roots), and nullifier-as-nonce-key for parallel withdrawals (crops-frame P0001/P0005). | ✅ exp/06: all four layouts mined; VERIFY 244,808 (keyed) to 248,991 (storage); two keyed withdrawals in one block; storage-pool users evict each other; with a 2-root ring, a pending proof turned invalid once 2 more deposits rotated its root out; the stock Tornado verifier is refused for `GAS` (patched to forward all gas). Rust path in kohaku-rs. |
| **AA for plain EOAs, no migration, no 7702** | needs a smart account | Default code: batching, sponsorship by an EOA, gas in ERC-20 | ✅ 01, 03, 04 |
| **Protocol-validated signatures as a service** | signatures checked in EVM by each contract | Any contract checks "signer X signed digest D" with `SIGPARAM` on an explicit-`msg` entry: permits/orders/votes without `ecrecover`/`P256VERIFY`, passkey-signed DEX orders | ✅ 20: it works, and it costs more, not less. Under the calldata floor each further signature is 10,288 gas against 5,603 for `ecrecover` (secp256k1) and 18,220 against 11,267 for `P256VERIFY`. What it buys is one code path for every scheme. An explicit-digest entry is a bearer instrument |
| **Cross-frame introspection** | `postOp` sees only its own op | Contracts read other frames' data, status and gas (`FRAMEDATALOAD`, `FRAMEPARAM 0x05/0x0A/0x0B`): exact token refunds (04), pay-on-success, intent settlement checked against the user's own frames | ✅ 04 (refunds), 12 (a policy that reads the calls), 18 (every word from every mode matches the EIP; a later frame sees a rolled-back frame as a success) |
| **Mixed atomic and independent steps, with per-frame receipts** | one `executeBatch`: all or nothing | Batches + SKIPPED + independent frames in one tx | ✅ 03 |
| **No bundler, no EntryPoint, no deposits** | the bundler re-simulates; paymasters stake | `eth_sendRawTransaction`; replacement may change payer; canonical-paymaster code match | ✅ 09 (code match, payer change), 21 (the bundler's loss and the EntryPoint's 54.8M gas of state, measured) |
| **Native deadline and recent-root anchoring** | `validUntil` only via a paymaster or the account | Expiry verifier frame (only place `TIMESTAMP` is allowed); EIP-8272 recent roots | ✅ 06 (8272 roots), 10 (expiry: inclusive, 3,051 gas, upper bound only under the EIP), 19 (ethrex also gives VERIFY a lower bound) |
| **Gas** | EntryPoint overhead | `aa` (81410): 4337 self-paid transfer 120,162 vs 47,573 with frames. Re-measure on 8141 | ✅ 21: one ERC-20 transfer, 116,735 through EntryPoint v0.8 against 48,435 as frames, 2.41 times. Being new to the EntryPoint costs 195,840 more, part of it paid by the bundler |

### Wallet integration: kohaku-rs

The owner's direction: integrate these experiments into `4w44h9jckz-boop/kohaku-rs`, the wallet reference
implementation (Rust). Status: push access granted; work is on kohaku-rs branch `experiment/frames`
(its CONTRIBUTING puts experiments on `experiment/*`), not merged.

- What is there: `kohaku-userop-kit` (EntryPoint v0.8, Simple7702Account, Pimlico bundler, EIP-712 userop
  hash, ECDSA only) and the Tornado crates. The only 4337 flow is a withdrawal whose gas is paid by the
  note through Robert-MacWha's `privacy-paymaster` (TornadoFeeAdapter). `fork-kit` runs anvil, which has no
  type-`0x06` support, so tests need ethrex or a Kurtosis devnet instead.
- Proposed crates:
  1. ✅ `kohaku-frame-kit`: a port of `src/frametx` (8250 envelope, sig hash, gas model, secp256k1 +
     P256 signing with `signAll` ordering, `ethrex_simulateFrameTransaction`, receipts). Offline tests:
     the ethrex golden vector and 42 mined transactions from every branch (hash, signatures,
     `gasUsed`). Like `tooling`, it does not yet speak the 7-field devnet envelope.
     Since then: `Fees::bumped` (10% on both fees, 19) and receipts trusted only once a block is
     built on them (19); 55 mined transactions in its fixtures.
  2. ✅ `kohaku-frame-accounts`, the account and sponsor layer: a `TxPlan` builder over the
     default-code EOA, `SimpleAccount` (02), `Multisig` (05), `P256Account` and `WebAuthnAccount`
     (11), `SessionAccount` (12); sponsors `EoaSponsor`, `TokenSponsor` (04), `CanonicalPaymaster`
     and `MultisigSponsor` (09). The builder adds deadlines (10) and charges a fresh nonce key's slot
     to the payer (01, 08, 16). Its tests rebuild 38 mined transactions byte for byte and 3 more
     frame for frame, all offline. Its examples ran 01-05 again from Rust on the testnet; the ports
     after them (09-12) are rebuilt from mined transactions but have not been sent from Rust.
  3. Tornado and privacy pool on frames: ✅ (c) pool-as-sender. `kohaku-frame-pool` holds the prover
     CLI that 06 calls, and a withdrawal builder whose test rebuilds every mined 06 withdrawal byte for
     byte. Its `keyed_withdrawal` example ran a deposit and a withdrawal on the testnet from Rust alone
     (`0x7fa5825c…`, same frame gas as the TypeScript one). 💡 (b) relayer-EOA-as-payer for the
     stock Tornado contract is still open.

### Track D: protocol probing 🔄

- ✅ **Expiry verifier frame** (10): the deadline is inclusive; admission checks the head and
  inclusion happens a slot later; 3,051 gas, and 3,050 halts; shape is checked before simulation;
  only the prefix protects.
- ✅ **Keyed nonces (EIP-8250)**: 06 mined two pending txs from one sender in one block; first use
  is 97,920 state gas (01, 06, 08, 16); 16 found two nonce-key domains per sender (key 0 and the
  rest). Not yet probed: the 5-fresh-keys-per-tx limit.
- ✅ **Introspection playground** (18): every `TXPARAM`/`FRAMEPARAM`/`SIGPARAM` word from every
  mode matches a model of the EIP, and every case that must halt halts. An empty `msg` reads as
  zero; the opcodes are undefined outside frame transactions.
- ✅ **Mempool rule probing** (19): each prefix rule probed alone, with errors that name the rule;
  replacement; receipt finality. ethrex departs from the EIP in two places, both permissive:
  `TIMESTAMP` through a nested call to `0x8141`, and calls to a code-less EOA with a nonce or
  balance. Simulation is a faithful dry run of admission.
- ✅ **Cross-client** (22, frames-devnet-0, unfunded): heads agree at 50/50 heights; all 2,000 frame
  txs built by the four clients re-encode, recover and settle under `tooling`, but they are 5 spamoor
  shapes, all self-relayed secp256k1. 49 admission probes × 2 fee levels × 4 clients: geth checks
  balance before any frame rule, has a 24,000 gas floor, refuses blob frame txs; reth reports bad
  signatures as prefix failures; ethrex lets the EIP-7825 and state caps reach simulation;
  Nethermind held a zero-fee sponsored tx. `MAX_VERIFY_GAS` is 100k (reth, ethrex), 300k
  (Nethermind), 500k (Hegota). 21 of 39 tx JSON fields differ; `gas` means two things.
  ⏳ Funded: replay 02–21's shapes on devnet-0 (list in 22's README), then devnet-1 (8-field).
- ✅ **Approval scope** (23): the EIP's "or otherwise constrain every subsequent `SENDER` frame"
  read literally. A mempool observer inserted a sandwich *inside the victim's own transaction* as a
  `DEFAULT`-frame replacement, mined in block 315,369 (front 95,247 and back 15,463 execution gas,
  paid by the victim), and a relayer raised the tip to 0.0011865 ETH. A scoped digest that commits
  to every frame except the pay frame's contents let a second payer replace the first without the
  user re-signing (block 315,376).
- ✅ **Sealed paymaster** (24): ethereum/EIPs#12328's whole-code egress scan, live. A paymaster
  with no `CALL` in its code, so sealed by the scan, sent its whole balance out through a `SENDER`
  frame's `value` while a sponsorship it backed was pending, and the sponsorship was dropped. A
  paymaster sealed by construction (immutable EIP-8272 source, a Merkle policy over target,
  selector, cap and deadline): prefix 13,305 gas at depth 4, pay frame $3{,}811 + 191d$. A later
  root does not revoke an earlier one inside 8,191 slots; only the policy's `notAfter` bounds it.
  Offline: the PR's scan fails 28% of call-free Solidity builds on metadata bytes alone; an
  amended scan (reachable code only, constant-scope `APPROVE`, no code-less or delegated payer)
  fails 0.9%. A reorg at block 316,413 turned a mined drain's receipt from success to failure.

## Status log

- **2026-10-07 (a)**: Researched the wire format against ethrex source and the pinned EIP texts.
  Built `tooling`. Ran experiment 01: 4 txs mined, all frames as expected. Test account
  `0xa93CEe06b1e4fFACdf920BD500cb301a39DdEB74` (key only in a local, gitignored `.env`; make your
  own with `npm run account`).
- **2026-10-07 (b)**: Added contract compilation and CREATE2 helpers to `tooling`. Ran experiments 02,
  03 and 04 (their mined txs kept as fixtures on each branch; tests pass). Read the `aa`, `pmpc`
  and `crops-frame` repos for MPC and multisig background (Track B). Found frames-devnet-0 (four
  clients including Nethermind; needs a 7-field envelope and a human faucet claim). Roadmap gained
  Tracks B–D.
- **2026-10-07 (c)**: P256 signing and ordered multi-key signing (`signAll`) in `tooling`. Ran
  experiment 05 (multisig): the first P256 entry among our fixtures; MAX_VERIFY_STATE_GAS bounds
  counterfactual deploys to 206 B. Mapped kohaku-rs's 4337 usage onto frames. Added Track E
  (8141-only capabilities) around the three-gates privacy-pool design.
- **2026-10-07 (d)**: Ran experiment 06 (privacy pool as its own sender, two designs): 16
  withdrawals mined from TypeScript and one from Rust; 30 cases simulated, 26 of them refused.
  Push access to kohaku-rs: branch `experiment/frames` has `kohaku-frame-pool` (prover CLI,
  withdrawal builder, testnet example) and `kohaku-frame-kit`, plus a one-line clippy fix the new
  toolchain needed. Both repos now check each other's mined transactions. Track B's proposed 06-08
  became 07-09.
- **2026-10-07 (e)**: Ran experiments 07 to 21, one branch each, every one with its mined
  transactions as fixtures and a README of results. That closes Tracks B, C and E and all of Track D
  except cross-client. Plan item 05b ran inside 08. Track E's "no bundler" and "gas" rows both
  landed in 21, the ERC-4337 comparison on this chain. `tooling`'s README indexes all 21.
- **2026-10-07 (f)**: kohaku-rs `experiment/frames` gained `kohaku-frame-accounts`'s later ports:
  the canonical paymaster and a multisig treasury (09), deadlines (10), passkey accounts (11),
  session keys (12), fresh-nonce-key charging (01, 08, 16), and in `kohaku-frame-kit` the
  replacement bump and receipt confirmation (19). Every port is checked by rebuilding the
  experiment's mined transactions offline. While porting 11, kohaku's `Eoa` was found to claim
  the default code accepts P256, which the EIP does not allow, and the claim was corrected.
- **2026-10-08 (a)**: Experiment 22 on frames-devnet-0, all four clients, without funds (the
  faucet needs a human): chain agreement and conformance, admission probes, cap bisection, JSON
  per client. Found and fixed an eRPC trap (merged in-flight requests answered by one upstream).
  All four serve a frame rolled back with its batch as `SUCCESS` (`0x13dcebcf…`, block 99,563).
- **2026-10-08 (b)**: Read EIP-8141 master and the open PRs (12039, 12041, 12061, 12091, 12109,
  12113, 12213, 12253, 12301, 12310, 12321, 12328, 12330, 12340, 12352, 12387, 12395;
  execution-apis 860, 894, 907, 909, 910). Wrote the ethresear.ch post on branch
  `post/ethresearch` (`posts/frame-transactions-in-practice.md`): results of 01–22 and seven
  suggestions, each with its cost and the easier fix it does not propose: frame-level `TIMESTAMP`
  (plus an optional not-before in the expiry frame), a two-dimensional validation budget (access
  vs compute) instead of moving the floor, a ROLLED_BACK frame status, scheme admission by
  aggregation and pre-execution validation (BIP-340 first, WebAuthn stays in the EVM), no wider
  default code without a rotation path, `MAX_VERIFY_STATE_GAS` in bytes, one admission order with
  structured reasons.

- **2026-10-08 (c)**: Asked "are frame transactions done?", read EIP-8141 master end to end with
  EIP-8250, EIP-8272, EIP-7805, EIP-8369, ERC-7562 and the Hegota and Glamsterdam meta EIPs, and
  `aa`'s and `crops-frame`'s findings. Ran experiments 23 (approval scope) and 24 (sealed paymaster)
  to test the two claims that needed a live chain. Rewrote the post around a readiness map: the
  execution layer is done; approval semantics, payers, the public mempool, inclusion lists, partial
  statelessness and post-quantum accounts are not. Its suggestions: sign what you approve (Security
  Considerations); a fan-out invariant for payers, under which the code-less sponsor rule and the
  PR-12328 scan both fail; evict by fee, and by deadline only near expiry; a FOCIL profile for
  directly evaluable frame transactions; a namespaced VOPS surface; scheme agility only with a
  rotation path, since an EOA has no protocol path off ECDSA. It also sets the public mempool beside
  ERC-7562 (narrower on every row) and says what stays on ERC-4337 at launch. 183 mined transactions
  across the branches.

## References

- EIP-8141 (pinned): https://github.com/ethereum/EIPs/blob/b75cbe6115/EIPS/eip-8141.md
- EIP-8250 (pinned): https://github.com/ethereum/EIPs/blob/f3079a09e8/EIPS/eip-8250.md
- ethrex testnet docs: https://github.com/lambdaclass/ethrex/tree/hegota-testnet/docs (`hegota-testnet-*.md`, `eip-8141.md`)
- Reference encoder/submitters: `ethrex/scripts/hegota-testnet/frametx*.py`
- Faucet and EIP guide: https://faucet.privacy.ethrex.xyz (`/eips`)
- frames devnets: https://github.com/ethpandaops/frames-devnets, https://notes.ethereum.org/@ethpandaops/frames-devnet-0,
  https://notes.ethereum.org/@ethpandaops/frames-devnet-1; EELS tracker ethereum/execution-specs#3727
- Client work: Nethermind PR 12526 (merged 2026-09-24: 8141/8250/8272/7906), geth PR 35666 (draft),
  reth `frames-devnet-0` branch and PR 27528 (8250), Besu draft PR 11305
- Other implementations to cross-check: spamoor `txtypes/frame.go` (Go, both envelopes),
  `JustaLab-co/frametx-kit` (TS), `polus-arcticus/awesome-frames` (Yul accounts, PQ toys)
- Nero_eth, *Frame transactions and the three gates to privacy* (2026-04-16): https://ethresear.ch/t/frame-transactions-and-the-three-gates-to-privacy/24666;
  canonical pool contract: https://github.com/nerolation/eip-8141-pseudo-privacy-pool-contract
- kohaku-rs (owner's fork of the wallet reference implementation): `4w44h9jckz-boop/kohaku-rs`; upstream paymaster
  `Robert-MacWha/privacy-paymaster` (Tornado, Railgun and privacypools adapters)
- The owner's related research: `4w44h9jckz-boop/aa` (frames gas measurements, paymasters, spec
  questions), `4w44h9jckz-boop/pmpc` (MPC custody requirements), `4w44h9jckz-boop/crops-frame`
  (privacy seams on frames; P0001 nonce-key visibility, P0005 shared-sender mempool ceiling)
