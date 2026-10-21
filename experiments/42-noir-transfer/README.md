# 42 - A private transfer on Aztec's note and nullifier model, proved in Noir, checked in a frame

Post 22 says of Aztec: "Aztec's private functions are proved on the user's device, so its client
proof becomes a dependency frame, its fee a `VERIFY` frame paid from the pool or a blind ticket,
and its public functions plain `SENDER` frames on L1". This experiment writes one private function,
a transfer of notes, in Noir, proves it on the device, and asks whether a frame can check the
proof.

The first question: **which proof systems can Noir's toolchain verify on the EVM, and what does
each verifier cost** against the testnet's 500,000 gas of `VERIFY` and EIP-8141's 100,000?

## Written before any run

**The claim.** Take away Aztec's rollup and a private function still works on L1 through frames.
The user's device makes the proof, a `VERIFY` frame checks it, and the transaction carries every
nullifier the function spends as one of its nonce keys. The protocol then refuses a second spend
by itself, and no sequencer has to order the spends.

**What would refute it:**
- every proof system that Noir's toolchain can produce a verifier for costs more to check than
  the testnet gives a `VERIFY` frame;
- or the chain accepts a transaction that reuses a nullifier, either into the mempool or into a
  block.

**This entry is done when:**
- the transfer is proved on the device and its verifier is deployed on the testnet;
- the verifier's gas, for each proof system Noir's toolchain can verify on the EVM, is recorded
  against both budgets;
- a transfer transaction carries one EIP-8250 nonce key per nullifier, ready for the mempool's
  admission and the end-to-end run, which are not this entry's.

**The plan, fixed before the run:**
- Noir and Barretenberg are used unmodified, pinned in `pins.json`: the Noir compiler and executor at
  v1.0.0-rc.6, Barretenberg's `bb.js` at aztec-packages v5.2.1. Their licences are recorded beside
  each pin.
- The circuit is this repository's, on Aztec's model: a note hash commits to an owner, a value and
  randomness; a nullifier is derived from the note hash and the owner's nullifier key, so only the
  owner can spend a note and each note has one nullifier; the note hashes sit in an append-only
  tree whose root the proof opens against. The transfer spends two notes and creates two, and
  conserves value. Hashing is Poseidon2, as Aztec's is.
- Barretenberg's EVM targets are measured: UltraHonk with zero knowledge (`evm`) and without
  (`evm-no-zk`). Each verifier is compiled, deployed, and called on a real proof; its gas is read on
  the testnet.
- If neither fits the budget, other proof systems Noir's circuits can be compiled to are looked for
  and measured the same way, and the search is recorded whatever it finds.
- The transaction: the verifier called from a `VERIFY` frame, with the two nullifiers as its
  EIP-8250 nonce keys.

## Results, first part: Barretenberg's verifiers

Run on 2026-10-21 against the testnet (chain 8141). The verifiers and their libraries were deployed
in `0xb591cc03ec47bbe9288376ae795401641a4e61e3dfb237aa2224736a325a9ac8`, at block 490,958. The
records are `build/summary.json` (proving) and `verifiers.json` (the chain), and `rebuild.test.ts`
reads both back.

**The circuit.** `transfer.nr` spends two notes from a depth-32 tree and creates two, with seven
public inputs: the root, two nullifiers, two output note hashes, the fee and a context word. UltraHonk
sizes it at $2^{14}$ rows.

**Proving**, in `bb.js` under Node on this container with 8 threads, from `build/drive.mjs`:

| target | proving | proof | verified natively |
|---|---:|---:|---|
| `evm` (zero knowledge) | 1,106 ms | 8,000 B | yes |
| `evm-no-zk` | 468 ms | 7,072 B | yes |

**Verifying on the testnet.** Each verifier is called on its proof by `GasMeter.yul` under
`eth_call`, which times the `STATICCALL` and nothing else; the same call with one public input
changed is refused by both.

| target | verify gas | testnet `VERIFY` (500,000) | EIP-8141 `VERIFY` (100,000) | contract + libraries |
|---|---:|---:|---:|---|
| `evm` | 3,494,968 | 7.0 times over | 35 times over | 18,240 B + 7,972 B + 6,151 B |
| `evm-no-zk` | 1,782,522 | 3.6 times over | 18 times over | 17,186 B + 7,972 B |

Not counted: the calldata. The proof is 7 to 8 KB, and it is charged as intrinsic gas outside the
frame's validation budget.

**Neither of Barretenberg's EVM targets fits either budget**, so the plan's search for other proof
systems starts.

**No pairing-based proof fits EIP-8141's 100,000, on either curve the EVM has.** A verifier
that ends in a pairing check needs at least two pairs:

- On BN254, EIP-1108 prices $k$ pairs at $34{,}000k + 45{,}000$, so two pairs cost 113,000.
- On BLS12-381, EIP-2537 prices them at $32{,}600k + 37{,}700$, so two pairs cost 102,900.

Both exceed 100,000 before any transcript, input or calldata is paid for. Hash-based proofs are
dearer still on the EVM. The 100,000 question is therefore settled by the schedule, without a
measurement.

**The 500,000 question has one candidate left: Groth16.** On BN254 with seven public inputs, its
check costs at least $34{,}000 \cdot 4 + 45{,}000 + 7 \cdot (6{,}000 + 150) = 224{,}050$ gas. That
is a projection and not a measurement. Groth16 also trades away something UltraHonk has: it needs a
trusted setup for each circuit, not the universal one.

The candidate route found is Reilabs' Sunspot. It compiles a Noir program's ACIR to gnark's Groth16
over BN254 and is published under Apache-2.0. It is not among the pieces this experiment's plan
pinned, so it is held until it is agreed; see the log.

