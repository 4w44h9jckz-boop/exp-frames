# 42 - A private transfer on Aztec's note and nullifier model, proved in Noir, checked in a frame

Post 22 says of Aztec: "Aztec's private functions are proved on the user's device, so its client
proof becomes a dependency frame, its fee a `VERIFY` frame paid from the pool or a blind ticket,
and its public functions plain `SENDER` frames on L1". This experiment writes one private function,
a transfer of notes, in Noir, proves it on the device, and asks whether a frame can check the
proof.

The first question: **which proof systems can Noir's toolchain verify on the EVM, and what does
each verifier cost** against the testnet's 500,000 gas of `VERIFY` and EIP-8141's 100,000?

## Written before any run

**The claim.** A private function proved on the user's device leaves Aztec's rollup as frames: its
proof checked in a frame, each nullifier it spends a nonce key of the transaction, so that no
sequencer orders the spends.

**It would be shown wrong if:**
- no proof of the private function, in any proof system Noir's toolchain targets, can be checked in
  a frame within the testnet's validation budget;
- or a nullifier spent twice is admitted or mined.

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

## Divergences from the plan

- Barretenberg's verifiers keep under the contract size limit by putting their largest functions in
  external libraries. Those libraries are deployed separately, at their own CREATE2 addresses, and
  linked into the verifier: `linkBytecode` in `src/contracts.ts`. The verifier code is otherwise
  as generated.
- The circuit was compiled and proved with the npm packages of Noir and `bb.js`, not with `nargo`
  and `bb` binaries, because the binaries' release pages cannot be reached from where this ran.
  The packages are the same releases at the pinned commits.
