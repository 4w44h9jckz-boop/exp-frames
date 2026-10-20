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
| [`rust-wallet.ts`](rust-wallet.ts) | kohaku-rs's Rust wallet as an EIP-1193 provider: `dapp.ts` runs against it with `RUST_WALLET` set |
| [`rebuild.test.ts`](rebuild.test.ts) | Every batch either wallet sent, rebuilt by `wallet.ts`'s layout, byte for byte |
| [`permissions.ts`](permissions.ts) | ERC-7715: a permission requested from the Rust wallet, redeemed, refused out of scope, revoked |

## Run

```bash
npx tsx experiments/28-wallet-send-calls/dapp.ts        # setup (once), then A-H
npx tsx experiments/28-wallet-send-calls/rails.ts r1    # fresh EOAs per run label; needs experiment 21's EntryPoint
npx vitest run experiments/28-wallet-send-calls          # offline: rebuild every batch from its fixture

# kohaku-rs's Rust wallet in place of wallet.ts (part 2); build it with
#   cargo build --release -p kohaku-frame-wallet --bin frame-wallet
RUST_WALLET=<kohaku-rs>/crates/target/release/frame-wallet npx tsx experiments/28-wallet-send-calls/dapp.ts
RUST_WALLET=<kohaku-rs>/crates/target/release/frame-wallet npx tsx experiments/28-wallet-send-calls/permissions.ts
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

## Part 2: the same dapp against a Rust wallet, and ERC-7715 (2026-10-20)

kohaku-rs's `kohaku-frame-wallet` (`crates/frame-wallet`, branch `claude/nifty-einstein-llp9cd`)
is the wallet of `wallet.ts` written again in Rust, over `kohaku-frame-accounts`, and served as an
EIP-1193 provider over HTTP. It has the same layout, the same estimation and the same ERC-7677
binding. With `RUST_WALLET` set, `dapp.ts` spawns one per user through
[`rust-wallet.ts`](rust-wallet.ts). The dapp's code, its viem 2.57.3 stock actions and the
paymaster service are unchanged. Run against ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`.

### The dapp, unchanged

Every case ran as it does against `wallet.ts`: A to E the same statuses, payers and round trips,
and F, G and H the same errors with the same codes. The table is the second run, the steady
state, beside part 1's second run.

