# 57 - Frame transactions as the records pre-signing checks read

A wallet can run rule-based checks before it signs: is this an approval to a spender nobody knows,
a transfer to an address on the wrong chain, a typed-data request that grants more than it says,
an account with no post-quantum path. Such checks read a record per transaction, with fields such
as the spender, the approved amount, the selector, the recipient and the signing chain. The checks
this experiment targets were written for earlier transaction types: one sender, one call, one
signature over the whole.

A frame transaction (EIP-8141) breaks those assumptions:
- it has many calls, some run by the entry point rather than the sender;
- a payer may be someone other than the sender;
- the sender may sign an execution digest $E$ (experiment 27) that leaves the payer's frame open.

This experiment builds the converter from a frame transaction to each applicable check's record,
and publishes the records. It does not run the checks.

## Written before any code

**The claim.** Checks written for earlier transaction types miss harm that only frames allow:
- an inserted frame;
- an account paying for itself over $E$;
- a frame that reads the fee;
- a replay across EIP-8250 revisions.

The records they read have no field for any of these.

**It would be shown wrong if** the records of experiment 27's eight refused cases differ from those
of the valid case each was cut from, in a field a check reads, so that a check written without
frames in mind could flag them.

**It is done when** every case below has its records, each refused case is compared with its valid
twin field by field, and the frame facts that no record carries are listed per case.

**The plan:**
- **The checks' records.** The converter fills only what the transaction itself determines:
  - addresses;
  - selectors;
  - amounts;
  - the chain ID;
  - for an $E$ signature, the typed data and its domain separator.

  Fields that need outside knowledge stay out of the record, and the record lists their names:
  - a scam list;
  - a block explorer's verification;
  - a price;
  - the user's history.
- **Which checks apply.** Of the sixteen record types the checks read, the converter fills these
  seven where the transaction holds what they need:
  - an approval;
  - a typed-data signature;
  - a transfer's destination;
  - a swap;
  - a transaction's inclusion path;
  - the account's post-quantum readiness;
  - a mixer-style withdrawal.

  The other nine are about backups, behaviour over weeks, lending positions, governance, layer-2
  sequencing, bridges, stealth addresses and RPC traffic. Each is marked not applicable, with the
  reason.
- **The frame facts.** Beside the records, the converter lists what a frame-aware rule would read:
  - each frame's mode, flags, resolved target, limits, value and selector;
  - the payer;
  - whether the sender signed the canonical hash or an explicit digest, and whether that digest is
    this transaction's $E$;
  - the nonce keys.
- **The cases:**
  - experiment 27's nineteen signed cases, the set for EIP-8250 at `f3079a0` that the Hegota
    testnet follows, each with its verdict;
  - experiment 28's twelve batches, fetched as mined from the testnet;
  - experiment 34's pair, the two withdrawals of one note;
  - the EIP-8250 replay pair: experiment 27's `key-zero` bytes read under `f3079a0`, where key 0
    is the legacy nonce, and under `1a086d5c`, where it is an ordinary key. One byte string, two
    readings. A mined replay needs a chain that changes revision in place, which no test network
    here does.

