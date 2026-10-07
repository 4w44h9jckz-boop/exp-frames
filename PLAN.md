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
| **ethpandaops frames-devnet-0** | `7034189865` | geth, Nethermind (`v2.1.0-unstable+3c210d3c`), reth, ethrex behind one eRPC balancer | 8141@`b75cbe61`, **no 8250** (7-field envelope with a plain `nonce`) | ⏳ cross-client runs |
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
| Mempool concurrency | spec text (EIPs#12039) allows several pending txs on disjoint keys. **The `aa` repo measured one pending tx per sender, even on disjoint keys** (2026-09-18). Re-check. | one pending tx per sender |
| Code-less payer | the client caps it at one pending tx per payer, like a non-canonical paymaster (`aa`, measured on 81410) | exempt from the cap; per-payer exposure rule only |
| Recent roots | leading VERIFY frame to `0x…8272` (EIP-8272) | n/a |

ethrex keeps a consensus divergence ledger in `docs/hegota-testnet-divergences.md`. Check it before
relying on an edge case.

### frames-devnet-0 (next)

- RPC `https://rpc.frames-devnet-0.ethpandaops.io`. Each request goes to a random client, so a run
  gets cross-client coverage, but you cannot pick the client. `debug_*` and `txpool_*` are blocked.
  Explorer `https://dora.frames-devnet-0.ethpandaops.io`.
- Faucet `https://faucet.frames-devnet-0.ethpandaops.io`: proof-of-work plus **hCaptcha**, so a human
  must claim. A GitHub login gives 100 ETH a day.
- Tooling needed (`tooling` follow-up):
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
  ("silent drop", `aa` repo, measured on 81410). Keep a margin on VERIFY limits.

## Roadmap

Status: ✅ done · 🔄 in progress · ⏳ next · 💡 idea

### Tooling

- ✅ Encode/decode, sig hash, tx hash, gas model, secp256k1 signing, simulate/send/receipt, faucet,
  inspector. Tests: the ethrex golden vector plus mined txs (hash, signature recovery, `gasUsed`): 14 on
  `tooling`, plus each experiment branch's own.
- ✅ Contract compilation (`solc` npm: Solidity, plus Yul with `verbatim_*` for `0xaa`, `0xb0–0xb5`)
  and CREATE2 deployment frames.
- ⏳ Network profiles: the frames-devnet-0 envelope (no 8250), RPC feature probing, per-network fixtures.
- 💡 P256 signing (scheme `0x2`; signer = `keccak(qx‖qy)[12:]`); ARBITRARY entries + `SIGDATACOPY` helpers.
- 💡 Gas-limit estimation: simulate with generous limits, tighten to observed usage plus a margin.
- 💡 Receipt log decoding against ABIs; EIP-7708 transfer logs (`0xff…fe`).

### Track A: the EIP's own examples ✅

| # | Branch | EIP example | Result |
|---|---|---|---|
| 01 | `exp/01-simple-tx` | 1, 1a | ✅ ETH transfer (new/existing account), CREATE2 deploy, probe call (CALLER/ORIGIN per mode), 9 rule violations. Simple transfers are calldata-floor bound. |
| 02 | `exp/02-account-deployment` | 1b | ✅ 77-byte Yul account deployed *at* `tx.sender` and used in the same tx (`DeploySelfVerify`). Validates from the protocol signature list with `SIGPARAM`, at 288 gas. Nonce 0 → 2. 7 rule violations. |
| 03 | `exp/03-atomic-batch` | 2 | ✅ Approve + swap. A failed batch rolls back and marks later frames SKIPPED, but rolled-back frames keep `SUCCESS`. Approve + exact swap nets 0 state gas plus a 10,000 refund. All 6 static batch rules enforced. |
| 04 | `exp/04-sponsored-erc20` | 3 | ✅ A user with zero ETH: EOA sponsor via default code (two signatures), then TokenSponsor (Yul) is paid in tUSD and refunds exactly in a post-op. Frontrun risk confirmed: an empty-wallet sender is still valid and the sponsor eats 218,760 gas. 12 cases. |

### Track B: multisig and MPC wallets ⏳

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

| # | Branch (proposed) | Experiment | Measures |
|---|---|---|---|
| 05 | `exp/05-multisig` | ✅ **k-of-n multisig account**, owners in its code; VERIFY counts distinct protocol-validated SECP256K1/P256 entries via `SIGPARAM`. 2-of-3 secp256k1 and 2-of-3 secp256k1 + **P256** transfers mined. | VERIFY 1,129 gas for 2 signers. Under 100k: ~20 secp256k1 or ~10 P256 signers. **`MAX_VERIFY_STATE_GAS` caps a self-deployed account at 206 B of code** (326 B prefunded), so counterfactual multisigs need a proxy + owner commitment. Explicit-digest co-signatures are inside the sig hash (sign them first). |
| 05b | `exp/05b-multisig-proxy` | 💡 Counterfactual multisig through the public mempool: 45-byte proxy + owner-set commitment, owners in the VERIFY frame's data; signers in ascending order (linear VERIFY). | Fits 206 B? VERIFY gas vs 05. |
| 06 | `exp/06-threshold-wallet` | **MPC wallet as one key**. (a) Threshold ECDSA or a FROST-like 2-of-3 producing one SECP256K1 entry. (b) FROST Schnorr in an `ARBITRARY` entry, verified with the `ecrecover` trick. Compare against 05. | On-chain cost and indistinguishability against the multisig. Off-chain rounds. A silent signer. |
| 07 | `exp/07-multisig-ops` | **Multisig ergonomics**: one keyed nonce per proposal (Safe-style queue), fee bumps needing re-signing, an expiry frame per proposal, owner rotation (ERC-8403 tiers 1/2). | Mempool: one pending tx per sender? Fresh key cost 97,920 state gas. Revocation timing. |
| 08 | `exp/08-shared-payer` | **A multisig or MPC treasury as paymaster** for its members (pay frame checks k-of-n co-signatures), and a verifying-paymaster variant of TokenSponsor (sponsor co-signs, which closes the experiment 04 frontrun). | Payer caps (non-canonical: 1 pending); silent drop at an exact gas limit. |

### Track C: ERC-4337 use cases ported to frames 💡

Most of what a 4337 bundle does is a frame list. Port each one, then compare gas and trust
assumptions with a 4337 run where useful. `aa` measured a 4337 self-paid transfer at 120,162 against
47,573 as frames on 81410.

- ✅ smart account + counterfactual deploy (02); ✅ batching (03); ✅ ERC-20 paymaster (04)
- 💡 **Verifying paymaster** (off-chain approval via co-signature): see 08.
- 💡 **Passkey (P256) account**: scheme `0x2` validated by the protocol (6,700 gas). No P256 entry has
  been measured on chain yet (`aa`).
- 💡 **Session keys / spending limits**: a validator that allows a second key only for given targets,
  selectors and values. Needs sender storage reads in VERIFY.
- 💡 **Social recovery / guardians**: rotate the owner after m-of-n guardian co-signatures plus a delay.
- 💡 **Modular accounts (ERC-7579-like)**: a validator module called from VERIFY (`DELEGATECALL` is
  allowed if the trace stays clean).
- 💡 **EIP-7702-delegated EOA** as sender: delegation code doing the VERIFY.
- 💡 **Subscriptions / recurring pulls**: keyed nonces + expiry frame + a merchant-paid fee.
- 💡 **Post-quantum verifier**: an `ARBITRARY` signature + `SIGDATACOPY` + a hash-based check, against
  `MAX_VERIFY_GAS`.

### Track E: what 8141 can do that 4337 cannot 💡

Owner's question (2026-10-07): beyond 4337's capability, what can 8141 demonstrate?

| Capability | Why 4337 can't | Demo | Status |
|---|---|---|---|
| **Privacy-pool withdrawal with the pool as `tx.sender`** | A 4337 paymaster that checks roots/nullifiers reads pool storage. kohaku-rs's Tornado paymaster runs `Tornado.withdraw` inside validation, and its tests run the alto bundler with `--safe-mode false`. | Layout from Nero_eth's *Frame transactions and the three gates to privacy* (ethresear.ch/t/24666): `VERIFY(EXECUTION)→pool` reads its own `acceptedRoots`/`nullifierHashes` and checks Groth16; `VERIFY(PAYMENT)→sponsor`; `SENDER→pool` marks the nullifier and pays out. Reference contract: `nerolation/eip-8141-pseudo-privacy-pool-contract`. Groth16 is ~250k gas: over the spec's 100k, under the testnet's 500k, so testable here. Also test the post's root-rotation mass-invalidation claim (ring buffer vs append-only roots), and nullifier-as-nonce-key for parallel withdrawals (crops-frame P0001/P0005). | ⏳ flagship, exp/06 |
| **AA for plain EOAs, no migration, no 7702** | needs a smart account | Default code: batching, sponsorship by an EOA, gas in ERC-20 | ✅ 01, 03, 04 |
| **Protocol-validated signatures as a service** | signatures checked in EVM by each contract | Any contract checks "signer X signed digest D" with `SIGPARAM` on an explicit-`msg` entry: permits/orders/votes without `ecrecover`/`P256VERIFY`, passkey-signed DEX orders | 💡 (05 shows the account side) |
| **Cross-frame introspection** | `postOp` sees only its own op | Contracts read other frames' data, status and gas (`FRAMEDATALOAD`, `FRAMEPARAM 0x05/0x0A/0x0B`): exact token refunds (04), pay-on-success, intent settlement checked against the user's own frames | 🔄 04 done |
| **Mixed atomic and independent steps, with per-frame receipts** | one `executeBatch`: all or nothing | Batches + SKIPPED + independent frames in one tx | ✅ 03 |
| **No bundler, no EntryPoint, no deposits** | the bundler re-simulates; paymasters stake | `eth_sendRawTransaction`; replacement may change payer; canonical-paymaster code match | 💡 |
| **Native deadline and recent-root anchoring** | `validUntil` only via a paymaster or the account | Expiry verifier frame (only place `TIMESTAMP` is allowed); EIP-8272 recent roots | 💡 Track D |
| **Gas** | EntryPoint overhead | `aa` (81410): 4337 self-paid transfer 120,162 vs 47,573 with frames. Re-measure on 8141 | 💡 |

### Wallet integration: kohaku-rs

The owner's direction: integrate these experiments into `4w44h9jckz-boop/kohaku-rs`, the wallet reference
implementation (Rust). Status: cloned read-only; **push access not granted yet**.

- What is there: `kohaku-userop-kit` (EntryPoint v0.8, Simple7702Account, Pimlico bundler, EIP-712 userop
  hash, ECDSA only) and the Tornado crates. The only 4337 flow is a withdrawal whose gas is paid by the
  note through Robert-MacWha's `privacy-paymaster` (TornadoFeeAdapter). `fork-kit` runs anvil, which has no
  type-`0x06` support, so tests need ethrex or a Kurtosis devnet instead.
- Proposed crates:
  1. `kohaku-frame-kit`: a port of `src/frametx` (envelope with and without 8250, sig hash, gas model,
     secp256k1 + P256 signing with `signAll` ordering, `ethrex_simulateFrameTransaction`, receipts).
     Test against the same golden vector and `test/fixtures/chain`.
  2. A frame account and sponsor layer on top: default-code EOA, the 05 multisig, the 04 token
     sponsor and post-op refund, an EOA sponsor.
  3. Tornado and privacy pool on frames: (b) relayer-EOA-as-payer, which complies with mempool rules
     today; then (c) pool-as-sender once the Track E contract exists.

### Track D: protocol probing 💡

- 💡 **Expiry verifier frame**: before and after the deadline, and mempool eviction.
- 💡 **Keyed nonces (EIP-8250)**: several pending txs on disjoint keys (re-check `aa`'s one-per-sender
  finding); first-use state gas; `TXPARAM 0x0D–0x10`; the 5-fresh-keys-per-tx limit.
- 💡 **Introspection playground**: a contract that dumps every `TXPARAM`/`FRAMEPARAM`/`SIGPARAM`
  value from each mode, checked against the encoder's view of the tx.
- 💡 **Mempool rule probing**: banned opcodes in the prefix, storage reads outside the sender, prefix
  gas caps, silent drop. Compare simulation verdicts with `eth_sendRawTransaction`.
- 💡 **Cross-client**: replay experiments 01–04 on frames-devnet-0 (7-field) and devnet-1 (8-field)
  once tooling supports them, and diff receipts and gas.

## Status log

- **2026-10-07 (a)**: Researched the wire format against ethrex source and the pinned EIP texts.
  Built `tooling`. Ran experiment 01: 4 txs mined, all frames as expected. Test account
  `0xa93CEe06b1e4fFACdf920BD500cb301a39DdEB74` (key only in a local, gitignored `.env`; make your
  own with `npm run account`).
- **2026-10-07 (c)**: P256 signing and ordered multi-key signing (`signAll`) in `tooling`. Ran
  experiment 05 (multisig): the first P256 entry among our fixtures; MAX_VERIFY_STATE_GAS bounds
  counterfactual deploys to 206 B. Mapped kohaku-rs's 4337 usage onto frames. Added Track E
  (8141-only capabilities) around the three-gates privacy-pool design.
- **2026-10-07 (b)**: Added contract compilation and CREATE2 helpers to `tooling`. Ran experiments 02,
  03 and 04 (their mined txs kept as fixtures on each branch; tests pass). Read the `aa`, `pmpc`
  and `crops-frame` repos for MPC and multisig background (Track B). Found frames-devnet-0 (four
  clients including Nethermind; needs a 7-field envelope and a human faucet claim). Roadmap gained
  Tracks B–D.

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
