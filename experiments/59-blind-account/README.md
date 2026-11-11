# 59 - A blind account: ETH paid out on blind tickets, capped per key by what was bought

The question: can an account hold ETH for anonymous holders, so that whoever presents a ticket the
issuers signed blind can move a fixed amount out, and can it keep the books so that blind issuance
never creates ETH? Can that be done with what exists today, with no new opcode?

Experiments 36 and 48 used blind tickets to pay for gas: a paymaster that checks a threshold BLS
signature over a message it rebuilds, bound in experiment 48 to a one-time key. Here the tickets
carry value. The account they draw on keeps one count per key, and the count caps the payouts.

## The design

- **The escrow.** `BlindAccount.yul` holds ETH for keys $\chi = \mathrm{keccak256}(D \Vert e)$,
  one key for each denomination $D$ and epoch $e$.
- **Purchase.** `buy(e)` with value $D$ raises `burned[chi]` by one and logs the purchase. The
  buyer then asks the issuers to blind-sign its message.
  - The issuers are four, with a quorum of three: experiment 36's committee from a distributed key
    generation, signing blind BLS over BLS12-381 (MinSig).
  - Each issuer answers one blinded request per purchase it has seen on chain.
- **The ticket message**, under the namespace `BLIND_ACCOUNT_V1`:

  ```text
  chain_id (32) || account (20) || D (32) || epoch (8) || serial (32) || binder (20)     144 bytes
  ```

  - `serial` is random and non-zero. It is the payout's EIP-8250 nonce key.
  - `binder` is a one-time secp256k1 key, experiment 48's.
