---
title: Execution-Scope Digest for Frame Transactions
description: An EIP-712 digest of what an execution-only approval authorizes, so the payer and the fees can be chosen after the sender signs
author: TBD
discussions-to: TBD
status: Draft (unsubmitted; exp-frames experiment 27)
type: Standards Track
category: ERC
created: 2026-10-08
requires: 712, 8141, 8250
---

## Abstract

An EIP-8141 frame transaction may be approved by two parties: the sender's account grants
`APPROVE_EXECUTION`, and a payer grants `APPROVE_PAYMENT`. When the sender signs the canonical
signature hash, it commits to the payer's frame and to the fees as well. So a new payer, or a new
fee, means a new signature from the sender.

This ERC defines one digest, `E`, as EIP-712 typed data. It covers every frame except the payer's,
with its position, plus the number of frames, the nonce, the chain, the account and the blob
versioned hashes. A sender signs `E` as the explicit `msg` of a signature entry. The account
recomputes `E` by introspection, and approves execution on it and on nothing else. Any payer may
then complete the transaction, or replace another payer's copy, without the sender.

`E` is also a stable identifier for the operation, across every envelope that carries it.

## Motivation

EIP-8141 (master, 2026-10-08) separates the two approvals and gives signature entries an explicit
`msg` field, "an explicit 32-byte digest". Its Security Considerations section requires an
execution approval to "verify against the canonical signature hash, or otherwise constrain every
subsequent `SENDER` frame". The canonical hash is the safe choice. It is also the reason a
sponsored transaction cannot be re-priced or re-sponsored without the sender. That costs:
- **a k-of-n account**: k signers coordinate again for a fee bump or a failed sponsor;
- **a privacy design whose witness is a blind voucher**: re-signing is a second contact with the
  issuer, and that contact links the spender to the voucher;
- **a hardware or passkey signer**: another prompt, for a change that does not affect the user;
- **sponsor failover and competition**: a sponsor that goes offline, or is outbid, strands the
  operation until the sender signs again.

ERC-4337 has the same constraint, by design. Its v0.8 user operation hash is an EIP-712 hash of
`PackedUserOperation`, which includes `gasFees` and `paymasterAndData`. A 4337 user commits to the
paymaster and the fees before it signs.

Frames can do better without a protocol change, because the explicit `msg` is already there. What
is missing is a shared layout. Without one, every account invents its own digest, a wallet cannot
produce one without knowing the account, and a sponsor cannot check what it is completing. Nobody
can follow the operation once a replacement changes its transaction hash.

## Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as
described in RFC 2119 and RFC 8174.

### Definitions

- A **pay frame** is a frame with `mode == VERIFY` and
  `flags & APPROVE_SCOPE_MASK == APPROVE_PAYMENT`. Whether a frame is a pay frame depends on its
  mode and flags only.
- An **execution-only approval** is `APPROVE` with scope `APPROVE_EXECUTION` (`0x2`).
- `resolved_target` is `frame.target`, or `tx.sender` when the target is empty, as in EIP-8141.

### The digest

`E` is the EIP-712 signing hash of the following typed data.

Domain:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)

