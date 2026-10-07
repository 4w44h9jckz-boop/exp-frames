# 16 — Subscriptions: the merchant pulls, and pays to pull

A subscription is a standing permission to take a fixed amount every period. Under ERC-4337 the
merchant holds a session key or a module grant and submits a UserOperation through a bundler.
The gas is paid by the account itself, or by a paymaster contract that holds a deposit in the
EntryPoint. With frames the merchant can send the pull *from the account*, and pay for it from its
own EOA through the default code. That needs no paymaster contract, no deposit and no bundler.

[`SubscriptionAccount.yul`](SubscriptionAccount.yul) has its owner key in code. It stores each
subscription at `keccak256(m)` as `amount (16) ‖ period (8) ‖ next due (8)`. A pull is three
frames:

| Frame | Mode | Target | Scope | Data | Checked by |
|---|---|---|---|---|---|
| 0 | VERIFY | the account | EXECUTION | | the account: shape, signer, nonce key; no storage |
| 1 | VERIFY | merchant `m` | PAYMENT | | `m`'s default code, signature entry 1 |
| 2 | SENDER | the account | | `0x03 ‖ m` | the account, in execution: subscribed, due; pays `m` |

`nonce_keys = [m]`, so each merchant has its own nonce lane in the account. Both signature
entries are `m`'s secp256k1 signature over the canonical hash. The account never runs ecrecover:
the protocol verified entry 0 as a SECP256K1 entry, and VERIFY only reads its signer with
`SIGPARAM`.

The account's VERIFY reads no storage. It accepts a pull when:

- it is frame 0, approving EXECUTION only;
- there are exactly three frames;
- frame 1 is a PAYMENT VERIFY whose target is the signer of entry 0;
- frame 2 is a SENDER frame to the account with no flags, no value and the 21 bytes `0x03 ‖ signer`;
- the transaction uses one nonce key, equal to the signer (`TXPARAM(0x0E)`, `TXPARAM(0x10)`).

Everything that needs state is checked in execution: whether `m` is subscribed, whether the
period has passed, and the payment itself. When the signer is the owner, VERIFY approves whatever
scope the frame asks for, as in experiment 12.

| File | What |
|---|---|
| [`SubscriptionAccount.yul`](SubscriptionAccount.yul) | The account: 460 B of runtime plus the owner, 492 B deployed |
| [`subscription.ts`](subscription.ts) | Keys, the CREATE2 address, `subscribe` / `cancel` frames, `readPlan`, `pullTx`, `ownerTx` |
| [`example-subscriptions.ts`](example-subscriptions.ts) | Setup, then 1 and A-E |
| [`concurrency.ts`](concurrency.ts) | Which transactions from the one account may wait in the pool together: C2-C4 |
| [`negative.ts`](negative.ts) | What VERIFY refuses and what it leaves to execution (simulation only) |

## Run