- **Payout.** A frame transaction whose sender is the blind account, paid by the blind account,
  with exactly two frames:
  1. `VERIFY` (scope 3), whose data is the ticket: `D || epoch || serial || binder || sigma`. It
     checks:
     - the pairing $e(\sigma, -g_2)\, e(H(m), PK) = 1$ through EIP-2537;
     - a signature entry by `binder` over the signature hash (experiment 48's binding);
     - that the transaction's nonce keys are exactly `[serial]` at sequence 0, through
       `TXPARAM(0x0f)` and `TXPARAM(0x01)`. EIP-8250's nonce manager then records the serial
       spent, with no storage of the account's own;
     - that `minted[chi] < burned[chi]`;
     - that the maximum cost is below $D$;
     - that the transaction has exactly these two frames, the second a `SENDER` frame to the
       account itself calling `payout(D, epoch, recipient)` with no value and an execution budget of
       at least 60,000.
  2. `SENDER` to the account: `payout(D, epoch, recipient)`. It:
     - raises `minted[chi]`, and reverts if that would pass `burned[chi]`;
     - sends $D - \mathrm{maxCost}$ to `recipient`, holding back 20,000 gas (60,000 since amendment 1).

     If the send fails, the amount is credited to the recipient, who can take it with `claim()`.
     That is experiment 06's pool's rule.
- **What is bound.** The binder signs the signature hash, which covers both frames, the fees and
  the nonce key. So the recipient is the binder's choice, and a copy seen pending cannot be
  redirected.
- **Why the count is raised in `SENDER`.** `VERIFY` is a static call: it can read the count but
  not raise it. At inclusion `VERIFY` runs again on the block's state, so a payout whose key is
  exhausted by then is invalid, and is never included.
- **The fee.** The account pays it out of the escrow. The recipient gets $D - \mathrm{maxCost}$,
  and the unused part of the maximum cost is refunded to the account. Each payout takes at most
  $D$ out of the escrow.
- **The aggregate payout.**
  - Several tickets of one key, each with its own serial, one binder and the sum of their
    signatures, in one transaction. EIP-8250 allows up to 16 nonce keys, all at sequence 0.
  - One public key signs every message, so the check is still two pairs:
    $e(\sum \sigma_i, -g_2)\, e(\sum H(m_i), PK) = 1$, plus one hash to $G_1$ per ticket.
  - `payout(D, epoch, recipient, n)` raises the count by $n$.

## Written before any run

**The claim.** What exists today gives a blind account whose payouts under a key never exceed its
purchases, with no new opcode:
- EIP-2537's pairing;
- an EIP-8141 `VERIFY` frame;
- an EIP-8250 single-use nonce key;
- a one-time key.

**It would be shown wrong if any of these is observed:**
- (c) is paid;
- (e) leaves the count different from what was paid or credited;
- (d) pays past the cap.

**It is done when** cases (a) to (f) and the aggregate run on the test network (chain 8141), each
mined or refused, with receipts. Every payout's gas is measured, single and aggregate.

**The cases:**
- **(a) An honest payout.** Buy one under $\chi$, get the ticket issued, and pay out to a fresh
  recipient.
- **(b) The same ticket twice.**
  - After (a) is mined, its exact bytes are sent again.
  - Then the ticket is put in a new transaction at sequence 1.
- **(c) A ticket with no purchase behind it.** The issuers sign a message no purchase paid for, as
  a corrupt quorum would. It is presented once every honest ticket under its key has been paid.
- **(c2) The same, while honest tickets are outstanding.** This is the design's stated limit: a
  forged ticket can take the float. Then the honest holder's ticket is presented.
- **(d) Two payouts under one key, with one unit left.** Both are sent before either is mined.
- **(e) A payout to a recipient that reverts on receipt.**
- **(f) A copy of a pending payout, redirected to another recipient.** It is tried three ways:
  - the binder's signature kept;
  - the binder's entry removed;
  - another key named as binder, signing.
- **(g) Aggregate payouts** of 2, 4 and 8 tickets of one key.

**Predictions:**

| Case | Prediction |
|---|---|
| (a) | mined; `minted` 1 of 1; the recipient receives $D$ less the maximum cost |
| (b) | the replay is refused: its nonce key is spent. The sequence-1 copy is refused: `VERIFY` requires sequence 0 |
| (c) | refused before inclusion: `minted == burned` |
| (c2) | the forged ticket is paid, and the honest holder's is then refused: the loss falls on an honest holder of the same key, never on another key's float, and no ETH is created |
| (d) | one is mined. The other is refused at admission if the first is already in, or dropped at inclusion when `VERIFY` sees the raised count. It is never mined |
| (e) | mined; `minted` raised by one; the amount credited to the recipient, not sent; `claim()` from the recipient pays it |
| (f) | all three refused before inclusion: the first two by the binding, the third by the pairing |
| (g) | mined; `minted` raised by $n$ |

**Gas:**
- A single payout's `VERIFY` is predicted at about 125,000: experiment 48's 122,233 for its
  bound check, plus the count reads.
- The aggregate's `VERIFY` is predicted at about 110,000 plus about 18,000 per ticket. The
  pairing stays at two pairs, 102,900 at EIP-2537's prices, and each ticket adds its own hash to
  $G_1$. So it is predicted to fit the test network's 500,000 at 16 tickets, and to exceed
  EIP-8141's 100,000 at any size.

**What is not covered.**
- The fee is paid from the escrow, so a payout's actual gas is not charged to any key. A refund
  stays in the account. A per-key fee account is out of scope.
- A key's float is shared among its holders, which is case (c2).

### Amendment 1, 2026-11-11: after two partial runs, before the full run

Run r1 stopped at its first payout, and run r2 ran (a) to (g) with defects of my own and stopped at
the 8-ticket aggregate. Neither wrote a record file: what is known of them is quoted here. They are
kept as runs, not results. What they showed, and what changes:

1. **`VERIFY` needs state gas for the nonce keys.**
   - r1's payout was refused: "validation prefix frame reverted". The cause was the same with a
     `VERIFY` that does nothing but approve.
   - Any keyed nonce was refused, and the legacy key `[0]` admitted. EIP-8250 charges each keyed
     nonce's first use, 97,920 state gas, to the frame that approves payment, and the builder gave
     `VERIFY` none.
   - The builder now gives it 97,920 per ticket.
2. **The payout frame ran out of state gas paying a fresh recipient.**
   - In r2 every payout's `SENDER` frame failed except the one whose recipient already existed. A
     new account costs 183,600 state gas, on top of the count's slot.
   - The frame now carries two slots and a new account, 379,440.
3. **A recipient that burns its gas made the payout frame fail.**
   - Holding back 20,000 gas was too little once the call's own cost (cold access and value
     transfer) is taken first. So the credit was never written, and the count never moved.
   - The contract now holds back 60,000 and requires at least 100,000 execution for the payout
     frame (it was 60,000). The builder gives 150,000.
