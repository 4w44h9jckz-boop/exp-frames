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

## A post-quantum run, written before any code (2026-11-05)

The run above found that tfhe-zk-pok's proof, checked by the EVM, costs at least 3,936,012 gas,
and that its pairings are broken by a quantum computer anyway. This run asks the same question of
a hash-based proof: one leanVM proof of the ciphertext's well-formedness, checked as one EIP-8288
leanSTARK dependency, in place of the pairing-based proof. The records above stay as they are.

**It is a port.** It measures the model: the relation tfhe-rs's compact public-key encryption
satisfies, written as a leanVM program. It does not measure tfhe-rs's or tfhe-zk-pok's own proof,
and it is not their code.

### The statement

Public: the compact public key $(a, b)$, $d$ coefficients each, and the ciphertext $(c_1, c_2)$,
$d$ and $k$ coefficients, all in $\mathbb{Z}_{2^{64}}$. Private: $r \in \{0,1\}^d$,
$e_1 \in [-2^{17}, 2^{17})^d$, $e_2 \in [-2^{17}, 2^{17})^k$, $m \in [0, 16)^k$, such that, modulo
$2^{64}$,

$$c_1 = a \circledast r + e_1, \qquad c_{2,i} = \langle b, r \rangle_i + e_{2,i} + 2^{59} m_i,$$

where $\circledast$ is the negacyclic product in $\mathbb{Z}_{2^{64}}[X]/(X^d + 1)$ and
$\langle b, r \rangle_i$ the $i$-th rotated inner product, exactly as `kohaku-fhe-input`'s
`encrypt` computes them (tfhe-zk-pok's test encryption, at tfhe-rs `0a43e3cd`, $d = 2048$,
`TUniform(17)` noise, a 2-bit message with 2 carry bits and a padding bit). The bounds are exact,
where tfhe-zk-pok's proof bounds the noise with slack, so the port proves no weaker a bound.

### How, fixed now

- **The program**, one file in leanVM's zkDSL at `3cbac04`, under the layout of `exp-e2e-frames`
  `docs/leanvm-program-layout.md` (`72068fd`): the key is keccak256 of the file, and the public
  input is one digest $D$.
- **Integers in the exponent.** leanVM's words are elements of $\mathrm{GF}(2^{192})$ and it has no
  integer arithmetic. Multiplying powers of its generator $g$ adds exponents exactly modulo
  $2^{64} - 1$, so each 64-bit coefficient is split into two 32-bit halves, held as $g^{x}$. A sum
  of at most $d$ halves stays below $2^{43}$ and so never wraps, and the carries between halves and
  the final reduction modulo $2^{64}$ are hinted and checked. Each coefficient read from the
  hashed bytes is decomposed into bits, which are checked binary and recomposed both ways.
- **The binary $r$ as its support:** the prover gives the indices $j$ with $r_j = 1$, strictly
  increasing, and the product sums only those columns.
- **The digest:** $D = H(H(h_{pk}, h_{ct}), \mu)$, where $h_{pk}$ and $h_{ct}$ are keccak256 of
  the key's and the ciphertext's bytes (little-endian 64-bit coefficients, the cell layout), and
  $\mu$ is the request's message: keccak256 of a domain, the chain id, the request contract, its
  request number and the requester. The contract holds $h_{pk}$, hashes the ciphertext from its
  calldata, and rebuilds $\mu$ and $D$.
- **A request contract** in kohaku-rs, `FheRequest.yul`: it accepts one TFHE input per
  transaction when the transaction declares the triple `0x11 || D || key`, and records the
  ciphertext's hash.
- **Sizes:** first $k = 1$ at $d \in \{64, 256, 1024, 2048\}$, for the scaling, proved and verified
  by experiment 19's prover built with `-C target-cpu=native`. Then $d = 2048$ with $k = 32$ (a
  64-bit integer), if $k = 1$ fits.
- **Chains:** the local chain, EIP-8288 extended (leanSTARK is reserved as written), run by the
  coordinator, with the proof handed to the builder. The test network, modelled: the triple in
  `VERIFY` data, the proof checked off chain, every figure saying so.
- **Refusals:**
  - a proof for a ciphertext with one coefficient changed;
  - the same proof under another request number;
  - a witness with one noise coefficient out of bound, which must fail to prove.

### It would be shown wrong if any of these is observed

- the statement cannot be proved within the wallet machine's memory (this machine: 15 GiB);
- its proof needs more than one leanSTARK dependency.

### It is done when

