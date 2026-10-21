# 51 - An enclave on someone else's machine, simulated: attestation against a proof

Post 29's "hardware trap" separates two enclaves. One on the user's own device, experiment 50's,
leaves nobody else in the loop. One on someone else's machine leaves two parties in it: the
manufacturer, whose implementation and attestation service vouch for what ran, and the operator,
who has the machine. The post's middle ground is to trust such an enclave for integrity and not
for privacy, because a wrong result can be caught by another check, while a secret it was given
leaks without a trace.

This experiment builds that enclave as a function: it takes input encrypted to its key, computes,
and returns an output with a signature for attestation, and it can also return a zero-knowledge
proof that the output is the function of what the ciphertext holds. The chain then accepts the
output twice, once on the signature and once on the proof, and the two are compared on what each
lets the chain check.

**Simulated.** There is no enclave hardware. The enclave is a separate process that holds its
keys in a sealed file, encrypted under a key derived from its own code's hash, and an
"attestation key" that stands in for the manufacturer's. All of it runs on this machine, under
this experiment's control. What this experiment shows is what the chain can check. It shows
nothing about what a real enclave hides from its operator.

## Written before any run

**The function.** A sealed comparison of two private inputs: two owners each encrypt a 64-bit bid
to the enclave's public key, and the enclave returns one bit, whether the first bid is above the
second. It is the comparison the coordinator's whole-gradient run uses at every step.

**The claim.** On chain, an output from a remote enclave can be accepted in a `VERIFY` frame in two
ways that bind different things:
- an **attestation**, a P-256 signature by the attestation key over the code's measurement, the
  enclave's encryption key, the ciphertexts and the output. Checking it shows which code ran only
  to the extent that the attestation key is trusted: whoever holds that key can sign any output
  for any measurement;
- a **zero-knowledge proof** that the output is the comparison of what the two ciphertexts
  decrypt to under the secret key of the enclave's public encryption key. Checking it shows the
  output is right without trusting any key, but it says nothing about which machine or which code
  produced the proof.

Neither shows that the plaintexts stayed unread. Whoever holds the decryption key can read the
bids, and the proof needs that key to be made, so privacy rests on the enclave and its operator
in both routes.

**It would be shown wrong if any of these is observed:**
- the attestation signature, or the proof, cannot be checked in `VERIFY` within the testnet's
  500,000 gas;
- anything the chain checks in either route shows that the operator could not have read the
  plaintexts;
