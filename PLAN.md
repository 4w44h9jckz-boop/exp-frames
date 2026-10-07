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
  `exp/01-simple-tx` is stacked that way. After `tooling` merges with a merge commit, the PR shows
  only its own commit. If `tooling` is squash-merged, rebase the experiment branch onto `main` first.
- Library changes an experiment needs go to `tooling` (or a `tooling/*` follow-up branch) rather than
  into the experiment branch. That keeps experiment PRs about the experiment.
- Each experiment README records: the EIP section it reproduces, how to run it, tx hashes with explorer
  links, per-frame gas, and observations, including any divergence from the spec text.
- Mined txs worth keeping go in `test/fixtures/chain/` via `scripts/capture-fixture.ts`. The tests
  then pin the encoder and gas model to them, offline, so they survive a testnet relaunch.

## Target: ethrex Hegotá testnet

- Chain `8141`, RPC `https://rpc1.privacy.ethrex.xyz`, explorer `https://dora.privacy.ethrex.xyz`,
  faucet `https://faucet.privacy.ethrex.xyz` (`POST /api/claim {address}`, 1 ETH/hour/address).
- Client: ethrex `hegota-testnet` branch; `web3_clientVersion` on 2026-10-07 reported
  `v23.0.0-hegota-testnet-hotfix-4738681`. Network spec: `docs/hegota-testnet-spec.md` in that branch.
- Pins: EIP-8141 `b75cbe6115`, EIP-8250 `f3079a09e8`, EIP-8272 `824cbc0b0e`, EIP-7805 `9a345f96c2`,
  EIP-8369 `51dc7b939a`. All on top of Glamsterdam (EIP-8037 two-dimensional gas, EIP-7928 BALs, …).
- **A relaunch voids everything.** This is the fourth genesis (2026-09-14). Balances, deployed
  contracts and tx hashes do not carry over. Re-run scripts rather than relying on addresses.

### What differs from EIP-8141 master