name              = "FrameExecution"
version           = "1"
chainId           = tx.chain_id
verifyingContract = tx.sender
```

Types:

```
FrameExecution(bytes32 nonceKeysHash,uint64 nonceSeq,Frame[] frames,bytes32[] blobVersionedHashes)
Frame(uint8 mode,uint8 flags,address target,uint64 executionLimit,uint64 stateLimit,uint256 value,bytes data)
```

Values:

| Field | Value |
|---|---|
| `nonceKeysHash` | EIP-8250's `nonce_keys_hash(tx)`, which `TXPARAM(0x0F)` returns. On a chain without EIP-8250, `nonce_keys_hash` of `[0]`: `keccak256(uint256(1) ‖ uint256(0))` |
| `nonceSeq` | `tx.nonce_seq` (`TXPARAM(0x01)`). On a chain without EIP-8250, `tx.nonce` |
| `frames[i]`, not a pay frame | `mode`, `flags`, `resolved_target`, `limits.execution`, `limits.state`, `value`, `data` of `tx.frames[i]` |
| `frames[i]`, a pay frame | `mode`, `flags` and `value` of `tx.frames[i]`; `target = address(0)`, `executionLimit = 0`, `stateLimit = 0`, `data` empty |
| `blobVersionedHashes` | `tx.blob_versioned_hashes` |

```
E = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(FrameExecution))
```

with `domainSeparator` and `hashStruct` as EIP-712 defines them. In particular `frames` is hashed as
`keccak256` of the concatenated `hashStruct(Frame)` values, so each frame's position and the number
of frames are part of `E`. `data` is hashed as `keccak256(data)`.

A plain EIP-8141 transaction with nonce `n` and an EIP-8250 transaction with `nonce_keys = [0]`
and `nonce_seq = n` have the same `nonceKeysHash` and `nonceSeq`. The two forms of one operation
therefore share one `E`. That is intended: `nonce_keys = [0]` is the legacy nonce.

### Accounts

An account that accepts `E`:
1. MUST NOT call `APPROVE` with a scope that includes `APPROVE_PAYMENT` on the evidence of a
   signature over `E`. This covers its own `self_verify` frame, and a pay frame whose target a
   relay has set to the account.
2. MUST recompute `E` from the transaction being validated, by `TXPARAM`, `FRAMEPARAM`,
   `FRAMEDATACOPY`, `BLOBHASH`, `CHAINID` and `ADDRESS`. It MUST compare the result with the `msg`
   of the signature entry it relies on, and MUST NOT accept `E` from calldata or frame data.
3. MUST check that entry's `scheme` and resolved signer by `SIGPARAM`, as for any explicit-`msg`
   entry. The protocol has already verified the signature over `msg` for `SECP256K1` and `P256`.
   An `ARBITRARY` entry is verified by the account over `E` in the usual way.

An account MAY accept `E` and the canonical signature hash side by side: the canonical hash when
it pays, `E` when it does not. The reference account does exactly that.

### Wallets and signers

1. A wallet MUST present a request to sign `FrameExecution` typed data as a transaction from
   `verifyingContract` on `chainId`, not as a message. It SHOULD render each pay frame as a payer
   chosen by whoever completes the transaction.
2. A wallet SHOULD include an expiry verifier frame (EIP-8141) in a transaction whose `E` it
   signs. See Security Considerations.
3. A wallet SHOULD NOT let any amount the transaction pays a payer depend on values `E` leaves
   open: the fees, the pay frame, or the signature entries. The amount belongs in frame data,
   where `E` fixes it.

### Payers and relays

A party completing a transaction from a signed `E` may set:
- the target, the limits and the data of each pay frame;
- `fees`;
- signature entries other than those the sender's account relies on.

Any other change alters `E`, and the account refuses it. A payer SHOULD recompute `E` before it
signs, to confirm the sender's entry covers the transaction it is about to pay for.

### The operation identifier

`E` identifies an operation across every transaction that carries it. Two transactions that differ
only in their payer or their fees have different signature hashes and transaction hashes, and the
same `E`.

To follow an operation, a wallet watches the sender's nonce: the selected keys under EIP-8250, or
the account nonce. When it is consumed, the wallet fetches the consuming transaction and
recomputes `E`. If the two `E` values match, this operation landed. If they do not, another
operation took the slot.

Contracts that need an identifier for the operation SHOULD recompute `E`, not read
`TXPARAM(0x08)`, which changes with the payer.

## Rationale

### What is left open, and why that is safe

The pay frame's target, limits and data, the fees and the payer's signature entries are what a
payer chooses. None of them can change what the sender's frames do:
- A `VERIFY` frame executes as a `STATICCALL`. Only `APPROVE` modifies state or the transaction
  context, and `APPROVE_PAYMENT` sets the payer and collects `max_cost` from it, not from the
  sender.
- The pay frame's limits raise `max_cost`, which the payer pays.
- Under EIP-8250, the first use of a keyed nonce charges state gas to the frame that approves
  payment. The pay frame's state limit has to stay open for that reason too: the payer budgets it.

What remains is what the sender's frames *read*. That is a Security Consideration, not part of the
digest.

### What is pinned, and why

- **Every other frame, with its position, and the number of frames.** Constraining only the
  `SENDER` frames is not enough. A `DEFAULT` frame inserted between two of them runs while the
  sender's operations are in flight. In experiment 23 a mempool observer used that to sandwich a
  swap inside the victim's own transaction, and an appended frame is still paid for by the payer.
- **A pay frame's mode, flags and value.** Today a `VERIFY` frame must carry zero value and no
  `ATOMIC_BATCH_FLAG`, and bits 3 and up are reserved. So these fields are fixed for any valid pay
  frame, and pinning them costs nothing. A later extension could give `VERIFY` frames a flag or a
  value, and `value` is "transferred from the `sender`". Pinning them now means such an extension
  cannot reach the sender through an open field.
- **The blob versioned hashes.** `BLOBHASH` returns `tx.blob_versioned_hashes[index]` in every
  frame. A `SENDER` frame that posts a blob commitment reads them, so a relay that could swap the
  blobs could swap what the sender posts. The digest of experiment 23 left them out; this one does
  not.
- **The resolved target, not the raw one.** `FRAMEPARAM(0x00)` returns only the resolved target,
  and an empty target and an explicit `tx.sender` execute identically.
- **The nonce as a hash and a sequence.** EIP-8250 exposes the keys only as
  `nonce_keys_hash` (`TXPARAM(0x0F)`), their count and the first key. Mapping the plain nonce to
  `[0]` gives both envelopes one layout.

### Why the signature list is excluded

The sender's entry cannot sign itself. The payer's entry signs the canonical hash after the
sender's entry exists, and that canonical hash covers the sender's explicit-`msg` entry
byte for byte. Leaving the list out is forced. Its cost is that execution must not read it (see
Security Considerations).

### Why execution only

A frame that also approves payment pays for whatever fees the transaction states. If it signed
something that left the fees open, whoever relays the transaction would set the tip, and the
account would pay it. Experiment 23 measured this against an account that did not commit to the
fees: relayed at a 10 gwei tip instead of the 1,000 wei its owner signed, it paid 0.0011865 ETH,
about ten million times what its owner signed for. So the rule is asymmetric. The canonical hash when
the account pays, `E` when it does not.

### Why EIP-712

- Wallets that know nothing about frame transactions can produce the signature today, through
  `eth_signTypedData_v4`, which handles arrays of structs. In experiment 27, an unmodified viem
  account signed `E` this way, and the protocol's `ecrecover` over `msg` accepted the entry.
- Domain separation comes with it. `E`'s preimage starts with `0x1901`, the canonical hash's with
  the transaction type `0x06`, and EIP-191 personal messages with `0x19 0x45`. Chain and account
  are in the domain.
- ERC-4337 v0.8 made the same choice for the user operation hash.

The cost over a flat encoding is one more `KECCAK256` per frame and three overall, a few hundred
gas for a typical transaction.

### Alternatives considered

- **A flat byte layout** (experiment 23's `E`). Slightly cheaper, but no wallet can sign it
  without frame-specific code, and it needs its own domain separation.
- **An execution hash defined by the protocol**, for example a reserved `msg` value meaning
  "`compute_execution_hash(tx)`". It would let the default code, and so plain EOAs, sign
  execution-only. It would be cheaper, and RPCs could return it. It would also be a second
  canonical hash in the protocol, fixed forever, for a use that has not been shown at scale. The
  explicit `msg` field is the extension point EIP-8141 already provides, and an ERC can be revised
  by version. If most sponsored traffic comes to use `E`, the default code could gain an `E` path
  in a later fork. That decision belongs to evidence this ERC would produce.
- **Pinning the payer.** No attack on the sender depends on who the payer is, and pinning it
  removes the replacement this ERC exists for. A sender that wants a particular payer can have its
  account check the pay frame's target directly, outside `E`.
- **Moving the fees out of the canonical hash.** That would give fee freedom to every account,
  including the self-paying ones, which is the relay-sets-the-tip result above. The accounts that
  need fee freedom are the ones that do not pay, and `E` gives it to them.

## Backwards Compatibility

None. An account opts in by accepting `E`; nothing else changes.

## Test Cases

In exp-frames, branch `exp/27-execution-digest`, directory `experiments/27-execution-digest/`:
- `vectors.json`: ten transactions with their domain separators, struct hashes and `E`, each with
  the raw signed transaction. The shapes are a sponsored transfer, an expiry frame, an atomic
  batch, a deploy frame, two keyed nonces, nonce 7 on key `[0]`, value and `DEFAULT` frames, two
  blobs, twelve frames with data of 0 to 1,000 bytes, and a self-paying transaction.
- `ethrex/cases.txt`: nineteen signed transactions, with the verdict the reference account must
  give inside ethrex's validation-prefix simulation. Eleven are accepted, including the same owner
  entry under another payer and other fees, and an empty target written out as the sender. Eight
  are refused: a frame inserted, a frame appended, a state limit lowered, a target changed, a blob
  swapped, another account with the same owner, the account named as its own payer, and
  self-payment on `E`.

## Reference Implementation

- `digest.ts`: `E` through viem's EIP-712 encoder, and by hand from the layout above.
- `ExecutionScopeAccount.yul`: an account that accepts `E` for execution-only approval and the
  canonical hash for self-payment (617 bytes of code, then the owner).
- kohaku-rs, branch `experiment/frames`, `crates/frame-kit/src/digest.rs`: `E` through alloy's
  EIP-712 derive.

## Security Considerations

### A signed `E` is a bearer instrument until the nonce moves

Anyone holding the transaction and the sender's entry can land it, with any payer, at any fee and
at any time, until the nonce it names is consumed. Two things bound that:
- **Expiry.** An expiry verifier frame is pinned by `E` like any other frame, so a deadline signed
  in cannot be removed.
- **Cancellation.** The sender consumes the nonce with any other transaction: one it pays for
  itself over the canonical hash, or another `E`. Under EIP-8250, consuming any selected key
  cancels.

### What the sender's frames read, the payer may have chosen

The fees (`GASPRICE`, `TXPARAM(0x03)` to `TXPARAM(0x06)`), the pay frame (`FRAMEPARAM`,
`FRAMEDATALOAD` and `FRAMEDATACOPY` on its index), the signature list (`SIGPARAM`, `SIGDATACOPY`,
`TXPARAM(0x0B)`) and the signature hash (`TXPARAM(0x08)`) are all readable by the sender's frames,
and all open in `E`. A frame that pays the payer an amount computed from any of them lets the
payer set the amount.

For example, a fee in tokens computed from `max_cost` lets a payer raise the tip, pay it to itself
as the block's builder, and collect more tokens. Amounts belong in frame data. Experiment 23's
`PayThePayer` reads the pay frame's target to decide whom to pay. It is safe because the amount is
fixed in its data.

### The relay chooses the payer, and may choose the sender

The pay frame's target is open, so a relay can name the account itself. `E` does not change. Only
rule 1 of the account section stops the account from paying, at whatever fees the relay states.
Any account that approves `APPROVE_PAYMENT` because "a valid owner entry exists", without
requiring that entry to cover the fees, is drained this way. The reference account refuses
`PAYMENT` alone outright, and refuses `E` for `EXECUTION_AND_PAYMENT`.

### Typed-data phishing

A signature over `E` authorizes arbitrary frames as the account, exactly as a transaction
signature does, but it arrives through the typed-data interface that permit phishing already
abuses. That is why wallet rule 1 is a MUST.

### Exposure before inclusion

`E` stops frames from being inserted into the sender's transaction. It does not stop ordinary
front-running by other transactions. Handing a signed `E` to several sponsors widens the set of
parties who see the operation before inclusion. EIP-8141's *Cross-frame Data Visibility During
Validation* already applies to every payer; `E` multiplies the payers.

### Deploy frames

A deploy frame is pinned. If an observer front-runs the deployment, which EIP-8141's *Deploy
Frame Front-Running* expects, the transaction must be re-signed without the deploy frame, as it
would be under the canonical hash. A wallet can sign both variants up front; they share a nonce,
so at most one lands.

### Atomic batches

`ATOMIC_BATCH_FLAG` is invalid on `VERIFY` frames and requires a non-`VERIFY` successor, so a pay
frame can neither join a batch nor end one. Every other frame's flags are pinned. An inserted frame
cannot join or split a batch, because insertion changes `E`.

### Replay

Chain and account are in the domain, the nonce keys and sequence in the message, and the layout
version in the domain's `version`.