```bash
npx tsx experiments/16-subscriptions/example-subscriptions.ts   # setup (once), then 1 and A-E
npx tsx experiments/16-subscriptions/concurrency.ts             # after the example; waits until both merchants are due
npx tsx experiments/16-subscriptions/negative.ts                # simulation only
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

The parties:

- alice, the owner: `0x03789bDfCD676daccdedbc3Ec5903D02A6d597F9`;
- her SubscriptionAccount: `0x675717a98724E7A5C2B599a092Cd7dca7F9191e7`;
- merchant 1: `0x4ca59347039923965bDB70de38e849Aa3ebd8E52`;
- merchant 2: `0xD32e0973aAbcf4c54aa41fD884f022893ea5F69F`.

Both subscriptions are for 0.0001 ETH every 30 s, first due at once.

| Tx | What | Pays | Frames (gas) | `gasUsed` |
|---|---|---|---|---|
| [`0xdb62d505…`](https://dora.privacy.ethrex.xyz/tx/0xdb62d5052ff913d25e85dee70dcbf2c8ae9ae3260268e8b34bb7f0c792b0657b) | setup: deploy the account, fund it and both merchants | funder | | 1,378,095 |
| [`0xd7ae77c3…`](https://dora.privacy.ethrex.xyz/tx/0xd7ae77c38a43b31b4788deb8aa5a0d7135043133aceae6e04f850af66d288df3) | **1.** alice subscribes merchants 1 and 2 (two fresh slots) | account | 334, 12,416, 12,416 | 239,807 |
| [`0xa427233c…`](https://dora.privacy.ethrex.xyz/tx/0xa427233c33d49cbd1b769eced2fb57e542d6ac211f278107a7088ce70080b37b) | **A.** merchant 1 pulls, the first use of its lane | merchant 1 | 705, 3,000 + 97,920, 21,818 | 145,868 |
| [`0x9247ec31…`](https://dora.privacy.ethrex.xyz/tx/0x9247ec31a7e230342f7fac474ba5bbe2681930a973eb51d0dcb5ba8c7ef875f3) | **B.** merchant 1 pulls again at once: not due, frame 2 reverts | merchant 1 | 705, 3,000, **2,514 ✗** | 32,721 (floor) |
| [`0x0d41c2ac…`](https://dora.privacy.ethrex.xyz/tx/0x0d41c2ac1a614853f9394844984136fc7904d8bee9f2e8227558b73ea9caa0fe) | **C.** alice pays someone on key 0; both pulls sent with it are refused (observation 4) | account | 334, 3,000 | 27,382 |
| [`0xb30b839b…`](https://dora.privacy.ethrex.xyz/tx/0xb30b839b162498ffe113ee7a1b0f300f6dbdf37d822f716fbe910defcb8d8b4e) | **D.** merchant 1 pulls after the period | merchant 1 | 705, 3,000, 21,818 | **47,948** |
| [`0xbb32f1fe…`](https://dora.privacy.ethrex.xyz/tx/0xbb32f1fe1431716a3c9602b731bb995fb68e1d7f8d4300596268cdf357f5cc25) | **E.** alice cancels merchant 2 (refund capped at a fifth) | account | 334, 12,434 | 24,191 |
| [`0x3f605bae…`](https://dora.privacy.ethrex.xyz/tx/0x3f605baea3e18b4d6585173f65ab1750d0663a07f735dd8b1918d6b6a8d33da1) | **E.** merchant 2 pulls after cancellation, the first use of its lane: frame 2 reverts | merchant 2 | 705, 3,000 + 97,920, **2,493 ✗** | 130,641 |

A successful pull costs the merchant 47,948 gas, and 145,868 the first time it uses its lane in
an account:

| Part | Gas |
|---|---|
| Intrinsic: two SECP256K1 entries at 2,800 each, plus calldata | 22,425 |
| Frame 0, the account's VERIFY: twenty parameter reads and `APPROVE`, no storage | 705 |
| Frame 1, the merchant's default code (payment) | 3,000 |
| Frame 2, the pull: one `SLOAD`, one `SSTORE` to a live slot, a call with value | 21,818 |
| The first pull on a lane: the keyed nonce slot, charged to frame 1 | + 97,920 |

[`concurrency.ts`](concurrency.ts) ran twice. The first run also re-subscribed merchant 2, whom E
had cancelled.

| Case | Tx | Block (index) | Outcome | `gasUsed` |
|---|---|---|---|---|
| run 1: re-subscribe merchant 2 | [`0x287b27c3…`](https://dora.privacy.ethrex.xyz/tx/0x287b27c3808d1aab671166eb550db40eba3dc05a91e32b5a0107b53ac5db6bdd) | 305533 (0) | success; one fresh slot | 128,400 |
| run 1, **C2**: merchant 1 and merchant 2 pull at the same moment | [`0xc4030e91…`](https://dora.privacy.ethrex.xyz/tx/0xc4030e91d6b935f93dd59fe59104b609e846b1441cd19ad2946034aea2c7ddf3), [`0x24d95a90…`](https://dora.privacy.ethrex.xyz/tx/0x24d95a900830b8a678e90594537ecf96c486c1a1a3db39359af84d917e308936) | 305533 (2, 1) | both mined, success; sent *after* the receipt for index 0 (observation 6) | 47,948 each |
| run 1, **C3**: merchant 1 pulls, then alice sends on key 0 | [`0x5a84aaa3…`](https://dora.privacy.ethrex.xyz/tx/0x5a84aaa3921df5150f151c7fa386ab78d36ca338a168f633ef5171bb94ed1693) | 305534 (0) | the pull mined; alice **refused** | 47,948 |
| run 2, **C2** | [`0x35291ed9…`](https://dora.privacy.ethrex.xyz/tx/0x35291ed9ee3560437b9c2e9be2e7d0676d77cef376d2445f3428b3dd7d0eb80e), [`0x0dcba149…`](https://dora.privacy.ethrex.xyz/tx/0x0dcba149bc9881aee2336cdbda4b723975156bdfb10513c057a2f016cf4ea207) | 305574 | both mined, success; `txpool_status` showed 2 pending | 47,972 each |
| run 2, **C3** | [`0xa70c6698…`](https://dora.privacy.ethrex.xyz/tx/0xa70c6698f2c67e8965db7f77878999ffea9a6e66cacdd320d640e44a156cc80b) | 305575 | the pull mined; alice **refused** | 47,948 |
| run 2, **C4**: merchant 1 pulls, then alice sends on *her own* key 1 | [`0xc727c5bc…`](https://dora.privacy.ethrex.xyz/tx/0xc727c5bc3ec023dc632b13250b67ea9551daba6be4cc04b273a6b4931d5592ed), [`0x3f0a7648…`](https://dora.privacy.ethrex.xyz/tx/0x3f0a76488d59f740f8cbbfd74971e1a9f98880bc91fc02cee98e154d45d4d4e9) | 305576 | both mined; 2 pending | 47,972; alice 125,302 |

The refusal in C and C3 reads: `A frame transaction in the other nonce-key domain is already
pending for this sender`. The 24 gas between 47,948 and 47,972 is calldata, from the fee fields.
Alice's 125,302 in C4 is her key-0 payment (27,382) plus the fresh slot for key 1 (97,920).

[`negative.ts`](negative.ts), simulated against the account after the runs above:

| Case | valid | Violation | Execution |
|---|---|---|---|
| merchant 1 pulls (baseline) | true | | success |
| a stranger with no ETH pulls for itself | false | validation prefix frame reverted | |
| a stranger with ETH (the funder) pulls for itself | **true** | | reverted |
| merchant 1 pulls on nonce key 0 | false | validation prefix frame reverted | |
| merchant 1 pulls on merchant 2's lane | false | validation prefix frame reverted | |
| merchant 1 pulls and asks the account to pay | false | frame 1: VERIFY frame follows the validation prefix | |
| merchant 1 pulls for merchant 2 | false | validation prefix frame reverted | |
| merchant 1 pulls with value on the pull frame | false | validation prefix frame reverted | |
| merchant 1 pulls, then a second frame | false | validation prefix frame reverted | |

The stranger with no ETH fails in frame 1, its own default code, because it cannot pay. With ETH
it passes VERIFY and is refused in execution. When the merchant asks the account to pay, frame 0
approves both scopes, so the prefix ends there, and frame 1, a second VERIFY, is out of place.

## Observations

1. **The merchant pays to collect, from its own EOA.** The account approves EXECUTION only, and
   the merchant's address approves PAYMENT with the default code: the mempool's
   `[only_verify, pay]` prefix, as for experiment 09's paymasters, with an EOA as the payer. The
   merchant has no contract and no deposit, and uses no bundler. Alice pays nothing for pulls:
   not for the ones that succeed, and not for the ones that fail.

2. **A VERIFY that reads no storage cannot tell a subscriber from a stranger, and does not need
   to.** VERIFY checks only that the signer is pulling for itself, on its own lane, paying for
   itself. Whether the signer is subscribed and due is checked in execution, where `TIMESTAMP`
   is allowed. (VERIFY could not check "due" anyway: there is no "not before" in VERIFY;
   experiments 10 and 12.) Every refusal lands on the puller:
   - an early pull costs the merchant 32,721 gas (B, the calldata floor);
   - a pull after cancellation costs 130,641 (E, including the lane);
   - a funded stranger's pull is valid and reverts at its own expense.

   One cost does reach the account. A stranger who pulls opens a lane in alice's account, which
   is one more storage slot, forever, paid by the stranger. Refusing strangers in VERIFY would
   take an `SLOAD`, and observation 4 says what that costs.

3. **The nonce key is part of the authorisation.** VERIFY pins the transaction to one nonce key,
   equal to the signer. A merchant on key 0 would hold up alice's own sequence. A merchant on
   another merchant's lane would burn that merchant's next sequence number, and invalidate the
   pull it had signed. Both are refused (`negative.ts`). The protocol charges a fresh lane to the
   frame whose `APPROVE` covers payment, so the merchant pays 97,920 once per account (A against
   D). Alice pays for a lane only if she opens one herself (C4).

4. **ethrex has two nonce-key domains per sender: key 0, and everything else.** Transactions on
   disjoint non-zero keys wait in the pool together:
   - two merchants pulling at once (C2, twice);
   - a merchant and alice on her own key 1 (C4).

   A key-0 transaction and a keyed one do not, in either order (C and C3). The pinned EIP-8250
   keeps EIP-8141's "limit of one pending frame transaction per sender in the public mempool". It
   adds that "a future policy MAY admit multiple pending frame transactions for the same sender
   on disjoint non-zero key sets"; ethrex runs that policy already. Earlier experiments add the
   condition that the prefix reads no sender storage.

   Two consequences for a wallet:
   - An account with subscriptions should send its owner's transactions on a keyed lane. Then
     neither side waits for the other. The lane costs one slot the first time.
   - **Inferred, not tested:** a funded stranger can keep a valid keyed pull pending (observation
     2) and so keep alice's key-0 transactions out of the pool. Each attempt costs the stranger
     one included transaction, about 32,721 gas per block. A keyed owner lane evades this too.

5. **Accrual, not reset.** A pull moves the due time on by one period from the old due time, not
   from now. A merchant that has not collected for a while can therefore collect the arrears back
   to back. In run 2, merchant 1 was paid in three consecutive blocks (C2, C3 and C4, 12 s), and
   its plan is still about thirteen periods behind. This is a choice every pull-payment contract
   makes, and frames do not change it. What frames change is who pays for the catch-up, which is
   the merchant, one transaction per period. A wallet that wants "missed periods lapse" sets the
   next due time from `TIMESTAMP` instead, or caps the arrears.

6. **A receipt for a block that was then rebuilt, and the third silent drop explained.** In run
   1, the re-subscription's receipt said block 305533. The script then sent C2, and both pulls
   landed in block 305533 as well, at indices 1 and 2. So the receipt came from a block 305533
   that did not become canonical. The canonical 305533 has a timestamp 12 s after its parent
   instead of 6, so the slot in between was missed.

   The same 12 s gap follows the block that preceded each of the two unexplained drops:
   - experiment 07: setup in 305126, then the transfer dropped;
   - experiment 15, first run: the delegation in 305424, then C dropped.

   **Hypothesis.** ethrex serves receipts from a payload it built for a slot that is then
   missed. It revalidates pending transactions against the parent state and evicts those that
   needed the vanished block. It does not readmit them when the block is rebuilt. The two
   dropped transactions both needed it:
   - 07's transfer came from the account that setup deployed;
   - 15's C needed the delegation.

   The C2 pulls did not need it, since VERIFY reads no storage and their lanes were their own,
   and they survived into the rebuilt block. Experiment 19 tests this deliberately. Until then,
   a wallet should treat a receipt as provisional until a block builds on it, before it sends a
   transaction whose validity depends on it.

   *Tested in experiment 19 (observation 6).* Over 80 rounds of a transaction and a dependent one, a
   single receipt named a block that never became canonical: a rebuilt block at the same height, one
   slot later, held the same transaction. That confirms the first half of the hypothesis. The
   dependent transaction survived, and none of the 80 was dropped, so the eviction happens only
   sometimes, and what decides it is still open. The advice above stands.

7. **A design note, not tested: entry 0 is redundant.** Frame 1 approves payment only if the
   merchant signed entry 1 over the canonical hash, which covers the pull frame. So the account
   could take the merchant from frame 1's target, and leave entry 0 as a 100-gas ARBITRARY
   placeholder. It has to stay as a placeholder, because the default code reads index 1 for a
   payment-only frame. That would save about 2,700 gas of signature verification and the
   calldata of one signature. The payer's approval would be the authentication.
