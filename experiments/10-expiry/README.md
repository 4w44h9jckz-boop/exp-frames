# 10 — The expiry verifier frame

EIP-8141 lets a transaction carry a deadline. The deadline sits in a `VERIFY` frame aimed at the
predeployed expiry verifier (`0x…8141` on this testnet). This is the only place the validation
prefix may read `TIMESTAMP`. ERC-4337 offers the same thing through `validUntil` in the account's
or paymaster's validation data. Here it is a protocol frame that the mempool understands.

| Frame | Mode   | Flags                         | Target          | Data                    |
| ----- | ------ | ----------------------------- | --------------- | ----------------------- |
| 0     | VERIFY | `0`                           | EXPIRY_VERIFIER | deadline, 8 bytes, BE   |
| 1     | VERIFY | APPROVE_EXECUTION_AND_PAYMENT | Null (sender)   |                         |
| 2     | SENDER | -                             | recipient       | value                   |

The verifier's 27-byte runtime reverts unless `len(calldata) == 8` and
`block.timestamp <= deadline`. A revert in a `VERIFY` frame invalidates the whole transaction, so an
expired transaction cannot be included and nobody pays for it.

## Run

```bash
npx tsx experiments/10-expiry/expiry.ts     # A-D: mined, boundary, past deadline, look-alike frame
npx tsx experiments/10-expiry/negative.ts   # 19 shapes: simulated, then sent
npx tsx experiments/10-expiry/pool.ts       # can a transaction wait in the pool past its deadline?
```

