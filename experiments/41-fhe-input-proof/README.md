# 41 - An encrypted input's proof of knowledge, checked in a `VERIFY` frame?

Post 22 says of Fhenix's CoFHE: it "takes encrypted inputs and returns results signed by a
threshold network, so a request's `VERIFY` frame can check the input's proof itself". The input is
a TFHE ciphertext, and its proof of knowledge is Zama's `tfhe-zk-pok`, the proof tfhe-rs attaches
to a compact ciphertext list. This experiment asks whether that proof, as its authors ship it, can
be checked by the EVM inside a `VERIFY` frame.

> **Read after the run, 2026-10-26.** The sentence quoted above describes Fhenix's planned
> threshold network, as Fhenix's blog and SDK introduction do. Fhenix's CoFHE documentation
> and its `TaskManager` contract describe what runs today. One Intel TDX enclave checks each
> input's proof and signs, and the chain checks that one signature. Another enclave holds the
> whole key and decrypts. This experiment's answer stands either way: the proof of knowledge, as
> tfhe-rs ships it, costs far more than a `VERIFY` frame can spend. Sources:
> cofhe-docs.fhenix.zone (ZK Verifier, Teecryptor, Future plans); FhenixProtocol/cofhe-contracts
> at `b5c20ed4`, `TaskManager.sol`.

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

## Short answers

1. **Yes, the proof can be made on BLS12-381**, by `tfhe-zk-pok` unmodified: it is generic over
   its curve and ships BLS12-381. At tfhe-rs's parameters it proved and verified for one block and
   for 32, in both of its modes, and refused every proof against a ciphertext changed after
   proving. tfhe-rs itself fixes the curve to BLS12-446 and keeps its encryption's randomness
   private, so a tfhe-rs ciphertext cannot be proved on BLS12-381 without a change to tfhe-rs.
2. **No, a `VERIFY` frame cannot afford to check it.** Any EVM verifier of the unmodified proof
   spends at least 3,936,012 gas on one block: 7.9 times the testnet's 500,000 and 39 times
   EIP-8141's 100,000. Two EIP-2537 calls alone, which the testnet charged at 1,807,840 gas, are
   3.6 times the testnet's budget.

So the claim fails as it is written: a request's `VERIFY` frame cannot check the input's proof
itself, within either budget.

| File | What |
|---|---|
| [`measure.json`](measure.json) | The native runs on BLS12-381 and BLS12-446, and the floor for one block and for 32 |
| [`precompiles.json`](precompiles.json) | The testnet's price for the 128-point G2 MSM and the eight-pair pairing check |
| [`GasMeter.yul`](GasMeter.yul), [`precompiles.ts`](precompiles.ts) | How that price was measured: initcode run by `eth_call`, nothing deployed |
| [`pins.json`](pins.json) | The pinned code and its licence |
| [`rebuild.test.ts`](rebuild.test.ts) | The floor recomputed from the schedule and the transcript, and the records read back |

The proofs are made by kohaku-rs's `kohaku-fhe-input` (branch `experiment/fhe-input`, commit
`dd56f87`), over `tfhe-zk-pok` at tfhe-rs commit `0a43e3cd`.

## Run

```bash
# kohaku-rs, crates/:
RECORD=measure.json cargo run --release -p kohaku-fhe-input --example measure
# here: the precompiles' price on the testnet, then the records offline
npx tsx experiments/41-fhe-input-proof/precompiles.ts
npx vitest run experiments/41-fhe-input-proof
```

## The proof, on BLS12-381

tfhe-rs's parameters for compact public-key encryption with a proof
(`PARAM_PKE_..._TUNIFORM_2M128_ZKV2` at `0a43e3cd`): dimension $d = 2048$, noise drawn from
`TUniform(17)`, the native modulus $2^{64}$, and a plaintext of 2 message bits, 2 carry bits and a
padding bit. A list of $k$ blocks is one ciphertext; a 64-bit integer is 32 blocks.

| Curve | $k$ | Mode | CRS | Prove | Verify (batched) | Proof, EIP-2537 encoding |
|---|---:|---|---:|---:|---:|---:|
| BLS12-381 | 1 | proof load | 4.5 s | 539 ms | 53 ms | 2,304 B |
| BLS12-381 | 1 | verify load | 4.8 s | 412 ms | 226 ms | 1,792 B |
| BLS12-446 | 1 | proof load | 7.1 s | 679 ms | 63 ms | |
| BLS12-381 | 32 | proof load | 4.5 s | 523 ms | 40 ms | 2,304 B |
| BLS12-381 | 32 | verify load | 4.6 s | 455 ms | 228 ms | 1,792 B |
| BLS12-446 | 32 | proof load | 7.4 s | 777 ms | 60 ms | |

Times on one machine, all cores. Every proof verified in both pairing modes, and every one was
refused against the same key with a ciphertext changed in two coefficients.

