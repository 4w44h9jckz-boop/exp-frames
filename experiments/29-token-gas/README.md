# 29 - Gas paid in tokens, with no server

Gas paid in tokens is the feature the most wallets in our survey ship (`posts/wallets-and-frames.md`):
MetaMask, Trust, Tangem, Phantom, Coinbase, and every ERC-4337 provider. Every one of them has a
server in the loop. Either the wallet's backend signs a fee quote and relays the transaction, or an
ERC-20 paymaster accepts only operations its off-chain service has priced and signed. Experiment 04
showed why a frames sponsor cannot simply drop the server: its VERIFY frame may not read the user's
token balance, so a user who empties their wallet first gets their gas paid for nothing.

This experiment builds the version with no server at all and measures what it costs the sponsor. A
user who holds only Token A swaps some of it for ETH and repays the sponsor out of the proceeds, in
the same atomic batch. Paying in ETH needs no price: the sponsor is repaid in the currency it spends.
The swap needs no allowance from anyone else, and the sponsor needs no signer, no oracle and no
storage.

[`GasForOutput.yul`](GasForOutput.yul) is the sponsor. Its VERIFY frame approves payment when:
- the transaction's maximum cost is at most its cap, 0.005 ETH;
- every frame from its own to the repayment is a SENDER frame with the atomic-batch flag, so the calls
  and the repayment are one batch;
- the repayment is a SENDER frame to it, closing the batch, with value at least the maximum cost
  (`TXPARAM(0x06)`);
- optionally, the last frame is its post-op, a DEFAULT frame with at least 30,000 gas.

The post-op refunds the user the gas the earlier frames left unused, priced at the max fee, when the
repayment succeeded. It never checks what the calls are. A variant built with `check = 1` also reads
the token's `balanceOf(sender)` in VERIFY and requires the batch's first call, `approve(spender,
amount)`, to be covered. That read is outside the sender's storage, which the public mempool forbids,
so the variant exists to be refused.

| Frame | Mode | Flags | Target | What |
|---|---|---|---|---|
| 0 | VERIFY | `APPROVE_EXECUTION` | sender | default code, the user's signature |
| 1 | VERIFY | `APPROVE_PAYMENT` | GasForOutput | the layout checks above |
| 2 | SENDER | atomic | Token A | `approve(dex, amount)` |
| 3 | SENDER | atomic | ToyEthDex | `swapForEth(amount, minOut)` |
| 4 | SENDER | | GasForOutput | repays the maximum cost, in ETH |
| 5 | DEFAULT | | GasForOutput | post-op: refunds the unused gas |

[`ToyEthDex.sol`](ToyEthDex.sol) is a constant-product pool of Token A against ETH, token in and ETH
out, with no fee. The repayment's value is part of the calldata it pays for, and so is the
signature's, so [`token-gas.ts`](token-gas.ts) iterates the value to a fixed point with a worst-case
65-byte signature priced in. The first attempt priced the unsigned transaction, and every VERIFY
reverted: the signed transaction cost more than the repayment.

| File | What |
|---|---|
| [`GasForOutput.yul`](GasForOutput.yul) | The sponsor |
| [`ToyEthDex.sol`](ToyEthDex.sol) | The pool |
| [`token-gas.ts`](token-gas.ts) | Setup, then cases B to H |

## Run

```bash
npx tsx experiments/29-token-gas/token-gas.ts   # setup (once), then B-H
```

## Results (2026-10-14, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

| Contract | Address |
|---|---|
| ToyEthDex (1,000 Token A against 0.5 ETH at setup) | `0xc5c0c3fd960821dc9E8C10932857F55D83b7F413` |
| GasForOutput, cap 0.005 ETH | `0xe96D2b2655E0F397cf3dB549835B29746c6F2662` |
| GasForOutput, cap 0.005 ETH, `check = 1` | `0xE3AF2f4CCbF0f0CE00B9f492a1F1F906130d7d38` |
| a contract that is one `INVALID` opcode (runtime `0xfe`) | `0x9221Df381613c587fa1cCC124ADf49BE199Df20E` |

