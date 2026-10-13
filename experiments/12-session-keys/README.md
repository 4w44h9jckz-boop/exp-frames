# 12 — Session keys: a second key with a policy, checked frame by frame

A session key is a second key the owner hands to an app, an agent or a device. It may act for the
account, but only within limits. Under ERC-4337 the account's validator decodes the `execute`
calldata of one user operation to find out what the session key is asking for. Under EIP-8141,
the calls are the frames themselves, and VERIFY can read every one of them before it approves.
This experiment builds that check and finds where it has to differ from the 4337 version.

[`SessionAccount.yul`](SessionAccount.yul) has one owner (address in code, full control) and any
number of sessions in storage. A session is
`target (20) ‖ selector (4) ‖ validUntil (8)`, a `budget` in wei, and `1 + spent`. A transaction
signed by a session key must have exactly this shape, and VERIFY checks every frame:

| Frame | Mode | Target | Data | VERIFY requires |
|---|---|---|---|---|
| 0 | VERIFY | `EXPIRY_VERIFIER` | deadline (8) | deadline $\le$ `validUntil` |
| 1 | VERIFY | Null (sender) | | entry 0 a protocol scheme, `msg` ∅, signer has a session; this frame is index 1 |
| 2 | SENDER | sender | `0x03 ‖ key ‖ amount` | key = signer; no flags, no value, $\ge$ 30,000 execution gas |
| 3+ | SENDER | `target` | empty if `selector` = 0, else starting with it | every one; nothing else in the transaction |

and, over the whole transaction,

$$\mathrm{amount} \ \ge\ \mathrm{TXPARAM}(\texttt{0x06}) + \sum_{i \ge 3} \mathrm{value}_i, \qquad \mathrm{spent} + \mathrm{amount} \ \le\ \mathrm{budget}.$$

The budget therefore covers fees as well as value, counted at the maximum cost. The owner adds,
revokes and records with SENDER frames the account sends to itself (`caller == address()`); the
session's target may never be the account.

| File | What |
|---|---|
| [`SessionAccount.yul`](SessionAccount.yul) | The account: 642 B runtime followed by the owner (674 B deployed) |
| [`session.ts`](session.ts) | Keys derived from `PRIVATE_KEY` (owner, session, merchant), `addSession`, `revokeSession`, `readSession`, `sessionTx` (computes the amount), `ownerTx` |
| [`example-session.ts`](example-session.ts) | Setup, then 1 and A-E on the testnet |
| [`negative.ts`](negative.ts) | 17 cases, simulated (it grants the session again first if it is revoked) |

## Run

