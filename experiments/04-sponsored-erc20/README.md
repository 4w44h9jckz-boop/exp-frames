# 04 — Sponsored transaction, fee paid in ERC-20 (EIP-8141 Example 3)

A user who has never held ETH sends tokens and pays for the gas in tokens. A sponsor pays the ETH.

| Frame | Mode    | Caller      | Flags              | Target        | Value | Data                   |
| ----- | ------- | ----------- | ------------------ | ------------- | ----- | ---------------------- |
| 0     | VERIFY  | ENTRY_POINT | APPROVE_EXECUTION  | Null (sender) | 0     | Empty                  |
| 1     | VERIFY  | ENTRY_POINT | APPROVE_PAYMENT    | Sponsor       | 0     | Sponsor data           |
| 2     | SENDER  | Sender      | APPROVE_SCOPE_NONE | ERC-20        | 0     | transfer(Sponsor,fees) |
| 3     | SENDER  | Sender      | APPROVE_SCOPE_NONE | Target addr   | 0     | Call data              |
| 4     | DEFAULT | ENTRY_POINT | APPROVE_SCOPE_NONE | Sponsor       | 0     | Post op call           |

The script first runs a warm-up: the simplest sponsorship, where **an EOA pays through its default
code**. That is how the fresh user gets tokens to pay with:

| Frame | Mode   | Flags             | Target        | Signature checked by default code                         |
| ----- | ------ | ----------------- | ------------- | --------------------------------------------------------- |
| 0     | VERIFY | APPROVE_EXECUTION | Null (sender) | index 0, user (`signer` empty → sender)                   |
| 1     | VERIFY | APPROVE_PAYMENT   | Sponsor EOA   | index 1, sponsor (`signer` = sponsor, must be explicit)   |
| 2     | SENDER | -                 | tUSD          | `mint(user, 1000)`                                        |

Both signatures cover the same canonical sig hash (empty `msg`), so the sponsor approves exactly
these frames.

## The sponsor contract

[`TokenSponsor.yul`](TokenSponsor.yul) takes three constructor arguments, appended to its code:
`token`, `rate` (2,000 tUSD per ETH), and `owner`.

- **VERIFY (pay frame).** A public-mempool pay frame may not read storage outside `tx.sender`. So
  the sponsor cannot check the user's token balance. It only checks the transaction:
  - the next frame is a SENDER frame to `token`, with no `ATOMIC_BATCH_FLAG`;
  - its data is exactly `transfer(sponsor, amount)`;
  - `amount ≥ TXPARAM(max_cost) × rate`.

  If all of that holds, it calls `APPROVE(PAYMENT)`. It uses `TXPARAM`, `FRAMEPARAM`,
  `FRAMEDATALOAD` and a `CODECOPY` of its own arguments. No storage, no `BALANCE`.
- **DEFAULT (post-op).** This path runs only in the last frame, so a refund can happen at most once.
  It finds the pay frame and checks with `FRAMEPARAM(status)` that the fee transfer succeeded. It
  then reads every earlier frame's `gas_used.execution` and `gas_used.state` (`FRAMEPARAM 0x0A/0x0B`)
  and refunds `paid − rate × (max_cost − unused × max_fee)`. The sponsor keeps what the post-op
  frame itself leaves unused, plus the gap between the max fee and the effective price.
- **Owner call without value.** Sweeps the sponsor's tokens and ETH to the owner.

Calldata matters for the fee: the fee amount is part of the calldata it pays for. So
[`sponsor.ts`](sponsor.ts) iterates until `amount ≥ max_cost × rate`, pricing a worst-case 65-byte
signature (observation 6).

## Run

