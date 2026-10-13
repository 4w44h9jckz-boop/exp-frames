# 22 — Four clients, one chain: what frames-devnet-0 agrees on

Experiments 01 to 21 ran on one client, ethrex, on the Hegota testnet. ethpandaops'
frames-devnet-0 runs four execution clients on one chain:
- geth `v1.17.6-unstable-8f5271e4`;
- Nethermind `v2.1.0-unstable+3c210d3c`;
- reth `v2.5.2-0f07d37`;
- ethrex `v23.0.0-frames-devnet-0-52c2e626`.

All four sit behind one eRPC balancer, which pins a request to one of them on request. The chain
is EIP-8141 at `b75cbe61` alone, without EIP-8250 or EIP-8272. Its envelope therefore has 7
fields, with a plain `nonce` where Hegota has `nonce_keys` and `nonce_seq`; the tooling speaks
both since `9bcc0d2`.

The test account has no funds on this chain: its faucet takes a PoW claim behind a captcha, which
is for a person to solve. So this experiment asks what four clients can be asked without spending
anything:
1. **The chain** ([`observe.ts`](observe.ts)). Do the four agree on its blocks? Does this
   repository's encoder, signature hash and gas model agree with every frame transaction any of
   them built? Which shapes of transaction does the devnet's traffic cover?
2. **Admission** ([`admission.ts`](admission.ts)). 49 transactions, each sent to each client on
   its own. Each breaks one rule (an encoding, a static constraint, a signature check, the expiry
   frame, a public mempool rule) or no rule but funds. Which rule does each client name, and in
   what order does it check them?
3. **The validation prefix's caps** ([`caps.ts`](caps.ts)). A bisection of each client's
   `MAX_VERIFY_GAS` and `MAX_VERIFY_STATE_GAS`.

The raw outputs are in [`results/`](results).

## Run

```bash
npx tsx experiments/22-cross-client/observe.ts 200    # 200 blocks, about 10 minutes
npx tsx experiments/22-cross-client/admission.ts      # 49 probes x 2 fee levels x 4 clients
npx tsx experiments/22-cross-client/caps.ts
```

Every probe sender is a key derived from a public string (`exp-frames/22 admission probe ...`).
The scripts stop if any of them holds a balance, because then the probes would no longer be
refusals.

### Asking one client, and only that one

`makeClient(FRAMES_DEVNET_0_RPC_URL, 'reth')` sends eRPC's `X-ERPC-Use-Upstream: *reth*` and
`X-ERPC-Skip-Cache-Read: true`. The first run of `observe.ts` showed that this is not enough.
eRPC merges identical requests that are in flight at the same time, and answers all of them from
whichever upstream served the first, whatever each one asked for. Four concurrent pinned
`eth_getBlockByNumber` calls for one block came back from one node, which made the heads check
compare a client with itself. The `x-erpc-upstream` response header names the node that
answered. So since tooling `68929f9`, a pinned client refuses an answer from another node, and
viem retries the request alone. The scripts here also ask the clients one at a time.

## Results (2026-10-08, blocks 99,163 to 99,434)

### 1. The chain

[`results/observe-2026-10-08.md`](results/observe-2026-10-08.md)

**Heads.** At each of 50 consecutive heights, all four clients served the same block hash, the
same state root and the same receipts root.

**Conformance.** In 200 blocks, the four clients built 48 to 55 blocks each. Every frame
transaction in them passed three checks:
- re-encoded by this repository's plain envelope, it gives its hash;
- every SECP256K1 entry recovers, over this repository's signature hash, to its signer;
- its receipt's `gasUsed` equals this repository's settlement of its frame receipts.

| Built by | Blocks | Frame txs | Re-encode to hash | Signatures recover | `gasUsed` settles |
|---|---|---|---|---|---|
| ethrex | 48 | 485 | 485 | 485 | 485 |
| geth | 49 | 490 | 490 | 490 | 490 |
| nethermind | 55 | 545 | 545 | 545 | 545 |
| reth | 48 | 480 | 480 | 480 | 480 |

The six fixtures in the tooling's `test/fixtures/chain/` are from this chain: one of each shape,
built and served by different clients.

