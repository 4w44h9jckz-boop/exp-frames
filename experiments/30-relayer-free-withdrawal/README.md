# 30 - A privacy withdrawal with no relayer, priced against today's relayers

A withdrawal from a privacy pool goes to a fresh address, and a fresh address has no ETH to pay for
gas. Today somebody else sends the transaction and the note pays them out of the withdrawal: a
Tornado Cash relayer, a Privacy Pools relayer, a Railgun broadcaster. A user who does not want to pay
one sends the withdrawal from an address that already holds ETH, and so links the withdrawal to that
address. Experiment 06 built a pool that is its own frame-transaction sender: its VERIFY frame checks
the proof, the pool pays the gas, and the note's fee reimburses the pool. Our wallet survey
(`posts/wallets-and-frames.md`, W6) called this the feature frames change most. This experiment
prices it:
- **on mainnet**, what notes paid relayers over 30 days, against the gas the relayers spent
  ([`mainnet.ts`](mainnet.ts));
- **on the testnet**, what the same withdrawal costs a note with no relayer, priced the way a wallet
  prices a transaction, before and after a fix for the one way it overcharges
  ([`refund.ts`](refund.ts), [`RefundPool.yul`](RefundPool.yul)).

| File | What |
|---|---|
| [`mainnet.ts`](mainnet.ts) | Every withdrawal from four Tornado Cash ETH pools and Privacy Pools' ETH pool in a block window: fee, sender, gas |
| [`RefundPool.yul`](RefundPool.yul) | Experiment 06's keyed pool, trimmed to the layout where the pool pays, plus a last frame that refunds the fee's surplus |
| [`refund.ts`](refund.ts) | One withdrawal from experiment 06's keyed pool and one from RefundPool, priced alike |
| [`layout.ts`](layout.ts) | Both layouts, the worst-case fee and the tightened limits, without the chain |
| [`layout.test.ts`](layout.test.ts) | Every withdrawal mined from these layouts, rebuilt byte for byte from its fixture, including kohaku-rs's |

## Run

```bash
npx tsx experiments/30-relayer-free-withdrawal/mainnet.ts 26188878 30   # mainnet, read-only
npx tsx experiments/30-relayer-free-withdrawal/refund.ts                # testnet: setup (once), then two withdrawals
npx vitest run experiments/30-relayer-free-withdrawal                   # offline: rebuild every mined withdrawal
```

From kohaku-rs, the same RefundPool withdrawal in Rust (part 3):

```bash
PRIVATE_KEY=0x... cargo run --release -p kohaku-frame-pool --example refund_withdrawal
```

`mainnet.ts` reads from `https://mainnet.gateway.tenderly.co` unless `MAINNET_RPC_URL` is set. The
publicnode endpoint refused our 30-day-old log queries without a token. Receipts are cached in
`$CACHE_DIR`, and a second run over the same window reproduces every table below without fetching
them again. `refund.ts` needs kohaku-rs's `frame-pool` prover, as experiment 06 does.

## Part 1: what notes pay relayers on mainnet

Blocks 25,972,879 to 26,188,878: 30 days, 2026-09-14 03:04 to 2026-10-14 06:14 UTC.

Sources, all primary, and each checked on chain before use:
- Tornado Cash's ETH instances and router: `config.js` in tornadocash/tornado-cli, `netId1`. Each
  instance's `denomination()` returns 0.1, 1, 10 and 100 ETH.
- The `Withdrawal(to, nullifierHash, relayer, fee)` event: `contracts/Tornado.sol` in
  tornadocash/tornado-core.
- Privacy Pools' Entrypoint (`0x6818809e...`) and ETH pool (`0xf241d57c...`):
  docs.privacypools.com/deployments. The pool's `ASSET()` is native ETH, and the Entrypoint's
  `scopeToPool(SCOPE())` and `assetConfig(ETH)` both name it. The Entrypoint charges a 50 bps
  vetting fee on deposits and caps the relay fee at 1,000 bps.
- `WithdrawalRelayed(relayer, recipient, asset, amount, feeAmount)` and `Withdrawn(processooor, ...)`:
  `IEntrypoint.sol` and `IPrivacyPool.sol` in 0xbow-io/privacy-pools-core.