4. **The test network's pool admits one pending transaction per sender.**
   - A second payout sent while the first is pending is refused: "A pending frame transaction
     from this sender is already in the pool". So (d)'s "two in one block" cannot be posed
     through this node.
   - (d) becomes: the second is sent while the first is pending (refused by the pool), then again
     once the first is mined (refused by the count).
   - Every case now waits for its payout to be mined before the next is sent.
5. **An aggregate carries at most 5 tickets on this network, not 16.**
   - The prefix's state gas is capped at 500,000 (`MAX_VERIFY_STATE_GAS`). Each ticket's nonce key
     costs 97,920 of it, so 8 tickets needed 783,360 and were refused.
   - The prediction for (g) was wrong. (g) becomes aggregates of 2, 4 and 5, and 6 is sent to show
     the refusal.

What r2 already showed, kept for the record:
- (a)'s `VERIFY` cost 124,677 gas, against about 125,000 predicted.
- The aggregates' `VERIFY` cost 140,748 for 2 tickets and 172,891 for 4: about 16,000 per extra
  ticket, against about 18,000 predicted.
- (b): the replay was refused on its nonce ("expected 1, got 0"), and sequence 1 by `VERIFY`.
- (f): the copy that kept the binder's signature was refused by the protocol's signature check.
  The other two were refused by `VERIFY` in simulation.
- (e): the reverting recipient was credited `D` less the maximum cost, and the count moved by one.

## Results, run r3, 2026-11-11

- **Where:** the Hegota test network, chain 8141, blocks 776,776 to 776,809.
- **Runner:** kohaku-rs `experiment/blind-account` at `b6cb30b`:

  ```text
  PRIVATE_KEY=... RUN=r3 RECORD=record.json cargo run --release -p kohaku-frame-ticket --example blind_account
  ```

- **Record:** [`record.json`](record.json): every transaction, raw and hashed, the node's answers,
  the counts read after each case, and the 26 blinded points the issuers saw. It holds no key and
  no blinding factor.
- **The account:** `0x0664329A...6093`, 2,131 bytes of code with its key. The ticket's
  denomination is 0.001 ETH.

| Case | Outcome | Count after (burned, minted) |
|---|---|---|
| (a) honest payout | **mined**, block 776,779. The recipient received 0.0009992 ETH: $D$ less the maximum cost | 2, 1 |
| (b) its bytes again | **refused**: "Nonce mismatch: expected 1, got 0", the serial spent | |
| (b) the ticket at sequence 1 | **refused**: `VERIFY` reverted, since it requires sequence 0 | |
| (c2) forged, float present | **mined**, block 776,781 | 2, 2 |
| (c2) the honest holder's ticket after it | **refused**: `VERIFY` reverted, the key exhausted | 2, 2 |
| (c) forged, key exhausted | **refused**: `VERIFY` reverted | 2, 2 |
| (d) the second, the first pending | **refused by the pool**: "A pending frame transaction from this sender is already in the pool" | |
| (d) the first | **mined**, block 776,785 | 1, 1 |
| (d) the second, the first mined | **refused**: `VERIFY` reverted, the key exhausted | 1, 1 |
| (e) recipient that reverts | **mined**, block 776,789. 0.0009992 ETH credited to it, not sent, its balance 0 | |
| (e) recipient that burns its gas | **mined**, block 776,791. Credited the same, balance 0 | 2, 2 |
| (f) redirected, binder's signature kept | **refused**: "frame signature list does not authenticate the sender" | |
| (f) redirected, the thief's entry in place of the binder's | **refused**: `VERIFY` reverted in simulation. The node's send answered "underpriced replacement", the original being pending | |
| (f) redirected, the thief named as binder | **refused**, as the previous | |
| (f) the original | **mined**, block 776,795. The thief's balance is 0 | |
| (g) 2 tickets | **mined**, block 776,799 | 2, 2 |
| (g) 4 tickets | **mined**, block 776,803 | 4, 4 |
| (g) 5 tickets | **mined**, block 776,807 | 5, 5 |
| (g) 6 tickets | **refused**: "prefix state gas budget exceeded: 587520 > 500000 (MAX_VERIFY_STATE_GAS)" | |