X5's input side, a request carrying one TFHE input, is mined on the local chain with its leanVM
proof checked by the block; or a measured reason why it cannot be.

### Predictions, fixed now

1. **Cycles grow as $d^2$:** the product dominates, about $2d^2$ multiplications for $d^2/2$
   expected terms. At $d = 2048$, $k = 1$: between 5 and 20 million cycles.
2. **$d = 2048$, $k = 1$ proves on this machine** (4 threads, 15 GiB), within 10 minutes, at a
   peak memory under 15 GiB.
3. **The proof is 200 to 400 KiB**, as experiment 19's are.
4. **The request's `VERIFY` frame fits EIP-8141's 100,000 gas**, hashing the ciphertext included.
   The ciphertext's 16 KiB of calldata is paid outside it.
5. **Each refusal holds:** the changed ciphertext and the other request number are refused by the
   contract's digest, and the out-of-bound witness does not prove.

### Conditions, in every result

- leanVM has no zero knowledge yet: the proof hides nothing it was given, here $r$, $e_1$, $e_2$
  and $m$, the plaintext included. Every privacy statement is conditional on it gaining zero
  knowledge, and no record publishes a proof's bytes beyond its hash.
- EIP-8288 reserves `LEANSTARK_SCHEME`; the local chain extends it, and the test network models it.
- It is a port: it measures the model, not tfhe-rs's own proof.

### Amendment 1, 2026-11-05, after version 1 and before version 2's runs

**Version 1, as planned** (kohaku-rs `experiment/q8-fhe-input` `9dd918b`, program
`crates/fhe-input-pq/programs/fhe_input.py`; records in `pq/1-v1-*.json`). It used 32-bit halves
held as powers of $g$, and the product eight slots at a time.

| $d$ | cycles | prove | verify | proof | peak memory | committed |
|---:|---:|---:|---:|---:|---:|---:|
| 64 | 133,713 | 0.49 s | 22 ms | 299,976 B | 0.24 GB | |
| 256 | 781,678 | 1.94 s | 28 ms | 301,536 B | 1.08 GB | |
| 1024 | 7,040,380 | 15.9 s | 41 ms | 348,032 B | 5.60 GB | $2^{27.1}$ words |
| 2048 | refused | | | | 6.07 GB | $2^{30}$ words |

At $d = 2048$ leanVM refused the proof before proving: `WitnessOutOfRange { log_committed: 30 }`.
leanVM at `3cbac04` accepts a committed witness of at most $2^{28}$ words (`MAX_MU`), the largest
its verifiers and its recursion accept. The out-of-bound noise witness failed at $d = 64$, as it
must (`1-v1-d64-noise.json`).

**What changes, for version 2.** The same statement, more cheaply:
- **A coefficient as one exponent of a primitive element $h$ of $\mathrm{GF}(2^{192})^\times$**
  ($h = 7 + 8Y$, of order $2^{192} - 1$, pinned by `tests/generator.rs`), in place of two 32-bit
  halves under $g$. A coefficient sum is below $2^{75}$, so it never wraps, and one table read and
  one product replace two.
- **Coefficients read a byte at a time**, through tables, in place of a bit at a time.
- **The product tiled**, sixteen output coefficients by sixteen slots of $J$, so that each slot's
  pointer serves sixteen products.
- The carry check is then one equation per coefficient.

**What it does not change.** No claim, falsifier, prediction or "done when". The statement, the
digest and the key's rule are as written. The program is a new file, so it has a new key. Version
1's records stand: they show the first program does not fit leanVM's bound at tfhe-rs's
parameters.

### Results, version 2 (2026-11-05)

Program `crates/fhe-input-pq/programs/fhe_input_v2.py`, instantiated per $(d, k)$; the
instantiated file is the program, and its key is keccak256 of that file. kohaku-rs
`experiment/q8-fhe-input` `ceec4df` (proofs) and `a9ca8d3` (the request); built with
`-C target-cpu=native`; this machine: 4 threads, 15 GiB. Records in `pq/2-v2-*.json` and
`pq/3-request-testnet.json`; commands in the examples' headers.

**The proof** (`examples/prove`):

| $d$ | $k$ | cycles | prove | verify | proof | peak memory | committed |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 64 | 1 | 46,174 | 0.25 s | 52 ms | 242,768 B | 0.09 GB | $2^{20.3}$ |
| 256 | 1 | 220,911 | 0.57 s | 78 ms | 276,120 B | 0.34 GB | $2^{22.4}$ |
| 1024 | 1 | 1,807,803 | 4.1 s | 76 ms | 322,576 B | 2.46 GB | $2^{25.3}$ |
| **2048** | **1** | **5,974,185** | **14.6 s** | **77 ms** | **356,904 B** | **6.29 GB** | $2^{27.3}$ |
| 2048 | 32 | 6,751,799 | 14.2 s | 77 ms | 357,640 B | 6.39 GB | $2^{27.3}$ |

