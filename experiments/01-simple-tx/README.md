# 01 — Simple transaction (EIP-8141 Examples 1 and 1a)

The smallest useful frame transactions, sent from a plain EOA using the protocol's
**default code**, so no contract is needed for validation.

| Frame | Mode   | Caller      | Flags                         | Target        | Value  | Data      |
| ----- | ------ | ----------- | ----------------------------- | ------------- | ------ | --------- |
| 0     | VERIFY | ENTRY_POINT | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | 0      | Empty     |
| 1     | SENDER | Sender      | APPROVE_SCOPE_NONE            | Target        | Amount | Call data |

The transaction carries one `SECP256K1` signature with an empty `msg` (signed over the canonical
sig hash) and an empty `signer` (so it resolves to `tx.sender`). Frame 0's target is null, so it resolves
to the sender. The sender has no code, so the default code checks signature 0 and runs
`APPROVE(0x3)`: execution is approved, the nonce is bumped, and `max_cost` is escrowed from the sender.

## Run

```bash
npm run account && npm run faucet                                # once
npx tsx experiments/01-simple-tx/example-1a-transfer.ts [dest]   # Example 1a: ETH transfer
npx tsx experiments/01-simple-tx/example-1-call.ts               # Example 1: deploy + call a contract
npx tsx experiments/01-simple-tx/negative.ts                     # rule violations, simulation only
```

Every script dry-runs through `ethrex_simulateFrameTransaction` before sending; add `--dry-run` to
stop there.

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

Sender `0xa93CEe06b1e4fFACdf920BD500cb301a39DdEB74`, max fee ≈ 1 gwei (the base fee was 7 wei).

| Tx | What | Frames (execution / state gas used) | `gasUsed` |
|---|---|---|---|
| [`0x7fbe0199…`](https://dora.privacy.ethrex.xyz/tx/0x7fbe019993c2093080a1a2c71bb66a2f23f297c24b248954b729ba6e2e84411d) | 1a: 0.001 ETH to a **new** account | VERIFY 100/0 · SENDER 3,000/183,600 | 209,702 |
| [`0xb91efd4a…`](https://dora.privacy.ethrex.xyz/tx/0xb91efd4abb4e7548ae58591b2d62c9dc269686a33cb82da3caf8dec684045c43) | 1a: 0.001 ETH to an **existing** account | VERIFY 100/0 · SENDER 3,000/0 | 26,102 |
| [`0x4c68a30a…`](https://dora.privacy.ethrex.xyz/tx/0x4c68a30a16961d9d8f8a7b9582f67ef90ee9abaf9b4ef3429538163cb7f15396) | 1: SENDER → CREATE2 deployer (`salt ‖ initcode`), deploys the probe | VERIFY 100/0 · SENDER 15,149/235,620 | 268,883 |
| [`0xaa8aa58c…`](https://dora.privacy.ethrex.xyz/tx/0xaa8aa58cb05b25a23e03256f359b47b98814684417744473e8d36e3429f9268f) | 1: SENDER → probe, then DEFAULT → probe | VERIFY 100/0 · SENDER 16,879/97,920 · DEFAULT 1,987/0 | 135,015 |

The probe (`probe.ts`, 34 bytes at `0x00EeBE89C69E32A6aF547ab6294Ca95eD9B7Db26`) logs
`caller ‖ origin ‖ callvalue ‖ counter ‖ calldata` and bumps a counter in slot 0. Here is what it saw:

| Frame | `CALLER` | `ORIGIN` | counter | state gas |
|---|---|---|---|---|
| SENDER | sender | sender | 1 | 97,920 (slot 0: zero → non-zero) |
| DEFAULT | ENTRY_POINT `0xaa` | ENTRY_POINT `0xaa` | 2 | 0 (slot already non-zero) |

## Observations

1. **Default code works as specified.** A codeless EOA validates with `[VERIFY(flags=3, target=null)]`
   plus one signature. Its VERIFY frame costs only the 100-gas warm access of the sender, because
   the default code itself is free. The node classifies the prefix as `SelfVerify`.
2. **`ORIGIN` follows the frame's caller.** It is the sender in a SENDER frame and `0xaa` in a
   DEFAULT frame, at every call depth. So at a frame's top-level call, `tx.origin == msg.sender`
   holds in both modes.
3. **Two gas dimensions, and execution gas can't cover state gas.** State costs observed:
   - new account: 120 × CPSB = **183,600**
   - fresh storage slot: 64 × CPSB = **97,920**
   - contract deploy: 183,600 + 34 B × 1,530 = **235,620**

   With `limits.state = 0`, a transfer to a new address is still a valid, includable tx. Its SENDER frame
   fails and burns its whole execution budget (see `negative.ts`).
4. **A plain transfer is calldata-floor bound.** For the existing-account transfer, intrinsic + execution
   is 22,838 + 3,100 = 25,938, but the EIP-7976 floor is 21,750 (mandatory) + 68 data bytes × 64 = **26,102**,
   which is what was charged. The 65-byte signature dominates the data. These scripts leave `signer`
   empty, which saves another 20 bytes (1,280 gas at the floor rate). The mandatory 21,750 breaks down as 12,000 base +
   2 × 475 per frame + 2,800 secp256k1 + 6,000 value transfer.
5. **Over-provisioning is cheap.** Unused execution and state budgets are refunded. They only raise the
   `max_cost` escrowed up front.

### Rule violations (`negative.ts`, simulated against the live node)

| Change to Example 1a | `valid` | Node says |
|---|---|---|
| signature `v` as 27/28 | false | frame signature list does not authenticate the sender |
| signed by another key | false | frame signature list does not authenticate the sender |
| frame `value` edited after signing | false | frame signature list does not authenticate the sender (the sig hash commits to every frame) |
| SENDER frame before VERIFY | false | validation prefix does not match any recognized shape |
| VERIFY with `flags = 0` | false | validation prefix does not match any recognized shape |
| VERIFY approves execution only | false | validation prefix does not match any recognized shape (no payer) |
| VERIFY with 50 execution gas | false | validation prefix frame reverted (can't pay the 100-gas target access) |
| no signatures | false | validation prefix frame reverted (default code finds no signature 0) |
| new-account transfer, `limits.state = 0` | **true** | frame 1 fails using all 30,000 execution gas, but the tx is valid and the payer pays |