| Topic | Testnet | EIP-8141 master |
|---|---|---|
| Nonce | `nonce_keys, nonce_seq` (EIP-8250) in place of `nonce` | `nonce` |
| Expiry verifier | predeploy at `0x…8141` | keyless deploy at `0x81413f0c…FfFf` |
| Calldata floor | cites EIP-7623; same numbers as master (64 gas per data byte at the floor) | cites EIP-7976 |
| `MAX_VERIFY_GAS` (mempool) | 500,000 (node flag) | 100,000 |
| Mempool concurrency | keyed-nonce senders may have several pending txs (EIPs#12039) | one pending tx per sender |
| Recent roots | leading VERIFY frame to `0x…8272` (EIP-8272) | n/a |

ethrex keeps a consensus divergence ledger in `docs/hegota-testnet-divergences.md`. Check it before
relying on an edge case. The node build seen on 2026-10-07 already has the `SIGPARAM(0x03)` and
`value_cost` fixes listed there.

### Traps worth remembering

- secp256k1 signature bytes are `yParity ‖ r ‖ s` with yParity 0/1, never 27/28, and low s.
- `fees` is a nested 3-list and `limits` is a nested `[execution, state]` pair. Older encoders send flat
  fields and get `MalformedData`.
- State growth draws only from `limits.state`. When a frame "runs out of gas" with `stateGasUsed = 0`,
  the missing budget is usually state, not execution. Costs: new account 183,600; fresh slot 97,920;
  code deposit 1,530/byte.
- The RPC cannot estimate frame gas. Use `ethrex_simulateFrameTransaction` (per-frame execution gas)
  and the state numbers above.
- Simple txs are often calldata-floor bound (64 gas per data byte at the floor; the 65-byte signature dominates).
- The chain is quiet. On 2026-10-07 the latest ~3,000 blocks held no frame tx, so there is
  little traffic to learn from. The 14 historical txs in `test/fixtures/chain` cover most shapes.

## Roadmap

Status: ✅ done · 🔄 in progress · ⏳ next · 💡 idea

### Tooling

- ✅ Encode/decode, sig hash, tx hash, gas model, secp256k1 signing, simulate/send/receipt, faucet,
  inspector. Tests: ethrex golden vector plus mined txs (hash, signature recovery, `gasUsed`).
- ⏳ Contract compilation: `solc` (npm) for Solidity and for Yul with `verbatim_*` for the new opcodes
  (`APPROVE 0xaa`, `TXPARAM 0xb0`, `FRAMEDATALOAD 0xb1`, `FRAMEDATACOPY 0xb2`, `FRAMEPARAM 0xb3`,
  `SIGPARAM 0xb4`, `SIGDATACOPY 0xb5`). Needed from experiment 02 on.
- 💡 Gas-limit estimation: run the simulation with generous limits, then tighten to the observed
  per-frame usage plus a margin. State budget comes from a rule-of-thumb table.
- 💡 Receipt log decoding against ABIs; EIP-7708 transfer logs (`0xff…fe`).

### Experiments: the EIP's own examples first

| # | Branch | EIP example | Shape | Status |
|---|---|---|---|---|
| 01 | `exp/01-simple-tx` | 1, 1a | `[VERIFY(3), SENDER]` from an EOA via default code | ✅ ETH transfer (new/existing account), CREATE2 deploy, probe call (CALLER/ORIGIN per mode), 9 simulated rule violations |
| 02 | `exp/02-account-deployment` | 1b | `[DEFAULT(deploy), VERIFY(3), SENDER]` | ⏳ |
| 03 | `exp/03-atomic-batch` | 2 | `[VERIFY(3), SENDER(atomic), SENDER]` | ⏳ |
| 04 | `exp/04-sponsored-erc20` | 3 | `[VERIFY(2), VERIFY(1)→sponsor, SENDER, SENDER, DEFAULT(post-op)]` | ⏳ |

**02 — Account deployment (Example 1b).** A minimal smart account (Yul) whose VERIFY path checks an
owner signature over `TXPARAM(0x08)` and calls `APPROVE`. The owner is fixed in the initcode, so
anyone may deploy it. Deploy it *at `tx.sender`* in a DEFAULT frame through the CREATE2 deployer
(`0x4e59…956c` exists on the testnet; the EIP-7997 predeploy does not). The counterfactual address
has no code and no key, so prefund it with ETH first. Check: prefix shape `DeploySelfVerify`; the
front-running note (a replayed deploy frame fails once code exists, so the follow-up tx drops the
deploy frame); state gas for code deposit.

**03 — Atomic approve + swap (Example 2).** A toy ERC-20 and a toy DEX. Run the happy path, then make
the swap revert and confirm the approve is rolled back: frame statuses, `0x2` SKIPPED for frames
after the failure, the `gas_used.state` rollback and empty logs. Also check that APPROVE-scope flags
inside a batch are statically rejected.

**04 — Sponsored tx paying in ERC-20 (Example 3).** A sponsor contract whose `pay` frame
inspects the next frame (`FRAMEPARAM`, `FRAMEDATALOAD`), checks it is `transfer(sponsor, fee)`,
then calls `APPROVE(PAYMENT)`. A DEFAULT post-op frame reads `FRAMEPARAM(0x0A/0x0B)` (gas used) to
refund unused tokens. Mempool angle: the trace rules forbid reading the token's storage in VERIFY, so
the sponsor must trust the frame data (front-running risk noted in the EIP). A non-canonical
paymaster is limited to 1 pending tx. The on-chain tx `0xbd73cb7e…` (fixture) is a real instance of
this shape to compare against.

### After the examples (ideas, unordered)

- 💡 **EOA as paymaster** via default code: `[VERIFY(2)→sender, VERIFY(1)→gas-EOA, SENDER]` with the
  payer's signature at index 1. Two EOAs, no contracts.
- 💡 **Expiry verifier frame** `[VERIFY→0x8141 deadline, VERIFY(3), SENDER]`: before and after the
  deadline, and mempool eviction.
- 💡 **Keyed nonces (EIP-8250)**: several pending txs from one sender on disjoint keys; first-use state
  gas (97,920 per key); `TXPARAM 0x0D–0x10`.
- 💡 **P256 / passkey account**: scheme `0x2`, signer = `keccak(qx‖qy)[12:]`, protocol-verified (6,700 gas).
- 💡 **Post-quantum-ish custom verifier**: `ARBITRARY` signature + `SIGDATACOPY` + Lamport/hash-based
  check in VERIFY. Measure gas against `MAX_VERIFY_GAS`.
- 💡 **Introspection playground**: a contract that dumps every `TXPARAM`/`FRAMEPARAM`/`SIGPARAM` value
  from each mode, checked against the encoder's view of the tx.
- 💡 **Mempool rule probing**: banned opcodes in the prefix, storage reads outside the sender, prefix
  gas caps; compare simulation verdicts with `eth_sendRawTransaction`.
- 💡 **Local devnet**: ethrex + kurtosis (`fixtures/networks/hegota-testnet.yaml`) for experiments that
  would spam the shared testnet or need a controlled relaunch.

## Status log

- **2026-10-07**: Researched the wire format against ethrex source (`crates/common/types/transaction.rs`,
  `scripts/hegota-testnet/frametx.py`) and the pinned EIP texts. Built `tooling` (60 tests passing,
  including 18 mined txs). Ran experiment 01 on the testnet: 4 txs mined, all frames as expected; plain
  transfers are calldata-floor bound. Test account `0xa93CEe06b1e4fFACdf920BD500cb301a39DdEB74`
  (key only in a local, gitignored `.env`; make your own with `npm run account`).

## References

- EIP-8141 (pinned): https://github.com/ethereum/EIPs/blob/b75cbe6115/EIPS/eip-8141.md
- EIP-8250 (pinned): https://github.com/ethereum/EIPs/blob/f3079a09e8/EIPS/eip-8250.md
- ethrex testnet docs: https://github.com/lambdaclass/ethrex/tree/hegota-testnet/docs (`hegota-testnet-*.md`, `eip-8141.md`)
- Reference encoder/submitters: `ethrex/scripts/hegota-testnet/frametx*.py`
- Faucet and EIP guide: https://faucet.privacy.ethrex.xyz (`/eips`)
- Other implementations to cross-check: `JustaLab-co/frametx-kit` (TS), `polus-arcticus/awesome-frames` (Yul accounts, PQ toys)
- EELS implementation and tests: ethereum/execution-specs PR 3047