The scripts derive two senders from `PRIVATE_KEY` (labels `late` and `control`) and fund them from
it once.

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`, 6 s slots)

### A. A deadline two minutes out

[`0xefb6d408…`](https://dora.privacy.ethrex.xyz/tx/0xefb6d408ccbe651393c469e15918f7e09d8e923f6feb1a7eae90d76b178b0dfa):
the expiry frame used **3,051** execution gas. Of that, 3,000 is the cold account access to
`0x…8141`, charged at frame entry, and 51 runs the code. The ethrex divergence ledger states the
charge applies even when a client evaluates the deadline directly ("protocol-defined evaluation is an
optimization, never a discount"). The
transaction settled at **21,089**, which is its calldata floor.

| | intrinsic | execution | floor | `gasUsed` |
|---|---|---|---|---|
| with the expiry frame (mined) | 17,381 | 3,251 | 21,089 | **21,089** |
| the same transaction without it (gas model) | 16,826 | 200 | 20,102 | 20,102 |

In a transfer this small, execution hides under the calldata floor, so the deadline costs only the
**987** gas its bytes add to the floor. In a transaction bound by execution it would cost
3,051 + 555 intrinsic (the 475 per-frame cost plus its calldata).

### B. Deadlines near the head

Each transaction was built against the latest block and sent at once. Blocks come every 6 s.

| deadline − head timestamp | simulation | `eth_sendRawTransaction` | outcome |
|---|---|---|---|
| 0 s | valid | accepted, hash returned | **dropped at the next block, never mined** |
| 3 s | valid | accepted | **dropped, never mined** |
| 5 s | valid | accepted | **dropped, never mined** |
| 6 s | valid | accepted | mined at `block.timestamp == deadline` ([`0x96cdac11…`](https://dora.privacy.ethrex.xyz/tx/0x96cdac1117ad36bb7800c649a19a5ce9ccecda98955d7a3711df0df4f6e860db)) |
| 7 s | valid | accepted | mined, 1 s to spare |
| 12 s | valid | accepted | mined in the next block |

### C. A deadline already past

`head − 1`: the simulation says `validation prefix frame reverted`, and `eth_sendRawTransaction`
refuses with `Frame transaction expiry deadline has passed`.

### D. A look-alike after the prefix

[`0x85b55048…`](https://dora.privacy.ethrex.xyz/tx/0x85b550481cdd8f71ae6f18b434cae6806170de19e6a3b48aaf22f9a98d393c3d):
a `DEFAULT` frame calls the same contract with a past deadline after the self-verify. It is not an
expiry verifier frame, which must be `VERIFY` mode. The frame fails (`FAILURE`, 3,056 gas), the
transaction is mined, and the sender pays. A deadline only protects the sender inside the validation
prefix.

### Shapes (`negative.ts`)

| Case | Simulation | `eth_sendRawTransaction` |
|---|---|---|
| baseline `[expiry, self_verify, transfer]` | valid | accepted, mined ([`0xa9074f8f…`](https://dora.privacy.ethrex.xyz/tx/0xa9074f8fb8b467261d6fc38e8f46e28cad685533b8407c77af408679456eeb07)) |
| deadline $2^{64}-1$ | valid | accepted, mined ([`0x045fb58b…`](https://dora.privacy.ethrex.xyz/tx/0x045fb58b1c52183b3869d764ac5deebf697dd835d9cacfe2ef54b8283a24f723)) |
| flags = `APPROVE_PAYMENT` | invalid | `expiry verifier frame must have flags == 0` |
| flags = `APPROVE_EXECUTION` | invalid | same |
| value = 1 wei | invalid | `non-zero value only allowed in SENDER mode` |
| `limits.state = 1` | invalid | `expiry verifier frame must have state_gas_limit == 0` |
| data of 7, 9 or 0 bytes | invalid | `expiry verifier frame data must be 8 bytes` |
| deadline 0 | invalid (prefix reverted) | `Frame transaction expiry deadline has passed` |
| two expiry frames | invalid | `Frame 1: more than one expiry verifier frame` |
| expiry after `self_verify` | invalid | `prefix structure is invalid: frame 1: expiry verifier frame must be the first frame` |
| expiry as the last frame | invalid | same, frame 2 |
| execution limit 3,000 or 3,050 | invalid (prefix reverted: out of gas) | refused |
| execution limit 3,051 | valid | accepted, mined ([`0x7d3e237f…`](https://dora.privacy.ethrex.xyz/tx/0x7d3e237f2256863a62aa5efa335e8d8ef6cb97db83fb09624db1317d88190b0b)) |
| `SENDER` frame to the verifier, deadline 0, after the prefix | valid | accepted, mined with that frame `FAILURE` ([`0x2c817111…`](https://dora.privacy.ethrex.xyz/tx/0x2c8171116f1f5171e33da5b045cc90b49d8ee44b69b8afd941f9a09f498636fb)) |
| `DEFAULT` frame to the verifier, deadline 0, first | invalid (prefix reverted) | refused |
| `DEFAULT` frame to the verifier, future deadline, first | invalid (`DeployInstalledNoCode`) | refused: a leading `DEFAULT` frame is read as a deploy frame |

### Waiting in the pool (`pool.ts`)

To see the pool drop a transaction "at any point" its deadline passes, the transaction first has to
wait there. Both obvious ways to make it wait are refused at admission:

| Attempt | `eth_sendRawTransaction` |
|---|---|
| `maxFeePerGas` = base fee − 1, with and without a deadline | `validation-prefix simulation failed: Insufficient max fee per gas` |
| `nonce_seq` one ahead of the account, with and without a deadline | `validation-prefix simulation failed: Nonce mismatch: expected n, got n+1` |

ethrex simulates the prefix against the head before it admits a frame transaction, so its pool holds
only frame transactions that could go in the next block. There are no queued or underpriced ones.
A transaction can wait past its deadline only between admission and the next block, and that is case B.

## Observations

1. **The deadline is inclusive.** A block whose timestamp equals the deadline includes the
   transaction, as the runtime code says: it reverts only if `block.timestamp > deadline`.
2. **Admission checks the head; inclusion happens a slot later.** A deadline in
   `[head, head + slot)` is accepted and given a hash, then dropped at the next block with no receipt
   and no error. This conforms to the EIP, which drops a transaction when its deadline is behind
   "the node's view of the current block timestamp". It is still a silent drop of the kind the `aa`
   repository found for pay frames at an exact gas limit. A wallet should set
   `deadline >= head + slot` plus a margin, and treat "accepted" as provisional until a receipt
   arrives.
3. **What the frame costs.** 3,051 execution gas, nearly all of it the cold access to `0x…8141`.
   In calldata-bound transfers that hides under the floor, and the deadline adds about 1,000 gas.
   A frame budget of 3,050 or less halts, which makes the transaction invalid. The library's default
   of 5,000 has room to spare.
4. **The node checks shape before it simulates.** All four protocol rules (flags, value, state budget
   and 8-byte data) and the at-most-one rule are refused with specific messages, and so is the
   mempool's first-frame-only rule. Rejected transactions cost nothing: none of them was ever in the
   pool.
5. **Only the prefix protects.** The same contract called from a `DEFAULT` or `SENDER` frame after
   payment is approved is an ordinary call. Its revert fails one frame, and the payer still pays. A
   leading `DEFAULT` frame is taken for a deploy frame.
6. **One deadline per transaction, and only an upper bound.** The rules allow one expiry frame, and it
   must come first. A sponsor that wants its own expiry has to agree on the same one; it sees the
   deadline because the sig hash commits to it. There is no `validAfter`: a "not before" check needs
   `TIMESTAMP` in the prefix, which is banned, so it can only run after payment is approved, at the
   payer's risk. ERC-4337's `validAfter` has no frame equivalent. Experiments on subscriptions and
   session keys have to work around this.

   *Amended after experiment 19.* This holds for the EIP and not for ethrex. The EIP allows
   `TIMESTAMP` only in an expiry verifier frame, and a frame qualifies when its target is
   `0x8141`. ethrex allows it whenever the code running is the verifier's, at any call depth. An
   account's own VERIFY can therefore `STATICCALL` the verifier and require it to **revert**,
   which passes only once `block.timestamp > deadline`: a `validAfter`. Experiment 19 (probe 30)
   showed it end to end. The transaction was refused before its time, then mined after it. Code
   that relies on this is not portable to a client that follows the EIP's wording.
