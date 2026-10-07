# 21 — ERC-4337 side by side: one transfer, through the EntryPoint and through frames

The plan's Track E carries two rows that only a side-by-side run can settle. **Gas**: `aa`
measured an ERC-4337 self-paid transfer at 120,162 against 47,573 as frames, on chain 81410, and
asked for a re-measurement on 8141. **No bundler, no EntryPoint, no deposits**: what does the
ERC-4337 machinery cost beyond gas?

This experiment deploys the ERC-4337 v0.8 reference contracts on chain 8141. It then sends the
same ERC-20 `transfer` five ways, with the same token, recipient, fees and basefee, in two rounds:

| Row | Rail | Sender |
|---|---|---|
| 1 | type 2 | a plain EOA, no account abstraction: the floor |
| 2 | frames | a plain EOA running the protocol's default code |
| 3 | frames | `FrameAccount`, experiment 02's smart account; round 1 creates it in the same transaction |
| 4 | ERC-4337 | the reference `SimpleAccount`; round 1 creates it through `initCode` |
| 5 | ERC-4337 | an EOA delegated by EIP-7702 to the reference `Simple7702Account` |

**What is excluded.**
- *The contracts.* The ERC-4337 contracts are the npm package `@account-abstraction/contracts@0.8.0`
  (MIT), fetched and checked against the registry's sha512 by [`artifacts.ts`](artifacts.ts); none
  of their bytes are committed here. They are deployed fresh rather than at the canonical
  addresses. `Simple7702Account` hard-codes the canonical EntryPoint, so its bytecode has that
  constant replaced with ours; nothing else is changed.
- *The bundler.* There is none. The script submits `handleOps` itself, with its own key as the
  beneficiary, so nothing here measures what a bundler's ERC-7562 simulation would admit.
- *The UserOperation's gas fields.* `preVerificationGas` is a fixed 50,000 rather than computed from
  calldata. `callGasLimit` is 120,000. `verificationGasLimit` is 1,500,000 for the creating
  operation and 150,000 otherwise.
- *Batching.* Every `handleOps` carries one operation. A bundler's economics come from batching.
- *New accounts.* Both smart accounts' addresses were funded with ETH before they had code, which
  is the usual counterfactual flow. Neither creation therefore pays the 183,600 a new account costs.
- *Noise.* A signature's zero bytes cost 4 gas and its non-zero bytes 16, so the same row moves by
  multiples of 12 gas between runs.

| File | What |
|---|---|
| [`side-by-side.ts`](side-by-side.ts) | Setup (deploy, then fund and mint), the EIP-7702 delegation, then the five rows per round |
| [`artifacts.ts`](artifacts.ts) | Fetches and verifies the v0.8.0 package; `artifact(name)` |
| [`FrameAccount.yul`](FrameAccount.yul) | Experiment 02's `SimpleAccount`, renamed to keep it apart from ERC-4337's |
| [`baseline.ts`](baseline.ts) | Two plain type-2 sends that fix the type-2 intrinsic cost on this chain |

## Run

```bash
npx tsx experiments/21-erc4337-side-by-side/side-by-side.ts     # first run: deploys, then exits
npx tsx experiments/21-erc4337-side-by-side/side-by-side.ts 2   # funds, mints, delegates, two rounds
npx tsx experiments/21-erc4337-side-by-side/baseline.ts
```

On a chain where the contracts and accounts already exist, the first round is no longer a
creating round.

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

| Name | Address |
|---|---|
| EntryPoint v0.8 | `0x992bDBa963772035A7dDC90086ee383D696BAFFA` |
| SimpleAccountFactory | `0xfE0EF86B67481B4C4Eb28C8A397a473B235F8f01` |
| Simple7702Account (EntryPoint patched) | `0xf72564aBb558797403B713152Df0D9f34923dD02` |
| TestToken | `0xf3986991b0DBC90273DCef8572f4768d7e2ca4c1` |
| FrameAccount | `0xff8ac970F3CDa64d00810D4EF1DE09908EE32FE0` |
| SimpleAccount | `0xF8B9871Fa371757BAA49259160b58A19f31859aE` |
| owner of both accounts | `0xb42642796f0eE99Bd5267b4470505b77Cf6D39F7` |
| bundler and beneficiary | `0x66F48D523bbcbaaA2D46051b394E4ed62879918e` |
| plain EOA, frames EOA, 7702 EOA | `0x725e1FC2…`, `0x4d57Aca4…`, `0x8b47eC13…` |