**Coverage.** The agreement covers less of the EIP than the counts suggest. Every one of the 2,000
transactions is spamoor's `frametx` scenario, in one of five shapes:

| Shape | Count |
|---|---|
| `VERIFY/3 SENDER/4 SENDER/4 SENDER [SECP256K1]` | 667 |
| `VERIFY@expiry VERIFY/3 SENDER [SECP256K1]` | 334 |
| `VERIFY/3 SENDER [SECP256K1]` | 333 |
| `VERIFY/3 SENDER+value [SECP256K1]` | 333 |
| `VERIFY/3 SENDER SENDER SENDER SENDER [SECP256K1]` | 333 |

Every one is self-relayed: an EOA's default code approves execution and payment. Of the 6,669
frame receipts in 200 blocks, 333 frames failed and 333 were skipped, all in the atomic-batch
shape. All four clients
derive the transaction-level `status` the same way (0 when any frame failed), on the two such
transactions compared. The devnet's traffic has none of the following:
- a payer other than the sender (a sponsor or a paymaster);
- a P256 or ARBITRARY entry, or an explicit `msg`;
- a DEFAULT frame, so neither a deploy frame nor a `post_op`;
- a contract account, and with it any introspection opcode;
- state gas (every frame's `limits.state` is 0);
- a blob.

Each of those ran on Hegota in experiments 02 to 21, on ethrex alone. That four clients agree on
them is not yet tested anywhere.

### 2. Admission

[`results/admission-2026-10-08.md`](results/admission-2026-10-08.md), with every refusal
verbatim.

Each probe was sent at two fee levels:
- **Priced**: tip 1 gwei, max fee 1 gwei plus twice the base fee, which nobody can pay.
- **Free**: every fee zero, so that `max_cost` is zero. A client that checks the balance first
  then has to say what else is wrong.

`✓` means the refusal names the rule the probe breaks. Otherwise the cell says what the client
named instead:
- *prefix reverted*: the generic simulation failure;
- *decoder*: the RLP decoder refused it, which also stops the transaction;
- *sender balance*, *fee* or *gas floor*: a check that ran before the rule.

| Probe | Rule broken | geth | Nethermind | reth | ethrex | geth, free | Nethermind, free | reth, free | ethrex, free |
|---|---|---|---|---|---|---|---|---|---|
| `unfunded` | none but funds | ✓ | ✓ | prefix reverted | prefix reverted | fee | ✓ | prefix reverted | fee |
| `unfunded-sponsored` | none but funds, a default-code sponsor paying | ✓ | prefix reverted | prefix reverted | prefix reverted | fee | **accepted** | prefix reverted | fee |
| `new-account-no-state` | APPROVE's new-account charge exceeds the frame's state budget | sender balance | prefix reverted | prefix reverted | prefix reverted | fee | prefix reverted | prefix reverted | fee |
| `cancel` | none but funds: one VERIFY frame, `max_gas` 19,435 | **gas floor** | ✓ | ✓ | ✓ | **gas floor** | ✓ | ✓ | fee |
| `keyed-envelope` | 7 fields, not EIP-8250's 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `nonce-leading-zero` | minimal RLP integers | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `empty-list` | the payload's fields | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `wrong-chain-id` | `chain_id` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | fee |
| `nonce-2^64` | `nonce < 2**64` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `no-frames` | `0 < len(frames)` | gas floor | ✓ | ✓ | ✓ | gas floor | ✓ | ✓ | ✓ |
| `65-frames` | `len(frames) <= MAX_FRAMES` | sender balance | decoder | ✓ | ✓ | fee | decoder | ✓ | ✓ |
| `mode-3` | `mode < 3` | sender balance | ✓ | decoder | ✓ | fee | ✓ | decoder | ✓ |
| `flags-8` | `flags < 8` | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `value-in-verify` | value only in SENDER frames | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `value-in-default` | value only in SENDER frames | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `approve-execution-elsewhere` | execution scope only on `tx.sender` | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `atomic-last` | an atomic flag needs a next frame | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `atomic-into-verify` | no VERIFY frame in a batch | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `scope-in-batch` | no approval scope in a batch | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `gas-over-cap` | intrinsic + execution within EIP-7825's cap | sender balance | ✓ | ✓ | **prefix reverted** | fee | ✓ | ✓ | fee |
| `gas-over-2^64` | total frame gas `< 2**64` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `blob-fee-no-blobs` | blob fee zero without blobs | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `blob-hash-version` | versioned hash starts `0x01` | **unsupported** | decoder | decoder | ✓ | **unsupported** | decoder | decoder | ✓ |
| `scheme-3` | known schemes only | sender balance | ✓ | decoder | ✓ | fee | ✓ | decoder | ✓ |
| `arbitrary-with-signer` | ARBITRARY has no signer | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `msg-31-bytes` | `msg` empty or 32 bytes | sender balance | decoder | decoder | ✓ | fee | decoder | decoder | ✓ |
| `msg-zero` | `msg` not 32 zero bytes | sender balance | ✓ | decoder | ✓ | fee | ✓ | decoder | ✓ |
| `secp-high-s` | low s | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `secp-v-27` | v is 0 or 1 | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `secp-r-zero` | `0 < r` | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `secp-other-signer` | `ecrecover` is the signer (the entry the default code reads) | sender balance | ✓ | **prefix reverted** | ✓ | fee | ✓ | **prefix reverted** | ✓ |
| `unused-secp-wrong` | the same, on an entry no frame reads | sender balance | ✓ | **prefix reverted** | ✓ | fee | ✓ | **prefix reverted** | ✓ |
| `unused-p256-wrong` | `P256VERIFY`, on an entry no frame reads | sender balance | ✓ | **prefix reverted** | ✓ | fee | ✓ | **prefix reverted** | ✓ |
| `p256-signer-not-key` | P256 signer is `keccak(qx ‖ qy)[12:]` | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `p256-high-s` | P256 low s | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `expiry-flags` | expiry frame: `flags == 0` | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `expiry-7-bytes` | expiry frame: 8 bytes of data | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `expiry-state-gas` | expiry frame: no state gas | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `two-expiry` | at most one expiry frame | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `expiry-past` | mempool: drop a passed deadline | sender balance | ✓ | prefix reverted | ✓ | fee | ✓ | prefix reverted | ✓ |
| `expiry-second` | mempool: an expiry frame comes first | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `no-verify` | no recognised prefix | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `no-signature` | the default code needs entry 0 | sender balance | prefix reverted | prefix reverted | prefix reverted | fee | prefix reverted | prefix reverted | fee |
| `pay-before-verify` | no recognised prefix | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `verify-after-prefix` | mempool rule 8: no VERIFY after the prefix | sender balance | ✓ | ✓ | prefix shape | fee | ✓ | ✓ | prefix shape |
| `two-default-first` | mempool rule 2: one deploy frame, first | sender balance | prefix shape | ✓ | ✓ | fee | prefix shape | ✓ | ✓ |
| `verify-gas-150k` | `MAX_VERIFY_GAS` | sender balance | **sender balance** | ✓ | ✓ | fee | **sender balance** | ✓ | ✓ |
| `verify-gas-600k` | `MAX_VERIFY_GAS`, against a 500,000 cap | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `verify-state-600k` | `MAX_VERIFY_STATE_GAS` | sender balance | ✓ | ✓ | **prefix reverted** | fee | ✓ | ✓ | fee |

### 3. The validation prefix's caps

[`results/caps-2026-10-08.md`](results/caps-2026-10-08.md). The probe is one VERIFY frame
approving execution and payment, one SENDER frame and one SECP256K1 entry, which costs 2,800.

| Client | `MAX_VERIFY_GAS`: largest VERIFY limit not refused for it | so the cap is | `MAX_VERIFY_STATE_GAS`: largest not refused |
|---|---|---|---|
| geth | none refused up to 2,000,000: the balance check comes first | unobserved | unobserved, for the same reason |
| Nethermind | 297,200 | **300,000** | 500,000 |
| reth | 97,200 | 100,000 | 500,000 |
| ethrex | 97,200 | 100,000 | **none refused up to 16,000,000** before simulation |

The EIP says 100,000 and 500,000, with the signatures' verification gas counted against the
first. reth and ethrex count it. ethrex's Hegota build took 500,000 from a node flag (experiment
19), so three values of one constant are deployed: 100,000, 300,000 and 500,000.

