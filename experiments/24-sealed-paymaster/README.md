# 24 — A sealed paymaster, and a scan that calls the wrong one sealed

EIP-8141's public mempool rations payers. The canonical paymaster, recognised by its exact code
hash, may have many sponsorships pending. Any other payer may have one. The canonical paymaster
earns that standing by a property: its ether leaves only as the gas it approves, which the node
has reserved, or through a withdrawal timelocked for a day.

[ethereum/EIPs#12328](https://github.com/ethereum/EIPs/pull/12328) proposes to admit any payer
whose code shows the same property: an *egress-decidable* paymaster. Its decidable form is a
whole-code scan that rejects `CALL`, `CALLCODE`, `DELEGATECALL`, `CREATE`, `CREATE2`,
`SELFDESTRUCT` and code re-pointing at every instruction position, and does not look at `APPROVE`:

> `APPROVE` is not an egress instruction: its `offset`/`length` operands designate return data
> only, and the protocol collects at most the reserved `max_cost` through `APPROVE_PAYMENT`
> regardless of the approval scope, so no scan of the `APPROVE` operands is required.

The PR's sponsorship policy is a leaf under the sponsor's own EIP-8272 recent root, proved in the
pay frame. It leaves the gas open: "None of these is measured end-to-end, since no client
implements the sealed pay frame yet."

This experiment builds both halves and asks three questions:
1. What does a sealed pay frame cost, end to end?
2. Is the scan sound?
3. What does a sponsor give up by sealing?

Short answers:
1. 13,305 gas of prefix execution at policy-tree depth 4, and 16,361 at depth 20, against
   `MAX_VERIFY_GAS` = 100,000.
2. No. A paymaster with none of the listed opcodes moved its whole balance out in one
   transaction, while a sponsorship admitted against that balance was pending, and the
   sponsorship was dropped. An account with no code passes the scan as well. Three changes make
   the scan sound, and the same changes cut its false positives from 28% to 0.9%.
3. A sponsor gives up withdrawal and revocation. A sealed paymaster's float can leave only as gas.
   A policy root it has published stays usable for 8,191 slots whatever it publishes next.
   Revocation can be bounded only through the expiry frame, and under the EIP's eviction order
   that puts every transaction it sponsors first in line for eviction.

| File | What |
|---|---|
| [`SealedPaymaster.yul`](SealedPaymaster.yul) | 406-byte runtime. No `CALL`-family opcode; `APPROVE` only as `PUSH1 1, PUSH0, PUSH0, APPROVE`; the sponsor's source id is an immutable inside a `PUSH32`, so nothing is appended after the code. Reads no storage and no balance |
| [`SelfSendingPaymaster.yul`](SelfSendingPaymaster.yul) | 134-byte runtime. The canonical paymaster's admission rule with the withdrawal deleted, and the default code's rule for when it is the sender. No `CALL`-family opcode |
| [`egress.ts`](egress.ts) | `prScan`, the PR's scan as written; `sealedScan`, the amended one; the Solidity metadata trailer |
| [`sealed.ts`](sealed.ts) | Keys, addresses, the policy tree, frames |
| [`example-sealed.ts`](example-sealed.ts) | `setup`, `run` (A to D, one sequence) and `drain` (E) on the testnet |
| [`scan.ts`](scan.ts) | F, offline: both scans against six runtimes, and a Monte Carlo of the metadata trailer |
| [`egress.test.ts`](egress.test.ts) | The scans' rules, as unit tests |

## Run

```bash
npx tsx experiments/24-sealed-paymaster/example-sealed.ts setup
npx tsx experiments/24-sealed-paymaster/example-sealed.ts run     # A-D, about 8 minutes: D waits for a policy to end
npx tsx experiments/24-sealed-paymaster/example-sealed.ts drain   # E
npx tsx experiments/24-sealed-paymaster/scan.ts                   # F, no network, about 2 minutes
```

The setup transaction deploys a fresh `TestToken` ("Token S"), both paymasters, gives the sealed
one 0.02 ETH and the self-sending one 0.01 ETH, and gives 0.005 ETH each to the two EOAs that
write roots:
[`0x98c00818…`](https://dora.privacy.ethrex.xyz/tx/0x98c008189cef9cd919a90073e098aa47496cafdd2b5d3af7d273c941e86f249c),
8 frames, block 316,307.

| | Address |
|---|---|
| SealedPaymaster | `0x56208581D049A396E81f6C3cea6DeCDe79006189` |
| SelfSendingPaymaster (owner `0x07c210Fe…`) | `0x4fda5F343934770709d9BD60459cD6a921E22867` |
| Token S | `0x3D071fcA1612aCAC37652CD60Ebc41316539254f` |
| sponsor (writes policy roots), stranger (writes roots too) | `0xAadaDaB94F5d6E11f26C9a5fc81147ecD0480d1d`, `0xf1614daAaa7C3C398D7BdA4B5EFbB595c011be23` |

## The construction

The sponsor's policy is a Merkle tree of leaves

$$\mathsf{leaf} = \mathsf{keccak256}(\mathsf{target} \Vert \mathsf{selector} \Vert \mathsf{cap} \Vert \mathsf{notAfter})$$

each field a 32-byte word: "I pay for one call to `selector` on `target`, if the transaction's
maximum cost is at most `cap` and it cannot be included after `notAfter`". The sponsor, an EOA,
writes the root to the EIP-8272 predeploy, where it is filed under
$\mathsf{source\_id} = \mathsf{keccak256}(\mathsf{sponsor} \Vert \mathsf{salt})$ and the slot of
the write. The paymaster holds that source id as an immutable, and nothing else.

```
 SPONSORED MINT    sender = USER (no ETH, no code)    signatures = [USER over the sig hash]
 ----------------------------------------------------------------------------------------------
 [0] VERIFY -> 0x..8141   deadline                     protocol: block.timestamp <= deadline
 [1] VERIFY -> 0x..8272   (source_id, slot, root)      protocol: root committed, slot in window
 [2] VERIFY -> USER       APPROVE(EXECUTION)           default code: entry 0
 [3] VERIFY -> SEALED     APPROVE(PAYMENT)             paymaster, reading only this transaction:
                                                         frame 1, tuple t: source_id is mine
                                                         leaf(frame 4's target and selector,
                                                              cap, notAfter) folds to its root
                                                         TXPARAM(0x06) max cost <= cap
                                                         frame 0's deadline <= notAfter
                                                         exactly five frames, frame 4 SENDER
 [4] SENDER -> TOKEN      mint(USER, 1e18)             caller = USER
 ----------------------------------------------------------------------------------------------
 pay data: t | cap | notAfter | index | depth | depth siblings        (32-byte words)
```

The protocol checks frames 0 and 1 before the paymaster runs, or the transaction is invalid. The
paymaster checks that they say what it needs.

## Results (Hegota testnet, chain 8141, 2026-10-08)

### A. Two policy roots, two slots

The policy has two leaves: P0, `mint` on Token S, alive for 6 minutes; P1, `transfer`, alive
for a day. The sponsor wrote it twice, as a depth-4 tree and as a depth-20 tree:

| Root | Slot | Transaction | Gas |
|---|---|---|---|
| depth 4, `0xf1ab625c…` | 335,894 | [`0x7350bf5f…`](https://dora.privacy.ethrex.xyz/tx/0x7350bf5f3b043455bcdc24744268202509369759b9bd9d2e278b39a9549434e4) | 131,289: the write is 15,419 execution and 97,920 state, a fresh ring-buffer slot |
| depth 20, `0x36bde952…` | 335,895 | [`0x5fb14e81…`](https://dora.privacy.ethrex.xyz/tx/0x5fb14e81410e093792b5f3f221b5d573e2990d788b977a6068dcaf8fbeb642da) | same |

Every write to a new slot index costs a fresh storage slot until the source's ring buffer has
wrapped (8,192 writes).

### B. Sponsored mints by users with no ETH

| Tree depth | Transaction | expiry | recent root | `only_verify` | pay | prefix execution | pay data | its calldata |
|---|---|---|---|---|---|---|---|---|
| 4 | [`0xf7d46af1…`](https://dora.privacy.ethrex.xyz/tx/0xf7d46af177260a3d4a85310ee25b10687a558455651419068dfce443b52fc256), block 316,311 | 3,051 | 5,579 | 100 | 4,575 | 13,305 | 288 B | 2,808 |
| 20 | [`0x316eb3f1…`](https://dora.privacy.ethrex.xyz/tx/0x316eb3f1f300f87403d6957351e0984e207c95e3ac892f48939c7479b666963b), block 316,312 | 3,051 | 5,579 | 100 | 7,631 | 16,361 | 800 B | 11,000 |

Payer: the sealed paymaster, both times. Each pay frame also carried 183,600 state gas, because
APPROVE created the user's account.

- **Each tree level costs 191 gas** in the pay frame:
  $(7{,}631 - 4{,}575) / 16$.
- **With the user's signature, the prefix used 16,105 gas at depth 4 and 19,161 at depth 20.**
  Rule 6 bounds the declared execution limits plus signature validation (2,800) by 100,000; the
  limits declared here sum to 65,000, so 67,800.
- **The proof's bytes are not in that budget.** Rule 6 counts execution limits and signature
  validation. The payer pays the 288 or 800 bytes as intrinsic gas. At depth 20 they cost more
  than the hashing (11,000 against 3,056).
- **Against the canonical paymaster.** Its pay frame cost 5,210 in experiment 09, and its signer's
  entry costs 2,800 plus about 90 bytes. The sealed path costs about 5,000 more execution,
  carries an expiry frame and a recent-root frame, and needs no signer online.

B2 sent two users' mints through the sealed paymaster at once. The first was mined (block
316,314). The second was refused:
`Non-canonical paymaster already sponsors the maximum number of pending frame transactions`.
ethrex does not implement the PR, so the sealed paymaster gets a non-canonical paymaster's cap of
one.

### C. What the sealed paymaster refuses

All seven variants were refused at admission. C7 was refused by the protocol; the others by the
paymaster ("validation prefix frame reverted").

| | Variant | Refused because |
|---|---|---|
| C1 | `mint` on another contract | the leaf for that target is not in the tree |
| C2 | max fee 10 gwei: max cost $5.27 \times 10^{15}$ wei against a cap of $10^{15}$ | max cost above `cap` |
| C3 | a sixth frame appended | not exactly five frames |
| C4 | the stranger wrote *the same root* under its own source id, and the tuple named the stranger's | the tuple's source id is not the paymaster's |
| C5 | expiry deadline 60 s after `notAfter` | deadline above `notAfter` |
| C6 | no expiry frame | not exactly five frames |
| C7 | a slot with no root in it | the protocol: `EIP-8272 recent-root reference is not committed in the RECENT_ROOT_ADDRESS predeploy at head state` |

C4 is why the paymaster binds the source id. The predeploy accepts any root from anyone, so a
tuple proves only that *someone* wrote that root.

### D. Revocation

The sponsor then wrote a third root, P1 alone, in slot 335,904, to revoke P0. A new user proved
P0 under the depth-4 root of slot 335,894, and the transaction was mined:
[`0x11594d4d…`](https://dora.privacy.ethrex.xyz/tx/0x11594d4ddea48ab65af7649c9a0fa5fb95041628c5601380433d7d832d0c987a),
block 316,318, payer the sealed paymaster. EIP-8272 keeps every root referenceable for 8,191
slots, so a later root adds a root and withdraws nothing.

What ended P0 was its own `notAfter` (unix 1,791,438,169). Twelve seconds after it:

| | Deadline | Refused by |
|---|---|---|
| D1 | now + 120 s, after `notAfter` | the paymaster |
| D2 | `notAfter`, already passed | the protocol: `Frame transaction expiry deadline has passed` |

### E. SelfSendingPaymaster: sealed by the scan, emptied by its owner

`prScan` of its runtime finds nothing. `sealedScan` finds `APPROVE` at byte 132 with a scope taken
from the stack.

The script built two transactions:
- a sponsored mint for a new user, signed by the owner as payer (entry 1), with a max fee high
  enough that its max cost (1,989,559,647 wei) exceeds what it would pay;
- a *drain*: the paymaster as `tx.sender`, approving `EXECUTION_AND_PAYMENT` on the owner's
  signature (entry 0), then a `SENDER` frame to the owner whose `value` is the balance minus the
  drain's own max cost minus 497,389,911 wei. That remainder is a quarter of the sponsorship's
  max cost.

Both simulated valid, and both were accepted. One block after both went out, the drain was the
only transaction in its block:

| | |
|---|---|
| drain | [`0xf14a42b2…`](https://dora.privacy.ethrex.xyz/tx/0xf14a42b232daee007f2aff2221528728009dd7d20ab7dc522ebbe90a54fd73e7), block 316,423: VERIFY 335, `SENDER` with value 3,000 + 183,600 state (a new account), status 1, 1 log |
| paymaster balance | 0.009999861732475678 ETH, then 580,965,481 wei |
| owner balance | 0, then 0.009999860728069323 ETH |
| the pending sponsorship | gone from the pool. Re-sent: `validation prefix frame reverted`, since the paymaster can no longer cover its max cost |

No instruction in the paymaster's code moved the ether. The `SENDER` frame did, because `APPROVE`
with an execution scope made the paymaster a sender. ethrex holds the paymaster to one pending
sponsorship, so here one transaction was lost. Under the PR, which lifts that cap for paymasters
that pass the scan, every sponsorship pending against this balance would be lost to the same one
transaction. That is the mass invalidation the canonical paymaster's timelock exists to prevent.

**A reorg on the way.** An earlier attempt (`0xccd392f4…`) left only 125,874,157 wei behind. Its
first receipt had the drain succeed at block 316,413 (210,982 gas). A reorganisation then replaced
that block at the same height. The canonical block puts the sponsorship first, the drain's value
frame fails for lack of balance (statuses 1, 0; 27,382 gas), and the paymaster kept its ether. The
same pair of transactions, two orders, two outcomes. The final run leaves a remainder that covers
one sponsorship's actual cost, so the drain succeeds in either order.

### F. Both scans against real runtimes (offline)

| Runtime | Bytes | PR scan | Amended scan | What the amended scan finds |
|---|---:|---|---|---|
| SealedPaymaster (this experiment) | 406 | sealed | sealed | - |
| SelfSendingPaymaster (this experiment) | 134 | sealed | not sealed | `APPROVE` whose scope is not the constant PAYMENT, byte 132 |
| canonical paymaster (EIPs#12041, as pinned) | 355 | not sealed (`CALL` at 332) | not sealed | `CALL` at 332, the timelocked withdrawal |
| no code (a code-less EOA sponsor, as in experiments 09 and 23) | 0 | sealed | not sealed | no code: the default code approves EXECUTION for a key |
| EIP-7702 delegation to a sealed paymaster | 23 | sealed | not sealed | a delegated EOA has a key |
| TestToken: solc 0.8, no external calls, metadata as emitted | 1,684 | not sealed (`CALLCODE` at 1,641) | sealed | - |

The amended scan (`sealedScan`) makes three changes:
1. **An account with no code, or with a delegation indicator, is not sealed.** Its key moves
   ether without any opcode.
2. **Every reachable `APPROVE` must be `PUSH1 0x01, PUSH0, PUSH0, APPROVE`.** None of these four
   is a `JUMPDEST`, so no jump can arrive between them, and the scope at that `APPROVE` is always
   `PAYMENT`. The canonical paymaster's runtime already uses exactly this sequence.
3. **Only reachable instruction positions count.** Execution enters at 0 and at `JUMPDEST`s, and
   falls through until `STOP`, `RETURN`, `REVERT`, `INVALID`, `JUMP`, `SELFDESTRUCT` or `APPROVE`.
   It is the same linear pass as `JUMPDEST` analysis, so it stays a pure function of the code.

The last row is a false positive of the PR's scan: TestToken has no external call. The opcode it
finds sits in the 32-byte IPFS digest that solc appends after `INVALID`. To see how often that
happens, `scan.ts` swaps in 100,000 digests from a seeded generator (xorshift128+, seed `0x24`):

| Code | PR scan says sealed | Amended scan says sealed |
|---|---:|---:|
| SealedPaymaster + `INVALID` + solc trailer | 72.17% | 99.08% |
| TestToken runtime + solc trailer | 71.66% | 99.05% |

About 28% of default Solidity builds of a call-free contract fail the PR's scan by the luck of
their source hash. The remaining 0.9% under the amended scan are digests with a `0x5b` byte at an
instruction position, which makes the bytes after it reachable as far as the scan can tell.
Building with `--metadata-hash none` or `appendCBOR: false` removes the trailer. EOF's separation
of code and data would have made this question disappear.

## Observations

1. **The sealed pay frame fits, with room.** The PR's open item was the gas of the recent-root
   frame and of the proof. Measured: 5,579 for the recent-root frame, $3{,}811 + 191d$ for the
   pay frame at depth $d$, and 3,051 for the expiry frame that revocation needs. With the user's
   signature the prefix is 16,105 at depth 4. Proof bytes fall outside `MAX_VERIFY_GAS` (rule 6
   counts execution limits and signature validation), so the budget is not what limits tree
   depth. The payer's calldata bill is.
2. **The PR's scan is unsound, and the hole is `APPROVE`.** The sentence "the protocol collects at
   most the reserved `max_cost` through `APPROVE_PAYMENT` regardless of the approval scope" is
   true of payment and false of execution. An account that can approve `EXECUTION` can be
   `tx.sender`, and a `SENDER` frame's `value` moves its ether with no opcode at all (E). Two more
   cases pass the scan vacuously:
   - an account with no code, whose default code approves execution for a key;
   - an EIP-7702-delegated EOA, whose key also signs ordinary transactions.
3. **The fix is syntactic and cheap.** Require each reachable `APPROVE` to be the four-instruction
   `PUSH1 1, PUSH0, PUSH0, APPROVE`, refuse no-code and delegated accounts, and skip unreachable
   bytes. The result is still a linear pass, cacheable per code hash as the PR wants, and it is
   more permissive in practice: 99% of call-free Solidity builds pass it, against 72% for the PR's
   scan.
4. **A sealed paymaster cannot withdraw, so its float is one-way.** The PR's property also admits
   ether that leaves "after a delay of at least the reservation horizon". But a timelocked
   withdrawal needs a `CALL` or an `EXECUTION` approval, and the scan forbids both. Under any
   whole-code scan, an egress-decidable paymaster is a gas tank: its float leaves as gas or not at
   all. If its sponsor stops writing roots, then 8,191 slots after the last write no tuple can
   name a root, and the float is stranded for good.
5. **Policies published to EIP-8272 cannot be revoked inside the window.** A later root does not
   withdraw an earlier one (D). For a privacy pool's commitment tree this is the point: the set
   only grows. For an allow-list it is not. Revocation can be bounded today by composition, with
   no protocol change:
   - put `notAfter` in the leaf (or in the published value, as
     $\mathsf{keccak256}(\mathsf{root} \Vert \mathsf{notAfter})$);
   - make the consumer require an expiry frame whose deadline is no later than `notAfter`.

   That composition has a price. The EIP evicts "first transactions already invalid against the
   current head, then transactions with the nearest expiry deadline, then transactions with the
   lowest effective priority fee". Every transaction sponsored this way carries a deadline, so it
   is among the first evicted under pressure, whatever it pays.
6. **The source id is the paymaster's job.** EIP-8272 checks that a tuple was written, not who
   wrote it in any sense the consumer cares about. The stranger wrote the sponsor's own root under
   its own source id at no cost beyond the write (C4). A consumer that checked only the root would
   have been satisfied.
7. **Order decides.** The reorg at 316,413 turned a successful drain into a failed one by
   reordering two transactions in a block. That is an observation of this testnet, seen once. It
   is also why the reservation rule cannot rest on "the paymaster probably will not spend": what
   matters is which transactions can reach the account's balance at all.
