# 09 — Paymasters in the public mempool: canonical, copied, code-less, and a multisig treasury

Who may pay for someone else's frame transaction, and how many such transactions the public
mempool will hold at once. EIP-8141 answers with three tiers:

- **The canonical paymaster.** Many instances may exist, each recognised by its runtime code hash.
  It is exempt from the validation-trace rules and is bounded only by its balance, minus what
  pending transactions have reserved and any pending withdrawal.
- **Any other paymaster contract.** It is subject to the trace rules and is capped at
  `MAX_PENDING_TXS_USING_NON_CANONICAL_PAYMASTER = 1` pending transaction.
- **A code-less sponsor** (default code). The EIP says it "is not a paymaster and is governed by the
  per-payer exposure rule alone".

The pinned EIP text leaves the canonical paymaster unspecified. ethrex implements
[ethereum/EIPs#12041](https://github.com/ethereum/EIPs/pull/12041), which pins a 355-byte runtime
with hash `0xda42f0d1…c4d45c`. Under that runtime, the signer lives in slot 0, a pay frame needs
signature entry 1 by that signer over the sig hash, and withdrawals and signer rotation wait
`DELAY = 86400` s. [`CanonicalPaymaster.yul`](CanonicalPaymaster.yul) is only initcode. It writes
the signer to slot 0 and returns the PR's runtime bytes verbatim. The deployed code hashes to the
pinned value.
[`NonCanonicalPaymaster.yul`](NonCanonicalPaymaster.yul) appends one unreachable zero byte to the
same runtime. It behaves identically and has a different hash. [`Multisig.yul`](Multisig.yul) is
experiment 05's 2-of-3 account, unchanged, used as a treasury that pays for its members.

| Frame | Mode   | Flags             | Target        | Signatures                                   |
| ----- | ------ | ----------------- | ------------- | -------------------------------------------- |
| 0     | VERIFY | APPROVE_EXECUTION | Null (sender) | entry 0: the user, via default code          |
| 1     | VERIFY | APPROVE_PAYMENT   | payer         | entry 1 (and 2): the payer's signer(s), msg ∅ |
| 2     | SENDER | -                 | funder        | a 0-value call: these users hold no ETH      |

## Run

```bash
npx tsx experiments/09-paymasters/canonical.ts   # A-F: deploy both instances (once), then the bursts
npx tsx experiments/09-paymasters/treasury.ts    # the 2-of-3 treasury as payer
npx tsx experiments/09-paymasters/replace.ts     # a self-paid transaction replaced by a sponsored one
```

Users, the sponsor key and the treasury owners are derived from `PRIVATE_KEY`. The sponsor key never
needs ETH to authorise payments. It holds some only because B3 uses it as a code-less sponsor and D
uses it to send admin calls.

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

### Who can sponsor several users at once

Four users with no ETH send at once, within one slot, each through the same payer:

| Payer | Admitted | Refused with |
|---|---|---|
| **B1.** canonical instance `0xBa19…B994` (code hash = pinned) | **4 of 4**, all mined in block 304984 ([`0xf2c01318…`](https://dora.privacy.ethrex.xyz/tx/0xf2c01318a275b98b6ac01b82191a1cf04054a042d5f236c7620c1cf5ff34f772) is one) | |
| **B2.** byte-different copy `0xbCE6…5fc2` (same behaviour, other hash) | **0 of 4** | `validation-prefix simulation failed: StorageReadNonSender` |
| **B3.** the sponsor key's EOA, default code | **1 of 4** ([`0xfde5cf2a…`](https://dora.privacy.ethrex.xyz/tx/0xfde5cf2a22d33ef73f0bf3f3622e79119ae2168e8ca5729f55571dfb11357363)) | `Non-canonical paymaster already sponsors the maximum number of pending frame transactions` |
| 2-of-3 multisig treasury (`treasury.ts`) | **1 of 2** | the same cap message |

### Reservation and withdrawals

| Case | Admitted | |
|---|---|---|
| **C.** a fresh canonical instance funded with exactly 2.5 transactions' max cost, three transactions at once | **2 of 3** | the third: `paymaster has insufficient balance to cover the reserved max cost` |
| **D.** the main instance after `op 0x01` (withdrawal) left balance − pending withdrawal = 1.5 transactions' max cost; two transactions at once | **2 of 2** | ethrex does not subtract slot 1 |

D's setup and cleanup are [`0x243ea126…`](https://dora.privacy.ethrex.xyz/tx/0x243ea12619fcb73314328bb24f3153b318a59940a00d43ebe98ee676a7f6f920),
the signer initiating a withdrawal (29,543 execution, 195,840 state for slots 1 and 2), and
[`0x2f734f97…`](https://dora.privacy.ethrex.xyz/tx/0x2f734f97812a2b362e6516741edfa5a657aa7194120528e053f3b44cfb8996b7),
the signer cancelling it (`op 0x03`, 38,792 gas after the refund for clearing both slots).

### Gas

| Tx | What | Frames: execution / state | `gasUsed` |
|---|---|---|---|
| [`0x2a0afccf…`](https://dora.privacy.ethrex.xyz/tx/0x2a0afccfa97f205307000a87a6baaf5f0a46a7b62b6a8c5dbdc052c009b9d140) | **A.** new user, canonical paymaster | only_verify 100 · pay **5,210**/183,600 · op 3,000 | 213,347 |
| [`0xa9320bf8…`](https://dora.privacy.ethrex.xyz/tx/0xa9320bf8b3930c0bbd3d14ae78f0d12898fa1e5105fb778f6098b62a028b87d7) | existing user, canonical paymaster (C) | 100 · **5,210** · 3,000 | 29,771 |
| [`0xfde5cf2a…`](https://dora.privacy.ethrex.xyz/tx/0xfde5cf2a22d33ef73f0bf3f3622e79119ae2168e8ca5729f55571dfb11357363) | new user, code-less sponsor (B3) | 100 · **3,000**/183,600 · 3,000 | 212,417 |
| [`0xf32a1681…`](https://dora.privacy.ethrex.xyz/tx/0xf32a16816d3c288372d0ba1715d147eca2ac602525818b0131983d282ff3aaa4) | new member, 2-of-3 treasury (alice + carol) | 100 · **4,413**/183,600 · 3,000 | 220,657 |
| [`0xda25878b…`](https://dora.privacy.ethrex.xyz/tx/0xda25878b5f7142f8b8bf6c1b112dfa5c157e472e17f58feb35905fd6de280640) | existing user, replacement sponsored by the canonical paymaster (below) | 100 · 5,210 · 3,000 | 29,771 |

The canonical pay frame costs 5,210: 3,000 for cold access to the paymaster, 2,100 for the cold
`SLOAD` of slot 0, and about 110 for the rest. The same user paying for itself, with no pay frame
and no second signature, costs 20,102. Sponsorship therefore adds **9,669** gas:

- the 5,210 pay frame;
- a second secp256k1 entry, 2,800;
- the 475 per-frame cost;
- the extra calldata.

A user's first transaction also pays 183,600 state gas, charged to the pay frame, because
`APPROVE(PAYMENT)` creates the user's account.

### E. The 15,000 gas guidance

The PR says a canonical pay frame needs at most 15,000 and that nodes MAY reject a higher limit as
non-canonical usage. ethrex's simulation accepts limits of 10,000, 15,000, 15,001 and 50,000 alike.
The frame uses 5,210 in every case.

### F. Refusals (simulated)

| Case | valid | Node says |
|---|---|---|
| baseline | true | |
| entry 1 signed by a stranger | false | prefix reverted (slot 0 is not the signer) |
| no entry 1 | false | prefix reverted (`SIGPARAM` out of bounds halts) |
| entry 1 is ARBITRARY | false | prefix reverted |
| entry 1 by the signer over an explicit digest | false | prefix reverted (`msg` must be empty) |
| pay frame with data (`0x03`, an admin op) | false | prefix reverted |
| pay frame before only_verify | false | `validation prefix does not match any recognized shape` |

### Replacing a pending transaction with a sponsored one (`replace.ts`)

Three transactions with the same `(sender, nonce)` were sent within one slot:

| # | What | fees (tip / max, wei) | Result |
|---|---|---|---|
| 1 | the user pays for itself | 1000 / 2014 | accepted, then replaced: no receipt |
| 2 | sponsored by the canonical paymaster, +5% | 1050 / 2115 | `Attempted to replace a pooled transaction with an underpriced transaction` |
| 3 | sponsored by the canonical paymaster, +10% rounded up | 1100 / 2216 | accepted, mined, **payer = the paymaster** ([`0xda25878b…`](https://dora.privacy.ethrex.xyz/tx/0xda25878b5f7142f8b8bf6c1b112dfa5c157e472e17f58feb35905fd6de280640)) |

A first attempt rounded the bump down: max fee 2215, which is 9.98% above 2014. It was refused
like the +5% one, and transaction 1 was mined. The node requires each fee to rise by at least 10%,
exactly.

## Observations

1. **Recognition is by code hash and nothing else.** The copy behaves exactly like the canonical
   paymaster. One extra unreachable byte still puts it under the generic trace rules, and there its
   `SLOAD` of its own signer slot is a read outside `tx.sender`, so it is refused outright
   (`StorageReadNonSender`), not merely capped. A paymaster that keeps any configuration in storage
   cannot use the public mempool unless it is canonical. One that keeps its configuration in code,
   like the treasury, passes the trace rules and is capped at one pending transaction.
2. **The canonical paymaster is the only payer that serves many users at once.** Four users went
   into one block through one instance. Everything else, the code-less EOA included, is capped at one
   pending transaction per payer.
3. **A code-less sponsor is capped like a paymaster.** The EIP exempts the empty code hash from the
   cap ("not a paymaster … governed by the per-payer exposure rule alone"), and ethrex caps it
   anyway. The `aa` repository measured the same on chain 81410. This confirms it on the Hegota
   testnet with the current client. It is the tier that matters most for "a gas account that pays
   for my other accounts", which is the EIP's own motivation for non-canonical payers.
4. **Reservation works; a pending withdrawal is ignored.** Funded for 2.5 transactions, an instance
   admitted 2 of 3. After a withdrawal was initiated it still admitted 2 of 2, against
   `available = balance − reserved − pending_withdrawal_amount`, which allowed only one. This matches
   the ethrex note that it has "no paymaster withdrawal queue" and treats the pending amount as 0. The
   exposure is bounded by `DELAY`: a pending transaction is invalidated only if somebody finalises
   the withdrawal while the transaction waits, and that cannot happen before 86,400 s have passed.
5. **The canonical paymaster is a verifying paymaster.** The sponsor's signer co-signs each
   transaction's sig hash, so the sponsor decides per transaction, off chain, and the chain needs no
   policy code. It also answers experiment 04's open problem: a token sponsor that cannot check a
   balance during validation can instead decline to sign. The PR's own security note applies: a
   stolen signer key drains the instance through self-sponsored transactions. Payments are not
   timelocked, only withdrawals and rotations are. Any protocol-verified scheme can be the signer.
   A P256 device key (experiment 11) works without a new canonical version, and so does a
   threshold-ECDSA group, whose output is an ordinary SECP256K1 signature. A FROST group key does
   not: experiment 07 carries its Schnorr signature in an ARBITRARY entry, and the pay frame
   refuses an ARBITRARY signer entry. (Amended after experiment 07; this note first named that
   experiment's threshold key as a possible signer.)
6. **A multisig treasury pays for one member at a time.** Its pay frame costs 4,413 gas for two
   owners and reads only its own code. As a non-canonical payer, however, it holds one pending
   transaction. To serve many members at once, the treasury would fund a canonical instance whose
   signer is a single key, for example one held by the owners as a threshold-ECDSA key (not FROST,
   see observation 5). Changing that key is a signer rotation, which also waits `DELAY`.
7. **The payer can change on replacement.** A pending self-paid transaction was replaced by a
   sponsored one at the same nonce, as the EIP allows. The bump has to be at least 10% on both fees,
   and a wallet that rounds down by one wei gets "underpriced".
8. **Admin calls are expensive in state gas.** Initiating a withdrawal writes two fresh slots
   (195,840 state gas). Cancelling clears them, but across transactions only the EIP-3529 refund
   comes back, not the state gas.