### What the clients disagree on

**1. Nethermind admits a validation prefix of up to 300,000 gas; reth and ethrex refuse one over
100,000.** The probe's prefix had 150,000 of verification gas. Nethermind refused it only for
funds; reth and ethrex refused it for `MAX_VERIFY_GAS`. A funded transaction like it would enter
Nethermind's pool, be gossiped, and be dropped by every reth and ethrex peer. It would then land
only if a Nethermind node builds a block while holding it. This is the case EIPs PR-12301 (define
`MAX_VERIFY_GAS` as a shared mempool floor) is about. The account designs of experiments 05 to 20
fit under 100,000 (the largest, the WebAuthn passkey, verifies in 15,542), so none of them would
split the network. A post-quantum verifier in the EVM would.

**2. geth reads the sender's balance before it checks any frame rule.** Priced, geth refused 40 of
49 probes with `insufficient funds for gas * price + value`, including every statically invalid
transaction and every invalid signature. Free, it refused the same 40 with `transaction gas
price below minimum: gas tip cap 0, minimum needed 1`. The order its refusals reveal:
1. decoding, the chain id, and a gas floor (point 3);
2. the minimum tip;
3. the balance;
4. then, unobservably without funds, the frame rules.

The EIP's Security Considerations ask a mempool to "perform all available structural and
stateless checks before sender-state access", because a frame transaction names its sender rather
than recovering it. geth looks up the named sender with no signature checked. The sponsored probe
gets the same refusal. The sponsor is a default-code EOA, and both accounts are empty, so this run
cannot tell whose balance geth reads. A funded sponsor would settle it.

