# 27 — A shared layout for the execution digest, as a draft ERC

Experiment 23 showed that an account approving `EXECUTION` alone can sign an explicit digest $E$
that leaves out the payer's frame and the fees. Then any payer can complete the transaction, or
replace another payer's copy, without the sender signing again. Its $E$ was one account's private
layout. The post's open question was the ERC that would let two wallets, an account and a sponsor
agree on $E$ byte for byte.

This experiment writes that ERC ([`erc-draft.md`](erc-draft.md)) and tests it against four
implementations that share no code.

| File | What |
|---|---|
| [`erc-draft.md`](erc-draft.md) | The draft: $E$ as EIP-712 typed data, the rules for accounts, wallets and payers, the operation identifier, rationale, security considerations |
| [`digest.ts`](digest.ts) | $E$ through viem's EIP-712 encoder, and by hand from the draft's layout |
| [`ExecutionScopeAccount.yul`](ExecutionScopeAccount.yul) | An account that approves `EXECUTION` on $E$, recomputed by introspection, and pays for itself only over the canonical hash. 617 bytes of code, then the owner |
| [`vectors.ts`](vectors.ts) | Ten vector transactions, and nineteen signed cases with the verdict each must get; writes [`vectors.json`](vectors.json) and [`ethrex/cases.txt`](ethrex/cases.txt) |
| [`digest.test.ts`](digest.test.ts) | The two TypeScript implementations agree; what $E$ pins and what it leaves; one $E$ for both envelopes; a wallet's typed-data signature is the frame entry; the mined transactions carry $E$ |
| [`ethrex/exp27_execution_digest.rs`](ethrex/exp27_execution_digest.rs) | The account against the nineteen cases, inside ethrex's validation-prefix simulation |
| [`example-digest.ts`](example-digest.ts) | The same on the Hegota testnet: setup, A (two payers), B (refusals), C (gas) |
| [`results/live-2026-10-08.md`](results/live-2026-10-08.md) | Every log, command and commit |

## The digest

```
domain  = EIP712Domain("FrameExecution", "1", chain_id, verifyingContract = sender)
message = FrameExecution(nonceKeysHash, nonceSeq, Frame[] frames, bytes32[] blobVersionedHashes)
Frame   = (mode, flags, resolved target, execution limit, state limit, value, data)
```

In a pay frame (`VERIFY`, allowed scope `PAYMENT` alone), the target, both limits and the data are
zeroed: those are the payer's. Mode, flags and value stay pinned.

What changed from experiment 23's layout, and why:

| | Experiment 23 | This draft | Why |
|---|---|---|---|
| encoding | a flat keccak with a label | EIP-712 | a wallet with no frame support can sign it through `eth_signTypedData_v4`; domain separation comes with it; ERC-4337 v0.8 made the same choice |
| blob versioned hashes | left out | pinned | `BLOBHASH` reads them in every frame, so a relay could swap the blobs under a frame that posts them |
| pay frame | its index and a marker | its index, mode, flags and value | none of the three can differ in a valid pay frame today; pinning them means a future flag, or value on `VERIFY`, cannot reach the sender through an open field |
| the account paying on $E$ | not allowed | not allowed, also when the relay names the account as payer | the relay chooses the pay frame's target, so it can choose the sender |
| plain EIP-8141 envelope | not covered | `nonce` digests as `nonce_keys = [0]` | the two envelopes of one operation share one $E$ |

## Results

### Four implementations, one digest

| Implementation | Checked on |
|---|---|
| viem's `hashTypedData` | the ten vectors (it produced them) |
| by hand, from the draft's layout ([`digest.ts`](digest.ts)) | the ten vectors |
| alloy's EIP-712 derive, kohaku-rs `frame-kit` (`src/digest.rs`) | the ten vectors' domain separators, struct hashes and digests, decoded from the raw transactions |
| the Yul account, recomputing $E$ by introspection | 19 signed cases in ethrex, and 3 mined transactions plus 5 refusals on the testnet |

The vectors cover:
- a sponsored transfer;
- an expiry frame;
- an atomic batch;
- a deploy frame;
- two keyed nonces;
- nonce 7 on key `[0]`;
- value and `DEFAULT` frames;
- two blobs;
- twelve frames with data of 0 to 1,000 bytes;
- a self-paying transaction.

### Inside ethrex: 19 cases, 0 mismatches

| Accepted (11) | Refused (8) |
|---|---|
| the ten shapes above except self-paying; the owner's entry, byte for byte, under sponsor 2 with its own pay frame (other limits, other data) and 20 times the fees; an empty target written out as the sender | a `DEFAULT` frame inserted; one appended; a state limit lowered; the transfer retargeted; a blob swapped; the same owner signature on a second account; **the account named as its own payer**; the account paying on $E$ |

Each refusal comes from the account. The protocol had already accepted the owner's signature over
the explicit `msg`, so the only thing that failed was the account's recomputed $E$, or its rule
against paying.

### On the Hegota testnet

**A. One typed-data signature, two payers.** The owner signed $E$ with viem's `signTypedData`,
the call a wallet serves for `eth_signTypedData_v4`. Sponsor 1 completed and sent the transaction.
Sponsor 2 built its own copy with its own pay frame and fees 20 per cent higher, reusing the owner's
entry byte for byte, and sent it as a replacement.