```bash
npx tsx experiments/04-sponsored-erc20/example-3-sponsored.ts   # setup (once), warm-up, Example 3
npx tsx experiments/04-sponsored-erc20/negative.ts              # 1 warm-up tx, then simulations
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

Owner `0xa93C…EB74`, tUSD `0xd8d75cd4d9C19651Bc96dBdC6948d47894D354EA`, TokenSponsor
`0xc57cB255D6113ae92D8229dB939F40C785D868E4`.

| Tx | What | Frames: status, execution / state gas | `gasUsed` |
|---|---|---|---|
| [`0x0d6ba2eb…`](https://dora.privacy.ethrex.xyz/tx/0x0d6ba2ebb5e91a2eda58844208e96537a84ddd5a066c89afdf83d4444d95db88) | setup: tUSD + first TokenSponsor + 0.05 ETH | 100/0 · 43,014/2,955,960 · 12,810/1,256,130 · 205/0 | 4,453,286 |
| [`0xcc96591e…`](https://dora.privacy.ethrex.xyz/tx/0xcc96591e9e6117ca748910ca67b38c83fdaefb005675918241b246a4ce620d6a) | Example 3 against the first sponsor: post-op **FAILURE** (bug, observation 7) | 100/0 · 3,499/0 · 30,357/97,920 · 15,457/97,920 · **1,554/0** | 266,346 |
| [`0x80f2c88b…`](https://dora.privacy.ethrex.xyz/tx/0x80f2c88b35662f483d1f3b8217549564e94c7cfa79879801d2445d1283ee0f6b) | setup: fixed TokenSponsor + 0.05 ETH | 100/0 · 15,737/1,280,610 · 219/0 | 1,356,595 |
| [`0xc8d33262…`](https://dora.privacy.ethrex.xyz/tx/0xc8d332625eaa3cfe449d4cd729fc1284cf01d073a30dd71f7835e10ba9e03d54) | **warm-up**: fresh user mints 1000 tUSD, the owner EOA pays | user VERIFY 100/0 · owner VERIFY 3,000/**183,600** · mint 29,848/97,920 | 336,537 |
| [`0xb1342980…`](https://dora.privacy.ethrex.xyz/tx/0xb1342980fe9045020c012589260f876c0e0fe322fe3d43055392b21725a70904) | **Example 3**: fee in tUSD, send 5 tUSD, post-op refund | 100/0 · sponsor VERIFY 3,517/0 · fee 30,357/97,920 · send 15,457/97,920 · post-op 4,832/0 | 269,642 |

The Example 3 money flow:

| | |
|---|---|
| user | 0 ETH before and after. 1000 → 994.35037999 tUSD: 5 to the friend, 0.64962001 for gas |
| fee transfer (frame 2) | 0.830782011630948 tUSD = 2,000 × max_cost of 0.000415391 ETH (quoted with a worst-case signature) |
| post-op refund (frame 4) | 0.181162002536268 tUSD |
| sponsor kept | 0.64962000909468 tUSD ≙ 0.00032481 ETH at the rate |
| sponsor paid | 269,642 gas × 1,000,000,007 wei = 0.000269642 ETH |

## Observations

1. **A user with no ETH has two ways in.** Either an EOA co-signs as payer through its default code,
   or a contract sponsor is paid in tokens. Both match the `OnlyVerifyPay` validation prefix. The
   EOA sponsor's VERIFY frame costs 3,000 gas: Amsterdam's cold account access, and nothing else,
   since default code draws no gas. TokenSponsor's costs 3,517: 3,000 + 517 of code.
2. **The pay frame creates the sender's account.** For a fresh sender, the 183,600 state gas is
   charged to the frame that calls `APPROVE(PAYMENT)`, because that is where the sender's nonce is
   incremented. It is not charged to the sender's own VERIFY. A sponsor of brand-new users must give
   its pay frame that budget. The mempool caps validation-prefix state gas at 500,000.
3. **The refund is exact.** The fee frames left 90,569 gas unused: 9,900 + 26,483 + 19,643 + 34,543.
   `max_cost − 90,569 × max_fee` is exactly what the sponsor kept, to the wei. Settlement charged
   324,810 − 55,168 = 269,642 gas, where 55,168 is the post-op frame's own unused gas. So the
   sponsor's margin here is that 55,168 × max_fee plus 7 wei/gas of fee gap: about 17% of the fee it
   kept. A tighter post-op execution limit shrinks it.
4. **The first fee transfer pays for the sponsor's balance slot.** Frame 2 used 97,920 state gas
   because the sponsor had never held tUSD, and the user paid for it. On later transfers that slot
   exists, and the post-op refunds those 97,920 gas. The negative runs simulate 171,7xx instead of
   269,642.
5. **The front-running risk in the EIP's note is real.** A sender with no tokens (case below) is
   still valid. Frame 2 fails, the post-op refuses to refund, and the sponsor pays 218,760 gas (simulated) for
   nothing, including the 183,600 to create the sender's account. In VERIFY the sponsor can see only
   the transaction, not token balances. Mitigations:
   - a sponsor service checks the balance off-chain and co-signs (an extra `SIGPARAM` check in
     VERIFY), as the warm-up's EOA sponsor does implicitly;
   - for a non-canonical paymaster, the mempool's limit of one pending transaction caps exposure to
     one at a time.
6. **Quote the fee on the signed transaction.** The first attempt priced the transaction before
   signing. The 65-byte signature then added 1,040 gas of calldata, the fee fell short, and the
   sponsor rightly refused. Because zero bytes cost 4 instead of 16, the signature's real cost
   varies by up to 780 gas. So the quote assumes a signature with no zero bytes, and the post-op
   returns the overpayment.
7. **A Yul pitfall, not a protocol one.** The first sponsor's post-op reverted after 1,554 gas.
   `transfer()` stored the calldata at memory 0..100 and then evaluated `call(gas(), token(), …)`.
   `token()` reads its constant with `CODECOPY` into memory 0, which overwrote the selector.
   VERIFY was unaffected: it uses no memory. The fixed contract reads constants through a scratch
   word at `0x80`. The first sponsor, `0xcD1e…1979`, has the same bug in its sweep, so its
   0.0497 ETH can now only pay for other users' gas.
8. **The post-op reads only past frames.** `FRAMEPARAM` status (0x05), `gas_used.execution` (0x0A) and
   `gas_used.state` (0x0B) work for completed frames, and the spec has them halt for the current and
   later frames. So "last frame only" is also the only position where the refund can see every
   other frame.

### Rule violations (`negative.ts`, simulated)

| Case | `valid` | Node says |
|---|---|---|
| Example 3 as designed | true (`OnlyVerifyPay`) | 171,734 gas before refund (sponsor slot exists) |
| fee 1% short | false | validation prefix frame reverted |
| fee paid to someone else | false | validation prefix frame reverted |
| fee frame targets another contract | false | validation prefix frame reverted |
| fee transfer batched with the user call | false | validation prefix frame reverted: a rolled-back batch would keep `status = SUCCESS` (experiment 03) |
| user call before the fee transfer | false | validation prefix frame reverted |
| pay frame flags `APPROVE_EXECUTION_AND_PAYMENT` | false | `Frame 1: APPROVE_EXECUTION requires an empty target or tx.sender` |
| pay frame before the sender's VERIFY | false | `validation prefix does not match any recognized shape` |
| two post-op frames, fee re-quoted | true | frame 4 FAILED (228 gas, not last), frame 5 refunds: at most one refund |
| sender holds no tokens (fresh key) | **true** | fee FAILED, user call FAILED, post-op FAILED; the sponsor pays 218,760 gas |
| EOA sponsor: signatures swapped | false | validation prefix frame reverted: default code reads index 0 for execution, 1 for payment |
| EOA sponsor: empty `signer` on its entry | false | validation prefix frame reverted: an empty `signer` resolves to the sender, not the sponsor |