**3. geth refuses a valid one-frame cancel for a 24,000 gas floor that the EIP does not have.**
`cancel` is `[VERIFY(approve execution and payment)]` with one SECP256K1 entry. It bumps the
nonce and does nothing else, which is how a wallet cancels a pending transaction. Its calldata
floor binds, so its `max_gas` is 19,435. That is valid under EIP-8141 for any existing, funded
EOA. geth refuses it with `insufficient gas for floor data gas cost: gas 19435, minimum needed
24000`. The 24,000 is the same for the zero-frame probe, whose `max_gas` is 18,960, so it does
not come from the transaction's data. The three other clients refused `cancel` only because its
sender does not exist and cannot pay.

**4. geth refuses every blob-carrying frame transaction.** Its message is `transaction type not
supported: frame transaction with 1 blob hashes`. The other three decoded the probe and refused it
for its malformed versioned hash. Blobs are optional in a frame transaction and the devnet
carried none.

**5. ethrex lets two static limits reach simulation.** A transaction over EIP-7825's execution
cap, and one whose prefix budgets 600,000 state gas, both reached the validation-prefix
simulation in ethrex and failed there for funds. Nethermind and reth refused both statically.
Whether ethrex would admit either one funded is not observable here. In experiment 08, the Hegota
build of ethrex enforced the state cap.

**6. reth reports an invalid signature as a failed validation prefix.** reth gives every
cryptographically invalid entry the same refusal as an unfunded payer, `validation prefix
execution failed`. That holds for:
- a wrong secp256k1 signer;
- a wrong secp256k1 signature on an entry no frame reads;
- a wrong P256 signature on an entry no frame reads.

Its structural signature checks (high s, v, `r = 0`, a P256 key that does not hash to its signer)
are refused as such. The EIP's acceptance algorithm validates every protocol-validated signature
in step 2, before the frame structure is even analysed. reth's refusals cannot say whether it
verified the entries before simulating, but an entry no frame reads cannot make a simulation fail.
A funded probe with a bad entry no frame reads would show whether reth admits it, which would be a
transaction every other client refuses.

