# 23 — What an approval has to commit to

EIP-8141 lets a `VERIFY` frame approve on any evidence it likes. Its Security Considerations
section, *Execution Approval Authorizes All Subsequent Sender Frames*, says what that evidence must
cover. The section ends (master, read 2026-10-08):

> Custom validation contracts that grant `APPROVE_EXECUTION` should verify against the canonical
> signature hash, or otherwise constrain every subsequent `SENDER` frame, before approving.

The first branch is what the default code does. This experiment asks two questions:
1. Is the second branch safe?
2. Is there a reason to take a branch other than the first?

The answers are no and yes. The second branch leaves the `DEFAULT` frames, the positions of the
frames and the fees to whoever relays the transaction, and a mempool observer used that to
sandwich a swap inside the victim's own transaction. The reason to leave the canonical hash is
sponsorship: a signature that covers exactly what its scope approves lets a second payer replace
the first without the user signing again.

Two accounts, both with the owner's key in code, so neither reads storage:

| Account | Entry 0, the owner's SECP256K1 signature, is over | Approves |
|---|---|---|
| [`SenderFramesAccount`](SenderFramesAccount.yul), "the literal account" | an explicit digest $D$ of chain id, sender, nonce keys hash, nonce sequence, and every `SENDER` frame in order: target, flags, both budgets, value, data hash | whatever scope its frame allows |
| [`ScopedAccount`](ScopedAccount.yul) | scope 3 (it pays): the canonical sig hash. Scope 2 (someone else pays): an explicit digest $E$ of chain id, sender, nonce keys hash, nonce sequence, the number of frames, and every frame with its index, except that a pay frame (`VERIFY` whose allowed scope is `PAYMENT` alone) contributes only its index | that scope |

The literal account constrains every `SENDER` frame: their number, their order and every field.
That is what the EIP's sentence asks for, read as written.

| File | What |
|---|---|
| [`SenderFramesAccount.yul`](SenderFramesAccount.yul) | 302 B initcode. $D$ by `FRAMEPARAM`, `FRAMEDATACOPY` and `TXPARAM(0x01, 0x0F)` |
| [`ScopedAccount.yul`](ScopedAccount.yul) | 380 B initcode. $E$ for scope 2, the canonical hash for scope 3 |
| [`PayThePayer.yul`](PayThePayer.yul) | 129 B. Called from a `SENDER` frame, it finds the pay frame and `transferFrom`s a token fee from the sender to that frame's resolved target, so a user can pay a fee to a payer chosen after signing |
| [`ToyAmm.sol`](ToyAmm.sol) | `ToyAmm`, a constant-product pool with no fee, and `Sandwicher`, the attacker's bot: `front(x)` buys B with A, `back()` sells all its B |
| [`scope.ts`](scope.ts) | Keys, addresses, frames, both digests as the accounts compute them, and `planSandwich` |
| [`example-scope.ts`](example-scope.ts) | `setup`, then scenarios A to E |

## Run

```bash
npx tsx experiments/23-approval-scope/example-scope.ts setup
npx tsx experiments/23-approval-scope/example-scope.ts A   # or B, C, D, E, all
```

