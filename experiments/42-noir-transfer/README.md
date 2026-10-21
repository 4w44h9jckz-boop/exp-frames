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