```bash
npx tsx experiments/12-session-keys/example-session.ts   # setup (once), then 1, A-E
npx tsx experiments/12-session-keys/negative.ts          # simulations, after one grant if needed
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

Account `0x49f30D74edd539CdB026Bd05f05B9359C719276A`. The session grant is one hour, plain
transfers to the merchant, and a 0.002 ETH budget.

| Tx | What | Frames: execution / state gas | `gasUsed` |
|---|---|---|---|
| [`0x922d2f82…`](https://dora.privacy.ethrex.xyz/tx/0x922d2f8209e209371a1871b9b09ba787d1565056628345a157617bd8ccd647cc) | setup: the funder deploys and funds the account | VERIFY 100 · deploy 15,695/1,214,820 · fund 141 | 1,288,053 |
| [`0xbdece101…`](https://dora.privacy.ethrex.xyz/tx/0xbdece10137bff29a04d111e154019c3e4d78dbc38a65a6bba0242b3509b44ed4) | setup, second run: 1 wei to the merchant so that its account exists | VERIFY 100 · SENDER 3,000/183,600 | 209,702 |
| [`0x3650463d…`](https://dora.privacy.ethrex.xyz/tx/0x3650463db2e5bcb005392c6f799d474c25a2c91798a3d0aa7fd9ac593efa9659) | **1.** owner grants the session | VERIFY 340 · add 36,683/293,760 | 348,805 |
| [`0x1d381c94…`](https://dora.privacy.ethrex.xyz/tx/0x1d381c945c266b560e7d347d0b5c32c1d6baa17049eb49a80662c3b994136abb) | **A.** session key pays the merchant 0.0001 ETH | expiry 3,051 · VERIFY **7,468** · spend 10,724 · pay 3,000 | 48,955 |
| [`0x84d4a91f…`](https://dora.privacy.ethrex.xyz/tx/0x84d4a91f00c6510fb91f88087b0a1c5d99da0ce5c9020088943695bb6217e0f5) | **B.** two payments in one transaction (0.0001 + 0.0002) | expiry 3,051 · VERIFY 7,646 · spend 10,724 · pay 3,000 · pay 100 | 55,732 |
| (refused) | **C.** 0.0015 ETH, more than the budget has left | prefix reverted | |
| [`0x822694c8…`](https://dora.privacy.ethrex.xyz/tx/0x822694c896372d8d6e8697de34c48b352a5fb48c47d144e9b55e3f2a530c6848) | **D.** owner revokes; the same session transaction is refused afterwards | VERIFY 340 · revoke 36,650 | 43,588 (refund capped at $\frac{1}{5}$) |
| [`0x5cd226e7…`](https://dora.privacy.ethrex.xyz/tx/0x5cd226e75d7303adc8d078db6207baf163f4dfd50250adfe3e98c14a430bd18c) | **E.** session re-granted; a session transaction sent, then at once the owner's revocation at the same nonce with fees 25% higher. The revocation was mined and the session transaction never was | VERIFY 340 · revoke 36,650 | 43,578 |
| [`0x7f53ae0c…`](https://dora.privacy.ethrex.xyz/tx/0x7f53ae0cf1ed9a9414cf5179bddb3024f1a7978488c8fe8ba75f60c9104d17b0) | first run's A, before the merchant existed: the payment frame ran out of gas; the spend was recorded | expiry 3,051 · VERIFY 7,468 · spend 10,724 · pay **50,000 FAILURE** | 95,955 |

Spent after A was 0.000270 ETH, which is 0.0001 ETH of value plus a maximum cost of 0.000170 ETH.
After B it was 0.000797 ETH. The fees actually paid for A and B were 0.000049 and 0.000056 ETH.

The same payment, signed by the owner and by the session key:

| Signed by | frames | intrinsic | execution | `gasUsed` |
|---|---|---|---|---|
| owner (VERIFY, SENDER), simulated in `negative.ts` | 2 | | VERIFY 340 | 27,382 (calldata floor) |
| session key (A) | 4 | 24,712 | 24,243 | 48,955 |

### Refusals (`negative.ts`, simulated)

| Case | valid | Node says |
|---|---|---|
| session key pays the merchant (baseline) | true | |
| owner pays the merchant: VERIFY, SENDER only | true | |
| a stranger's key, same shape | false | `validation prefix frame reverted` |
| no expiry frame | false | prefix reverted |
| deadline one second after `validUntil` | false | prefix reverted |
| deadline in the past | false | prefix reverted (the expiry frame) |
| pays another address | false | prefix reverted |
| pays the merchant with calldata (selector 0 means none) | false | prefix reverted |
| declares half the amount | false | prefix reverted |
| declares exactly max cost + value of the signed transaction | true | |
| declares one wei less than that | false | prefix reverted |
| spend frame with 29,999 execution gas | false | prefix reverted |
| spend frame in an atomic batch with the payment | false | prefix reverted |
| spend frame records the spend against another key | false | prefix reverted |
| an extra frame granting the session key a second session | false | prefix reverted |
| payment as a DEFAULT frame | false | prefix reverted |
| 0.0019 ETH: with the max cost, past the 0.002 budget | false | prefix reverted |

## Observations

1. **The policy reads the calls, not an encoding of them.** VERIFY walks frames 3 and up with
   `FRAMEPARAM` (mode, target, value, data length) and `FRAMEDATALOAD` (selector). There is no
   `execute(...)` calldata to decode, so no batch encoding the account must parse correctly. The
   price is that the account must also refuse everything it did not ask for: an extra frame that
   calls the account itself, a DEFAULT frame, a missing expiry frame. The negative cases cover each
   of those, and each was refused.

2. **VERIFY is static, so the budget is read in VERIFY and written by a frame that cannot fail.**
   A 4337 session validator updates its counters during validation, because ERC-7562 lets the
   account write its own storage there. Here VERIFY may read `spent`, but the write has to happen
   in frame 2. VERIFY makes sure that write lands:
   - frame 2 sits outside any atomic batch, so a failing payment cannot roll it back;
   - it carries enough gas;
   - it comes before the calls;
   - its own check repeats VERIFY's against the same pre-state, with only static frames in
     between.

   The first run shows why the record must sit outside the batch. The merchant had no account, so
   the payment needed 183,600 state gas it did not carry and ran out of gas. The spend was still
   recorded. Inside the batch, the record would have been rolled back, and a leaked session key
   could burn the account's ETH in fees on failing transactions without ever touching its budget.

3. **The deadline comes from the expiry frame.** `TIMESTAMP` is banned in VERIFY, so the account
   cannot compare the clock with `validUntil`. It requires the expiry frame instead, and bounds its
   deadline by `validUntil`. The expiry verifier refuses a deadline in the past, so no session
   transaction can be valid after the session ends. The mempool already wants the expiry frame
   first, which is why the session's VERIFY frame sits at index 1.

4. **The budget charges fees at the maximum cost.** VERIFY cannot know what a transaction will
   actually cost, so the budget counts `TXPARAM(0x06)`. For A that was 0.000170 ETH against 0.000049
   ETH actually paid, so a session spends its budget about 3.5 times faster than its fees alone
   would. A closing frame could credit the unused part back from `FRAMEPARAM(0x0A)`, as experiment
   04 refunds tokens. It would have to be as impossible to fail as the record, and that is not
   tested here. The amount check is $\ge$, not $=$, because the maximum cost includes the calldata
   of the signature, which is outside the sig hash and so not known when the amount is signed.
   Searching for the fixed point shows the node's `TXPARAM(0x06)` equals the tooling's `maxCost` to
   the wei: the exact amount passes and one wei less is refused.

5. **Revocation can overtake a pending session transaction, by replacement.** ethrex holds at most
   one pending transaction per sender here: it never queues a nonce gap (experiment 10), and it
   refuses a second keyed transaction when the prefix reads sender storage, as this one does
   (experiment 08). So the owner cannot revoke alongside a pending session transaction; the owner
   replaces it instead. In E, the revocation at the same nonce with fees 25% higher was mined, and
   the session transaction never was. Had the session transaction been mined first, the
   revocation would still have been valid, one nonce later.

6. **A session costs about 21,600 gas per transaction over the owner's own.** A came to 48,955
   against 27,382 for the same payment signed by the owner. The difference is:
   - the expiry frame, 3,051;
   - VERIFY reading three cold slots, 7,128 more than the owner's;
   - the spend frame, 10,724;
   - two more frames and their calldata.

   Granting a session writes three fresh slots (293,760 state gas, 348,805 in all at today's
   `CPSB`). Revoking clears them, but across transactions only the refund comes back, capped at a
   fifth of the gas used.

7. **What this policy cannot say.** It counts ETH, not token amounts: a selector-specific argument
   check (the amount in `transfer(address,uint256)`) would need the account to know the ABI. It has
   no per-period limit; experiment 16 (subscriptions) does periods. It accepts any protocol scheme
   for the session key, so a raw P256 device key (experiment 11) could be one, but only secp256k1
   was run.
