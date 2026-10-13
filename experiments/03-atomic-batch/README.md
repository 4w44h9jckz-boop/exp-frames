# 03 — Atomic approve + swap (EIP-8141 Example 2)

An EOA approves a DEX and swaps in one transaction. The two frames form an **atomic batch**: if the
swap reverts, the approval is rolled back with it, so the account is never left with a dangling
allowance.

| Frame | Mode   | Caller      | Flags                         | Target        | Value | Data                 |
| ----- | ------ | ----------- | ----------------------------- | ------------- | ----- | -------------------- |
| 0     | VERIFY | ENTRY_POINT | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | 0     | Empty                |
| 1     | SENDER | Sender      | ATOMIC_BATCH_FLAG             | ERC-20        | 0     | approve(DEX, amount) |
| 2     | SENDER | Sender      | APPROVE_SCOPE_NONE            | DEX           | 0     | swap(...)            |

A batch is a run of frames carrying `ATOMIC_BATCH_FLAG` (`0x4`) plus the first frame after them
without it. Frame 1 opens the batch and frame 2 closes it.

- **Contracts:** Token A and Token B are [`TestToken`](../../contracts/TestToken.sol) (anyone can mint).
  [`ToyDex.sol`](ToyDex.sol) swaps A for B 1:1 out of its reserves and reverts with `"slippage"` when
  `minOut` is above the amount. That revert is how runs B and C make the swap fail.
- **Setup:** [`setup.ts`](setup.ts) sends one frame transaction with five SENDER frames: three CREATE2
  deployments plus two mints. It does nothing if the contracts already exist.

## Run

```bash
npx tsx experiments/03-atomic-batch/example-2-approve-swap.ts   # setup (once), runs A–C, cleanup
npx tsx experiments/03-atomic-batch/negative.ts                 # simulation only
```

`example-2-approve-swap.ts` makes three transactions from the same EOA:

- **A.** The example as written.
- **B.** A three-frame batch `approve → swap(minOut too high) → transfer 1 B`, every frame but the last
  flagged.
- **C.** The same three frames without the flag.

A last transaction resets the allowance that C leaves behind, so the script can be re-run.

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

Trader `0xa93CEe06b1e4fFACdf920BD500cb301a39DdEB74`. Token A `0x8C2c…4B2a`, Token B `0x7f6B…Cc69`,
ToyDex `0x773d…67f7`.