The setup transaction deploys Token A and Token B (this repository's mint-anyone `TestToken`),
the pool with 1,000 of each, the bot with 300 A, `PayThePayer` and both accounts. It also gives
each account 100 A and 0.005 ETH, and each of two code-less sponsors 0.005 ETH:
[`0xd44f0765…`](https://dora.privacy.ethrex.xyz/tx/0xd44f0765707dd27a311c729ec9bf80142f4702b83735af96286f689713574d15),
18 frames, block 315,366.

| | Address |
|---|---|
| literal account (owner `0x49691Db1…`) | `0x3Fb649648C0CbdAa5a8E05c99291Bd0FFDE29925` |
| scoped account (owner `0xE250d681…`) | `0xfeB35a6B32585958b2568e97aF5A478742c14D97` |
| sponsor 1, sponsor 2 (code-less) | `0xDf049893a9d7e6ad43D5B918Bf7236c1d040EF73`, `0x461524897Bc21be21D7A8c07Baaf223bd259A817` |
| pool, bot | `0xF403D7dAFBE559Ff5Ed21D0B6e45d18217735145`, `0x689166a9b3057AD3AD0783Bb66F599E1B4683F88` |

Every swap is 10 A for B with `minOut` 3 per cent under the quote, the slippage setting a wallet
would apply.

## Results (Hegota testnet, chain 8141, 2026-10-08)

### A. A sandwich, inserted by replacement, against the literal account

The owner signs `[self_verify, approve(pool, 10 A), swap(10 A, minOut)]` at a 1,000 wei tip, and
the script sends it. A mempool observer copies it and makes three changes:
- it inserts `DEFAULT bot.front(15.42 A)` between the approve and the swap;
- it appends `DEFAULT bot.back()`;
- it raises both fee fields by 20 per cent, which a replacement needs.

It keeps the signature entry byte for byte and sends the copy within the same slot.

| | |
|---|---|
| $D$, honest and attacked | `0xb2c521ec…` both: the signature is valid for both |
| honest | [`0x943b7e04…`](https://dora.privacy.ethrex.xyz/tx/0x943b7e0497f72d63ed4e26afb50fec109cbe262356b4212ca9df0f0c3b231ec3), accepted, then **replaced** |
| attacked | [`0xb9fd1487…`](https://dora.privacy.ethrex.xyz/tx/0xb9fd14873107703e984a97305692d8a8518d009c202ce4517eb61f32ec8e2787), accepted as the replacement, **mined** in block 315,369 |
| frames | VERIFY 1,487 · approve 17,519 · **front 95,247** · swap 36,235 · **back 15,463** (execution gas) |
| the victim | paid 10 A, received **9.6040 B** against a quote of 9.9010: 0.2970 B, 3.0 per cent, exactly the slippage it allowed |
| the bot | **+0.3029 A**, 0 B left |
| who paid for the bot's frames | the victim, as payer: 110,710 of the transaction's execution gas |

### B. Fees chosen by the relay, against the literal account

The same honest swap, signed at a 1,000 wei tip, relayed with a 10 gwei tip instead. Nothing else
changes.

| | |
|---|---|
| relayed | [`0x6256f617…`](https://dora.privacy.ethrex.xyz/tx/0x6256f61748c76a0d4b75f5ac7fbfcf90fec37b4145dfe3548f18e5f0c78a8256), mined in block 315,371, 118,652 gas |
| the account paid | **0.0011865 ETH** at 10,000,000,007 wei per gas |
| at the tip its owner signed | 0.00000000012 ETH, about $10^{-7}$ of that |

The difference went to the block's fee recipient. Who sets the tip on the literal account is
whoever relays the transaction. If that is the builder, it is paying itself out of the sender's
balance.

### C. The same attacks against the scoped account

| Case | Simulation | `eth_sendRawTransaction` |
|---|---|---|
| C1. Paying for itself (canonical hash): the sandwich of A, fees raised | `frame signature list does not authenticate the sender` | `Invalid frame transaction signature` |
| C2. Sponsored, and the sponsor is the attacker: the sandwich inserted, sponsor's own entry re-signed, owner's entry reused | `validation prefix frame reverted` ($E$ changes from `0xf477ea0f…` to `0x8fc5d4c3…`) | `validation-prefix simulation failed: validation prefix frame reverted` |
| C3. As C2, but only a `DEFAULT bot.back()` appended at the end | `validation prefix frame reverted` | |

### D. One owner signature, two payers

The owner signs $E$ once over
`[only_verify, pay(·), approve(PayThePayer, 1 A), PayThePayer(A, 1 A), approve(pool, 10 A), swap]`.
Sponsor 1 completes it with its pay frame, its fees (1,000 wei tip) and its entry 1 over the
canonical hash. Sponsor 2 then builds its own copy from the same entry 0, with its own pay frame,
fees 20 per cent higher and its own entry 1. The script sends both within one slot.

| | via sponsor 1 | via sponsor 2 |
|---|---|---|
| $E$ | `0x7004ff07…` | `0x7004ff07…` |
| entry 0 (the owner's) | identical bytes | identical bytes |
| sig hash | `0xa511a21f…` | `0x9bc2b91e…` |
| tx hash | [`0x39b322d9…`](https://dora.privacy.ethrex.xyz/tx/0x39b322d9c2e6459b579def4c01b2ed684aafdf1ff3b7aa7ae99d0a5a0de385d4), accepted, then replaced | [`0x0ed442c7…`](https://dora.privacy.ethrex.xyz/tx/0x0ed442c74beaf35de33eceafb137930c0b4d9f17a9c084a04c7d0bbaaa43623f), **replacement with another payer, mined** in block 315,376 |
| receipt payer | | `0x46152489…` (sponsor 2) |
| sponsor's ETH | 0 | −422,476,554 wei |
| sponsor's Token A | 0 | **+1 A**, from `PayThePayer` |
| frames | | VERIFY 2,914 · pay 3,000 · approve 17,519 · PayThePayer 31,573 · approve 14,619 · swap 78,035 |

The account received 9.5240 B, exactly the quote.

### E. Baseline: the scoped account paying for itself

[`0x0478e663…`](https://dora.privacy.ethrex.xyz/tx/0x0478e663ed8de73c321165d32dfc8ffbe276ab7639322e218ea80731ab6d637a),
block 315,380: `[self_verify, approve, swap]` over the canonical hash, VERIFY **351** execution gas.

### What each check cost in VERIFY

| VERIFY | Execution gas |
|---|---|
| canonical sig hash (E) | 351 |
| $D$ over two `SENDER` frames, three frames in all (B) | 1,349 |
| $D$ over two `SENDER` frames, five frames in all (A) | 1,487 |
| $E$ over six frames, 464 bytes of frame data (D) | 2,914 |

Each covered frame costs some `FRAMEPARAM` reads plus a `FRAMEDATACOPY` and `keccak256` of its
data, so the cost is linear in frames and bytes. All of it is far below `MAX_VERIFY_GAS`.

## Observations

1. **The EIP's second branch is not a safe alternative to the first.** "Constrain every subsequent
   `SENDER` frame" leaves three things to the relay, and A and B used all three:
   - the `DEFAULT` frames, which run as the entry point and can trade against the sender's own
     operations between them;
   - where the `SENDER` frames sit;
   - the fees.

   Committing to positions alone would stop insertion but not appending: C3's appended back-run
   is a frame the sender pays for. Committing to the fees matters only when the account also pays.
   The sentence protects against a relay that swaps the sender's operations. It does not protect
   against one that adds its own, and that is what an observer gains from.

2. **The rule that does work: sign what you approve.**
   - An execution approval has to pin every frame that is not the payer's, with its position, and
     the number of frames.
   - A payment approval has to pin the fees and every budget as well, because together they make
     the maximum cost it pays.

   So a frame approving both scopes has nothing it may leave out except signature bytes, and that
   is the canonical hash. The default code is right for exactly the case it handles: an EOA
   approving both scopes, or approving payment with entry 1.

3. **An execution-only signature that leaves out the payer works on today's chain, through the
   explicit `msg` field.**
   - D replaced one payer with another, at higher fees, without the owner.
   - The EIP's replacement rule allows a different payer ("A replacement may name a different payer
     than the transaction it replaces"), and ethrex accepted it.
   - What stays fixed across payers is $E$, not the sig hash and not the transaction hash. A wallet
     that tracks its operation by transaction hash lost track of it at the replacement.
   - With `PayThePayer`, the user's token fee goes to whichever sponsor lands the transaction. So
     sponsors compete for an operation the user signed once, and none of them can change it.

4. **What that freedom costs the user.** A signature over $E$ is a bearer instrument until the
   nonce moves. Any payer can land it, at any fee and at any time.
   - **Timing.** The account should pin an expiry frame, which $E$ covers like any other frame.
   - **Last look.** A payer could condition the transaction on the outcome by appending a trailing
     `VERIFY` frame. The public mempool refuses that shape, and $E$ refuses it anywhere, because it
     pins the number of frames.
   - **Linkability.** The `aa` repository's question 13
     (`docs/06-findings/02-questions-for-the-specification-authors.md`) asks whether the fee fields
     can leave the canonical hash. For a blind-voucher design, re-signing to raise a fee is a second
     contact with the issuer, which links the spender. $E$ answers that at the account level,
     without changing the EIP. The default code cannot do it: an EOA's sponsored transaction is two
     signatures over one hash, so a new payer or a new fee means the EOA signs again.

5. **Atomic batches make "pin the frames" stricter than it looks.** Not run here; it follows from
   the EIP's definition of a batch. Batch membership is defined by adjacency: a frame with
   `ATOMIC_BATCH_FLAG` is batched with the next one. An account that pins a `SENDER` frame's flags
   but not its neighbour lets an inserted frame join or split a batch. A `DEFAULT` frame inserted
   after an `approve` that carries the flag would take the swap's place in its batch, and the
   approval would then survive a failed swap. The literal account is exposed to this; $E$ pins the
   neighbours.

6. **A later frame lowered an earlier frame's state gas.** In every swap the approve frame reports
   0 state gas, although it created an allowance slot. The swap spent the allowance back to zero,
   and the refill credited the frame that paid for the slot, as the EIP's state-gas section says.
   The 10,000 gas refund for each restored slot is recorded in the fixtures' `meta.refund`.

All five mined transactions are fixtures in `test/fixtures/chain/`: they re-encode to their hashes,
their signatures recover over this repository's sig hash, and the gas model settles to their
receipts.
