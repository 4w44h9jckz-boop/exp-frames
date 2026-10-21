# 50 - A note whose owner is a P-256 key, the kind a phone's enclave holds

Experiment 32's registry lets whoever holds a note's secrets update it: the kernel proof is the
whole authorization. A wallet that keeps those secrets in ordinary memory loses the note to
anything that reads that memory. Phones and laptops have a better place for one secret: a key
generated inside the device's secure element, which signs on request and never leaves it. Those
elements speak P-256, not secp256k1. Post 29's "hardware trap" calls such a key, on a device the
user holds, a reasonable trust: no one else is involved, and what remains is trust in the chip.

This experiment puts such a key in charge of a note. The note commits to the key, the kernel
proof says which key that is, and the registry's `VERIFY` checks a P-256 signature from that key
over the transaction, with EIP-7951's precompile at `0x100`.

**Simulated.** There is no enclave here. The owner key is a software P-256 key in this process,
derived from `PRIVATE_KEY`. Everything this experiment shows is about what the chain checks; it
says nothing about whether a real enclave keeps its key.

## Written before any run

**The claim.** An update of private owned state can be authorized by a P-256 key that only the
owner's device holds, and checked entirely in the registry's `VERIFY` frame: the precompile at
`0x100` verifies the key's signature over the transaction's signature hash, and the kernel proof
ties that key to the note being spent. Nobody but the owner takes part, and no one else needs to
be online.

**It would be shown wrong if any of these is observed:**
- the gas the owner key's check adds to `VERIFY` (the precompile call and the work around it,
  measured as the difference against the same update without it) is above 100,000, EIP-8141's
  validation budget. The kernel proof's own check is already known to be above that budget
  (experiment 32) and is not what this measures;
- the precompile is missing on the testnet, or refuses a valid signature;
- what the transaction needs signed cannot be signed by a key that only signs a 32-byte digest
  it is handed, the way a device's secure element does through its platform's API;
- the update needs anyone besides the owner: a relayer, a co-signer, a service that must answer;
- holding the note's secrets without the key is enough to spend it, or the key's signature for
  one update can be reused for another.

**It is done when** a note owned by a P-256 key is updated on the testnet by a transaction whose
`VERIFY` frame calls the precompile, the transaction is mined, and the README records the
precompile's availability, the gas of each frame and the gas the key's check adds. The refusals
in the plan are each run and recorded.

**The plan, fixed before the run:**
- The kernel is experiment 32's with one change: the note's inner commitment becomes
  `H(nullifierSecret, secret, owner)`, and `owner` becomes a seventh public input. `owner` is the
  P-256 key's address as EIP-8141 defines it, `keccak256(qx || qy)[12:]`, read as a number. A
  new Groth16 key is made the same way as experiment 32's, from the same powers of tau.
- The registry is experiment 32's, version 3, with one more word per update, `owner`, and one
  more check in `VERIFY`: signature entry 0 is ARBITRARY with an empty `msg` and 128 bytes,
  `r || s || qx || qy`; `keccak256(qx || qy)[12:]` equals `owner`; `s` is at most half the curve
  order; and `0x100` accepts `(TXPARAM(0x08), r, s, qx, qy)`. ARBITRARY bytes are left out of the
  signature hash, so the signature can cover it.
- A second route is measured beside it: the same registry also accepts a P256 entry (scheme 2)
  that the protocol itself checks, with its `signer` equal to `owner`. That route does not call
  the precompile from `VERIFY`, so it is the comparison, not the claim.
- The change note, if any, names a fresh P-256 key, so that two updates of one owner's notes do
  not show the same key.
- The run: deploy the verifier, the registry and experiment 32's `Balance` application; deposit
  two notes; update one through the ARBITRARY route with a change note (A), the change note
  through the P256 route (B), and the other note through the ARBITRARY route (C). Then, by
  simulation, the refusals: a stranger's key signs (D1); the owner signs with high `s` (D2); no
  signature at all, with valid secrets and proof (D3); A's signature on a copy of the update
  with another recipient (D4); a proof whose `owner` is not the note's (D5, at the prover).
