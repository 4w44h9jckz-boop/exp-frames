# 54 - An outcome check at the end of an atomic batch

A wallet can state what a transaction is for as a short list `Q` of expected results, for example
"the recipient's balance of token T rises by 10, mine falls by 10, and spender S's allowance over
my T stays 0". The user confirms `Q` and signs it. The chain then checks the outcome against `Q`
after the transaction's body has run, and reverts the body if the check fails.

EIP-7906 proposes an `ASSERT` frame mode for this, with `TXTRACE` to read the transaction's state
diff. Today's test network has EIP-8141 without EIP-7906. What it has is the atomic batch: "All
frames in a batch must succeed, or all of them revert." So the body's frames carry the atomic-batch
flag, and the batch ends with a `SENDER` frame calling the account's own `assert(Q)`, with `Q` in
the frame's data. Without `TXTRACE` this check can read named state but cannot list writes. It
checks a footprint: the values `Q` names, and nothing else. This experiment tests that rule's
weakness directly.

The rule a check should meet is stricter: **it denies every write the signed `Q` does not list.**
A check that only reads named state cannot meet it, and the cases below are chosen to show where.

## Written before any run

**The claim.** On today's test network, an atomic batch ending in `assert(Q)` gives revert-all:
a body whose named results differ from `Q` is undone in full. Reads of named state still let two
kinds of harm through: a write to a resource `Q` does not name (case c), and a contract that lies
about the state `Q` reads (case e).

**It would be shown wrong if any of these is observed:**
- case (b) or case (d) leaves its approval or grant in place after the check fails;
- reads of named state catch case (c) or case (e), which would mean the stricter rule above is
  unnecessary.

**It is done when** each case is mined or reverted on chain, with receipts. The `ASSERT` mode is
tried on the same network, and its outcome is recorded either way.

**The plan, fixed before the run:**
- The account, `OutcomeAccount.yul`, is experiment 27's execution-scope account with two
  additions:
  - Its `VERIFY` frame also requires the check frame:
    - The last frame must be a `SENDER` frame whose resolved target is the account and whose data
      starts with `assert`'s selector.
    - Every frame after the validation frames and before the check frame must carry the
      atomic-batch flag, so the check frame ends the one batch that holds the whole body.
    - EIP-7906 notes that nothing at protocol level makes a transaction include a check, so the
      account has to require it.
  - When the account calls itself with `assert`, it runs each entry of `Q`:
    - each entry is a target, a call, and the 32-byte word the call must return;
    - the account makes the call as a `STATICCALL` and reverts at the first entry whose word
      differs.
  - `VERIFY` keeps experiment 27's two paths:
    - the owner pays, over the canonical signature hash;
    - a payer pays, over the execution digest `E`.
- The contracts it acts on, all deployed by the run:
  - `TestToken`, the repository's ERC-20;
  - `TestCollection.sol`, a collection with `setApprovalForAll` and `isApprovedForAll`;
  - `LyingToken.sol`, an ERC-20 whose `transfer` credits a third address and whose `balanceOf`
    adds what the recipient was told it got.
- The cases. Each sends one transaction from the account:
  - **(a) An honest transfer.** The body moves 10 tokens to a recipient. `Q` lists both balances,
    and the allowance of one named spender at 0.
  - **(b) A hidden approval to a listed spender.** As (a), with an extra body frame approving the
    named spender for the maximum.
  - **(c) An approval to an unlisted spender.** As (a), with an extra body frame approving a
    spender `Q` does not name.
  - **(d) An operator grant on a listed collection.** As (a), with an extra body frame calling
    `setApprovalForAll(operator, true)` on the collection. `Q` lists `isApprovedForAll` for that
    operator as false.
  - **(e) A lying token.** The body transfers 10 of `LyingToken` to a recipient. `Q` lists both
    balances as `balanceOf` reports them.
  - **(f) A payer cannot drop or move the check.**
    - The owner signs `E` over a body and its check frame.
    - A payer completes the transaction, then:
      - removes the check frame;
      - moves the check frame ahead of the body;
      - moves the check frame into a separate batch.
    - Each copy is simulated and sent.
    - The honest completion is sent last, and must be mined.
- After each case, the run reads back:
  - every balance, allowance and grant involved;
  - for (e), the third address's real balance.
- The `ASSERT` mode. The run tries two things on the same network:
  - (a)'s transaction with the check moved into a final frame of mode 3;
  - a probe contract that runs `TXTRACE` (`0xb6`).
  If either is accepted, (a) to (e) run again under the stricter rule, with the check in an
  `ASSERT` frame that reads the diff through `TXTRACE`.

**Predictions:**

| Case | Prediction |
|---|---|
| (a) | mined; every body frame succeeds; the recipient has 10 more |
| (b) | mined, with the check frame and every body frame failed. The allowance stays 0 and the transfer is undone. The owner still pays for gas |
| (c) | mined, with every frame succeeded. The unlisted spender's allowance is the maximum afterwards |
| (d) | mined, with the batch failed. The grant stays false |
| (e) | mined, with every frame succeeded. The recipient's real balance is unchanged. The third address holds the 10 |
| (f) | all three altered copies refused before inclusion, because the account's `VERIFY` reverts. The honest completion is mined |
| `ASSERT` | refused: the test network's client accepts frame modes 0 to 2 only, and `0xb6` is not an opcode there |

The check's own cost: about 3,000 gas per entry for a warm `STATICCALL` to a token, plus the copy
of `Q`. The account's `VERIFY` cost, about 1,000 more than experiment 27's for the frame checks.

**Amendment, 2026-11-06, before any run.**
- Case (f) gains two transactions, to tell its two defences apart:
  - **a fourth copy**: the payer inserts a body frame into the batch, ahead of the check. The
    check frame still ends the batch, so the account's frame rule passes. Only `E` refuses this
    copy.
  - **a control**: the owner signs, over the canonical hash, a body with no check frame. `E` is
    not involved, so only the account's frame rule refuses it.
- The `ASSERT` try is also sent from the funder's EOA, with a final frame of mode 3. An EOA's
  default code does not look at the last frame, so only the network's own rules decide.
- Predictions: both new (f) transactions are refused before inclusion. The EOA's mode-3
  transaction is refused as the account's is.

**Post-quantum status.** None. The owner and the payers sign with secp256k1. Nothing here depends
on the signature scheme: the check frame is pinned by whatever signature covers the frames, so the
same layout works under EIP-8288's leanSPHINCS dependencies (experiment 49).
