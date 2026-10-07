# 13 — Social recovery: guardians, a delay, and nothing to say "not before"

The owner signs with one key. If that key is lost, guardians can hand the account to a new key,
two of three sufficing. The handover waits out a delay, and the current owner can cancel during
it. This is the usual ERC-4337 social-recovery module. Under EIP-8141 it fits in one account, with
the guardians' approval in the protocol's signature list.

[`RecoveryAccount.yul`](RecoveryAccount.yul) accepts three kinds of transaction:

| Signed by | VERIFY frame data | Allowed frames after VERIFY | Effect |
|---|---|---|---|
| the owner (slot 0) | empty | anything | |
| $m$ guardians, ascending, `msg` ∅ | `salt ‖ m ‖ guardians` (the reveal) | exactly one SENDER to self: `0x01 ‖ newOwner` | pending = newOwner, unlock = now + `DELAY` |
| the pending owner | empty | exactly one SENDER to self: `0x02` | owner = pending, if now $\ge$ unlock |

The owner also has `0x03` (cancel) and `0x04` (replace the guardian commitment). The account
stores only

$$\mathrm{commitment} = \mathrm{keccak256}(\mathrm{salt} \parallel m \parallel g_1 \parallel \dots \parallel g_n).$$

So the guardians are not on chain until they act, and the salt stops anyone confirming a guess at
who they are.

| File | What |
|---|---|
| [`RecoveryAccount.yul`](RecoveryAccount.yul) | v2: owner, commitment, and one recovery slot `pending (20) ‖ unlock (12)` that holds 1 when nothing is pending and never returns to zero. 709 B runtime followed by `DELAY` (741 B) |
| [`RecoveryAccountV1.yul`](RecoveryAccountV1.yul) | v1, which the first run used: pending owner and unlock time in two slots, cleared at the end of each recovery. 722 B |
| [`recovery.ts`](recovery.ts) | Keys derived from `PRIVATE_KEY` (alice, the new device, g1-g3, a thief), `reveal`, `commitment`, `recoveryAccount`, `initiate`, `accountTx`, `readState` |
| [`example-recovery.ts`](example-recovery.ts) | Setup, then A-F on the testnet (`--v1` for the first version) |
| [`negative.ts`](negative.ts) | 17 cases against v2, simulated |

## Run

```bash
npx tsx experiments/13-social-recovery/example-recovery.ts        # v2: setup, A-F (waits out the 60 s delay)
npx tsx experiments/13-social-recovery/example-recovery.ts --v1   # the first version
npx tsx experiments/13-social-recovery/negative.ts                # simulations against v2
```

Each version's account can be recovered once, because A-F leave it owned by the new key.
`DELAY` is 60 s here; days in practice.

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

v2 account `0xFc47a15216A85242705355eF416c25018A179D68`, v1 account
`0xc75be79D691876E4807471d151379BeC231dcE25`.

