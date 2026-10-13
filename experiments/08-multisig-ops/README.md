# 08 — Operating a multisig: proxies, parallel proposals, fee bumps, cancellation, rotation

Experiment 05 showed that a k-of-n account can let the protocol verify its owners' signatures and
merely count them. This experiment covers what running such an account involves day to day, and it
takes in what the plan called 05b: a counterfactual multisig small enough to deploy itself through
the public mempool.

The owner set moves out of the account's code and into the `VERIFY` frame's data. The account keeps
only a 32-byte commitment to it, and the counting logic lives in one shared implementation behind a
tiny proxy:

| Contract | Code | Role |
|---|---|---|
| [`MultisigImpl.yul`](MultisigImpl.yul) | 297 B initcode, deployed once | checks `keccak256(k ‖ owners) == commitment`, counts distinct owners among the sig-hash entries (as in 05), `APPROVE`s; a SENDER self-call `0x01 ‖ commitment` rewrites slot 0 |
| [`CodeProxy.yul`](CodeProxy.yul) | **108 B** deployed (44 B runtime + implementation + commitment) | `DELEGATECALL`s the implementation, appending the commitment **from its code** |
| [`StorageProxy.yul`](StorageProxy.yul) | **76 B** deployed (44 B runtime + implementation), commitment in slot 0 | the same, appending the commitment **from slot 0** |

`APPROVE` works through the `DELEGATECALL` because `ADDRESS` is still the account. The EIP spells
this out and warns that delegatecalled code is therefore fully trusted.

| Frame | Mode    | Flags                         | Target        | Data                          | Signatures      |
| ----- | ------- | ----------------------------- | ------------- | ----------------------------- | --------------- |
| (0)   | VERIFY  | 0                             | EXPIRY        | deadline                      | (E)             |
| (0)   | DEFAULT | -                             | CREATE2       | salt ‖ initcode               | (A)             |
| 0     | VERIFY  | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | `k ‖ owner_0 ‖ … ‖ owner_{n-1}` | k owners, msg ∅ |
| 1…    | SENDER  | -                             | …             | the proposal's calls          |                 |

Each proposal can use its own EIP-8250 nonce key. Its first use creates the key's slot in the nonce
manager, 97,920 state gas charged to the `VERIFY` frame whose `APPROVE` increments it.

## Run

```bash
npx tsx experiments/08-multisig-ops/ops.ts           # setup (once), then A-F
npx tsx experiments/08-multisig-ops/ops.ts B C       # any subset
```

The owners (`alice`, `bob`, `carol`, `dave`) are derived from `PRIVATE_KEY`. Both accounts start as
2-of-3 {alice, bob, carol}. F rotates the storage account between that set and {alice, bob, dave}, in
whichever direction is due.

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

Implementation `0x7dc4b1e7f58Fcd10739Ce24607C2Ef42c492441b`, code account
`0xd4A1c87e84db9E01389EBb12EaE79f70665Ef6eb`, storage account `0x142595Aa3B3F8a395cf2Fee5a16e6C6547542084`.

### A. Each account deploys itself in its first transaction