### Setup: what the ERC-4337 rail needs before its first operation

One frame transaction from the test key deployed all four contracts through the CREATE2 factory:
[`0xe2e6dcea…`](https://dora.privacy.ethrex.xyz/tx/0xe2e6dcea405bab96bf034108ab12d993afe0e4726940d8b8976661729e94064e),
**60,289,577 gas**. Every state charge decomposes exactly into 1,530 per byte of code, 183,600
per new account and 97,920 per fresh slot:

| Contract | Runtime bytes | State gas | Decomposition | Execution |
|---|---|---|---|---|
| EntryPoint, and the SenderCreator its constructor deploys | 21,738 + 1,217 | 35,488,350 | $22{,}955 \times 1{,}530 + 2 \times 183{,}600$ | 50,156 |
| SimpleAccountFactory, and the SimpleAccount implementation its constructor deploys | 2,173 + 6,362 | 13,523,670 | $8{,}535 \times 1{,}530 + 2 \times 183{,}600 + 97{,}920$ (the implementation's `_disableInitializers`) | 48,332 |
| Simple7702Account | 3,639 | 5,751,270 | $3{,}639 \times 1{,}530 + 183{,}600$ | 15,268 |
| TestToken, used by both rails | 1,684 | 2,955,960 | $1{,}684 \times 1{,}530 + 183{,}600 + 2 \times 97{,}920$ | 40,114 |

The three ERC-4337 contracts' state gas is **54,763,290**. The rest of the transaction, 2,570,327,
is the calldata floor: 17,175 mandatory plus 64 gas a byte over 39,893 data bytes, 39,825 of them
initcode. It binds over the 578,699 intrinsic and 153,970 of execution, because a deployment is
mostly bytes. The frame rail deploys nothing. `FrameAccount`'s 109 bytes are per account, paid in
the account's first transaction.

`aa` built the same EntryPoint from source (solc 0.8.30, 200 runs) and got 16,067 bytes of
runtime and 27,257,484 gas (`aa`, `bench/results/erc4337-rail-2026-09-18.md`, section 1). The npm
package's build is 21,738 bytes. A chain that ships ERC-4337 ships somebody's build. On this
schedule the 5,671 bytes between these two builds are 8,676,630 gas of state.

The 7702 EOA delegated itself with a type-4 transaction it sent itself:
[`0x7829bb3d…`](https://dora.privacy.ethrex.xyz/tx/0x7829bb3d5c41e913fe31e7602819bde53c838dfa8313ea07d54908f85b1bc6be),
58,052 gas, once per EOA.

### The transfers

| Round | Rail | Sender | Tx | `gasUsed` | Bytes | EntryPoint's `actualGasUsed` |
|---|---|---|---|---|---|---|
| 1 | type 2 | plain EOA | [`0xce5d36bb…`](https://dora.privacy.ethrex.xyz/tx/0xce5d36bbb58c4792a18c9075074bc8b9bf7b456b86c636b6dcc26ad807a16dfd) | 42,989 | 68 calldata | |
| 1 | frames | plain EOA, default code | [`0x3389926a…`](https://dora.privacy.ethrex.xyz/tx/0x3389926a0e1e3df0345184d76f9bc013e5a96a7c396bd7ec17d53f10116a227c) | 47,927 | 231 envelope | |
| 1 | frames | FrameAccount, **created in the same transaction** | [`0x211d8380…`](https://dora.privacy.ethrex.xyz/tx/0x211d8380e6ae1cb35a722a0924f3fbc769ef544e44f659d44fb289ab3b26cdd3) | **233,321** | 452 envelope | |
| 1 | ERC-4337 | SimpleAccount, **created by `initCode`** | [`0x3dbe4333…`](https://dora.privacy.ethrex.xyz/tx/0x3dbe433346a3bfd17ca0697fcc2d98f2fd2768b37f3cbc831f26bf9542061270) | **897,728** | 996 calldata | 817,686 |
| 1 | ERC-4337 | 7702 EOA, **first operation** | [`0x978e5969…`](https://dora.privacy.ethrex.xyz/tx/0x978e59699517dd176b4a3a345cabd4dae153bbdda0c94756cf0126a1d6ce3181) | **318,720** | 900 calldata | 239,639 |
| 2 | type 2 | plain EOA | [`0x204a2a06…`](https://dora.privacy.ethrex.xyz/tx/0x204a2a06650d9d05b452ab268327133f84d76a1d761cc73ae53a41ea5d15e39e) | 42,989 | 68 calldata | |
| 2 | frames | plain EOA, default code | [`0x8d92c6ea…`](https://dora.privacy.ethrex.xyz/tx/0x8d92c6ea17bb5c1e02807bcf0eb883595d336702380ce5e54ed4cf6751266b4c) | 47,927 | 231 envelope | |
| 2 | frames | FrameAccount | [`0x96243e11…`](https://dora.privacy.ethrex.xyz/tx/0x96243e113085a46566d3a679c0865d8c6be6fc16f5d8f4c4e40a777061682536) | **48,435** | 251 envelope | |
| 2 | ERC-4337 | SimpleAccount | [`0x39256fe0…`](https://dora.privacy.ethrex.xyz/tx/0x39256fe0bd1b9873a052766ae75f17463de95ca3b3a15b1fe77aeb704fb0c870) | **116,735** | 900 calldata | 135,525 |
| 2 | ERC-4337 | 7702 EOA | [`0x653a6520…`](https://dora.privacy.ethrex.xyz/tx/0x653a6520efb022f92d9d91e8e868aa54b83451a11beb3ee1a9c40cbd1c1db0cd) | **122,868** | 900 calldata | 141,719 |

Every operation succeeded. The four frame transactions are fixtures in `test/fixtures/chain/`.

### Steady state: the second round

`baseline.ts` sent a type-2 transaction with no value and no data
([`0x47f60879…`](https://dora.privacy.ethrex.xyz/tx/0x47f608790a1e7a059e5b80f41d2a7be373b04731c77781b315de71171d713994),
**15,000**), and one with 1 wei
([`0x13f55eae…`](https://dora.privacy.ethrex.xyz/tx/0x13f55eaebd34916b9ad667279cfadcddf95a7d8318adf44718ef4fe14a8eb2b1),
**21,000**). EIP-2780 is therefore live on 8141, as `aa` found on 81410: the base cost is 12,000,
the recipient's touch 3,000, and value 6,000 (`aa`, `bench/results/frames-yardstick-2026-09-10.md`,
section 1). Every row then splits exactly:

| Sender | `gasUsed` | Split | Over type 2 |
|---|---|---|---|
| type 2 | 42,989 | 15,000 intrinsic + 632 calldata + 27,357 execution | |
| frames, default code | 47,927 | 17,470 intrinsic + 100 VERIFY + 30,357 SENDER | +4,938 |
| frames, FrameAccount | 48,435 | 17,790 intrinsic + 288 VERIFY + 30,357 SENDER | +5,446 |
| ERC-4337, SimpleAccount | 116,735 | 15,000 intrinsic + 5,916 calldata + 95,819 execution | +73,746 |
| ERC-4337, 7702 EOA | 122,868 | 15,000 intrinsic + 5,892 calldata + 101,976 execution | +79,879 |

The SENDER frame's 30,357 is the type-2 transfer's 27,357 plus 3,000. That 3,000 is the
recipient's cold touch: the frame pays it on entry, the type-2 transaction inside its intrinsic.
It is `aa`'s finding to the gas (30,063 against 27,063 there, with its own token build). The call
prices the same on both rails. `FrameAccount` costs 508 more than the default code: its VERIFY
runs code (288 against 100), and its signature entry names a signer, 20 non-zero bytes at 16.

**The ERC-4337 SimpleAccount costs 2.41 times the frame account for the same transfer**: 116,735
against 48,435, or 68,300 more. `aa`'s figures on 81410 were 120,162 against 47,573. The two runs
use different builds of the account and the token and different gas fields, and the gap is the
same size.

The 7702 EOA costs 6,133 more than the SimpleAccount in this round, and the account code is not
the reason. The SimpleAccount's creating operation declared 1,500,000 of verification gas, so its
prefund left a deposit large enough to cover round 2, and it paid nothing to the EntryPoint. The
7702 EOA's deposit had to be topped up, which costs a value call into the EntryPoint. In ERC-4337
an operation's cost depends on the sender's deposit history.

### First use: what creating, or being new, costs

| Sender | First | Second | First use adds | Of which |
|---|---|---|---|---|
| FrameAccount | 233,321 | 48,435 | **184,886** | 166,770 for 109 bytes of code; 15,241 for the deploy frame's execution; 2,875 for the deploy frame's bytes in the intrinsic |
| SimpleAccount | 897,728 | 116,735 | **780,993** | 215,730 for the 141-byte proxy; 293,760 for three account slots (owner, ERC-1967 implementation, initializer); 195,840 for the EntryPoint's nonce and deposit slots; 912 for the 96 bytes of `initCode` calldata; 74,751 of execution (the factory call through SenderCreator, CREATE2, the proxy's constructor and `initialize`, and a prefund payment round 2 did not need) |
| 7702 EOA | 318,720 | 122,868 | **195,852** | 195,840 for the EntryPoint's nonce and deposit slots; 12 of calldata |
| frames EOA, type 2 | | | 0 | |

The three account slots were read back after the run, and all were zero in the block before.

Part of the SimpleAccount's cost is the reference account's design rather than ERC-4337's. An
upgradeable proxy with an initializer costs three slots and a proxy; `FrameAccount` keeps its
owner in its code and has no storage. What ERC-4337 itself imposes is the last row: **a sender new
to the EntryPoint pays 195,840 for two slots of EntryPoint state**, `nonceSequenceNumber` and
`deposits`. A frame sender has neither. Its nonce is the protocol nonce in its own account, and
its fee is escrowed by the protocol rather than deposited with a contract.

### The bundler's books

The bundler pays `gasUsed` at the transaction's effective price. The EntryPoint pays it back
`actualGasUsed` at the operation's price. Both are 1,000,000,007 wei here (basefee 7, tip 1 gwei),
so the bundler's margin is the difference in gas:

| Operation | Bundler's `gasUsed` | EntryPoint's `actualGasUsed` | Bundler's margin |
|---|---|---|---|
| SimpleAccount, creating | 897,728 | 817,686 | **−80,042** |
| 7702 EOA, first | 318,720 | 239,639 | **−79,081** |
| SimpleAccount | 116,735 | 135,525 | +18,790 |
| 7702 EOA | 122,868 | 141,719 | +18,851 |
| **total** | | | **−121,482** |

The bundler was funded with 0.03 ETH, sent nothing but these four transactions, and now holds
29,878,517,999,149,626 wei. It lost 121,482,000,850,374 wei, which is exactly
$121{,}482 \times 1{,}000{,}000{,}007$.

In steady state the EntryPoint over-charges, by 15 to 16%. `preVerificationGas` stands for what
the EntryPoint cannot measure: the 15,000 intrinsic, about 5,900 of calldata, and the loop around
the operation. The fixed 50,000 is more than that. v0.8 also charges 10% of any unused
`callGasLimit` beyond 40,000. How the 18,790 splits between the two is not traced here.

On first use it under-charges by about 98,000, and the cause is the order of two lines in
`_postExecution` (`core/EntryPoint.sol` in the v0.8.0 package). `actualGas` is fixed first.
`_incrementDeposit(refundAddress, refund)` runs after it. A sender with no deposit has its
`deposits` slot written three times in its first operation:
1. the account's prefund fills it, in validation;
2. `_tryDecrementDeposit` empties it again, in validation;
3. the refund refills it, after `actualGas` is fixed.

The first two cancel inside the measured window. The third creates the slot, and its 97,920 of
state gas lands after the measurement. The numbers isolate it. The 7702 EOA's two operations
differ by 195,852 in the receipt but by exactly 97,920 in `actualGasUsed`, which is the nonce
slot, written inside the window. The deposit slot is the other 97,920, and the bundler paid it.
The SimpleAccount's gap moves by 98,832, which is $97{,}920 + 912$: the 912 is the `initCode`'s
calldata, which a fixed `preVerificationGas` does not track.

`aa`'s run did not see this. Its script calls `depositTo(account)` before the creating operation
(`aa`, `bench/sim/erc4337_rail.py`), so the slot already existed, and its creating row has the
EntryPoint charging 1,056,240 against a transaction of 1,011,416. On mainnet's schedule the same
late write costs 20,000. The clear in step 2 has already put 19,900 in the refund counter, so the
bundler loses about 100. That is derived from EIP-2200 and EIP-3529, not measured here. **A state
gas schedule turns a 100-gas leak into a 97,920 one**, on every operation from a counterfactual
account funded by a plain transfer, which is the common case.

A frame transaction has no second ledger to drift from the first. The payer is charged the
receipt's `gasUsed`, settled by the protocol.

### Deposits left behind

After two transfers each, the EntryPoint holds 2,386,788,993,327,523 wei of the SimpleAccount's
ETH and 498,280,999,007,967 wei of the 7702 EOA's. Both reconcile to the wei, with each charge
taken at 1,000,000,007 wei a gas:
- the SimpleAccount's is its creating prefund, $1{,}670{,}000 \times 2$ gwei, less both charges;
- the 7702 EOA's is $320{,}000 \times 2$ gwei, the level its second operation topped it up to, less
  that operation's charge.

The money stays with the EntryPoint until the account withdraws it, which is
another operation. A frame payer's maximum cost is escrowed for the length of one transaction,
and the unused part returns to the payer's balance at settlement. Nothing is left with any
contract.

### Estimating

ethrex's `eth_estimateGas` refused the bundler's `handleOps`, the plain EOA's type-2 transfer and
the 7702 EOA's type-4 with `Insufficient account funds`. These accounts hold 0.01 to 0.03 ETH, and
the error is consistent with the node checking the balance against the full block gas limit at
the offered fee: $200{,}000{,}000 \times 2$ gwei is 0.4 ETH. It does not appear to cap the estimate
at what the balance can buy. That reading is inferred, not taken from ethrex's source, but it
agrees with experiment 19, whose estimate for a type-4 from the well-funded test key succeeded.
The script uses fixed limits instead.

A bundler that estimates through such a node fails for any account that holds less than the
block's worth of gas. Frame transactions here are checked with `ethrex_simulateFrameTransaction`
against limits the sender declares.

## Observations

1. **Steady state: 2.41 times.** The same ERC-20 transfer costs 116,735 through the reference
   ERC-4337 account and 48,435 through a frame account on chain 8141, a difference of 68,300.
   That re-measures `aa`'s 120,162 against 47,573 on 81410 at the same size. The frame account
   costs 5,446 over a type-2 transaction; the ERC-4337 account costs 73,746 over it.

2. **Being new to the EntryPoint costs 195,840.** On a schedule that charges 97,920 a slot, the
   EntryPoint's nonce and deposit slots are a per-sender entry fee that a frame sender does not
   pay. A 7702 EOA's first operation costs 318,720 against 122,868 afterwards. Creating the
   reference SimpleAccount costs 780,993 against `FrameAccount`'s 184,886. Of the SimpleAccount's
   cost, 509,490 is the reference account's proxy and initializer, which a leaner 4337 account
   could avoid.

3. **The EntryPoint's accounting drifts from the chain's, and here it cost the bundler.** In
   steady state the EntryPoint over-charged by 15 to 16%. On first use it under-charged by 80,042 and
   79,081, because the deposit slot is created after `actualGas` is fixed. The bundler lost
   121,482 gas over four operations, confirmed to the wei by its balance. Anyone running a bundler
   on a state-gas schedule must add 97,920 to `preVerificationGas` for a sender with no deposit.
   On mainnet the same ordering costs about 100 gas.

4. **The infrastructure is 54.8 million gas of state before the first operation, and its size
   depends on the build.** The npm build of the EntryPoint is 21,738 bytes against `aa`'s 16,067
   from source, 8.7 million gas apart on this schedule. The frame rail needs nothing deployed.
   Its per-account code is the account's own business.

5. **Deposits strand ETH, and deposit history changes the price.** After two transfers, 0.0024 ETH
   of the SimpleAccount's and 0.0005 ETH of the 7702 EOA's sit in the EntryPoint. The two senders'
   identical second operations differ by 6,133, because only one had to top its deposit up.

6. **ethrex's `eth_estimateGas` refuses accounts that cannot afford a whole block at the offered
   fee.** That breaks gas estimation for the bundler and for the type-2 and type-4 transactions
   alike. It is a client behaviour rather than an EIP-8141 one, but a wallet that estimates
   ERC-4337 or EIP-7702 transactions through ethrex meets it first.

7. **For kohaku-rs.** `kohaku-userop-kit` sends EntryPoint v0.8 operations from EIP-7702
   `Simple7702Account` EOAs through a bundler. On a state-gas schedule, its first operation from a
   fresh EOA costs about 196,000 more than later ones. The bundler eats about 98,000 of that unless
   `preVerificationGas` covers it, and a bundler that does not will under-price or refuse such
   operations. The frame path in kohaku-rs (`kohaku-frame-accounts`, with its sponsor layer) has
   none of the three costs.