**7. Nethermind holds a transaction that pays nothing.** The free sponsored probe, with every fee
zero, was accepted by Nethermind
(`0xb3ac5132d562e39da7ef56efe39c9511b4bbc506dbb576a02d7112e782141010`). It is valid apart from
its fee, since an empty sponsor can pay a `max_cost` of 0. geth and ethrex require a 1 wei tip,
and reth refused it for a failed prefix. Nethermind still held it after the run and no other
client did. It cannot be included while the base fee is above zero. The free self-relayed probe
was refused by Nethermind with `insufficient funds ... transaction cost: 0`, which reads as a
zero-balance filter on the payer rather than a comparison.

**8. "The validation prefix reverted" covers too much.** Nethermind and ethrex report an unfunded
payer, an unbudgeted new-account charge and a missing signature entry identically. reth reports
those three the same way, and also a wrong signature and a passed deadline. A wallet reading the
refusal cannot tell "fund this account" from "budget 183,600 state gas for its creation" from
"sign entry 0". Each is a protocol-defined failure: the default code's revert, APPROVE's balance
revert, and APPROVE's state-gas halt. None carries a reason the client could pass on.

The decoders also differ, and the difference is harmless: a cap enforced while decoding (65
frames in Nethermind, a 31-byte `msg` in Nethermind and reth) refuses the transaction as surely as
a check after it.

### 4. The JSON

The clients agree on the chain and disagree on how to show it. Field by field, from the same
transactions ([`results/observe-2026-10-08.md`](results/observe-2026-10-08.md)): the transaction
object has 39 distinct fields across the four clients, of which 21 are not served by all four.
The receipt has 32, of which 5 differ.

| Field | geth | Nethermind | reth | ethrex |
|---|---|---|---|---|
| a frame's execution limit | `executionGas` | `executionGasLimit` | `executionGas` | `gasLimit` |
| a frame's state limit | `stateGas` | `stateGasLimit` | `stateGas` | `stateGasLimit` |
| a frame's target | `target` | `target` | `target` | `to` |
| the sender | `from` | `from` | `from` | `from` and `sender` |
| an absent signer | `"0x"` | field omitted | field omitted | `null` |
| a frame receipt's execution gas | `gasUsed` and `executionGasUsed` | `executionGasUsed` | `gasUsed` and `executionGasUsed` | `gasUsed` |
| a frame receipt's `status` | `"0x1"` | `1` | `"0x1"` | `"0x1"` |
| `gas` | `max_gas` (51,790) | sum of frame execution limits (35,000) | omitted | omitted |
| `to`, `value`, `input` | `null`, `0x0`, `0x` | `null`, `0x0`, `0x` | omitted | omitted |
| `v`, `r`, `s` | `null` | `0x0`, plus `yParity` and an empty `accessList` | omitted | omitted |
| receipt `to` | `null` | `null` | the sender | `null` |
| `blobVersionedHashes` | omitted | `[]` | `[]` | `[]` |

`gas` is the one that bites: it means two different things, by 16,790 gas on a plain transfer. A
wallet that computes a fee bound as `gas * maxFeePerGas` gets two answers. execution-apis
PR-860 and PR-907, both open, are where these get settled. Until then the tooling's
`frameTxFromJson`, `frameReceiptGas` and `frameReceiptStatus` read all four.

## What this needs funds for

Each of these needs a funded account on devnet-0. They are listed so that a person can claim
funds once and run them in one go:
- Every shape spamoor does not send, landed once and read back from all four clients: a sponsor,
  the canonical paymaster, a P256 entry, a WebAuthn ARBITRARY entry, a deploy frame, an
  explicit `msg`, introspection (experiment 18's dump), state gas, and a `post_op`.
- Whose balance geth reads for a sponsored transaction: a funded sponsor, an empty sender.
- Whether reth admits a transaction with a bad entry no frame reads, and whether ethrex admits one
  over EIP-7825's cap or `MAX_VERIFY_STATE_GAS`.
- A validation prefix between 100,000 and 300,000 gas, sent to Nethermind: whether it is
  gossiped, and whether it lands.
- Whether geth's 24,000 floor is a pool rule or a validity rule: a 19,435-gas cancel sent to
  another client, then the block that includes it, read by geth.