- `StakeBurned(address,uint256)`: the topic the Tornado relayer registry emits in every relayed
  withdrawal, which we matched by hashing the signature.

A withdrawal is **relayed** when its note paid a fee. Its relayer's gas is the receipt's `gasUsed`
times the effective gas price.

**Excluded:**
- Tornado's ERC-20 pools, and every pool on other chains.
- Privacy Pools' non-ETH assets, and its deposit fee.
- Railgun. Its broadcaster's fee is a shielded note encrypted to the broadcaster, so the chain does
  not show it. Railgun's docs say the broadcaster checks that note against "a previously advertised
  rate * the estimated gas" (docs.railgun.org, Community Broadcasters).
- Relayer transactions that failed. They emit no `Withdrawal`, so their gas is missing from the
  relayers' costs.
- The TORN each Tornado relayer burns per withdrawal. We report it in TORN and did not price it.

### Who sent the withdrawals

| Pool | Withdrawals | Relayed (fee > 0) | Sent by an address that already held ETH (fee 0) | ... of which the recipient itself | Relayers seen | Top relayer's share of relayed |
|---|---|---|---|---|---|---|
| Tornado 0.1 ETH | 5,447 | 5,164 (95%) | 283 (5%) | 138 | 28 | 31% |
| Tornado 1 ETH | 2,285 | 1,833 (80%) | 452 (20%) | 169 | 26 | 24% |
| Tornado 10 ETH | 1,189 | 609 (51%) | **580 (49%)** | 258 | 23 | 20% |
| Tornado 100 ETH | 553 | 421 (76%) | 132 (24%) | 94 | 21 | 25% |
| Privacy Pools ETH | 611 | 587 (96%) | 24 (4%) | 2 | 4 | **77%** |
| all | 10,085 | 8,614 (85%) | 1,471 (15%) | 661 | 33 | 26% |

### What a relayed withdrawal cost the note, and what it cost the relayer (medians)

The last two columns price the same withdrawal with no relayer, at the same effective gas price,
using RefundPool's gas from part 2: 579,661 used plus the 13,469 RefundPool keeps.

| Pool | Fee | Relayer's gas | `gasUsed` | Price (gwei) | Fee / gas | Fee less gas, bps of the amount | Relayer's max fee / price | TORN burned | **No relayer** | Fee / no relayer |
|---|---|---|---|---|---|---|---|---|---|---|
| Tornado 0.1 ETH | 0.002080 | 0.000426 | 428,639 | 1.032 | 5.1x | 175.3 | 1.00 | none | 0.000612 | **3.6x** |
| Tornado 1 ETH | 0.005850 | 0.000286 | 431,788 | 0.667 | 19.9x | 54.6 | 1.00 | 1.138 | 0.000395 | **14.3x** |
| Tornado 10 ETH | 0.041774 | 0.000242 | 414,215 | 0.569 | 172.8x | 41.5 | 1.00 | 11.368 | 0.000337 | **123.8x** |
| Tornado 100 ETH | 0.431695 | 0.000434 | 409,443 | 1.060 | 1,053.4x | 43.1 | 1.00 | 112.813 | 0.000628 | **729.1x** |
| Privacy Pools ETH | 0.000170 | 0.000099 | 611,391 | 0.160 | 1.4x | 10.1 | 1.24 | - | 0.000095 | **1.4x** |

Amounts are in ETH. Privacy Pools' withdrawals are partial, so its "amount" is what each one took
out.

### Totals over the 30 days

| Pool | Relayed | Fees paid by notes | Relayers' gas | Fees less gas | **The same withdrawals with no relayer** | Gas of the self-sent |
|---|---|---|---|---|---|---|
| Tornado 0.1 ETH | 5,164 | 11.3080 | 2.1094 | 9.1986 | 2.9488 | 0.1056 |
| Tornado 1 ETH | 1,833 | 10.7458 | 0.7094 | 10.0364 | 0.9902 | 0.1942 |
| Tornado 10 ETH | 609 | 26.5379 | 0.2608 | 26.2771 | 0.3696 | 0.2760 |
| Tornado 100 ETH | 421 | 175.5474 | 0.1635 | 175.3839 | 0.2324 | 0.0960 |
| Privacy Pools ETH | 587 | 0.3723 | 0.1073 | 0.2650 | 0.1042 | 0.0115 |
| all | 8,614 | **224.5113** | 3.3504 | 221.1610 | **4.6451** | 0.6833 |

