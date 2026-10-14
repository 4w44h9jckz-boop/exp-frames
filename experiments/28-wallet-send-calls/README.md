# 28 - `wallet_sendCalls` over frames

Every wallet and wallet provider in our survey (`posts/wallets-and-frames.md`) serves dapps through
[EIP-5792](https://eips.ethereum.org/EIPS/eip-5792): `wallet_sendCalls` sends a batch of calls,
`wallet_getCallsStatus` reports what happened, `wallet_getCapabilities` says what the wallet can do.
Sponsorship rides on [ERC-7677](https://eips.ethereum.org/EIPS/eip-7677)'s `paymasterService`
capability, whose web service is written for ERC-4337 EntryPoints v0.6 and v0.7. This experiment asks
whether a dapp written against those APIs works unchanged when the wallet underneath sends EIP-8141
frame transactions, and what the binding costs and leaves out.

The dapp is [`dapp.ts`](dapp.ts). It uses viem 2.57.3's stock wallet actions (`getCapabilities`,
`sendCalls`, `waitForCallsStatus`) over a `custom` transport, and nothing written for frames. The
transport is [`wallet.ts`](wallet.ts), an EIP-1193 provider for an EOA with no code:

| Batch | Frames |
|---|---|
| self-paid | `[VERIFY sender, scope 3] [SENDER call 0] ... [SENDER call n-1]` |
| sponsored | `[VERIFY sender, scope 2] [VERIFY paymaster, scope 1] [SENDER call 0] ... [SENDER call n-1]` |

With `atomicRequired` (viem's `forceAtomic`), every call frame but the last carries the atomic-batch
flag, so the calls commit or roll back together. Without it, the calls are independent frames of one
transaction. The protocol's default code checks the user's one secp256k1 signature.

[`paymaster.ts`](paymaster.ts) is a paymaster web service in ERC-7677's shape, bound to frames, in
front of a canonical paymaster instance (experiment 09's runtime, EIPs#12041) whose signer it holds.
Its policy `toy-dex` pays for calls to Token A and the DEX of experiment 03, up to 0.01 ETH of maximum
cost. The binding, field by field:

| ERC-7677 | Frames binding |
|---|---|
| `entryPoint` parameter | `0x00...aa`, the frames entry point, which says "frames" |
| user-operation parameter | the unsigned frame transaction, in the JSON of [`binding.ts`](binding.ts) (there is no agreed JSON for a frame transaction: experiment 22) |
| `paymaster` | the pay frame's target |
| `paymasterData` | the pay frame's data |
| `paymasterVerificationGasLimit` | the pay frame's execution budget |
| `paymasterPostOpGasLimit` | a DEFAULT frame after the calls, aimed at the paymaster; 0 means none |
| `sponsor`, `isFinal` | as in ERC-7677 |
| *(none)* | **`paymasterStateGasLimit`**: the pay frame's EIP-8037 state budget. A pay frame that approves a sender with no account creates it, 183,600 state gas |
| *(none)* | **`paymasterSignatures`**: the payer's signature entries. The canonical paymaster reads its signer's entry at index 1, so the sender's entry must be index 0 |

ERC-7677 has the paymaster sign first and the user last. That works unchanged: the canonical signature
hash elides every signature whose `msg` is empty, the user's included, so the paymaster signs the same
hash the user will.

| File | What |
|---|---|
| [`wallet.ts`](wallet.ts) | The EIP-1193 provider: capabilities, `wallet_sendCalls` (build, estimate, sign, send), `wallet_getCallsStatus` (EIP-5792 status from frame receipts) |
| [`paymaster.ts`](paymaster.ts) | The paymaster web service, its canonical paymaster instance, its policy |
| [`binding.ts`](binding.ts) | The JSON an unsigned frame transaction travels in |
| [`dapp.ts`](dapp.ts) | Setup, then cases A to H through viem |
| [`rails.ts`](rails.ts) | The same batch on four rails, two rounds each |

## Run

```bash
npx tsx experiments/28-wallet-send-calls/dapp.ts        # setup (once), then A-H
npx tsx experiments/28-wallet-send-calls/rails.ts r1    # fresh EOAs per run label; needs experiment 21's EntryPoint
```

## Results (2026-10-14, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

The paymaster instance is `0xC925Ee6cb70CFd7B97bBb93B5b070C185e43159E` (signer
`0x9D29Ff745f5306ccd52A066D11Ce0F964B3d13E6`); Alice is `0x88Bf7273077F8c4f07d727f0Ef79Ec80dFF50A2d`
and holds ETH; Bob is `0x83D00Dd052eb3a8181E4C08C7E8062645A7Bc098` and holds none.
The table is the second run of `dapp.ts`, when Alice and Bob already had Token B, so it shows the
steady state. In the first run, B used 188,241 gas and C 381,686: C then included the 183,600 that
creating Bob's account cost, paid by the pay frame.

| Case | EIP-5792 status | Tx | `gasUsed` | Frame statuses | What the dapp sees |
|---|---|---|---|---|---|
| **A.** `wallet_getCapabilities` | | | | | `{"8141": {"atomic": {"status": "supported"}, "paymasterService": {"supported": true}}}` |
| **B.** approve + swap, atomic, self-paid | **200** | [`0x32eb0bc5...`](https://dora.privacy.ethrex.xyz/tx/0x32eb0bc5548ec482973ab785f4f49c5e9bee5668db7959324ba1a7f45590cd9e) | 90,321 | 1, 1, 1 | one receipt, 4 logs |
| **C.** the same, sponsored; the sender holds no ETH | **200** | [`0x9688c1f8...`](https://dora.privacy.ethrex.xyz/tx/0x9688c1f8e5ea5f0a3fe6b8c3416d45488e06c7433e763332b18db2ede10710d7) | 100,142 | 1, 1, 1, 1 | payer = the paymaster; Bob's balance 0 |
| **D.** three independent calls, the middle one fails | **600** | [`0x78564f0a...`](https://dora.privacy.ethrex.xyz/tx/0x78564f0a39b40b1b7ada544bc0750c1894e3faa2a322b0c9d736f2e489928042) | 35,310 | 1, 1, **0**, 1 | the third call ran after the second failed |
| **E.** approve + swap, atomic, the swap fails (slippage) | **500** | [`0x3fc65c1d...`](https://dora.privacy.ethrex.xyz/tx/0x3fc65c1d54cc3d4c422b8d38c0fec14725702f9a124d5d24e22f561e453d327b) | 39,434 | 1, **1**, 0 | 0 logs; the approve's frame says SUCCESS, and the allowance is unchanged |
| **F.** sponsored, a call outside the policy | | | | | `InternalRpcError (-32603)`: the service refused at `pm_getPaymasterStubData` |
| **G.** a non-optional capability the wallet lacks | | | | | `UnsupportedNonOptionalCapabilityError (5700)` |
| **H.** a call with no `to` (a deployment) | | | | | `InvalidParamsRpcError (-32602)` |

Round trips and maximum cost, from the same run:

| Case | Round trips, in order | Max cost: draft, final (wei) |
|---|---|---|
| B | user signs the draft; simulate; user signs the final; simulate; send | $1.597 \times 10^{15}$, $0.910 \times 10^{15}$ |
| C | `pm_getPaymasterStubData`; `pm_getPaymasterData`; user signs the draft; simulate; `pm_getPaymasterData`; user signs the final; simulate; send | $1.617 \times 10^{15}$, $0.929 \times 10^{15}$ |

What the node serves for D and E, read back with `eth_getTransactionReceipt`:

| Case | Transaction `status` | Frame statuses | Logs per frame |
|---|---|---|---|
| D | `0x0` | 1, 1, 0, 1 | 0, 1, 0, 1 |
| E | `0x0` | 1, 1, 0 | 0, 0, 0 |

### The same batch on four rails (`rails.ts`)

Fresh EOAs, one per rail, each holding Token A. Round 1 creates the user's Token B balance; round 2 is
the steady state. The ERC-4337 contracts are experiment 21's: EntryPoint v0.8 and `Simple7702Account`
with that EntryPoint patched in. Both EIP-7702 EOAs first delegated with a self-sent type-4
transaction, 58,052 gas each.

| Round | Rail | Tx | `gasUsed` | Signatures |
|---|---|---|---|---|
| 1 | frames, default code, self-paid | [`0x9489899e...`](https://dora.privacy.ethrex.xyz/tx/0x9489899ebee99bbbda3c7274ea86ee8108df1bcf3ce33eaa2238f188219c6fde) | 188,229 | user 2 (one for estimation) |
| 1 | frames, default code, canonical paymaster | [`0x57135ff7...`](https://dora.privacy.ethrex.xyz/tx/0x57135ff7a484a2f92030479de7ae0fae015519bf8e19a0822ab641a069eaf3ad) | 381,686 | user 2; paymaster 2, plus a stub |
| 1 | type 2, EIP-7702 delegate's `executeBatch` | [`0x659c2f58...`](https://dora.privacy.ethrex.xyz/tx/0x659c2f581ba457e63909d7c90c0ea55e07a7b9c9acc419f8f85d745dfa284c4b) | 190,063 | user 1 |
| 1 | ERC-4337 v0.8, EIP-7702 delegate's `executeBatch` | [`0x7dd8cdea...`](https://dora.privacy.ethrex.xyz/tx/0x7dd8cdea330b2fc449a203ef995be4d9b378f3f4319e67499266bf6ff0090a76) | 461,230 | user 1; bundler 1 |
| 2 | frames, default code, self-paid | [`0x644424fe...`](https://dora.privacy.ethrex.xyz/tx/0x644424feaff57ea728c954f367be786567b713dcef7f49fe5feb2ee5d855067d) | **90,321** | user 2 (one for estimation) |
| 2 | frames, default code, canonical paymaster | [`0xd3c04b29...`](https://dora.privacy.ethrex.xyz/tx/0xd3c04b29114f2fc0742183f5c63d5a5af7676250993d4a4f9e903457550b6bc8) | **100,142** | user 2; paymaster 2, plus a stub |
| 2 | type 2, EIP-7702 delegate's `executeBatch` | [`0xf834a460...`](https://dora.privacy.ethrex.xyz/tx/0xf834a4603566e4c9b3c14f56202a544deeac180b82bb1892fd7fbbb82ae861d0) | **92,143** | user 1 |
| 2 | ERC-4337 v0.8, EIP-7702 delegate's `executeBatch` | [`0x699c3bb3...`](https://dora.privacy.ethrex.xyz/tx/0x699c3bb395ff518248ee09e02f162f27a142f871f4d834d138681b3e05ac4a64) | **167,458** | user 1; bundler 1 |

Round 1's sponsored row is 193,457 above the self-paid one: 183,600 for creating the sponsored user's
account, which the pay frame pays, and 9,857 for the pay frame and the paymaster's signature. The
ERC-4337 operations reported `actualGasUsed` 388,081 and 202,033, which is what the account was charged;
the bundler's transaction is the `gasUsed` above. Experiment 21's exclusions apply: no bundler
simulation, a fixed `preVerificationGas` of 50,000, one operation per bundle.

## Observations

1. **A dapp written against EIP-5792 needs no change.** viem's stock actions drove every case,
   including sponsorship, and read the results back through `waitForCallsStatus`. The capability
   answer is the interesting part: every EOA can batch atomically through the default code, so the
   wallet reports `atomic: supported` at once. An EIP-7702 wallet whose EOA has not delegated yet can
   only say `ready`, and EIP-5792 says it "MUST upgrade before proceeding": a type-4 transaction,
   58,052 gas here.

2. **In gas, frames match the EIP-7702 batch and undercut ERC-4337.** In the steady state the batch
   cost 90,321 as frames, 92,143 through a 7702 delegate's `executeBatch` and 167,458 through
   EntryPoint v0.8. Frames need no delegation and no delegate contract. Sponsoring it cost 9,821
   more, and needs no relayer: the user's own wallet sent the sponsored transaction.

3. **One frame transaction carries both of EIP-5792's semantics.** With `atomicRequired`, the calls
   commit or roll back together (E: status 500). Without it, they are independent frames of one
   transaction, and two of three calls persisted after the second failed (D: status 600). A 7702
   delegate's `executeBatch` and an ERC-4337 `executeBatch` revert everything on any failure, so a
   wallet on those rails gets partial success only by sending several transactions.

4. **Neither the transaction status nor the frame statuses say what happened; the wallet has to
   derive it.** EIP-8141's receipt "carries no transaction-level status ... An interface that has to
   present a single status for the transaction therefore derives it" (master, 2026-10-08).
   - ethrex's JSON derives `status: 0x0` whenever any frame failed. In D that is wrong in the way that
     matters: two of the three calls persisted. viem's own fallback path for wallets without EIP-5792
     reads exactly this field, and would report D as a complete failure.
   - In E, the approve's frame reports SUCCESS although the batch rolled it back. The EIP defines it
     that way: "executed frame receipts retain their execution status ... with empty logs and zero
     state gas used". Only a reader that knows which frames formed an atomic batch can tell. Our
     wallet knows, because it built the batch. A block explorer or indexer does not. A receipt status
     for rolled-back frames would make the receipt self-describing (post, smaller fixes row 10).

5. **Estimation needs real signatures.** The node simulates only a transaction whose validation prefix
   approves, so a stub signature cannot be simulated. ERC-4337 has the opposite rule: an account
   "SHOULD return `SIG_VALIDATION_FAILED` ... without reverting on signature mismatch" and "SHOULD
   complete the normal flow to enable performing a gas estimation". Here the user signed twice (a
   draft with generous budgets, then the final one), and the paymaster service was called three
   times instead of ERC-7677's two: the stub is useless to a frames simulation.
   - A hardware wallet would prompt twice, or the wallet would send the draft's budgets. That
     reserves about 1.75 times the final maximum cost here.
   - A dummy-signature simulation mode, for example `ethrex_simulateFrameTransaction` with signature
     checks skipped, would remove the draft signature. It would not change consensus.

6. **State gas cannot be estimated per frame.** The simulation reports each frame's execution gas, not
   its state gas, and its total is net of refunds, so the state gas cannot be attributed to frames by
   subtraction. A frame short of state gas fails, and burns its whole execution budget: a probe mint
   with no state budget used 200,000 of 200,000. The wallet therefore gives every call a fixed 379,440
   of state budget (two fresh slots and one new account). That is safe for these calls and inflates
   the maximum cost. Reporting per-frame state gas from the simulation, as receipts already do, would
   fix it.

7. **ERC-7677 binds to frames with two fields added and one convention.** The pay frame's state budget
   and the payer's signature entries have no field; the canonical paymaster's signer entry must sit at
   index 1, after the sender's. A policy refusal has no error code in ERC-7677, so the dapp sees a
   generic `-32603` (F). The user-operation parameter needs a JSON for an unsigned frame transaction,
   and none is agreed yet.

8. **A call without `to` has no frame.** EIP-5792 allows a call with no `to`, which is a deployment. A
   SENDER frame with no target calls the sender itself. The wallet has to refuse it (H) or route it
   through a deployer contract.

9. **Filtering logs is easier.** EIP-5792 requires the receipt's logs to be "only ... those relevant to
   the calls". An ERC-4337 wallet filters a bundle's logs by user operation. Frame receipts carry logs
   per frame, so the wallet keeps the call frames' logs and drops the pay frame's and any post-op's.