## Results, second part: the transfer as a frame transaction

Run on 2026-10-21 by `pool.ts`; the record is `pool.json`, and `rebuild.test.ts` reads it back.

**The note tree lives on L1.** Without the rollup, nobody else keeps Aztec's note tree, so the pool
keeps it, in the hash the circuit proves cheaply:

- `Poseidon2.yul` is Barretenberg's permutation, generated by `poseidon2-yul.ts` from Barretenberg's
  own parameter file (`vendor/`). It matches Barretenberg's outputs (`build/poseidon2.vectors.json`)
  at one to seven inputs (`hasher.json`).
- One permutation costs 32,329 gas by call. Each further permutation adds about 29,200.
- `NotePool.yul` keeps a depth-32 tree of note hashes and files each new root with EIP-8272.
  Inserting one note costs about 1,021,590 gas of execution: a deposit, which hashes the note and
  then the 32 levels.
- The first deposit also sets the tree's 35 slots, for 3,427,200 state gas.

**The transaction.** Its layout is:

- frame 0: EIP-8272's verifier frame, naming the root;
- frame 1: the pool's `VERIFY`, which checks the layout, the nonce keys and the proof, then
  approves execution and payment;
- frame 2: the pool's `SENDER` frame, which inserts the two new notes.

The two nullifiers are the transaction's EIP-8250 nonce keys, ascending, at sequence 0. No
signature: the proof is the authorisation, and its context input is the pool's address. The
wallet's prover (`build/prove.mjs`) orders the two spent notes so that their nullifiers ascend.
Raw, the transaction is 8,525 bytes.

| pool | `VERIFY` limit | the node's answer |
|---|---:|---|
| `zk`, Barretenberg's zero-knowledge verifier | 3,600,000 | refused: "prefix gas budget exceeded: 3610000 > 500000 (MAX_VERIFY_GAS)" |
| `zk` | 490,000 | refused: "validation prefix frame reverted" |
| `layout`, `AcceptAnyProof` | 490,000 | admitted, and mined in block 491,124 |
| `layout`, the same two notes again | 490,000 | refused: "Nonce mismatch: expected 1, got 0" |

`AcceptAnyProof` answers true to everything, and is not a verifier. It is there only to separate
the verifier's gas from everything else the transfer asks of the chain. Both pools' proofs are real
and are accepted by Barretenberg's verifier when called directly, where no validation budget
applies.

**Proved from kohaku-rs.** A second transfer in the layout pool was proved by kohaku-rs's
`kohaku-noir-transfer` (branch `experiment/noir-transfer`, `c1564b9`; `pool.ts --rust`, record
`pool.rust.json`). In it, the first transfer's recipient spends the note it received with one it
had deposited.

- The witness comes from Noir's own executor, `acvm` 1.0.0-rc.6. The proof comes from Barretenberg
  through `barretenberg-rs` 5.2.1, which drives the `bb` binary of the same release. Nothing runs
  in JavaScript.
- Proving took 468 ms with 4 threads. Barretenberg's verifier accepts the proof by call.
- The transfer was mined in block 491,204 (`0x02c98ad7...`), at 2,772,915 gas.
- The crate's tests check its Poseidon2 against `bb.js`'s outputs, and its root, nullifiers and
  output notes against `build/drive.mjs`'s.

**What the mined transfer cost** (`0x2a4cc880...`, 2,782,967 gas in all):

| frame | execution | state |
|---|---:|---:|
| 0, EIP-8272 root | 5,579 | 0 |
| 1, the pool's `VERIFY` without the verifier | 6,198 | 195,840: the two nonce keys' first use |
| 2, two insertions | 2,337,257 | 97,920 |

So the prefix a real transfer needs is the following, against 500,000 and 100,000:

$$5{,}579 + 6{,}198 + 3{,}494{,}968 = 3{,}506{,}745$$

The verifier is 99.7% of it. Everything else the transfer asks of the prefix fits the testnet's
budget with 488,000 to spare, and EIP-8141's with 88,000.

**Without zero knowledge is not an option for a transfer.** `evm-no-zk` is half the gas, but its
proof is not zero-knowledge, so it would publish information about the spent notes. The transfer's
number is the zero-knowledge verifier's.

**Against what would refute the claim:**

- *Every verifier Noir's toolchain can produce costs more than the testnet's `VERIFY`
  budget.* So far this is true for both of Barretenberg's targets. For EIP-8141's 100,000 it holds for any pairing-based proof, by the
  schedule. For the testnet's 500,000 it is open until Groth16 is measured.
- *A transaction reusing a nullifier gets into the mempool or a block.* Not observed: the second spend was refused by
  the nonce keys, before any proof was checked.

## Divergences from the plan

- Barretenberg's verifiers keep under the contract size limit by putting their largest functions in
  external libraries. Those libraries are deployed separately, at their own CREATE2 addresses, and
  linked into the verifier: `linkBytecode` in `src/contracts.ts`. The verifier code is otherwise
  as generated.
- The plan said the transfer is built ready for the mempool and the end-to-end run, which are not
  this entry's. It was also offered to the testnet, because the refusal is the result. A layout
  pool against `AcceptAnyProof` was added to separate the verifier's gas from the rest.
- A first `NotePool`, `0x54eb475b...`, was deployed and given the same four notes before
  `pool.ts` took its final shape; its transfer was refused the same way. It is not in `pool.json`.
- The circuit was compiled and proved with the npm packages of Noir and `bb.js`, not with `nargo`
  and `bb` binaries, because the binaries' release pages cannot be reached from where this ran.
  The packages are the same releases at the pinned commits.