Median `gasUsed`: relayed Tornado withdrawals 409k to 432k, all through the router; self-sent
Tornado withdrawals 320k to 349k; relayed Privacy Pools withdrawals 611k. The ten busiest relayers,
and one withdrawal per pool at the median fee / gas, are in the script's output.

## Part 2: the same withdrawal with no relayer, on the testnet

### The overcharge

A note's fee is fixed when the proof is made, and the pool may approve payment only when the fee
covers the transaction's maximum cost, every gas limit at the max fee. The chain then charges the
pool what the transaction used and returns the rest. In experiment 06 that return stays in the pool,
where nobody owns it. So with no relayer the note pays

$$\text{fee} \ge \Big(g_{\text{intrinsic}} + \sum_i \ell_i\Big) \cdot f_{\max} \quad\text{against}\quad \Big(g_{\text{intrinsic}} + \sum_i u_i\Big) \cdot p$$

charged, where $\ell_i$ and $u_i$ are frame $i$'s limits and use, $f_{\max}$ is the max fee and
$p = \min(f_{\max}, \text{basefee} + f_{\text{tip}})$ is the price paid. Each factor is a choice a
wallet must make with headroom. The pool also floors the withdrawal frame at 100,000 execution gas,
so that nobody can starve it after approval, and that frame uses 14,000.

### The fix: a last frame that refunds it

[`RefundPool.yul`](RefundPool.yul) adds a DEFAULT frame after the withdrawal, `[8272, P VERIFY, W, R]`,
which VERIFY requires. `R` sends the recipient the fee less an upper bound on what the transaction
will be charged. The bound needs no oracle. The frames' use is `FRAMEPARAM` 0x0a and 0x0b. The
intrinsic gas is not exposed, but with no blobs and no signatures, both of which VERIFY checks,

$$g_{\text{intrinsic}} + \sum_i \ell_i = \frac{\texttt{TXPARAM(0x06)}}{\texttt{TXPARAM(0x04)}}$$

so

$$\text{charge} \le \Big(\frac{\texttt{TXPARAM(0x06)}}{\texttt{TXPARAM(0x04)}} - \sum_{i<R} (\ell_i - u_i)\Big) \cdot \min\big(\texttt{TXPARAM(0x04)},\ \texttt{BASEFEE} + \texttt{TXPARAM(0x03)}\big)$$

`R` counts its own limit as used, so the pool never refunds more than the transaction leaves it. A
storage refund would only lower the charge. The calldata floor could raise it, but it is 46k to 54k
here against more than 280k of execution.

### Results (2026-10-14, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

| Contract | Address |
|---|---|
| Experiment 06's keyed pool | `0x73e47a8DA2C83Beb802708Fc473B5B7D094f3eE6` |
| RefundPool, the same hasher, patched verifier and 0.001 ETH notes | `0xe19605853A749322655470199Fd31D3F3e53Baf9` |

