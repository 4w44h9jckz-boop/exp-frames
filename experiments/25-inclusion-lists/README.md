# 25 — Inclusion lists for frame transactions: what they protect, and who decides

FOCIL ([EIP-7805](https://eips.ethereum.org/EIPS/eip-7805)) gives each slot a committee of 16
includers. Each publishes a list of up to 8 KiB of transactions it saw in the mempool. The
builder must include every listed transaction unless it is invalid or does not fit, and attesters
refuse to extend a payload that omits one without an excuse. For an ordinary transaction the
excuse is cheap to check, because validity depends on the sender's nonce and balance only.

A frame transaction's validity depends on code it names. [EIP-8369](https://eips.ethereum.org/EIPS/eip-8369)
(Informational, Draft, master read 2026-10-08) describes two profiles:

- Profile 1 covers legacy, 2930, 1559 and 7702 transactions. Attesters judge them by account
  fields.
- Profile 2 covers frame transactions whose validation prefix stays inside a fixed state surface.
  Attesters replay those prefixes, metered by a VERIFY budget of `MAX_VERIFY_GAS_PER_IL = 2**20`
  per list.

Its motivating example is "a privacy spend that checks recent roots and consumes each nullifier
as a single-use EIP-8250 keyed nonce".

The only implementation of Profile 2 is ethrex's `hegota-testnet` branch:
`docs/eip-focil-frametx.md` and `crates/blockchain/focil_profile2.rs` at
[`c94964843d`](https://github.com/lambdaclass/ethrex/tree/c94964843d39d04914dff178e55e60daf7707089).
It runs on the testnet every other experiment here used.

This experiment asks four questions of the 183 frame transactions this repository has mined:

1. Which of them can an inclusion list protect at all?
2. How many per slot?
3. Is the Profile 2 verdict a function of the inclusion lists?
4. What does checking a frame transaction cost an attester, compared with a type-2 transaction?

Short answers:

1. **173 of 183 under EIP-8369 as written, and 183 under EIP-8272's rule.** The 10 that EIP-8369's
   condition 2 leaves out are every transaction with an EIP-8272 recent-root frame: the privacy
   withdrawals of 06 and the sealed sponsorships of 24. Those are the transactions its motivation
   names.
   - EIP-8272 (master, changed 2026-10-08) says "clients MUST skip both optional leading protocol
     verifier frames", and ethrex does the same. Under that rule all 183 are candidates.
   - 68 of the 183 would qualify for a Profile 1 for frame transactions, judged by account fields
     with no replay (suggestion 5 of the post).
2. **2 privacy withdrawals per slot.** ethrex runs the budget per payload rather than per list,
   because the Engine API hands the execution layer one flat array. That is 2^20 gas per slot,
   which protects:
   - 2 privacy withdrawals at their declared limits, or 4 had they declared exactly what they
     used;
   - 15 sealed sponsorships;
   - 134 self-relayed EOA transactions.

   EIP-8369's per-list budget would protect 32, 176 and 688.
3. **No.** The consensus specification deduplicates the lists through a set: "Order does not need
   to be preserved". ethrex's budget fill debits in the order it receives. The consequences:
   - The same four withdrawals give six different admitted sets over their 24 orders.
   - Eight runs of the consensus specification's own function deliver eight orders, and ethrex
     admits eight different sets.
   - One committee member listing one never-valid transaction that declares 2^20 gas denies every
     honest Profile 2 transaction of the slot whenever it comes first.
   - Thirty such transactions at 2^20/30 gas each, 4,800 bytes in one list, need no position:
     honest withdrawals are admitted in 26% of orders.

   Sorting by cost makes the verdict deterministic, but cheaper junk still denies the expensive
   transactions. Filling each member's list on its own, as EIP-8369 specifies, admits every honest
   transaction in every scenario here. It needs list boundaries carried to the execution layer,
   and the attester's replay bound becomes 16 times the per-transaction cap.
4. **The same.** Decoding a default-code frame transaction and checking its signature takes 50 to
   53 µs on one core with ethrex's own functions. Recovering a type-2 sender takes 48 µs. A
   privacy withdrawal's stateless check takes 5 µs, because it has no signature; its cost is the
   replay, 250,387 gas of proof verification.

| File | What |
|---|---|
| [`corpus.ts`](corpus.ts) | Every mined frame transaction fixture on every `exp/` branch and `tooling`, attributed to the branch that mined it; checks each hash against the envelope |
| [`profiles.ts`](profiles.ts) | EIP-8141's mode subclassification plus the recent-root frame; Profile 2 candidacy under EIP-8369's and EIP-8272's shape rules; the VERIFY budget cost; the proposed Profile 1 for directly evaluable prefixes |
| [`profiles.test.ts`](profiles.test.ts) | The rules, as unit tests |
| [`classify.ts`](classify.ts) | A, B and F, offline: [`results/classify.md`](results/classify.md) |
| [`scenarios.ts`](scenarios.ts) | Builds the lists fed to ethrex: [`ethrex/scenarios.txt`](ethrex/scenarios.txt). Mined transactions, plus never-valid ones from a key nobody funds |
| [`cl_order.py`](cl_order.py) | consensus-specs' `get_inclusion_list_transactions`, verbatim, run under eight hash seeds: [`ethrex/delivered.txt`](ethrex/delivered.txt) |
| [`ethrex/exp25_fill_order.rs`](ethrex/exp25_fill_order.rs) | C, D and E against ethrex's own `budget_fill` and `validate_frame_signatures`: [`results/ethrex-fill-order.md`](results/ethrex-fill-order.md) |

## Run

```bash
git fetch origin
npx tsx experiments/25-inclusion-lists/classify.ts                                    # A, B, F; no network
npx tsx experiments/25-inclusion-lists/scenarios.ts > experiments/25-inclusion-lists/ethrex/scenarios.txt
for sc in mixed committee flood; do for s in 0 1 2 3 4 5 6 7; do
  PYTHONHASHSEED=$s python3 experiments/25-inclusion-lists/cl_order.py $sc
done; done > experiments/25-inclusion-lists/ethrex/delivered.txt
# C, D, E, in a checkout of lambdaclass/ethrex at c94964843d:
cp $EXP/ethrex/exp25_fill_order.rs crates/blockchain/tests/
EXP25_SCENARIOS=$EXP/ethrex/scenarios.txt:$EXP/ethrex/delivered.txt \
  cargo test -q --release -p ethrex-blockchain --test exp25_fill_order -- --nocapture --test-threads 1
```

`scenarios.ts` signs with RFC 6979, so it reproduces the committed file byte for byte. Nothing
here sends a transaction. The attacker's key is
`keccak256("exp-frames/25 attacker, never funded")`, address
`0x63A16D6d8E1DE174e0420Cb0C583aA4ad8528E60`, and it has never held ether on any chain.

## What was read

- EIP-8369 and EIP-8272 at master, read 2026-10-08. The EIP-8272 text changed that day.
- consensus-specs master:
  - `specs/heze/inclusion-list.md`: `get_inclusion_list_transactions`, `get_inclusion_list_bits`;
  - `specs/heze/fork-choice.md`: `record_payload_inclusion_list_satisfaction`,
    `should_extend_payload`;
  - `specs/heze/beacon-chain.md`: `InclusionListBits`, "one bit per member in committee order",
    carried in `ExecutionPayloadBid`.
- execution-apis master, `src/engine/bogota.md`: `inclusionListTransactions: Array of DATA` in
  `PayloadAttributesV5` and `engine_newPayloadV6`, and `PayloadStatusV2.inclusionListSatisfied`.
- ethrex at `c94964843d`:
  - `docs/eip-focil-frametx.md`;
  - `docs/dogfood/spec-feedback.md`;
  - `crates/blockchain/focil_profile2.rs`;
  - `Transaction::sender` and `validate_frame_signatures`.

## A. Who is a candidate (offline, 183 transactions)

| rule | eligible | not eligible |
|---|---:|---:|
| Profile 2 candidate, EIP-8369 as written | 173 | 10 |
| Profile 2 candidate, skipping both verifier frames (EIP-8272, ethrex) | 183 | 0 |
| proposed Profile 1 (directly evaluable prefix) | 68 | 115 |

EIP-8369's condition 2 is "Ignoring the optional EIP-8141 expiry verifier frame for shape
matching, its modes, flags, and targets match one of four EIP-8141 prefixes". A recent-root frame
is a VERIFY frame with no approval, so a prefix that starts with one matches none of the four. The
10 it excludes have three shapes:

- `recent_root_verify | self_verify`: experiment 06's keyed withdrawals, and two from tooling;
- `recent_root_verify | only_verify | pay`: one from experiment 06;
- `expiry_verify | recent_root_verify | only_verify | pay`: experiment 24's sealed sponsorships.

EIP-8369 also describes the recent roots as "references in the signed envelope". It also asks for
"a single composed payload encoding and signature hash for EIP-8141, EIP-8250, and EIP-8272"
before activation. Both describe EIP-8272 before it moved the references into a canonical frame,
which its rationale explains under "Canonical frame instead of an envelope field".

The 115 not eligible for the proposed Profile 1 are those whose prefix runs code:

| reason | transactions |
|---|---:|
| the sender's VERIFY runs account code | 76 |
| the `only_verify` frame runs account code | 15 |
| the `pay` frame runs a paymaster | 8 |
| a recent-root frame | 10 |
| a deploy frame | 6 |

Default code is recognised from the receipt. EIP-8141 says it "draws no execution gas of its own:
the frame's only execution charge is the resolved target's access". Any code that reaches
`APPROVE` pushes three operands first, so it costs at least six more.

## B. What one slot carries

16 lists of 8,192 bytes. The table shows a homogeneous slot of each kind, at the cheapest
declared budget the corpus has, Hegota testnet only.

- "declared" uses the transaction's own limits.
- "tight" uses the gas it actually used, which is what a wallet that knew the cost exactly would
  declare.

| kind | bytes | budget declared / tight | ethrex (2^20 per payload) | EIP-8369 (2^20 per list) | proposed Profile 1 (bytes only) |
|---|---:|---:|---:|---:|---:|
| self-relayed EOA, default code (01) | 188 | 7,800 / 2,900 | 134 / 361 | 688 / 688 | 688 |
| EOA sponsored by a code-less EOA (04, 09) | 353 | 25,600 / 8,700 | 40 / 120 | 368 / 368 | 368 |
| deadline-bounded EOA (10) | 206 | 25,851 / 5,951 | 40 / 176 | 624 / 624 | 624 |
| smart account, own VERIFY (05) | 280 | 35,600 / 6,729 | 29 / 155 | 464 / 464 | not eligible |
| privacy withdrawal, keyed pool (06) | 747 | 410,000 / 250,387 | **2 / 4** | 32 / 64 | not eligible |
| sealed-paymaster sponsorship (24) | 702 | 67,800 / 16,105 | 15 / 65 | 176 / 176 | not eligible |

ethrex's choice is deliberate and documented. Its spec says "the Engine API delivers no list
boundaries, so that rule was not computable by the execution layer", and its dogfood log records
the same as spec-feedback entry 1. The result is that the payload-wide budget gives the most
expensive transactions the least protection, and the most expensive are the privacy spends.

## C. The order the execution layer receives

consensus-specs, `get_inclusion_list_transactions`, ends:

```python
    # Deduplicate inclusion list transactions. Order does not need to be preserved.
    return list(set(transactions))
```

`record_payload_inclusion_list_satisfaction` passes that list to the execution engine, and
`should_extend_payload` refuses a payload whose recorded verdict is false. The Engine API carries
it as `Array of DATA` and says nothing about order.

ethrex defines "the inclusion list" as that array "in the order delivered", and its fill runs "in
list order". Its spec concludes: "The evaluator computes this from the inclusion list alone, so
every evaluator admits the same set." That holds only if every evaluator receives the same order,
and the consensus specification says it need not.

`cl_order.py` runs the specification's function itself. It gives two members' lists of the
`mixed` set (4 withdrawals W, 3 sealed sponsorships S, 4 default-code EOA transactions E) to the
function under eight hash seeds. Each seed delivers a different order, and ethrex's `budget_fill`
admits a different set for each:

| `PYTHONHASHSEED` | admitted |
|---:|---|
| 0 | E1 E2 E3 E4, S1 S2, W2 W3 |
| 1 | E1 E2 E3 E4, S1 S3, W2 W4 |
| 2 | E1 E2 E3 E4, S1 S3, W1 W2 |
| 3 | E1 E2 E3 E4, S2 S3, W2 W3 |
| 4 | E3, S1 S2 S3, W2 W4 |
| 5 | E1 E2 E3 E4, S1 S2, W3 W4 |
| 6 | E1 E2 E3 E4, S2 S3, W1 W4 |
| 7 | E1 E2 E3 E4, S1 S2, W1 W4 |

Over 5,040 sampled orders of the same 11 transactions there are 46 distinct admitted sets. Each
withdrawal is admitted in about 48% of orders, each sealed sponsorship in 72%, and each EOA
transaction in 94%. The four withdrawals alone give 6 sets over their 24 orders, each withdrawal
admitted in exactly half.

A transaction that is not admitted is not checked, so its omission is excused. Two attesters
holding the same lists can therefore reach different `inclusionListSatisfied` verdicts on a
payload that omits W1. That is the disagreement EIP-8369's rationale says "a single eligibility
boundary" exists to prevent.

Production consensus clients were not read. The point is that the specification permits any
order, and its own reference implementation produces a different one per process.

## D. A committee member who lists what can never be valid

The attacker's transactions come from a key that has never held ether. Each is a self-relayed
frame transaction whose VERIFY limit makes its budget cost whatever the attacker wants. The fill
checks shape and signature before it debits, and both pass. Replay then finds the transaction
invalid, so its own omission is excused, and it has consumed the budget. It costs the attacker
nothing, because a transaction that is never included pays no fee. It needs a seat on the
committee: with a fraction $p$ of validators that is a probability of $1-(1-p)^{16}$ per slot,
15% at $p = 0.01$ and 56% at $p = 0.05$.

| scenario | lists | flat array, all or 5,040 sampled orders | canonical order (cost, then hash) | per list (EIP-8369) |
|---|---|---|---|---|
| `grief-honest` | W1 S1 E1 | all admitted in all 6 orders | all admitted | all admitted |
| `grief` | A (2^20), W1, S1, E1 | in the 6 of 24 orders where A is first, only A is admitted; otherwise all honest | all honest admitted | — |
| `grief-under` | U1 U2 U3 (400,000 each), W1, S1, E1 | W1 admitted in 50% | W1 denied, crowded out by U2 and U3 | — |
| `committee` | [A] [U1 U2 U3] [W1 S1 E1] [W2 W1 S2 E2] | W1 35.5%, W2 34.8%, S and E 90% | W1 and W2 denied | **all honest admitted** |
| `flood` | [F1 … F30] (34,952 each, 4,800 bytes) [W1 W2 S1 S2 E1 E2] [W3 W4 S3 E3 E4] | W 26%, S 43%, E 52%; every one of 5,040 orders a different set | E admitted, every S and W denied | **all honest admitted** |

Three properties follow.

- **The flat fill is not monotone in the lists.** `grief-honest` is `grief` without the attacker's
  list. An attester that never received that list requires W1, S1 and E1; one that did receive it
  excuses all three in a quarter of orders.
  - FOCIL's fork choice tolerates attesters seeing different lists because more lists can only
    mean more to include. The builder's bid declares which lists it covered, in
    `inclusion_list_bits`, and attesters check that their own lists are among them.
  - Per-list admission is monotone: a transaction is admitted if any list that carries it admits
    it. A builder that satisfies the lists its bits declare therefore satisfies every attester
    whose lists those bits include.
  - The flat fill loses this, and no ordering rule restores it. Adding a list can only add debits
    ahead of a transaction.
- **A canonical order fixes determinism and nothing else.** Ascending cost protects the cheap
  transactions, but junk priced just under a victim's cost still denies the victim (`grief-under`,
  `flood`). The victims priced highest are the privacy withdrawals.
- **One dishonest includer should cost one list, not sixteen.** Under the per-list fill the
  attacker's budget is its own. It can withhold its own protection, which it could always do by
  listing nothing, and it cannot spend anyone else's. That is FOCIL's assumption that one honest
  includer suffices, and the flat fill drops it for Profile 2.

## E. What the stateless half costs an attester

This is ethrex's code, release build, one core of an Intel Xeon at 2.80 GHz: decoding followed by
`Transaction::sender` for type-2, or `validate_frame_signatures` over `compute_sig_hash()` for
frame transactions. Each figure is the median of 5 rounds of 4,000.

`Transaction::sender` answers from a process-wide cache keyed by transaction hash after the first
recovery, so the type-2 loop empties that cache every iteration. Without that it measured 1.3 µs,
a cache hit.

| transaction | bytes | µs per transaction | per 8 KiB list | ms per slot (16 full lists, distinct) |
|---|---:|---:|---:|---:|
| T1, type-2 transfer | 111 | 48.2 | 73 | 56.3 |
| E1 to E4, default-code frame transaction | 167 to 251 | 50.0 to 52.6 | 32 to 49 | 25.6 to 41.2 |
| S1 to S3, sealed sponsorship (one SECP256K1 signature) | 702 to 1,214 | 49.8 to 56.8 | 6 to 11 | 5.0 to 10.0 |
| W1 to W4, privacy withdrawal (no protocol signature) | 746 to 747 | 5.0 to 5.5 | 10 | 0.8 to 0.9 |

A directly evaluable frame transaction costs an attester what a type-2 transaction costs, and a
full slot of them costs less, because they are larger. The proposed Profile 1 would add account
reads that Profile 1 already makes:
- the payer's balance and code flag;
- the keyed nonce at each declared key;
- the deadline against the block's timestamp.

Moving those transactions out of Profile 2 removes them from the budget, and with it from
sections C and D, at no new stateless cost.

## F. One dimension or two

EIP-7805 excuses an omission when `T.gas > gas_left`. ethrex's `gas_fits` is the same comparison
over `max_gas`, and its spec says it "is deliberately one-dimensional … Judging the sum against
the one remaining budget excuses more omissions than the per-dimension rule would, never fewer".
EIP-8141 includes a frame transaction when its execution reservation and its state reservation
each fit their own dimension.

In the corpus:
- 104 of 183 transactions declare state gas;
- `max_gas − execution_reservation` has a median of 97,920 gas;
- the largest is 30,070,620: a self-relayed transaction from experiment 20 whose five SENDER
  frames create contracts.

Under the one-dimensional rule, any transaction that creates an account or a contract needs room
in the dimension it does not use.

## Observations

1. **EIP-8369's condition 2 should defer to EIP-8272's rule and skip both verifier frames.** As
   written, it leaves out exactly the transactions its motivation names. EIP-8272 already states
   the rule for the mempool, and ethrex for Profile 2. The fix is editorial. The two stale
   sentences about envelope references and a composed payload encoding go with it.

2. **The Profile 2 budget must be a function of the set of lists, which means the fill must run
   per list, which means the boundaries must reach the execution layer.** The concrete change is
   in two places:
   - `get_inclusion_list_transactions` returns the timely, non-equivocating lists in committee
     order, the order `InclusionListBits` already uses, each in its signed order;
   - the Engine API carries them as `Array of Array of DATA`, or as the flat array plus a parallel
     array of list indices.

   The execution layer then deduplicates, exactly as EIP-8369 already says: "per IL occurrence
   before deduplication". The changes cost:
   - **Engine API bytes.** At most 16 × 8 KiB per call either way; deduplication removes only
     repeats.
   - **The replay bound.** One honest list must be able to protect a transaction of cost
     $c_{\max}$ whatever the other fifteen carry. So the worst case per slot is
     $16\,c_{\max}$, which is $2^{24}$ at the candidate cap, and no fill does better without
     lowering the cap. Keeping ethrex's $2^{20}$ per slot with per-list budgets would mean a cap
     of $2^{16} = 65{,}536$, below what a withdrawal uses (250,387). A cap that admits that
     withdrawal, declared tightly, needs a per-slot bound of at least $16 \times 250{,}387 \approx 4.0$M gas of
     replay.

   That number is the one EIP-8369 says "requires full pipeline benchmarks", and it should be
   benchmarked before either value is fixed. The per-list code budget in ethrex, and its
   normative replay order, are order-dependent in the same way and need the same treatment.

3. **A Profile 1 for directly evaluable frame transactions is worth its text.** It covers 68 of
   183 mined transactions, at the stateless cost of a type-2, bounded by bytes alone. The budget
   can neither ration it nor be ground against it. It also leaves the Profile 2 budget to the
   transactions that need replay.

4. **The omission check's gas fit should be EIP-8141's own two-dimensional test.** An attester
   that has executed the payload, as the Heze fork choice requires before it records a verdict,
   has both dimensions.

Not suggested, and why:

- **Dropping the budget.** Attester replay becomes unbounded.
- **A stateful fill, recomputed at each evaluation state.** ethrex's rationale applies: "would
  reintroduce the ordering problem this EIP removes".
- **Rationing per sender or per payer.** The attacker's keys are free and never funded. Rationing
  by key counts keys, not adversaries.
- **Ordering by fee.** A transaction that is never included never pays the fee it declares.
- **Ordering by arrival.** An includer who publishes first would choose the order, which is the
  attack.
- **A canonical order on the flat array as the fix.** It is better than no order, because it is
  deterministic and protects cheap transactions. Sections C and D show what it leaves:
  non-monotone verdicts, and expensive transactions denied by cheaper junk.

What per-list filling does not fix is the paid grief ethrex's security considerations already
record: a transaction that is valid when listed and invalidated by a cheaper conflicting one in
the block. Under per-list filling it costs the attacker one entry in each honest list it must
deny, each of which it must get there through the public mempool, instead of one seat anywhere
on the committee.
