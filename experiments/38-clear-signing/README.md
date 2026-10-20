# 38 - Clear signing for frame transactions

A hardware wallet that clear-signs shows what a transaction does before the key signs it.
ERC-7730 is the descriptor format for that: a JSON file per contract, or per EIP-712 domain, that
says how to show a call or a message. A frame transaction is more than a call. Its signature may
cover the whole transaction or only the execution digest $E$. It carries `VERIFY` frames with
approval scopes, a payer and a maximum cost, `DEFAULT` frames such as a deploy, an expiry frame,
atomic batches and nonce keys. ERC-7730 binds a descriptor to calldata or to an EIP-712 domain,
and has a place for none of these.

The question: can a device show a type-`0x06` transaction, or $E$'s typed data, well enough that
the signer is not signing blind, from descriptors and the transaction alone, without the account's
code? And which of those things need a descriptor at all?

The format is in [`format.md`](format.md). kohaku-rs's `kohaku-frame-display` renders it. It ran
on 83 inputs: experiment 27's cases under both EIP-8250 revisions, from the transaction and, for
the accepted ones, from typed data alone; experiment 28's twelve batches; experiment 12's session
grant, both redemptions and the revocation; experiment 02's deploy frame and its follow-up; and
experiment 12's setup, which deploys an account for someone else. Each was rendered three times:
with every descriptor, without the account descriptors, and with the transaction alone.

Short answers:
1. **Yes, for every common shape, without the account's code.** All 19 mined transactions
   reviewed with nothing blind: sponsored and self-paid atomic batches, independent calls, a
   deploy frame, a session grant, two session redemptions and a revocation. Experiment 27's
   accepted cases, 11 under the testnet's EIP-8250 and 12 under master, were blind only in
   calls to synthetic contracts that no descriptor describes, a pool, a factory and the
   many-frames targets, which the vectors made up.
2. **Five of the six things need no descriptor.** What the signature covers, the `VERIFY` scopes,
   the payer and maximum cost, the atomic batches and the nonce follow from the transaction by
   EIP-8141's rules. With the transaction alone, a device showed all of them, and was blind only
   in the calls. The sixth splits: the expiry frame is the protocol's, but a deploy frame needs a
   deployer descriptor, because the CREATE2 deployer's calldata is not ABI.
3. **The account's code matters twice, and an account descriptor replaces it both times.** Once
   for what the account's `VERIFY` frame does with a signature that is not over the whole
   transaction: without the account descriptor, every signature over $E$ was blind, 52 of 52.
   And once for the calls the account makes to itself: experiment 12's grant is a packed 69-byte
   call that ERC-7730 cannot key, and without the account descriptor the grant was blind. The
   descriptor binds by code template. The device checks a deploy frame against it from the
   transaction alone, and the wallet's own account list covers deployed accounts.
4. **What cannot be shown:** a session's limits and remaining budget, which are in storage and
   enforced by the account; blob contents, which travel beside the transaction; and, from typed
   data alone, nonce keys other than the account nonce, which arrive as a hash. And the nonce
   needs the fork's EIP-8250 revision: the same bytes `[0]` at sequence 0 are the account nonce
   at `f3079a09e8` and key 0 at master, under one signature hash and one $E$.

| File | What |
|---|---|
| [`format.md`](format.md) | The display format: the frame container's rules, ERC-7730 files as they stand, account and deployer descriptors, gaps |
| [`descriptors/`](descriptors/) | The descriptors: three ERC-7730 files (`erc7730/`), three account descriptors (`accounts/`), the CREATE2 deployer (`system/`), and the wallet's own data (`wallet.json`) |
| [`rebuild.test.ts`](rebuild.test.ts) | The record checked against this repository's code: the descriptors are the files kohaku-rs read, the account code and CREATE2 addresses, every format's selector, each transaction's hashes and maximum cost, $E$ and its typed data under each revision, and what each shape shows |
| [`record.json`](record.json) | The run: every review, with its lines, their sources and its gaps, and the gaps without account descriptors and with the transaction alone |
| [`kohaku-rs-output.txt`](kohaku-rs-output.txt) | The run's output, every review as a device would list it |
| [`erc7730-lint.txt`](erc7730-lint.txt) | The ERC-7730 files through the ERC's own linter |

The renderer is kohaku-rs's `kohaku-frame-display` (branch `experiment/frames`, commit
`30497a9`). Its `tests/fixtures` hold copies of `descriptors/`, of the chain fixtures and of
experiment 27's cases files. `kohaku-frame-wallet`'s experiment 28 test checks the wallet's
batches against it.

## Run