| Step | v2 tx | v2 frames: execution / state | v2 `gasUsed` | v1 tx | v1 `gasUsed` |
|---|---|---|---|---|---|
| setup: the funder deploys and funds | [`0xdb1815fd…`](https://dora.privacy.ethrex.xyz/tx/0xdb1815fdf33e606646f9f08cd3f4212f1d73e216b0c8cb73f71e35ff335eef91) | deploy 52,141/1,611,090 (3 slots) | 1,699,741 | [`0xb3ec8cda…`](https://dora.privacy.ethrex.xyz/tx/0xb3ec8cda7a1f14bfbb5914c228093e6b01680c01e2547048c07c46be4ad0eb5a) | 1,565,717 |
| **A.** owner pays | [`0x5786f2e2…`](https://dora.privacy.ethrex.xyz/tx/0x5786f2e2df2fc320e1f8e5a41faf279f68d11331d0c85d9b623c13d16d437eb9) | VERIFY 2,404 · pay 3,000 | 28,562 | [`0x4e12d85f…`](https://dora.privacy.ethrex.xyz/tx/0x4e12d85fee7de68b3843475c7e01d320314e465d07437813bc35557ec71565ab) | 28,550 |
| **B.** guardians 1 and 3 start a recovery to the new key | [`0xfd663ca6…`](https://dora.privacy.ethrex.xyz/tx/0xfd663ca66585d808c2fbbec69e0a3a02d4baa435f5bc7ba8e3e82b21a67972f8) | VERIFY **3,766** · start 12,452/**0** | **39,348** | [`0x6b5f0243…`](https://dora.privacy.ethrex.xyz/tx/0x6b5f024336eb1bd7cba74ae5ea6f8e2a1d630151249586e56fad42195f735a88) | **247,246** (start 24,522/195,840) |
| **C.** new key finishes 6 s into the 60 s delay: included, finish frame reverts | [`0xcf793fa5…`](https://dora.privacy.ethrex.xyz/tx/0xcf793fa5cd962a9282e299a19f96198d6c6dcf90100b2739eec3a44c048128be) | VERIFY 4,745 · finish 412 **FAILURE** | 22,319 | [`0x81669417…`](https://dora.privacy.ethrex.xyz/tx/0x81669417973b5682444784e95c5d43695f4855b7e7561fcdf75b1046fa1b9b5d) | 24,398 |
| **D.** new key finishes after the delay | [`0x75b9fae8…`](https://dora.privacy.ethrex.xyz/tx/0x75b9fae8678a950fbae9baa03a8cde5077e7fec7aba6246ec5afd2c312a48fc9) | VERIFY 4,745 · finish 20,623 | 42,530 | [`0x37b9884b…`](https://dora.privacy.ethrex.xyz/tx/0x37b9884bf42a0b2b66d61aa7b6438d4bae3545ff05884d8956e24d4afa960b69) | 43,761 (refund) |
| **E.** new owner pays; the lost key is refused | [`0x7e7f0d83…`](https://dora.privacy.ethrex.xyz/tx/0x7e7f0d836fda3f0785ccecebad64c4f9a22088ad2918fc9b88b5a7008e16f3b6) | VERIFY 2,404 · pay 3,000 | 28,562 | [`0x0fa9ce58…`](https://dora.privacy.ethrex.xyz/tx/0x0fa9ce58662705c83084db0b9cffd7c9e91de684c13b534855661158f6b59a36) | 28,550 |
| **F.** guardians 1 and 2 start a recovery to a thief's key | [`0xa625cf0b…`](https://dora.privacy.ethrex.xyz/tx/0xa625cf0bf4f55a8a3ccdb013d22f62c4f55adcdee3c0973e95b8747cf1cc0cc2) | VERIFY 3,766 · start 12,452/0 | 39,348 | [`0x427dd098…`](https://dora.privacy.ethrex.xyz/tx/0x427dd098d8f97de48266b3dd4801169de6ff0974c14e647ca4b735b579af10cc) | 247,246 |
| **F.** owner cancels; the thief's finish is then refused at VERIFY | [`0xa48badb6…`](https://dora.privacy.ethrex.xyz/tx/0xa48badb6a22156bc31ca0d4ed82d40d7e06e76476a46c921dbe6368b490ffb29) | VERIFY 2,404 · cancel 12,373 | 31,939 | [`0x1746a1a6…`](https://dora.privacy.ethrex.xyz/tx/0x1746a1a68f68281cfd0f700a3e0395358dd8be312c5a17a99a5079a08a12cb37) | 35,235 (refund) |

### Refusals (`negative.ts`, v2, simulated)

| Case | valid | Node says |
|---|---|---|
| owner pays (baseline) | true | |
| guardians 1 and 3 start a recovery (baseline) | true | |
| guardians 2 and 3 start a recovery | true | |
| guardian 1 alone | false | `validation prefix frame reverted` |
| guardian 1 alone, revealing $m = 1$ | false | prefix reverted (commitment mismatch) |
| guardian 1 twice | false | prefix reverted |
| guardians 1 and 3 in descending order | false | prefix reverted |
| guardian 1 and an outsider | false | prefix reverted |
| the right guardians, wrong salt | false | prefix reverted |
| the right guardians, a list with one extra address | false | prefix reverted |
| guardians pay out instead | false | prefix reverted |
| guardians start a recovery and pay out | false | prefix reverted |
| guardians start a recovery to address 0 | false | prefix reverted |
| guardians replace the guardian commitment | false | prefix reverted |
| guardians finish a recovery | false | prefix reverted |
| an outsider finishes (none pending) | false | prefix reverted |
| the old, lost key pays | false | prefix reverted |

## Observations

1. **VERIFY can bound time from above and never from below.** `TIMESTAMP` is banned in VERIFY, and
   the expiry verifier frame gives an upper bound only. Nothing lets VERIFY say "not before
   unlock", so the delay is enforced in execution. In C, the new key's early finish was valid at
   admission, was included, reverted in its finish frame, and cost the account 22,319 gas. Only the
   pending owner, whom $m$ guardians chose, can do this. Other designs would need the same thing:
   a timelocked admin action, a vesting release, the `DELAY` of the canonical paymaster's
   withdrawal (experiment 09). A "not before" counterpart of the expiry verifier would let VERIFY
   refuse such a transaction outright. That is a candidate for feedback on the EIP, not something
   tested here.

2. **Clearing a slot is expensive when it will be written again.** v1 clears the pending owner and
   unlock time when a recovery ends, so the next start writes two fresh slots: 195,840 state gas,
   247,246 gas in all. v2 packs both into one slot that holds 1 when idle, and never lets it reach
   zero, so a start is a non-zero to non-zero write: 39,348 gas, 84% less. The constructor pays
   for the slot once. Clearing earns a refund capped at a fifth of the gas used, and a refill in a
   later transaction is charged in full. ERC-4337 modules ported to frames should be checked for
   storage they clear and later rewrite. Experiment 12 uses the same idea (`1 + spent`).

3. **The guardians stay private until they act, and acting reveals them.** The commitment is
   salted, so the account says nothing about who the guardians are, unlike an account that stores
   their addresses. A recovery transaction publishes the whole list in its VERIFY data, and its
   signature entries name the two guardians who signed. After any recovery, the new owner should
   replace the commitment (`0x04`) with a fresh salt. A guardian set run as a FROST group
   (experiment 07) would reveal neither the list nor the signers, at the cost of the guardians
   holding shares rather than their own keys.

4. **A lost key is recovered; a stolen one is not.** The current owner's cancel beats any recovery,
   which is what saves the account from hostile guardians in F. A thief holding a stolen owner key
   can cancel every legitimate recovery the same way. This design suits a lost key only; a stolen
   key needs guardians who can also freeze the owner. The race is the same as experiment 12's: one
   pending transaction per sender, so a cancel and a finish at the same nonce are settled by
   replacement and fees.

5. **Guardians spend the account's ETH.** The guardian path approves whatever scope its frame asks
   for, so the account pays for its own recovery. That is convenient when the owner is gone, but
   hostile guardians can repeat F and make the owner pay 39,348 gas each time and again to cancel
   (247,246 under v1). Requiring the guardian path to approve EXECUTION only, with a guardian as
   payer, would move that cost onto them. That is not tested here.

6. **A rotatable owner costs about 2,100 gas per transaction.** VERIFY reads the owner from storage
   (2,404 gas) where an owner in code costs 340 (experiment 12). Every transaction pays for the
   option of a recovery. Experiment 08 measured the alternative, a code commitment behind a proxy,
   together with what a storage read in the prefix costs in mempool concurrency.