| Case | EIP-5792 status | Tx (Rust wallet) | `gasUsed` | `wallet.ts`, part 1 | Frame statuses |
|---|---|---|---|---|---|
| **A.** `wallet_getCapabilities` | | | | | `{"8141": {"atomic": {"status": "supported"}, "paymasterService": {"supported": true}}}` |
| **B.** approve + swap, atomic, self-paid | **200** | [`0x28885722...`](https://dora.privacy.ethrex.xyz/tx/0x28885722e31dd0b8d61bcb2ec18c25a9bd7818ccb895cc173c227d7b53fee0a6) | 90,333 | 90,321 | 1, 1, 1 |
| **C.** the same, sponsored; the sender holds no ETH | **200** | [`0x0cd8150d...`](https://dora.privacy.ethrex.xyz/tx/0x0cd8150d99b5f9ebbb8a5d67d04a9b5c03118332bb5d1e700da28db19a7e5461) | 100,166 | 100,142 | 1, 1, 1, 1 |
| **D.** three independent calls, the middle one fails | **600** | [`0x6c5d0038...`](https://dora.privacy.ethrex.xyz/tx/0x6c5d0038a0c09e444358946f7484a8c4202b7cc625dd5e97f01fff4bfaf15bc1) | 35,300 | 35,310 | 1, 1, **0**, 1 |
| **E.** approve + swap, atomic, the swap fails | **500** | [`0xf00c9f2c...`](https://dora.privacy.ethrex.xyz/tx/0xf00c9f2cc87d4f1220e967f5c947365896f454786921e344af7c1ab1b0c73886) | 39,422 | 39,434 | 1, **1**, 0 |
| **F.** sponsored, a call outside the policy | | | | | `InternalRpcError (-32603)`, refused at `pm_getPaymasterStubData` |
| **G.** a non-optional capability the wallet lacks | | | | | `UnsupportedNonOptionalCapabilityError (5700)` |
| **H.** a call with no `to` | | | | | `InvalidParamsRpcError (-32602)` |

The first run, for new users, matched part 1's first run in the same way: B 188,241 (part 1:
188,241), C 381,674 (381,686), D 35,310 (35,310).

**Every difference is calldata.** Frame by frame, the Rust wallet's four batches have the
execution gas, state gas, statuses and limits of `wallet.ts`'s. Their data cost differs by +12,
+24, -12 and -12 gas: other users, another paymaster and other signatures, with other zero
bytes. That is all of B's, C's and E's difference. D's refund is capped at a fifth of its gas, and
its 12 fewer gas lowered the cap by 2, which makes -10.

**Each wallet rebuilds the other's.** [`rebuild.test.ts`](rebuild.test.ts) rebuilds all twelve
batches with `wallet.ts`'s layout, factored out as `batchFrames`, `withPayer` and `tightened`:
part 1's eight and the Rust wallet's four. The inputs are the calls, the atomic flag, the payer's
quote, the envelope and each call's use. Each batch reaches its signature hash, and with the mined
signature put back, its bytes. kohaku-rs's `crates/frame-wallet/tests/experiment_28.rs` rebuilds
the same twelve in Rust.

### ERC-7715 bound to frames

[ERC-7715](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7715.md) (Draft, read at
`ethereum/ERCs` `48dc87a2897c`) defines `wallet_requestExecutionPermissions`. It requires
ERC-4337 and ERC-7710: a granted permission is redeemed by calling a delegation manager's
`redeemDelegations`. A frames binding needs no delegation manager. The user's account is a
`SessionAccount` (experiment 12), and its own `VERIFY` checks every session transaction. The
binding, as the Rust wallet implements it (`crates/frame-wallet/src/permissions.rs`):

| ERC-7715 | Frames binding |
|---|---|
| `from` | the user's `SessionAccount`, owned by the wallet's key |
| `to` | the dapp's session key |
| permission `native-token-allowance`, `data.allowance` | the session's budget in wei, which counts value sent and each transaction's maximum fee |
| rule `expiry`, `data.timestamp` | the session's `validUntil`; required, since every session transaction carries an expiry frame |
| rule `call-target`, `data.target`, `data.selector` | **not in ERC-7715**: the one contract and function the session may call; required |
| `isAdjustmentAllowed` | not used: granted as asked or refused |
| `context` | `account (20 bytes) \|\| session key (20 bytes)` |
| `delegationManager` | the account itself |
| `dependencies` | always empty: the account must already be deployed |
| redemption | a frame transaction `[expiry] [VERIFY account] [SENDER spend record] [SENDER calls]`, signed by the session key, sent by anyone |
| `wallet_revokeExecutionPermission` | the owner's transaction removing the session |

What it leaves out:
- **One permission type.** Only `native-token-allowance` is granted. Its budget also pays the
  session's fees, which ERC-7715's allowance does not mention.
- **A rule ERC-7715 does not have.** A `SessionAccount` session reaches one target and one
  selector, so `call-target` is required. Any rule the account cannot enforce is refused rather
  than ignored, because ERC-7715 says the `to` account "MUST abide by" every rule and only the
  account's code can make it.
- **No ERC-7710.** There is no delegation manager, no execution mode, and one call shape.
- **An EOA cannot grant.** The default code checks the sender's own key only, so the Rust wallet
  answers the permission methods with 4200 for an account with no code. A `SessionAccount`
  cannot deploy itself in a validation prefix, so `dependencies` has nothing to offer.
- **Revocation does not reach a pending session transaction.** The owner overtakes one by
  replacement, as experiment 12 found.

[`permissions.ts`](permissions.ts) asks the Rust wallet for a permission over plain EIP-1193
requests. It redeems the permission with experiment 12's own `sessionTx`, signed by the dapp's
key. The third run:

| Case | Result | Tx | `gasUsed` |
|---|---|---|---|
| **I.** `wallet_getSupportedExecutionPermissions` | `{"native-token-allowance": {"chainIds": ["0x1fcd"], "ruleTypes": ["expiry", "call-target"]}}` | | |
| **J.** `wallet_requestExecutionPermissions`: `approve` on Token A, 0.002 ETH, one hour | granted; the owner's transaction added the session | [`0x739dbfa0...`](https://dora.privacy.ethrex.xyz/tx/0x739dbfa01e2109f776e13e4614235c5d726f92508e7bd48a7178add8252aca2a) | 348,853 |
| **K.** the dapp redeems it: `approve(TOY_DEX, 1)` from the user's account, signed by the session key | every frame succeeded, the allowance is 1; the account paid; 0.000263 of 0.002 ETH spent | [`0x97a10945...`](https://dora.privacy.ethrex.xyz/tx/0x97a109454a5f08ae733058dbfc1ef4518fdacbe02ffab35ca52eacfdac12df02) | 156,001 |
| **L.** a call outside the grant, Token A's `transfer` | refused in simulation: "validation prefix frame reverted" | | |
| **M.** `wallet_revokeExecutionPermission`, then K again | no grant left, the session inactive on chain; the same redemption refused in simulation | [`0x8e7dbfdf...`](https://dora.privacy.ethrex.xyz/tx/0x8e7dbfdf05aebe44cc7a53ae8eb5efb7d21ca7932f91c41f894f41ca8f8be85f) | 43,578 |
| **N.** viem 2.57.3's experimental `grantPermissions` | `UnsupportedProviderMethodError (4200)`: it sends `wallet_grantPermissions` | | |

The account is `0x0aEFecDE5e3Ce37fa435A781f252305729e82dB6`. The grant's 348,853 gas is mostly
the session's three fresh slots: 293,760 of state gas. The redemption's 156,001 is 3,051 for the
expiry frame, 7,503 for the session's `VERIFY`, 10,724 for the spend record, and the `approve`
with 97,920 of state gas for the new allowance slot.

**The first two runs redeemed nothing.** Experiment 12's `sessionTx` gives call frames no state
budget, which suits its plain transfers to an existing account. An `approve` to a spender with no
allowance creates a slot. Without the slot's state gas, the call frame failed and burned its
whole 50,000 execution budget, and the transaction was still mined: the spend was recorded and
the account paid. That is [`0x78bf3318...`](https://dora.privacy.ethrex.xyz/tx/0x78bf331853188830024bb4b0fbbf512e7239d61621db7bec7947c8dbb064cfa8),
kept as a fixture, frame statuses 1, 1, 1, 0. The script's first version counted it as redeemed
because it was mined; it now gives the call its 97,920 of state budget through `sessionTx`'s
`edit` hook, and stops if any frame fails. The account accepts the state budget because it prices
the session's spend on the maximum cost, state included.

kohaku-rs's `crates/frame-wallet/tests/permissions.rs` rebuilds the grant, the revocation and
the redemption byte for byte. Experiment 12's TypeScript built the redemption; the Rust wallet
sent the other two.

### Observations, part 2

10. **A dapp needs no change for a wallet written in another language.** viem's stock actions
    drove a Rust wallet exactly as they drove `wallet.ts`. The wallet is the only thing that
    knows a batch is frames. In the steady state the two implementations spent the same frame
    gas to the unit, and differed only by calldata the users' keys decide.
11. **ERC-7715 binds to frames, at a price in the account.** The permission's semantics are
    `SessionAccount`'s, so the binding needs one rule ERC-7715 lacks and refuses what the account
    cannot enforce. A grant costs the user a transaction of about 350,000 gas, almost all of it
    state, where an ERC-7710 delegation is an off-chain signature. A redemption needs no relayer
    and no delegation manager. It is a transaction from the user's account that its own
    `VERIFY` checks frame by frame, and anyone can send it.
12. **A session that writes state must budget for it, and its budget pays for that.** The state
    budget a call frame needs is the dapp's to set, and the account counts it in the maximum
    cost it charges to the session's budget: 0.000263 ETH for one `approve`. A redemption short
    of state gas is still mined and still spends the budget, as the first runs showed. A session
    ERC like ERC-7715 says nothing about who prices state, and a session builder that leaves it at
    zero fails silently on the first write.
13. **viem's ERC-7715 action follows an earlier draft.** viem 2.57.3's experimental
    `grantPermissions` sends `wallet_grantPermissions` with a `permissions` array and `policies`.
    The ERC as read names `wallet_requestExecutionPermissions`, with `permission` and `rules`.
    A wallet that implements the ERC refuses viem's request, and the reverse holds too. The ERC
    also writes `ruleTypes` in its schema and `rulesTypes` in its example.