```bash
# kohaku-rs, crates/:
RECORD=record.json cargo run --release -p kohaku-frame-display --example clear_signing > kohaku-rs-output.txt
# here, offline:
npx vitest run experiments/38-clear-signing
# the ERC-7730 files, with the linter of python-erc7730 1.0.12:
uv tool run --python 3.12 --from erc7730==1.0.12 erc7730 lint --skip-abi-validation descriptors/erc7730
```

## The format

A device is given a transaction and the index of the signature entry it holds the key of, or the
typed data alone. It shows sections in order: what the signature covers and who else signs; the
account and how it is bound; the nonce; the `VERIFY` frames; payment; the calls; blobs. Every line
names its source, and every review ends with its gaps, each marked blind or not. `format.md` has
the rules.

Most of a review is the protocol's. Of the 312 lines in the 19 mined transactions' reviews, 234
came from EIP-8141 and EIP-8250, 52 from ERC-7730 files, 24 from account descriptors and 2 from
the deployer descriptor. A review ran 11 to 20 lines, 16 at the median.

The calls take ERC-7730 files as they stand. A `SENDER` frame is ERC-7730's EVM transaction
container with `@.from` the sender, `@.to` the frame's target and `@.value` its value. A
`DEFAULT` frame is the same with `@.from` the entry point, `0xaa`: a descriptor that names
`@.from` would otherwise call it the sender. For each of experiment 28's twelve batches the
review's intent is exactly ERC-7730's intents of its EIP-5792 calls, joined with " and " as
ERC-7730 joins a batch (`kohaku-frame-wallet`, `tests/experiment_28.rs`).

## Results (2026-10-20)

### Every shape, three ways

A blind gap is a frame or a signature whose effect the review cannot show. Starred counts are
blind.

| Input | Renders | All descriptors | Without account descriptors | Transaction alone |
|---|---:|---|---|---|
| experiment 28, atomic batches, self-paid | 6 | none | none | 12* no descriptor |
| experiment 28, atomic batches, sponsored | 4 | none | none | 8* no descriptor |
| experiment 28, D, independent calls | 2 | none | none | 6* no descriptor |
| experiment 12, session grant | 1 | none | 1* no descriptor | 1* |
| experiment 12, session redemptions A and B | 2 | 2 state | 2* no descriptor | 2* |
| experiment 12, revocation | 1 | none | 1* no descriptor | 1* |
| experiment 02, deploy frame 1b | 1 | none | 1* no descriptor | 1* |
| experiment 02, the follow-up | 1 | none | none | none |
| experiment 12, setup: a deploy for someone else | 1 | none | 1 no descriptor | 1* |
| experiment 27, accepted, from the transaction | 23 | 24* no descriptor, 2 not in transaction | the same, and 23* account | 23* account, 34* no descriptor, 2 not in transaction |
| experiment 27, accepted, from typed data alone | 23 | 24* no descriptor, 3 hash only, 2 not in transaction | the same, and 23* account | 23* account, 34* no descriptor, 3 hash only, 2 not in transaction |
| experiment 27, master's key-0 case read under the testnet's revision, both ways | 2 | none | 2* account | 2* account |
| experiment 27, refused | 16 | 12* opaque, 4 refusal, 8* no descriptor, 2 not in transaction | 18* account, 12* opaque, 8* no descriptor, 2 | 18* account, 12* opaque, 18* no descriptor, 2 |

The 24 blind calls in experiment 27's accepted cases, 12 in each set, are all to its synthetic
targets: the pool with selector `0x12345678`, the factory with `0xdeadbeef`, and the many-frames
targets. The vector token's transfers and approvals show.

### The six things ERC-7730 has no place for

| | Comes from | Shown with the transaction alone |
|---|---|---|
| the transaction as a whole, signed over the canonical hash | EIP-8141: an empty `msg` signs the signature hash; a `msg` equal to $E$ recomputed signs $E$; anything else is opaque | yes |
| `VERIFY` frames and their scopes | EIP-8141: the flags' allowed scope; the sender's frame's meaning from the account descriptor, or default code | the scopes, yes; what an account approves on $E$, no |
| the payer and its maximum cost | EIP-8141: the first frame that may approve payment; `max_gas` at the maximum fees | yes, and recomputed here with `src/frametx` for all 19 mined transactions |
| `DEFAULT` frames: a deploy, the expiry verifier | the expiry frame: EIP-8141. A deploy: the deployer descriptor, then the account descriptors for its initcode | the expiry, yes; the deploy, no |
| the atomic-batch flag | EIP-8141: maximal runs joined by the flag; calls before the payer is set run in the validation prefix | yes |
| nonce keys | EIP-8250, under the fork's revision | yes from the transaction; from typed data, the account nonce only |

### Experiment 27's refused cases

From the owner's entry, under either revision, every refused case was flagged:

| Case | Flagged as |
|---|---|
| a `DEFAULT` frame inserted, or appended; the state limit lowered; the transfer retargeted; a blob swapped; the signature on the second account | opaque: the owner's `msg` is no longer this transaction's $E$ |
| the account paying on $E$; the relay naming the account as its payer | refusal: the account descriptor approves only `EXECUTION` on $E$ |

## Observations

1. **Over the canonical hash, the account's code decides whether a signature is accepted, not
   what it allows.** The signature commits to every frame and the fees. Experiment 02's
   follow-up, with no deploy frame and no wallet list, bound the account to nothing and was
   still not blind. Experiment 28's senders are EOAs under EIP-8141's default code, whose
   meaning is the EIP's.

2. **Over $E$, it does not.** $E$ is fixed by the draft ERC, but whether the account reads a
   32-byte `msg` as $E$, and what it approves on it, is the account's. Without the account
   descriptor all 52 renders over $E$ were blind on that alone. With it, the descriptor also
   predicted both of the account's refusals, the two cases where it is asked to pay on $E$.

3. **ERC-7730 cannot key the calls an account makes to itself when they are packed.**
   `SessionAccount` encodes its owner's operations as a tag byte and fixed-width fields. The
   grant of a session, the one transaction in experiment 12 that hands out authority, is a
   69-byte call to the account itself. Without the account descriptor it shows as raw bytes. An
   account whose self-calls were ABI-encoded would key in ERC-7730 as it stands, and would still
   need a binding: ERC-7730 binds by address or by a factory's deploy event, and these accounts
   are deployed through a deployer that emits none.

4. **A deploy frame binds the account from the transaction alone.** The device computes the
   CREATE2 address from the deployer, the salt and the initcode's hash, sees that it is the
   sender, and matches the initcode against the account descriptors' creation code. Experiment
   02's 1b bound this way, with no wallet list. After deployment nothing in a transaction names
   the implementation: the follow-up bound only through the wallet's own list.

5. **The nonce needs the fork.** EIP-8250's change at `56b645be` gave the bytes `nonce_keys = [0]`
   two meanings. Master's key-0 case, read under the testnet's revision, shows the account nonce,
   with the same signature hash and the same $E$. One consequence, derived from the two texts and
   not run: a chain that moves from `f3079a09e8` to master's rule would read every earlier frame
   transaction, all of which carry `[0]` (as all 19 here do), as a key-0 transaction. Key 0's
   sequence starts at 0, so those transactions would become valid again, in order from sequence
   0, unless the move also changes the chain or resets state.

6. **Typed data alone loses only the nonce keys.** Every typed-data review had the same intent as
   the transaction's. The pay frame and the fees are not in $E$, so the device shows them as not
   signed either way. The nonce keys arrive as their hash; three of the 24 had keys other than
   the account nonce and showed a hash.

7. **The review shows what the account's layout risks.** A session redemption records the spend
   in one frame and pays in the next, and they are not batched: the review says "one can fail
   while the others succeed". That is what experiment 12's first run met, a spend recorded for a
   payment that failed.

8. **Full precision shows a failing swap.** Case E asks for one wei more than the swap pays, so
   that it fails. The review reads "Swap 1 TKA for at least 1.000000000000000001 TKB". A device
   that rounded amounts would have hidden the reason it fails.

9. **The intents are long for a device.** The linter warns that every interpolated intent here
   is over 30 characters and "may be truncated on Ledger devices". A batch's joined intent ran 37
   to 141 characters.

## Where it would go

The run separates three kinds of content:
- **wallet rules**, the frame container of part 1, which no descriptor carries, because EIP-8141
  fixes them;
- **ERC-7730 files as they stand**, with the container values per frame;
- **two descriptor kinds ERC-7730 lacks**: an account bound by code template, with `verify` rules
  and packed keys, and a deployer with non-ABI calldata.

The first two fit ERC-7730 as a third container beside its EVM transaction and EIP-712 ones. The
third needs a new `context` kind and a new key grammar. That can be an addition to ERC-7730 or a
separate small ERC that names ERC-7730's formats. The run supports either and decides neither.

## Not done here

- No device ran it. The renderer is a library; no hardware wallet's firmware or simulation
  service was tried.
- The descriptors were written here, for the experiments' own contracts. Who curates and signs
  account descriptors, and how a device trusts them, is not tested.
- Binding by runtime code, for a host that reads the account's code, is defined but not
  exercised: the wallet's list bound every deployed account.
- The default-code binding assumes the key never signed an EIP-7702 delegation; nothing here
  checks that.
- ERC-7730 alone was not run on $E$'s typed data as a plain EIP-712 message.
- Experiment 27's synthetic targets got no descriptors, since they are not contracts.