At tfhe-rs's parameters, one 2-bit block and a 64-bit integer (32 blocks) each prove within
leanVM's bound and this machine's memory. The witness with one noise coefficient at $2^{17}$, one
past its bound, does not prove (`2-v2-d2048-noise.json`: the noise's top byte fails its range
check).

**The request, on the test network, modelled** (`examples/request`; chain 8141). `FheRequest` was
deployed for the key's hash and the program's key, and funded (`0x2786cac0...`, block 702,456,
1,410,791 gas). The request, $d = 2048$, $k = 1$:

| Tx | Block | `gasUsed` | `VERIFY` | request frame |
|---|---|---|---|---|
| `0xd2a2e8ee99dcb33ca29c186b76e2570adbdc6ad58e93b587474e533d69673417` | 702,460 | 1,168,854 | **7,940** | 20,821 + 97,920 |

The `VERIFY` frame hashed the 16,400-byte ciphertext from the request frame, rebuilt $\mu$ and
the digest, and found the triple. The transaction's remaining gas is its calldata. The proof
(357,128 B, 5,974,185 cycles, 13.8 s) was checked here, off chain. On the test network nothing on
chain checks it, and EIP-8288 would add the 30,000 this family models for a leanSTARK dependency.

Refused before inclusion, each "validation prefix frame reverted":
- the same request with one ciphertext coefficient changed and the triple kept;
- after the request was mined, the same proof and triple at the next request number.

**Predictions:**
1. **Held:** 5,974,185 cycles at $d = 2048$, $k = 1$, within 5 to 20 million. Cycles grew about as
   $d^2$ from $d = 256$ on.
2. **Held for version 2; version 1 was refused** (amendment 1): 14.6 s and 6.29 GB.
3. **Held:** 356,904 B, about 349 KiB.
4. **Held, modelled:** 7,940 gas of `VERIFY`, against EIP-8141's 100,000 and experiment 41's floor
   of 3,936,012 for the pairing-based proof.
5. **Held:** the changed ciphertext and the next request number were refused by the digest, and
   the out-of-bound witness did not prove.

**Against "would show it wrong":** the statement proved within this machine's memory, and in one
leanSTARK dependency. Neither falsifier is observed.

**Not done yet:** the local chain, EIP-8288 extended to leanSTARK, where the block's validity
checks the proof. The procedure is below.

### Running the request on a chain with EIP-8288 extended

For ethrex `64b8fc09` with `exp-e2e-frames` experiment 19's patch at `X14_EIP8288=extended`, from
kohaku-rs `a9ca8d3` or later, in `crates/`. Build once:

```bash
RUSTFLAGS="-C target-cpu=native" cargo build --release -p kohaku-fhe-input-pq --example request
```

| Variable | Value |
|---|---|
| `RPC_URL` | the node's HTTP RPC: ethrex's own pool, since skandha's node path counts only leanSPHINCS proofs as checked |
| `CARRIER` | `dependency`: `FheRequest` reads the triple from a dependency frame (mode 4) only |
| `WITNESS_DIR` | the node's `X14_WITNESS_DIR`: the proof is written there as `w-<keccak256(0x11 \vert\vert D \vert\vert key)>.bin` (bare hex), before the request is sent |
| `PROGRAMS_DIR` | the chain's program directory: the instantiated program is written there as `fhe_input_v2_d2048_k1.py`, before the request is sent |
| `SEED_FILE` | a mnemonic file; with `PRIVATE_KEY` unset, the funder is its leanSPHINCS account `sphincs/funder` (experiment 49's `MODE=addresses` prints it), which the genesis funds |
| `RECORD` | where the record goes |

One command, `target/release/examples/request`:
1. deploys and funds `FheRequest`;
2. proves for this chain's request (about 15 s and 6.3 GB at $d = 2048$);
3. sends the changed-ciphertext copy, which must be refused;
4. sends the request, `[VERIFY, DEP_VERIFY, SENDER]`, which must be mined with its proof checked
   by the block;
5. sends the same proof at the next request number, which must be refused.

The builder must find the program by its key in `PROGRAMS_DIR`, and the proof by its triple in
`WITNESS_DIR`. The program directory must be the one the chain was started with.