| | via sponsor 1 | via sponsor 2 |
|---|---|---|
| $E$ | `0xa9979799…` | `0xa9979799…` |
| owner's entry | identical bytes | identical bytes |
| sig hash | `0x57888245…` | `0xf3ba39e1…` |
| tx hash | `0x86face08…`, replaced | [`0xffb40279…`](https://dora.privacy.ethrex.xyz/tx/0xffb402794317f1adc6617a60fd084b1d2f60677627a4003106f1af4095482d01), **mined** in block 320,282, payer sponsor 2 |

**B. Refusals, simulated against the chain.** Refused:
- a `DEFAULT` frame inserted, or appended;
- the transfer amount changed;
- **the pay frame naming the account itself**;
- the account paying on $E$. The node also rejected this one when it was sent: "validation-prefix
  simulation failed".

**C. What it costs in `VERIFY`.**

| `VERIFY` over | Execution gas |
|---|---:|
| the canonical sig hash, the account paying | [351](https://dora.privacy.ethrex.xyz/tx/0xb464883d25461d6b4ec68a4e6bf855264f6972155321053bde4bc9f94148b247) |
| $E$, three frames (one 68-byte transfer) | [1,974](https://dora.privacy.ethrex.xyz/tx/0x34ae87b165ac15ca705fbb9eb513bf7dd8d3482d35271ea9faa7393621bb3d58) |
| $E$, six frames (four 68-byte transfers) | [3,207](https://dora.privacy.ethrex.xyz/tx/0x9b4fd03bfa47ebf7a5d46605ed8a65ad0af1dbe80ab6918447b406c477011cc5) |

That is about 411 gas per added 68-byte `SENDER` frame. Experiment 23's flat layout cost 2,914 for
six frames with 464 bytes of data. EIP-712 adds one `KECCAK256` per frame and three overall, a few
hundred gas. Everything here is far below `MAX_VERIFY_GAS`.

## Findings

**A. A wallet that knows nothing about frames can authorize a sponsored frame transaction today.**
The owner's entry came out of `eth_signTypedData_v4`, re-encoded as `yParity ‖ r ‖ s`. The
protocol's `ecrecover` over the explicit `msg` accepted it, and the transaction was mined with
whichever payer landed it. That is a migration path that needs no wallet change beyond displaying
the typed data honestly. It is also why the draft makes that display a MUST: the same interface
carries permit phishing.

**B. The payer's choices reach further than the payer's frame.**
- **The relay can name the sender as payer.** $E$ does not change, so only the account stops it.
  An account that approves `PAYMENT` because "a valid owner entry exists", without requiring that
  entry to cover the fees, is drained at whatever fees the relay states. The draft's first account
  rule forbids approving payment on $E$, from any frame.
- **EIP-8250 charges a keyed nonce's first use to the frame that approves payment.** The pay
  frame's state limit must stay open, because the payer has to budget it. The keyed-nonce vector
  needed 195,840 state gas in the pay frame, and the account could not have supplied it.
- **Execution can read every open field.** The fees, the pay frame, the signature list and the
  sig hash are all readable by the sender's frames. A token fee computed from `max_cost` lets a
  payer that is also the builder raise the tip, pay it to itself and collect more tokens. The draft
  puts amounts in frame data.

**C. Experiment 23's layout had a gap: blobs.** It covered every frame but not
`blob_versioned_hashes`, which `BLOBHASH` exposes to every frame. A relay could have swapped the
blobs under a sender frame that posts them. The `blob-swapped` case is refused now.

**D. $E$ is the operation's identity, and the sig hash is not.** Across the two payers, the sig
hash and the transaction hash both changed and $E$ did not. The draft gives wallets an algorithm:
watch the nonce, recompute $E$ of whatever consumed it. Contracts that want an operation id should
recompute $E$ rather than read `TXPARAM(0x08)`.

## What the draft does not propose

- **A protocol execution hash.** A reserved `msg` value meaning "the execution hash" would let plain
  EOAs sign execution-only. It would also be cheaper and visible to RPCs. But it is a second
  canonical hash in the protocol, fixed forever, for a use not yet shown at scale. The explicit
  `msg` is the extension point EIP-8141 already has, and an ERC can be versioned.
- **Pinning the payer.** No attack on the sender depends on who pays, and pinning it removes the
  replacement.
- **Moving fees out of the canonical hash.** A self-paying account would then pay a tip the relay
  chose (experiment 23, B).

## Run

```bash
npx vitest run experiments/27-execution-digest
npx tsx experiments/27-execution-digest/vectors.ts           # regenerates vectors.json and ethrex/cases.txt
npx tsx experiments/27-execution-digest/example-digest.ts all # testnet: setup, A, B, C
# ethrex, from a checkout at c94964843d:
cp experiments/27-execution-digest/ethrex/exp27_execution_digest.rs crates/blockchain/tests/
EXP27_CASES=$PWD/.../ethrex/cases.txt cargo test -q --release -p ethrex-blockchain \
  --features ethrex-crypto/default --test exp27_execution_digest -- --nocapture
# kohaku-rs, branch experiment/frames:
cargo test -p kohaku-frame-kit --test execution_digest
```

The five mined transactions are fixtures in `test/fixtures/chain/`. They re-encode to their hashes,
their signatures recover over this repository's sig hash, and the gas model settles them to their
receipts.
