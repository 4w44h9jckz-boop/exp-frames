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
