# 41 - An encrypted input's proof of knowledge, checked in a `VERIFY` frame?

Post 22 says of Fhenix's CoFHE: it "takes encrypted inputs and returns results signed by a
threshold network, so a request's `VERIFY` frame can check the input's proof itself". The input is
a TFHE ciphertext, and its proof of knowledge is Zama's `tfhe-zk-pok`, the proof tfhe-rs attaches
to a compact ciphertext list. This experiment asks whether that proof, as its authors ship it, can
be checked by the EVM inside a `VERIFY` frame.

Two questions come first, in this order.
1. **Can the proof be made on BLS12-381**, the curve whose pairings EIP-2537 prices? tfhe-rs makes
   it on BLS12-446, which the EVM does not pair.
2. **Can a `VERIFY` frame afford to check it?** The testnet's limit is 500,000 gas of `VERIFY`
   execution; EIP-8141's is 100,000.

## Written before any run

**The claim.** A request transaction's `VERIFY` frame can check, by itself, the proof of knowledge
that comes with a TFHE input, so that no verifier has to sign for it.

**It would be shown wrong if** the proof cannot be checked in a `VERIFY` frame within the budget:
the least gas any EVM verifier of the unmodified proof must spend exceeds 500,000.

**It is done when** either:
- the floor is established and exceeds the budget, which ends the claim as it is written, and is
  reported as the result; or
- a request transaction whose `VERIFY` frame checks one input's proof is mined on the testnet.

**The plan, fixed before the run:**
- The third-party code is used unmodified and pinned at full commits in `pins.json`: tfhe-rs and
  `tfhe-zk-pok`, Zama's. Their licence is recorded beside each pin.
- tfhe-rs makes the keys and the ciphertext. If its API cannot hand the encryption's randomness to
  a proof on BLS12-381, the randomness is recovered without changing it: the same seeded
  generator is replayed, and the ciphertext rebuilt from the recovered randomness must equal
  tfhe-rs's byte for byte.
- `tfhe-zk-pok` proves on BLS12-381 and verifies natively, at tfhe-rs's own parameters for
  compact public-key encryption.
- The floor counts only what a verifier cannot skip without changing what the proof means:
  - the Fiat-Shamir transcript, hashed as the library hashes it, priced per Keccak-f permutation
    with a permutation measured on the testnet;
  - the group operations, priced by EIP-2537's schedule;
  - the field arithmetic, priced at the `MULMOD` and `ADDMOD` opcodes alone, with no loop or
    memory overhead.
  Every term of the floor is a lower bound, so the floor is one too.
- If the floor is within the budget, the verifier is built and the request mined.