| Tx | Account | Frames: execution / state | `gasUsed` |
|---|---|---|---|
| [`0x10ad8869…`](https://dora.privacy.ethrex.xyz/tx/0x10ad88695c05ee04d241ef916e265bf54ae58e099c594246af209d2f176a3ec7) | code | deploy 15,241/**165,240** · VERIFY **4,262** · transfer 3,000 | 218,920 |
| [`0x0abd7a22…`](https://dora.privacy.ethrex.xyz/tx/0x0abd7a2213ae394785115a334407cb4390818cb5699e08bf4d7f73f4ddc0b7a7) | storage | deploy 27,358/**214,200** (76 B + slot 0) · VERIFY 4,353 · transfer 3,000 | 280,272 |

Both were admitted as `DeploySelfVerify`. Experiment 05's 2-of-3 account carries its owners in code
(383 B) and cannot do this: `MAX_VERIFY_STATE_GAS` stops a self-deploy at 206 B of code, or 326 B if
the address is prefunded. A proxy's size does not depend on n, because the owners travel in each
`VERIFY`'s data at 20 bytes apiece.

### B. Two proposals at once, on disjoint fresh nonce keys

| Account | Proposal 1 | Proposal 2 |
|---|---|---|
| code (commitment in code) | mined in block 305056 ([`0xe23a53ac…`](https://dora.privacy.ethrex.xyz/tx/0xe23a53ac89083daba2bc29180bcf0ea2eeb675cdd2f9a18b4327d681c71dacfc)) | **mined in the same block** ([`0xa55459ce…`](https://dora.privacy.ethrex.xyz/tx/0xa55459ce89b77d51fdd50790eca52d5382c2e1d91f87ae211e3cedaee66b4c38)) |
| storage (commitment in slot 0) | mined in block 305057 | **refused**: `A pending frame transaction from this sender is already in the pool` |

Each proposal's `VERIFY` paid 97,920 state gas for its fresh key. The code account's verify used 4,262
execution gas and the storage account's 6,353, the difference being the cold `SLOAD`.

### C. A fee bump on a pending proposal

A proposal on a fresh key was sent at tip/max 1000/2014 wei. Within the same slot:

| Version | Result |
|---|---|
| fees raised to 1100/2216, **old signatures** | the sig hash moved (`0x54dfab22…` → `0x5cecc035…`). Simulation: `frame signature list does not authenticate the sender`; send: `Invalid frame transaction signature` |
| fees raised to 1100/2216, **re-signed by both owners** | accepted; replaced the original, which never got a receipt. Mined: [`0x39cc39d6…`](https://dora.privacy.ethrex.xyz/tx/0x39cc39d67b050cb9770ca5a4da2e0aa17456d50aeac4b779c0aafa8cfc7a3a90) |

### D. Cancelling a proposal that was signed and never sent

The owners spent its nonce key with a `VERIFY`-only transaction,
[`0x05a342d3…`](https://dora.privacy.ethrex.xyz/tx/0x05a342d384c75e9ef56764d99b69eaa07bd725f88d063aab4dfdcba3eccb9675),
which cost 132,955 gas, 97,920 of it the key's first use. The signed proposal then simulates as
`Nonce mismatch: expected 1, got 0`.

### E. A proposal with a deadline

[`0x87eb8274…`](https://dora.privacy.ethrex.xyz/tx/0x87eb827484c3b9e07f91e8ed2eec41cb31c895cd1550614e90fd9c1574e71e92)
has an expiry frame (3,051), then the keyed `VERIFY` (4,262 / 97,920), then the transfer. Experiment 10
covers expiry in detail.

### F. Rotating the owner set (storage account)

| Tx | What | Frames | `gasUsed` |
|---|---|---|---|
| [`0x327eaf95…`](https://dora.privacy.ethrex.xyz/tx/0x327eaf95192e82e3695ec84febfc4a4bbde67416f8fbabc3a9b1931cde9ce5d5) | alice + bob approve a SENDER self-call `0x01 ‖ commitment({alice, bob, dave})` | VERIFY 6,353 · self-call 10,610 | 39,737 |
| (simulated) | a transfer by the **old** set | `validation prefix frame reverted` | |
| [`0x642c7f12…`](https://dora.privacy.ethrex.xyz/tx/0x642c7f1207ae63027675b868e52061fb6d36a9ed8c4a009665b6d2aa3c7ba7a1) | a transfer by dave + alice, from the **new** set | VERIFY 6,442 · transfer 3,000 | 39,526 |

## Observations

1. **Where the commitment lives decides between concurrency and rotation.** With the commitment in
   code, the validation prefix reads no sender storage, and ethrex's keyed-concurrency rule then
   admits proposals on disjoint keys side by side: two were mined in one block. With the commitment
   in storage, the owners can rotate, but the prefix reads slot 0 and the account is back to one
   pending transaction. A Safe-style queue of many live proposals needs an immutable owner set, so
   rotation becomes a migration to a new address. A rotatable account queues its proposals one at a
   time.
2. **A proxy makes a counterfactual multisig fit the public mempool.** 108 B or 76 B of code deploy
   in the account's own first transaction whatever n is, where experiment 05's account was out of
   reach. The costs are a cold `DELEGATECALL` (VERIFY 4,262 here against 1,129 in 05) and 20 bytes
   of calldata per owner in every transaction.
3. **A fee bump means signing again.** The fees are inside the sig hash, so new fees with the old
   signatures are an invalid transaction, refused before simulation. Every one of the k owners has
   to sign again before a stuck proposal can be repriced. A practical workaround is to sign a fee
   ladder up front: the same proposal at several fee levels at least 10% apart, each a valid
   replacement for the one below. That is the `aa` repository's Q13, now measured.
4. **Cancelling costs a transaction.** A signed proposal stays valid until its nonce is spent. The
   owners do that on chain, and on a fresh key the first use alone costs 97,920 state gas. Reusing
   one key for proposals that are meant to run in order avoids the charge.
5. **Keyed nonces give an unordered queue.** Proposals on different keys execute in whichever
   order they arrive, unlike Safe's single nonce. Proposals on one key are strictly ordered by
   `nonce_seq`.
6. **Rotation is one approved self-call.** The account approves a `SENDER` frame to itself, and the
   implementation accepts it because `CALLER == ADDRESS`. The old set's signed proposals stop
   validating as soon as it is mined. Owners who are removed lose their power at that moment. There
   is no timelock unless the implementation adds one; experiment 13 (social recovery) needs one.