**Gas:**

| Payout | `VERIFY` execution | `VERIFY` state | Payout frame | Transaction |
|---|---:|---:|---:|---:|
| 1 ticket, a fresh recipient (a) | 124,677 | 97,920 | 24,870 execution, 281,520 state | 550,385 |
| 1 ticket, the count's slot already set (c2) | 124,677 | 97,920 | 24,870, 183,600 | 452,465 |
| 2 tickets | 140,748 | 195,840 | 24,870, 281,520 | 665,372 |
| 4 tickets | 172,891 | 391,680 | 24,870, 281,520 | 895,483 |
| 5 tickets | 188,963 | 489,600 | 24,870, 281,520 | 1,010,491 |

## Short answers

1. **Done when: met.** Every case was mined or refused on the test network, with receipts, and
   every payout's gas is measured.
2. **The claim holds. Nothing that would show it wrong was observed.**
   - (c) was refused once the key was exhausted.
   - In (e), the count moved by exactly one per payout, and each payout's amount was credited when
     the recipient would not take it.
   - (d) never paid past the cap. The pool refused the second payout while the first was pending,
     and `VERIFY` refused it once the first was mined.
   - In every case, `minted` ends at most `burned`, and each payout took at most $D$ from the
     escrow.
3. **The stated limit, observed (c2).** A ticket the issuers signed with no purchase was paid while
   an honest ticket under the same key was outstanding. The honest holder was then refused.
   - The loss stays within the key. Blind issuance cannot create ETH, but a corrupt quorum of
     issuers can take one key's float from its honest holders.
   - The count is what limits the loss. Nothing here detects the forgery: the issuers see only
     uniformly random points.
4. **What the pieces cost.**
   - A single payout's check is 124,677 execution gas in `VERIFY`, as predicted (about 125,000).
     It is past EIP-8141's 100,000 and inside the test network's 500,000.
   - Each extra ticket in an aggregate adds about 16,100. The pairing stays two pairs, and each
     ticket adds its hash to $G_1$.
   - What binds is state gas, not execution: each ticket's single-use nonce key costs 97,920 at
     its first use, inside the validation prefix's 500,000. So an aggregate carries at most 5
     tickets, not the 16 predicted.
   - A fresh recipient's account costs another 183,600 in the payout frame. A whole payout to a
     fresh address is 550,385 gas.
5. **The single-use record is the protocol's.** The serial is an EIP-8250 nonce key, so the
   account stores no spent-ticket set. A replay is refused by the nonce manager before any frame
   runs. That record is paid for: 97,920 state gas per ticket, the cost of one fresh storage slot.
6. **One pending payout per sender.**
   - On this pool, the blind account can have only one payout pending at a time. Every holder
     shares one sender, so payouts are serialised.
   - That is a throughput limit, and a fact a holder can observe: a refused send says that someone
     else's payout is pending.

**Post-quantum status.** None. The tickets are BLS12-381 signatures and the binder is secp256k1.
A post-quantum version needs a blind signature with no pairing, and a post-quantum binder
(experiment 49's leanSPHINCS dependency).