The ciphertexts are made by `tfhe-zk-pok`'s own test encryption, adapted with attribution, which
computes the compact public-key ciphertext tfhe-rs computes. tfhe-rs's encryption keeps the
randomness a proof needs in a private function (`encrypt_..._impl`) and its generators' fill
methods are crate-private, so it cannot be replayed through its public API; and tfhe-rs's `zk`
module fixes `type Curve = Bls12_446`. Making a tfhe-rs ciphertext's proof on BLS12-381 therefore
needs a change to tfhe-rs, which observation 3 names.

## The floor

In its cheaper mode (proof load, which moves the large G2 multiplications into the proof), the
verifier's final check is a product of eight pairings. Every EVM verifier must at least:

| Part | Why it cannot be skipped | Gas, one block |
|---|---|---:|
| a 128-point G2 MSM | one pairing's G2 side is $\sum_j (\delta_r \phi_j + \delta_{dec} \xi_j) \hat g_{n-128+j}$, whose scalars are Fiat-Shamir challenges; splitting it into pairings costs more | 1,509,120 |
| a pairing check of eight pairs | the eight G2 points are different, so no two pairs merge | 298,500 |
| the transcript | the first hash absorbs the key and the ciphertext (49,160 bytes), and the matrix $R$ is squeezed one byte per entry, $128 (2 (d + k) + 4) = 525{,}056$ bytes: 4,223 Keccak-f permutations at SHAKE256's 136-byte rate | 2,128,392 |
| **total** | | **3,936,012** |

Each term is a lower bound. A Keccak-f permutation is priced at 504 gas: its only nonlinear step,
$\chi$, touches all 1,600 bits in each of 24 rounds, and the EVM's only nonlinear bitwise opcodes,
`AND` and `OR`, act on 256 bits for 3 gas, so at least seven a round. A real implementation costs
far more. The later hashes of the transcript, the field arithmetic (the $128 \times 2{,}052$
matrix's products with the challenges, a negacyclic product of two 2,048-term polynomials) and
the G1 multiplications are left out. For 32 blocks the floor is 3,966,756.

The testnet charged the two precompile calls exactly EIP-2537's schedule, plus 110 gas for the
call itself, at block 490,853:

| Call | Input | Gas measured | Schedule |
|---|---:|---:|---:|
| `BLS12_G2MSM`, 128 points | 36,864 B | 1,509,230 | 1,509,120 |
| `BLS12_PAIRING_CHECK`, 8 pairs | 3,072 B | 298,610 | 298,500 |

## Observations

1. **The curve was not the obstacle.** `tfhe-zk-pok` runs on BLS12-381 unchanged, at a similar
   cost to BLS12-446. Why tfhe-rs chose BLS12-446, and what moving to BLS12-381 costs in security,
   is not settled here.

2. **The verifier's own design is.** The proof is built for a verifier with a CPU: a transcript
   over the whole key and ciphertext, a matrix squeezed from it byte by byte, and a G2
   multi-scalar multiplication with challenge scalars. On the EVM, the two precompile calls alone
   are three times the testnet's budget, before any hashing.

3. **A change to tfhe-rs would be needed for a tfhe-rs ciphertext, but would not help here.**
   Making tfhe-rs's own ciphertexts provable on BLS12-381 needs one of two changes to tfhe-rs:
   making its `zk` module generic over the curve, or exposing the encryption's random vectors. Either
   is small, and neither changes the floor, which is about the proof, not the ciphertext.

4. **What would fit is a different proof of the same statement**, one whose verifier the EVM
   prices well, for instance a SNARK over the encryption relation with a pairing-based verifier of
   a few pairings. That is not `tfhe-zk-pok`, and so not the unmodified pinned code.

## Divergences from the plan

- **The permutation's price.** The plan said to price a Keccak-f permutation by one measured on the
  testnet. A measured implementation shows what a permutation costs at most, not at least, so the
  floor prices it by the $\chi$ argument above, 504 gas, which no implementation can go under. No
  permutation was measured.
- **The field arithmetic.** The plan said to count it at the `MULMOD` and `ADDMOD` opcodes. It is
  left out of the floor: the two precompile calls and the transcript already exceed both budgets,
  and leaving a term out only lowers the floor.
- **The ciphertext.** The plan said tfhe-rs would make it, its randomness recovered by replaying its
  generator. Its generators' fill methods are crate-private, so the replay would have meant writing
  tfhe-rs's sampling again; the ciphertext was made by `tfhe-zk-pok`'s test encryption instead,
  which computes the same thing. The floor depends only on the parameters, not on who encrypted.

## Not done here

- No EVM verifier was written: the floor already exceeds both budgets.
- tfhe-rs's own ciphertexts were not proved on BLS12-381 (observation 3).
- The format agreed with the committee's input side is not needed until a request can be checked.