| Tx | What | Frames: status, execution / state gas | `gasUsed` | After |
|---|---|---|---|---|
| [`0xed789253…`](https://dora.privacy.ethrex.xyz/tx/0xed7892538fb269049d3a9d21376528abd3902f408144e74f2225314f117d00eb) | setup: 3 deployments + 2 mints | VERIFY 100/0 · 43,014/2,955,960 · 40,114/2,955,960 · 13,468/1,494,810 · 26,948/195,840 · 26,948/195,840 | 8,233,788 | A=1000 B=0 |
| [`0x952ac725…`](https://dora.privacy.ethrex.xyz/tx/0x952ac725a9f1ce2c169d38b2513fc85c9013d89a8e1e57e224a5d3d80773ec28) | **A.** approve (batched) + swap | VERIFY 100/0 · approve SUCCESS 17,519/**0** · swap SUCCESS 64,305/195,840 | 286,161 | A=990 B=10 allowance 0 |
| [`0xf790e5ad…`](https://dora.privacy.ethrex.xyz/tx/0xf790e5adbda3e6807d6752800667ec0337922abee23a1fd1e82b1e511446df2e) | **B.** batch, swap reverts | VERIFY 100/0 · approve SUCCESS 17,519/0 (0 logs) · swap FAILURE 3,394/0 · transfer **SKIPPED** 0/0 | 40,517 | A=990 B=10 allowance 0 |
| [`0x5c08e5fe…`](https://dora.privacy.ethrex.xyz/tx/0x5c08e5feca6995ba2ae3b782d61c3ed1b4159ea95c24df70895afb2bc5c2ed89) | **C.** no flag, swap reverts | VERIFY 100/0 · approve SUCCESS 17,519/97,920 · swap FAILURE 3,394/0 · transfer SUCCESS 30,357/97,920 | 266,738 | A=990 B=9 **allowance 10** |
| [`0xaca3e784…`](https://dora.privacy.ethrex.xyz/tx/0xaca3e784a3a0308bdef23b25d4e6e5edbb153c36f1d7c81621b8e30226a850df) | cleanup: approve(0) | VERIFY 100/0 · approve SUCCESS 17,519/0 | 28,004 | allowance 0 |

## Observations

1. **The batch works as specified.** In B the swap reverted, the approval was rolled back, and the
   frame after the failure was marked `SKIPPED` (status 2) without running. The allowance stayed
   0. In C the same failure left a 10-token allowance to the DEX, and the transfer after it went
   through.
2. **A rolled-back frame keeps `status = SUCCESS`.** In B, frame 1's receipt says SUCCESS with
   17,519 execution gas, but its `Approval` log is gone and its state gas is 0. The spec only adds a
   status for *skipped* frames. To learn that frame 1 was undone, a wallet or indexer has to look at
   the flags: frame 1 is in a batch, and a later frame of that batch failed. Logs alone are not
   enough, since a frame can succeed without logging.
3. **A failed batch costs only the execution gas burnt before the failure.** B paid 40,517: intrinsic
   gas plus 100 + 17,519 + 3,394. The approve's 97,920 state charge was dropped with the batch. The
   nonce was still consumed and the fee still paid, because approval happened in frame 0, outside
   the batch. The spec forbids approval scopes inside a batch for exactly this reason.
4. **Approve + exact swap is free in state gas.** In A the approve frame's state gas is **0**, not
   97,920. `transferFrom` spent the allowance back to zero in frame 2, and the EIP-8037 refill went
   to the frame that owned the charge (frame 1), not the frame that cleared the slot. On top of
   that, restoring an originally empty slot refunds 10,000 (EIP-3529, Amsterdam values): the
   simulator's pre-refund 296,161 settled to 286,161. Frame 2's 195,840 is the two genuinely new
   balance slots: the DEX's Token A balance and the trader's Token B balance.
5. **The cleanup refund is capped.** Clearing a slot that held a non-zero value at tx start refunds
   (10,000 + 2,100) × 4,800 / 5,000 = 11,616. The cap of `gas_used / 5` = 7,001 applied:
   35,005 → 28,004.
6. **The simulator reports gas before the refund.** `ethrex_simulateFrameTransaction`'s `gasUsed` and
   the receipt differ by exactly the capped refund. The RPC doesn't expose the refund counter, so
   the two fixtures above record it in `meta.refund`. The tooling's settlement test reads it there.
   The simulator also reports a skipped frame as `succeeded: false, gasUsed: 0`. Only the zero gas
   tells it apart from a failure.
7. **Swap failure costs 3,394 vs 494.** Both revert at the `require` on the first line. In runs B and
   C the DEX is touched for the first time in the transaction, so the access is cold. In
   `negative.ts`'s back-to-back case an earlier frame has already warmed it. The difference of 2,900
   is Amsterdam's cold account access (3,000) minus a warm one (100); before Amsterdam it was 2,600.

### Batch rules (`negative.ts`, simulated)

The node checks every static rule from the spec before running anything. `valid=false` comes with
these violations:

| Case | Flags | Node says |
|---|---|---|
| `ATOMIC_BATCH_FLAG` on the last frame | `0x3, 0x0, 0x4` | `Frame 2: atomic batch flag on last frame` |
| `ATOMIC_BATCH_FLAG` on a VERIFY frame | `0x4, 0x3, 0x0` | `Frame 0: atomic batch flag on a VERIFY frame` |
| batch terminated by a VERIFY frame | `0x3, 0x4, 0x0`(VERIFY) | `Frame 1: atomic batch flag followed by a VERIFY frame` |
| approval scope on a batched frame | `0x3, 0x5, 0x0` | `Frame 1: approval scope on an atomic-batch frame (flags=0x05)` |
| approval scope on the frame closing a batch | `0x3, 0x4, 0x1` | `Frame 2: approval scope on an atomic-batch frame (flags=0x01)` |
| reserved flag bit 3 | `0x3, 0x8, 0x0` | `Frame 1: reserved flag bits must be zero (flags=0x08)` |

Two valid layouts:

| Case | Flags | Simulated frames |
|---|---|---|
| two back-to-back batches, only the second fails | `0x3, 0x4, 0x0, 0x4, 0x0` | ok · ok 17,519 · ok 64,305 · ok 12,619 · FAILED 494 |
| DEFAULT frame (caller `ENTRY_POINT`) batched with a failing SENDER frame | `0x3, 0x4(DEFAULT), 0x0` | ok · ok 29,848 · FAILED 3,394 |

A frame without the flag closes its batch, so a new batch can start on the very next frame. The
spec's rollback goes back only to the start of the failing batch. The simulator reports "ok" for
rolled-back frames too (observation 2), so these runs show both layouts are accepted, but not which
writes survive. That would take a mined transaction. DEFAULT frames can be batched, so batch
membership is not tied to the sender.