**Predictions, for the eight refused cases against their valid twin (`sponsored-transfer`, or
`self-paying`'s own shape):**

| Refused case | Prediction |
|---|---|
| `self-paying` | no twin: its records look like any self-paid transfer's. Nothing in them says payment was approved on $E$ |
| `inserted-default` | records equal. The inserted frame's selector shows up only in the frame facts, since no applicable record lists calls without an approval in the transaction |
| `appended-default` | records equal, as `inserted-default` |
| `state-limit-lowered` | records equal: no record has a gas limit |
| `transfer-retargeted` | the transfer record differs in the token address. Nothing in the record says which token the user meant |
| `payer-is-sender` | records equal: no record has a payer |
| `other-account` | records differ in the sender address only |
| `blob-swapped` | records equal: no record has blob hashes |

So the converter predicts that at most two refused cases change a field a check reads, and that
neither change is a signal without the user's intent. If that holds, the claim holds for the
records, whatever the checks' rules.

**Post-quantum status.** Not applicable to the converter. The account-readiness record carries the
signature schemes the transaction uses, so a post-quantum sender (experiment 49) is visible to the
check that reads it.

## Results, 2026-11-06

- `npx tsx experiments/57-frame-records/records.ts` reads only files in this repository:
  - experiment 27's two case files;
  - the testnet fixtures in `test/fixtures/chain/` for experiment 28's twelve mined batches;
  - experiment 34's `record.json`.
- The converter is [`convert.ts`](convert.ts).
- It writes [`results/records.json`](results/records.json), the records and frame facts of all 35
  cases, and [`results/comparison.md`](results/comparison.md), the refused cases against their
  twins.

**The files a check reads.**
- `results/records/<case>/<record>.json` holds one record per file. It carries the record's fields
  under the check's own field names, and nothing else.
- When a case has two records of one kind, they are numbered `-1` and `-2`, in frame order.
- Amounts are JSON integers.
- `results/records/<case>/frame-facts.json` holds the case's frame facts.
- `results/records/index.json` maps each case to its files, each file's frame, and the fields that
  file leaves out. It also lists the nine record types that apply to no case.
- There are 35 cases and 137 record files.
- Regenerate with `npx tsx experiments/57-frame-records/records.ts` at this directory's commit.
  The output is deterministic.

**What the converter fills:**

| Source | Cases | Records per case |
|---|---|---|
| experiment 27, `f3079a0` | 19 | a transfer's destination (15: `atomic-approve-swap`, `blobs`, `many-frames` and `blob-swapped` transfer nothing); a typed-data signature (19); inclusion and account readiness (all). The one approval is `atomic-approve-swap`'s. Its swap uses a placeholder selector, so no swap record |
| experiment 28 | 12 | an approval and a swap each; D has a second approval, back to 0; inclusion and account readiness |
| experiment 34 | 2 | a pool withdrawal; inclusion and account readiness |
| EIP-8250 pair | 2 | as experiment 27's `key-zero` |

Nine of the sixteen record types apply to no case, for the reasons in `NOT_APPLICABLE`. Every
record names the fields it leaves out. Most are outside knowledge: a scam list, a price, a
history, the user's intent.

**The refused cases against their twins.** The table is in
[`results/comparison.md`](results/comparison.md).

- **At signing, six of the eight cannot be seen.**
  - `inserted-default`, `appended-default`, `state-limit-lowered`, `transfer-retargeted`,
    `other-account` and `blob-swapped` each carry their twin's signature: a relay made them after
    the user signed. A check that runs before signing sees the twin, and passes it.
  - `payer-is-sender` is signed over the same $E$ as its twin, so its typed data is the same.
    Only the pay frame's target, which $E$ leaves open, differs.
  - `self-paying` is the one the user signs as such. Its records look like any self-paid transfer's
    with an $E$ signature. No field says that payment was approved on $E$.
- **In transit, the prediction was wrong in detail.**
  - In the six relay copies, the typed-signature record loses its typed data. The transaction
    carries only the digest entry 0 signed, and that digest is not this transaction's $E$. A check
    sees an empty field, not a reason.
  - `inserted-default` changes the inclusion record's `to_address`: the first call is now the
    inserted `DEFAULT` frame. The prediction said no record would change.
  - `transfer-retargeted` changes the token, and `other-account` the sender, as predicted.
  - `state-limit-lowered`, `appended-default` and `blob-swapped` change nothing but the lost typed
    data. `payer-is-sender` changes nothing.
  - So in transit, three cases change a field a check reads beyond the typed data. None of the
    three changes says what was wrong without the user's intent: the token they meant, the
    account they meant, or the frames they signed.
- **The claim, for the records: it holds.**
  - No record has a field for any of the following:
    - frame modes and order;
    - the payer;
    - the approval scope;
    - limits;
    - blob hashes;
    - whether a signature covers this transaction.
  - So no check that reads these records can refuse a case for the reason the account refused it.
  - Whether the checks flag any case for another reason is for the run of the checks themselves.
    That run is not in this repository.
- **The EIP-8250 pair.**
  - The records are identical under both revisions.
  - So is $E$: `0x06ffc79e...abdacb` under both, since $E$ commits to the nonce keys and not to
    what the chain makes of them.
  - A replay across revisions is invisible to both the records and the signature.
- **Experiment 34's pair.**
  - The two withdrawals' records differ only in the recipient.
  - Experiment 34 found them linkable by their identical shape in one block. The records carry no
    shape, and the withdrawal record has nothing tying one withdrawal to another, so a check reading
    them one at a time cannot see the link.

**Post-quantum status.** None of the 35 cases uses a post-quantum signature. The account-readiness
record reads `SECP256K1` for every case. This records the cases, not a limit of the converter: a
leanSPHINCS dependency (experiment 49) would show up in the frame facts as a mode-4 frame.
