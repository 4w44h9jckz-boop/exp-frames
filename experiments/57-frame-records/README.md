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
  - W3's pair from experiment 34, the two withdrawals of one note;
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