The deployment was [`0xd0678b70...`](https://dora.privacy.ethrex.xyz/tx/0xd0678b70e01e593c449ce5ef5fdd4f4a02aa66615be693ac2af8513c4743b6fc).
The deposits were [`0xe0502f4f...`](https://dora.privacy.ethrex.xyz/tx/0xe0502f4f463ffe59b67ef2695d16ac852790f481e592a20cfdd3ac373068d273)
and [`0x6916fbb9...`](https://dora.privacy.ethrex.xyz/tx/0x6916fbb9dd664580042e7625e677f98c4daf9ec663385aca046ad7b2c70f170f),
three notes in each pool.

Both withdrawals were priced alike: a 0.1 gwei tip and a 0.2 gwei max fee. The base fee is 7 wei,
so the max fee leaves the room a wallet leaves for the base fee to double. Limits are set as
experiment 28's wallet sets them: simulate, then $1.25\,u + 5{,}000$, never below the pool's floors.
The fee in the note is the maximum cost of the same transaction with every calldata byte non-zero,
so that a fee fixed before the proof exists still covers the proof's bytes. Recipients are fresh
addresses. Frames are `status:execution+state`.

| Pool | Tx | `gasUsed` | Frames | Fee in the note | Gas charged | Refunded | Recipient got | Left in the pool |
|---|---|---|---|---|---|---|---|---|
| Experiment 06, keyed | [`0x9ccc4123...`](https://dora.privacy.ethrex.xyz/tx/0x9ccc4123b89ec87748b524dd335b501669f59b24dc5be06fc06fb3bab4f4f7f4) | 567,841 | 1:5,579 / 1:244,808+97,920 / 1:14,381+183,600 | 0.0001455792 | 0.0000567841 | 0 | 0.0008544208 | **0.0000887951** |
| RefundPool | [`0xc992b54a...`](https://dora.privacy.ethrex.xyz/tx/0xc992b54ace771290579f92435cb12e7eee1368d216eb02c7ed0544343aa2cd10) | 579,661 | 1:5,579 / 1:244,744+97,920 / 1:14,255+183,600 / 1:11,531 | 0.0001506582 | 0.0000579661 | **0.0000913452** | 0.0009406870 | **0.0000013469** |

Amounts are in ETH, at an effective price of 100,000,007 wei. The script checks each pool's balance
change against fee less gas less refund.
- **Experiment 06's pool.** The note paid **2.56 times** its gas: $\frac{0.2}{0.1} \times
  \frac{726{,}056}{567{,}841} \times 1.0025$. That is the max fee's headroom, the limits' headroom
  (85,619 of it the withdrawal frame's floor), and the worst-case calldata.
- **RefundPool.** The note paid **1.023 times** its gas. RefundPool's bound on the charge was 13,469
  gas above the actual charge, which is exactly the refund frame's 25,000 limit less the 11,531 it
  used. The refund frame cost 11,820 gas: 2% of the withdrawal.

## Part 3: the same withdrawal from Rust (2026-10-20)

kohaku-rs's `kohaku-frame-pool` now builds RefundPool's layout as a fifth layout of its withdrawal
builder, and prices it the way `refund.ts` does: simulate, tighten each limit to $1.25\,u + 5{,}000$
above the pool's floors, then fix the fee at the worst-case max cost of that shape. Its example
`crates/frame-pool/examples/refund_withdrawal.rs`, on kohaku-rs branch
`experiment/frames`, deposited a fresh note and withdrew it from Rust alone, at the same
fees as part 2:

| | Tx | Block |
|---|---|---|
| deposit | [`0x70346def...`](https://dora.privacy.ethrex.xyz/tx/0x70346def0670b891c564372cd0a620b2792c0b50b144a13473d193453631a73f) | 477,921 |
| withdrawal | [`0x339af560...`](https://dora.privacy.ethrex.xyz/tx/0x339af560b79b175b240b4250809cc14e84b34799023cb2a847053bd2e7119659) | 477,924 |

| Pool | `gasUsed` | Frames | Fee in the note | Gas charged | Refunded | Recipient got | Left in the pool |
|---|---|---|---|---|---|---|---|
| RefundPool, from Rust | 579,697 | 1:5,579 / 1:244,744+97,920 / 1:14,255+183,600 / 1:11,531 | 0.0001506582 | 0.000057969704057879 | 0.000091341595847838 | 0.000940683395847838 | 0.000001346900094283 |

Run on 2026-10-20 against ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`. The deposit came from a
fresh account funded by the faucet; the recipient is a fresh address.
- **Rust chose what TypeScript chose.** Its limits were 11,973 / 310,930 / 100,000 / 25,000, the
  same as part 2's RefundPool withdrawal, and its fee was the same 150,658,200,000,000 wei. Its
  `gasUsed` is 36 higher, all of it calldata: of the 620 bytes of frame data and nonce key, the
  Rust withdrawal's proof and nullifier have 150 zero bytes against 153, and each zero byte costs
  12 gas less.
- **The note paid 1.023 times its gas again**, and RefundPool's bound was again 13,469 gas over
  the charge: the refund frame's limit less its use.
- **Each side rebuilds the other's.** `layout.test.ts` rebuilds part 2's two withdrawals and
  this one byte for byte from their fixtures. It reads only what a wallet decides: the proof and
  its inputs, the root's slot and the fees. It derives the limits by tightening each frame's use
  from the receipt, and it checks that the note's fee is the worst-case max cost of the
  rebuilt shape. kohaku-rs's `crates/frame-pool/tests/withdrawal.rs` rebuilds the same three in
  Rust, beside experiment 06's.

## Observations

1. **Notes paid relayers 224.5 ETH in 30 days for 3.35 ETH of gas.** Tornado relayers charge gas
   plus a percentage of the note: net of gas, 41 to 55 bps on the 1, 10 and 100 ETH pools and
   175 bps on the 0.1 ETH pool. On a 100 ETH note, the median fee was 1,053 times the gas. The
   relayers also burn TORN per withdrawal (1.1, 11.4 and 112.8 TORN on the 1, 10 and 100 ETH
   pools), which we did not price, so "fees less gas" overstates their margin by that much. Privacy
   Pools' relayer fee is close to gas: 1.4 times, or 10 bps of the amount net.

2. **The price makes users link themselves.** 1,471 withdrawals, 15%, were sent by an address that
   already held ETH, and 661 of those by the recipient itself. In the 10 ETH pool it was 49%. That is
   the case relayers exist to prevent, chosen to save the fee: the median 10 ETH fee was 0.042 ETH
   against 0.00024 ETH of gas. With the pool as sender, a fresh recipient pays from the note, and
   nothing outside the pool is linked.

3. **33 addresses relayed 8,614 withdrawals.** The busiest sent 26% of them. One address sent 77% of
   Privacy Pools' relayed withdrawals, and 4 sent all of them. Each relayer sees every request it
   relays when it arrives, and can refuse it. A frame withdrawal can be handed to any node.

4. **With no relayer, the note overpays unless the pool refunds.** The fee must cover the maximum
   cost, so a note priced with ordinary headroom paid 2.56 times its gas. Experiment 06 left the
   difference in the pool. RefundPool returns it in a last frame, using
   $\texttt{TXPARAM(0x06)} / \texttt{TXPARAM(0x04)}$ to recover the intrinsic gas the protocol does
   not expose. The note then paid 1.023 times its gas, for 11,820 more gas. The same identity
   serves any post-op that refunds. Experiment 29's sponsor refunds unused gas at the max fee. On
   the testnet, where the base fee is 7 wei, that loses nothing. With a max fee above the price, as
   on mainnet, the sponsor would keep the difference, and the identity lets it refund that too.

5. **Priced at each relayed withdrawal's own gas price, the same withdrawals with no relayer would
   have cost 4.65 ETH instead of 224.5 ETH.** By median, that is 3.6, 14.3, 124 and 729 times
   cheaper on the 0.1, 1, 10 and 100 ETH pools, and 1.4 times on Privacy Pools. The comparison is
   conservative for frames. RefundPool's 593,130 gas includes 281,520 of EIP-8037 state gas, for
   the nullifier's nonce key and the recipient's new account. Today's mainnet prices the same state
   at about 47,000: 22,100 for a new storage slot and 25,000 for a value transfer that creates an
   account. The relayers' transactions pay today's prices and use 410k to 430k.

6. **What frames do not remove.** The relayer also hides the user from whoever first sees the
   transaction. A frame withdrawal still has to reach a node from some IP address: over Tor, a
   mixnet, or a node the user runs. Railgun's broadcasters, which take requests over Waku, already
   do this part. Frames remove the payment, not the network path. Experiment 06's keyed pool admits
   concurrent withdrawals (one nonce key per note), so the pool is not a bottleneck. Its storage
   variant admits one at a time.