- the attestation route rejects an output signed by the attestation key for a measurement that
  never ran, or a wrong output so signed, when it is checked on chain (which would mean the
  signature shows more than the key's word);
- the proof route accepts a wrong output, or an output for other ciphertexts or another enclave
  key.

**It is done when** two bids, each encrypted to the simulated enclave's key and posted on the
testnet, go through the enclave, and its output is mined twice: once accepted on the attestation
signature checked in `VERIFY`, once on the zero-knowledge proof checked in `VERIFY`. The README
records the gas of each, and a table of what each binds (measurement, enclave key, ciphertexts,
output, the function) and what it does not.

**The plan, fixed before the run:**
- Encryption: the enclave's key is a Baby Jubjub key `pk = sk * B8`. An owner encrypts bid `x`
  with a fresh `r`: `E = r * B8`, `c = x + H(S.x, S.y)` where `S = r * pk` and `H` is circomlib's
  MiMC sponge. The enclave computes `S = sk * E`. The two ciphertexts are posted on experiment
  33's board contract.
- The enclave process: `sk` and the attestation key are in a sealed file, AES-256-GCM under
  `HKDF(device secret, measurement)`, where the measurement is the SHA-256 of the enclave's
  source file. A changed enclave source cannot open the file. The process reads the two
  ciphertexts, decrypts, compares, and answers with the output, the attestation and the proof.
- The attestation: a P-256 signature, low `s`, over `keccak256("exp-frames/51/attest" ||
  measurement || pk || keccak256(ciphertexts) || output)`. The attestation key's public half is
  fixed in the outcome contract's code, standing in for the manufacturer's root.
- The proof: Groth16 over a circuit that takes `pk`, both ciphertexts and the output as public
  inputs and `sk` as private, and checks `pk = sk * B8`, both decryptions, the 64-bit range of each
  bid, and the comparison. Its key is made as experiment 32's was.
- The outcome contract is its own sender and payer, as experiment 32's registry is. One
  transaction records one output: `VERIFY` recomputes the statement from frame data, checks the
  attestation with `P256VERIFY` or the proof with the verifier, requires one nonce key equal to
  the statement's hash for that route, and approves; the `SENDER` frame logs the output.
- The run: post the two ciphertexts; run the enclave; mine the attested output (A) and the proved
  output (B). Then, by simulation: the attestation key signs the wrong output (D1, which the
  chain is expected to accept: the key's word is all it checks), and signs for a measurement
  that never ran (D2, likewise); the proof route with the output flipped (D3), with another
  ciphertext (D4) and with another enclave key (D5), each expected refused; and the sealed file
  opened by a changed enclave source (D6, expected to fail off chain).

## Design

| File | What |
|---|---|
| [`enclave.ts`](enclave.ts) | The enclave, SIMULATED: a process whose measurement is this file's SHA-256, with its keys sealed under it. `provision` makes its key; `run` decrypts, compares, attests and proves |
| [`enclave.circom`](enclave.circom) | The comparison, proved: `pk = sk * B8`, both decryptions, both bids below 2^64, `out = (a > b)`; 11,829 constraints |
| [`EnclaveOutcome.yul`](EnclaveOutcome.yul) | The chain's end, its own sender and payer: checks the attestation (`P256VERIFY`) or the proof (the verifier) in `VERIFY`, then logs the output; 839 B of creation code |
| [`outcome.ts`](outcome.ts) | Encryption to the enclave, the contract and `outcomeTx`, and the call into the enclave process |
| [`run.ts`](run.ts) | Setup, the posts, the enclave's run, A, B and D0 to D6 |
| [`rebuild.test.ts`](rebuild.test.ts) | The two outputs rebuilt byte for byte; the attestation and the proof verified offline; the ciphertexts traced to the board |
| `build/` | The compiled circuit, its proving key and its verifying key |

The verifier is experiment 32's `Groth16Verifier.yul` with this circuit's key. The board is
experiment 33's, already on the testnet.

Who holds what, in the simulation:

| Secret | Held by | Stands in for |
|---|---|---|
| the enclave's Baby Jubjub key `sk` | made inside the enclave process at `provision`, then only in the sealed file | a key generated inside an enclave |
| the sealing key | `HKDF(device secret, measurement)`, computed inside the process | the processor's sealing key, bound to the enclave's identity |
| the device secret | the host, which passes it to the process in its environment | a key fused into the processor. A real one never leaves it |
| the attestation key (P-256) | the host, which derives it and gives it to the enclave at `provision`; its public half is in the outcome contract | the manufacturer's attestation key and its service |

### The proving key

Made as experiment 32's was: phase 1 the same `ppot_0080_16.ptau` (sha256
`ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`), phase 2 one contribution
from 64 random bytes that were never printed or stored.

| | |
|---|---|
| circuit hash | `6f95be39 dbd9d546 7bb303a8 19f334ff 121a3b1f a483df57 fac1227a d8a5d366 a8e2529c 4bbecb18 0a81b460 696fd7b4 65ebedc6 9542ff01 7a612585 ad1eef6d` |
| contribution hash | `98a6b5f9 9a57c95f e1e56782 e0c077ec 3b13f883 565316b0 e9a70fa0 0c26d91d e99da1d4 992523c2 87096f4d b8ac2988 0b93e4c5 6bc5df44 d4450c8f 94fe1fb5` |
| `enclave.r1cs` sha256 | `46c58591a607de08b043b18fb7617606d937e3071e6caecb8eb6fc39fa1d08dc` (circom 2.2.3, rebuilt, not committed) |
| `enclave.wasm` sha256 | `0d989e0eff75b5775c76c680ec70d690b3156e980e22fab3dd111e0d5b2624ac` |
| `enclave.zkey` sha256 | `ae75a923c324ce284c6c4d2fec899281ccbfad56e5964f6d858dc66738de8c34` |

`snarkjs zkey verify` accepts it.

## Run

```bash
npx tsx experiments/51-remote-enclave/run.ts --dry-run
npx tsx experiments/51-remote-enclave/run.ts
```

The sealed file, the enclave's public key and its last answer go to `sealed/`, which git ignores.
The measurement is the SHA-256 of `enclave.ts`, so any edit to that file is another enclave: it
cannot open the old seal, and the mined attestation no longer names it.

## Results (2026-10-21, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

**Simulated.** The enclave is a process on this machine. Every result below is about what the
chain checks.

The measurement is `0xbb2fcc3350684526c79840482617ec5ce375650fa57162f45ca96c71698fc7b5`. The
outcome contract is `0x8A93f51D44199c074FC0bf0f28358F27FFD17938`, its verifier
`0x9732b4364573564A1DF6A63876b60c9A6AB9a437`. The enclave's key, made at provisioning, is
`pk = (0x1967f2b0…cc4ae, 0x0fedaea4…0b6d)`. Alice bid 700 and Bob 650, so the output is 1.

| Step | Tx | Block | `gasUsed` | Frames: execution + state gas |
|---|---|---|---|---|
| deploy the verifier and the outcome contract, fund it with 0.02 ETH | [`0x30941135...`](https://dora.privacy.ethrex.xyz/tx/0x30941135e24ee0670dcfb2ba94d15343e6f7d484ba46b396e80969be08abcea5) | 491,261 | 4,219,114 | |
| post the two ciphertexts on the board, 96 bytes each | [`0x72e0a5ca...`](https://dora.privacy.ethrex.xyz/tx/0x72e0a5cae9fee044d02c319fa06eaf3b4d3d69cbd399c8ed213557df81ff1b8d) | 491,263 | 41,569 | |
| **A.** the output, accepted on its attestation: `P256VERIFY` in `VERIFY` | [`0xe294edcc...`](https://dora.privacy.ethrex.xyz/tx/0xe294edcc0ea04cba5846032f6b70ee4fae4b0bb572b174028b4d7a34e4ed7cc2) | 491,265 | **152,278** | VERIFY **9,696** + 97,920 · record 2,636 |
| **B.** the same output, accepted on its proof: Groth16 in `VERIFY` | [`0xd6a2834c...`](https://dora.privacy.ethrex.xyz/tx/0xd6a2834ce5e9ac8581672507586dc1776ff93b6d411a323ede79767c7a665540) | 491,266 | **368,405** | VERIFY **245,699** + 97,920 · record 2,636 |

The 97,920 state gas in each is the nonce key's first use. The `record` call is 612 bytes in
both.

| Case | How | Outcome |
|---|---|---|
| **D0.** the attestation signed by another P-256 key | simulation and `eth_sendRawTransaction` | refused: "validation prefix frame reverted" |
| **D1.** the attestation key signs the **wrong** output, 0 | simulation, before A | **accepted** (`VERIFY` 9,696): the chain checks only the key's word |
| **D2.** the attestation key signs the right output for a measurement **that never ran** | simulation, before A | **accepted**, likewise |
| **D3.** the proof, with the output flipped | simulation and `eth_sendRawTransaction` | refused |
| **D4.** the proof, with Alice's ciphertext changed in one word | simulation and `eth_sendRawTransaction` | refused |
| **D5.** the proof, under another enclave key | simulation and `eth_sendRawTransaction` | refused |
| **D6.** `enclave.ts` with one comment line added opens the sealed file | off chain | fails: AES-GCM "unable to authenticate data" |

D1 and D2 were simulated before A, since A uses the attestation route's one nonce key for these
ciphertexts. They were not sent. A refusal leaves no hash; these are the run's reported outcomes.

Every mined transaction above is a fixture in `test/fixtures/chain/`. `rebuild.test.ts` reads the
attestation key from the deployed initcode, rebuilds A and B with `outcomeTx` byte for byte,
verifies A's attestation for the measurement of `enclave.ts` as committed, verifies B's proof for
the same statement (and refuses it with the output flipped), and finds the statement's
ciphertexts in the board's two logs (6 of 6).

### What each binds

| | Attestation (A) | Proof (B) |
|---|---|---|
| the code's measurement | signed, so the key's word; D2: the key signs a measurement that never ran, and the chain accepts | not bound. The proof names no code and no machine |
| the function computed | only through the measurement | bound: the verifying key is the comparison's circuit |
| the enclave's encryption key `pk` | signed | bound: the prover knew `sk` with `pk = sk * B8` (D5) |
| the ciphertexts | signed | bound: both decryptions are checked (D4) |
| the output | signed; D1: a wrong output so signed is accepted | bound: right for those ciphertexts under that key (D3) |
| who ran it, on what machine | the attestation key's word | nothing |
| that nobody read the bids | no | no: the prover holds `sk` |
| integrity rests on | the attestation key's holder, the manufacturer and its service | the proof system, and the circuit's setup |
| privacy rests on | the enclave and its operator | the same |
| `VERIFY` gas | 9,696 | 245,699 |

### Communication

One round, and no interaction between the owners. Each owner posts one ciphertext of 96 bytes
(here both in one transaction from this experiment's account, so the board shows one poster, as
experiment 33 found). The enclave reads both and answers a 1-bit output with 64 bytes of
attestation and 256 bytes of proof. On this machine the enclave's run took 3,683 ms, from process
start: unseal, decrypt, sign, and prove 11,829 constraints in snarkjs. On chain each output is one
transaction; A and B were mined one block apart.

## Observations

1. **The claim holds, with the enclave simulated.** Both routes were checked in `VERIFY` within
   the testnet's 500,000, and nothing either checks shows that the bids stayed unread: the proof
   requires `sk` to be made. D1 and D2 were accepted, so the attestation shows the attestation
   key's word and no more. D3 to D5 were refused, so the proof shows the output is the comparison
   of those ciphertexts under that key. No condition of "would show it wrong" was observed.

2. **Only the attestation fits EIP-8141's 100,000.** The attestation's `VERIFY` is 9,696 gas; the
   proof's is 245,699, about 25 times more and two and a half times the spec's budget. Under the
   spec's rule the check that trusts a key is admitted and the one that trusts nobody is not.

3. **A proof does not move privacy off the enclave.** To prove the comparison one must decrypt,
   so whoever can make the proof can read the bids. The proof takes the attestation key out of
   the integrity path; it leaves the enclave and its operator in the privacy path exactly where
   the attestation leaves them. The post's middle ground, a remote enclave trusted for integrity
   and not for privacy, becomes: not trusted even for integrity, once there is a proof, and
   still trusted for privacy.

4. **A wrong attestation would leave evidence beside a proof.** D1's wrong output is valid on the
   attestation route alone. Had it been mined, it would have taken the route's one nonce key for
   these ciphertexts, and B's proof would still have recorded the right output: two
   contradictory outputs for one statement, one signed and one proved, in public. That is the
   evidence an integrity fault leaves. Derived from the simulation of D1, not mined.

5. **The sealed file binds the code, and the operator still holds what opens it.** A changed
   source could not open the seal (D6). But in this simulation the host passes the device secret
   to the process, so the host, run with the exact source, can open the seal and read `sk`. In a
   real enclave the device secret stays in the processor, and what replaces this step is the
   manufacturer's implementation and the operator's physical access: the trust post 29 names.

6. **What is not built.** No hardware, no attestation certificate chain or quote format, no
   revocation; the measurement is the process's own report of its file. The ciphertexts are not
   authenticated. And the output itself says one bit about the two bids, which whoever learns
   it learns, whatever the route.

7. **Added after the run, from a later reading; no claim changes.**
   - **Everything here is pre-quantum.** The bids are encrypted by a Baby Jubjub Diffie-Hellman
     exchange, so the ciphertexts on the board can be harvested now and read later by a quantum
     adversary, without the operator. The P-256 attestation and the Groth16 proof are pre-quantum
     too.
   - **In this run the attestation key is the operator's.** The host derives it and hands it to
     the enclave, so for route A "integrity rests on" is this experiment's operator. The
     manufacturer stands in for it only with real hardware.
   - The reading's costly case, proving the decryption over a curve foreign to the proof system,
     did not arise: the circuit proves the decryption, and Baby Jubjub is native to BN254.