Carol (`0x176dBDd390d8B1584822a42Cb12cE06F3C999E03`) and Erin hold Token A and no ETH. Dave
(`0x1A4eb66Dc3591fB49779b0585f5d71B58aE0F6d3`) holds nothing. The effective gas price was
1,000,000,007 wei throughout. The script ran three times. In the first run every VERIFY reverted
(observation 6); the second created Carol's and Dave's accounts; the table is the third, when the
accounts already existed.
Frames are `status:execution+state`; status 2 is SKIPPED.

| Case | Tx | `gasUsed` | Frames | Sponsor | User |
|---|---|---|---|---|---|
| **B.** Carol swaps 10 A for ETH and repays | [`0xb5ba35e7...`](https://dora.privacy.ethrex.xyz/tx/0xb5ba35e751ebbba7f6d75f402a30dc30269bc890c82b85931a28571d0540b809) | 91,276 | 1:100 / 1:3,754 / 1:17,519 / 1:43,967 / 1:137 / 1:9,953 | **+0.000060047** | +0.004702 ETH, -10 A |
| **C.** Dave, holding no Token A, sends the same layout | [`0x7b9e9411...`](https://dora.privacy.ethrex.xyz/tx/0x7b9e94118ec81860c97b4dc17701f6a60dce085eb19c9a91a1bc4d1fc0dc0c35) | 57,595 | 1:100 / 1:3,754 / 1:17,519 / **0**:10,202 / 2:0 / 1:258 | **-0.000057595** | nothing |
| **D.** Carol asks for 1 wei more than the pool gives | [`0x6f0db23c...`](https://dora.privacy.ethrex.xyz/tx/0x6f0db23c3846178acf36e2221d1cc21a579aab032174d98c5aba84922b6dbacb) | 53,999 | 1:100 / 1:3,754 / 1:17,519 / **0**:6,534 / 2:0 / 1:258 | **-0.000053999** | nothing |
| **E.** Carol and Erin at once | [`0x7ae50cd2...`](https://dora.privacy.ethrex.xyz/tx/0x7ae50cd2fe19fdaa0074e7a73f0afe055764101d843295f1a4c7da85e8f68ae9) | 91,192 | | | the second: `Non-canonical paymaster already sponsors the maximum number of pending frame transactions` |
| **F.** maximum cost 0.00553 ETH, above the cap | | | | | refused: validation prefix frame reverted |
| **G.** the `check = 1` variant, Carol (holds Token A) | | | | | refused: **`StorageReadNonSender`** |
| **G.** the `check = 1` variant, Dave (holds none) | | | | | refused: **`StorageReadNonSender`** |
| **H.** Dave's batch calls the `INVALID` contract, budget near the cap | [`0x5a63ad7d...`](https://dora.privacy.ethrex.xyz/tx/0x5a63ad7d532d39357ba872cbb9089159bf0ca9474b5e90fc035568a2fbf6ab0c) | **4,147,393** | 1:100 / 1:3,754 / 1:17,519 / **0**:4,100,000 / 2:0 / 1:258 | **-0.004147393** | nothing |

In the second run, Carol's and Dave's accounts did not exist yet. Approving payment for a sender with
no account creates it, and the pay frame pays that 183,600 of state gas:

| Case | Tx | `gasUsed` | Sponsor |
|---|---|---|---|
| B, Carol's first transaction | [`0x9ece9834...`](https://dora.privacy.ethrex.xyz/tx/0x9ece983468ec4d28e1b33b0d87c49b16b4b0651326b4a78e8cab15795693fb23) | 274,876 | +0.000060047 |
| C, Dave's first transaction | [`0xa6c31849...`](https://dora.privacy.ethrex.xyz/tx/0xa6c318499c2a3ff9b467f08d050d508c98c95ffc68fcdfffb8ae3d27228879ca) | **241,195** | **-0.000241195** |

### Where B's money went

The transaction's maximum gas was 531,686. The sponsor charged Carol that, then refunded 380,363
unused gas: the budgets of frames 0 to 4 minus what they used. Carol therefore paid for 151,323 gas,
and the transaction used 91,276. The sponsor kept 60,047 gas worth:
- 50,047 of the post-op's own budget, which it cannot refund because it is still running;
- 10,000 of storage refund: the swap cleared the allowance slot the approve had set, and the refund
  lowers the transaction's `gasUsed` but not the frames' `gas_used`, which is what the post-op reads.

A post-op budget sized to what it uses (about 10,000) would leave about 10,000 of difference.

## Observations

1. **Gas in tokens works with no server.** A user holding only Token A got their gas paid. The calls
   ran, and the sponsor was repaid in the same transaction and refunded the rest: 91,276 gas in the
   steady state, 274,876 for a user's first transaction. No relayer, no quote signer, no oracle, no
   storage: the whole policy is the frame layout, read by `FRAMEPARAM`.

2. **A failure anywhere in the batch is the sponsor's loss, and the user pays nothing.**
   - A user holding no tokens cost the sponsor 57,595 gas (C).
   - A slippage failure cost it 53,999 (D). That one needs no bad actor: a price that moves between
     signing and inclusion does it, and so does a searcher who moves it on purpose.
   - The same griefer from a fresh address cost 241,195, because approving payment for a sender with
     no account creates it, and the pay frame pays.
   - A griefer who wants to do damage calls something that burns its budget and fails: 4,147,393 gas,
     0.0041 ETH, in one mined transaction (H). The bound is the sponsor's own cap on the maximum cost.
     A sponsor that limits which contracts the calls may reach brings the bound down to what those
     contracts can burn before failing, but this one generalises to any call.

3. **The sponsor cannot learn from this.** It has no storage it may use in validation, so it cannot
   keep a list of addresses that cost it money. A griefer pays nothing per attempt and can reuse one
   address.
   - The public mempool's cap of one pending transaction per non-canonical payer (E) limits the rate
     to one per block. The same cap limits honest users to one per block too: a second user was
     refused while the first was pending.
   - On mainnet's 12-second slots, one sponsor's worst case is therefore
     $\frac{86{,}400}{12} \cdot c_{\max} = 7{,}200 \cdot c_{\max}$ a day, where $c_{\max}$ is its cap on
     the maximum cost. At this cap that is 36 ETH a day; with calls limited to the pool, it is $7{,}200
     \times 57{,}595$ gas, about 0.41 ETH a day at 1 gwei.

4. **The check that would close most of this is one storage read the public mempool forbids.**
   `balanceOf(sender)` on the token is refused with `StorageReadNonSender` (G), for the user who holds
   the tokens and for the one who does not alike. ERC-7562, which ERC-4337 bundlers apply, allows
   exactly this read. The token's balance slot for the sender is `keccak(sender || slot)`, which
   ERC-7562 calls storage "associated" with the account, and STO-021 allows it once the account
   exists. With that one read admitted, an empty wallet (C) is refused before inclusion, and what is
   left is the slippage case (D), which costs a searcher a real trade to cause. Associated storage
   is the reason ERC-7562 has the rule. This is section 7 of the post, as a product.

5. **So the choice today is the server, under another name.** The canonical paymaster serves many
   users at once, but its signer co-signs every transaction (experiment 09), and that signer is the
   service that checks the balance off chain. A stateless sponsor needs no server, but serves one user
   per block and pays for every failure. Frames remove the relayer, and they leave the server.

6. **The repayment has to price its own signature.** The maximum cost includes the transaction's
   calldata, the signature included, so a repayment computed before signing is short. Every VERIFY
   reverted in the first attempt for this reason. A wallet building this layout prices a worst-case
   signature, as experiment 04 does.
