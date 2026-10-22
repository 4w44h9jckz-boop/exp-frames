# 52 - Two owners compare sealed bids, with no committee

Experiment 33 settled an exchange between two owners in one frame transaction: each proved its
own side, and each proof named the other. Some joint functions cannot be split that way. Whether
Alice's bid is above Bob's depends on both bids at once, and neither should learn the other's.
Post 25's appendix on private owned state calls this the open gap of its trust gradient: private
joint computation without a committee. It says that where an abort costs nobody anything, a
collaborative proof, one proof that both parties' private inputs feed, settles exactly like a
self-update; and that where an abort can be exploited, as between two sealed bids, commitments
that only a valid result can consume, or that are reclaimed after a timeout, give economic
fairness and not cryptographic fairness.

This experiment builds both, for one function: `out = (a > b)` over two 64-bit bids, each bound
in advance by a commitment its owner posted.

## Written before any run

**The claim.**
- Two owners can produce one Groth16 proof of `out = (a > b)` over their two committed bids,
  each holding only its own bid, with nobody else involved: no dealer, no committee, no relay.
- That proof settles in one frame transaction whose `VERIFY` checks it, and the settlement looks
  on chain like the settlement of the same proof made by a single prover who knew both bids.
- Where the outcome matters, the bonds both owners lock are consumed by a valid result, or
  returned after a deadline, so that an owner who aborts after learning the outcome pays for it.
  That is economic fairness: an owner who values the abort above its bond still aborts.

**It would be shown wrong if any of these is observed:**
- the proof, the settlement or the reclaim needs a third party;
- an owner who aborts at some step leaves the other with less than it would reclaim had the
  other never started;
- the settlement of the jointly made proof can be told apart, from what the chain shows, from
  the settlement of the same statement proved by one prover;
- the joint proof cannot be checked in `VERIFY` within the testnet's 500,000 gas.

**It is done when** a sealed comparison of Alice's and Bob's committed bids, proved jointly, is
settled in one frame transaction on the testnet; and every step at which one of them can stop is
listed with what the one who stopped had learned and what each side gets back, the ones that
touch the chain run on the testnet.

**The plan, fixed before the run:**
- **The circuit.** Public: `Ca`, `Cb`, `session`, `out`. Private: `a, ra, b, rb`. It checks
  `Ca = Poseidon(a, ra)` and `Cb = Poseidon(b, rb)`, decomposes both bids into 64 bits, and
  compares them with a tree: at each bit `a_i * b_i`, then at each level two products per pair.
  Its key is made as experiment 32's was.
- **The joint prover.** Every wire of the witness is held as two additive shares. A wire that
  depends on one owner's input alone is that owner's, and the other's share is 0. The comparison's
  wires are computed jointly: each product of shared values needs the two cross terms, which are
  computed with Paillier encryption under Alice's key (Alice sends encryptions of her shares,
  Bob answers with an encryption of the cross terms plus a mask of his choosing, Alice decrypts).
  Then the Groth16 prover runs on the shares: the QAP vectors, the FFTs and the multi-scalar
  multiplications are linear; the pointwise product on the coset and the product `r * s` of the
  two parties' randomness use the same Paillier step; `pi_a` and `pi_b` are opened, as in
  collaborative Groth16; `pi_c` stays as two shares until the end. Semi-honest: each owner follows
  the protocol, and this experiment does not defend against one that sends wrong messages.
  Both owners run in one process here, exchanging serialized messages whose rounds and bytes are
  counted.
- **The contract.** Alice opens a session with `Ca`, a bond and a deadline; Bob joins with `Cb`
  and the same bond. After the joint prover, Alice posts her share of `pi_c` on chain. Bob, who
  then alone holds both shares, learns `out` first. The settlement is one frame transaction with
  the contract as sender and payer: an expiry frame at the session's deadline, `VERIFY` checking
  the proof against the session's commitments, and a `SENDER` frame that records `out` and
  returns both bonds. After the deadline, an unsettled session pays out: Alice alone, if Bob never
  joined; each its own bond, if Alice never posted her share; both bonds to Alice, if she posted
  and Bob did not settle.
- **The control.** The same statement proved by snarkjs alone, given both bids, settled through
  the same contract in another session. The two settlements are compared byte layout and gas.
- **The run.** Session 1: open, join, the joint proof, Alice's share, Bob's settlement. Sessions 2
  to 4, each with a short deadline: Bob never joins (Alice reclaims); the joint prover stops
  before its end (each reclaims its own); Bob stops after Alice's share (Alice takes both bonds).
  Session 5: the control. Refused by simulation: a settlement with `out` flipped, one after the
  deadline, and a reclaim before it.

## Design

| File | What |
|---|---|
| [`joint.circom`](joint.circom) | `out = (a > b)` over `Ca = Poseidon(a, ra)` and `Cb = Poseidon(b, rb)`, a 64-bit comparison tree; 1,545 constraints, so a domain of 2,048 |
| [`paillier.ts`](paillier.ts) | Paillier, 2,048-bit keys: encryption with Damgård, Jurik and Nielsen's speed-up, decryption by the Chinese remainder theorem |
| [`joint.ts`](joint.ts) | The joint witness and the joint Groth16 prover over additive shares; the channel that counts what crosses |
| [`SealedPair.yul`](SealedPair.yul) | Sessions, bonds and deadlines; the settlement checked in `VERIFY`; 1,322 B of creation code |
| [`pair.ts`](pair.ts) | The contract, its calls and `settleTx` |
| [`run.ts`](run.ts) | The five sessions |
| [`rebuild.test.ts`](rebuild.test.ts) | Both settlements rebuilt and their proofs verified; the two compared; the joint proof traced to its opened parts and Alice's share; every session's steps |
| [`joint.test.ts`](joint.test.ts) | The joint prover on two fresh bids, against circom's witness and the key; about 2.5 minutes, so only with `JOINT=1` |
| [`record-r1.json`](record-r1.json) | The run's record: sessions, commitments, deadlines, every flight with its bytes and the time before it, the opened `pi_a` and `pi_b`, Alice's share |

**Who computes what.** The witness is 1,549 wires. Wires that depend on one bid alone are its
owner's, computed by circom's witness generator with the other bid replaced by a placeholder
and the other owner's wires thrown away. The 64 leaf products, the 125 products of the tree and
the output are shared. In the prover, everything linear is computed by each party on its own
share. Two steps need products of shared values:
- the QAP's `c = a * b` on the domain, for the 253 rows whose two sums each party's share can
  make nonzero (the comparison's), read from the key's coefficients and the wires' owners;
- `a * b` pointwise on the odd coset, all 2,048 points.

Both use `multiply`: Alice sends Paillier encryptions of her shares, Bob answers each point with
one ciphertext of the cross terms plus a mask of 589 bits, and Alice decrypts. `pi_a`, `B1` and
`pi_b` are opened: they carry the parties' fresh `r` and `s`. `r * s` is one more product. Each
party then has a share of `pi_c`, and neither can test the output without the other's.

**The trust it needs.** Alice's Paillier key, generated by her, and each party following the
protocol. Nobody else: no dealer of correlated randomness, no committee, no relay. A party that
sends wrong values is out of scope (semi-honest).

### The proving key

Made as experiment 32's was: phase 1 the same `ppot_0080_16.ptau` (sha256
`ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`), phase 2 one contribution
from 64 random bytes that were never printed or stored.

| | |
|---|---|
| circuit hash | `3e81d14c f8ad0131 b1b92823 d0af28a0 65d27c47 4385e036 bf6a21bf c0debf68 ba4b2258 e924cf76 fa2a5cc3 587bcc29 d1461317 5e97e871 05348459 55293a01` |
| contribution hash | `1be63de3 14326083 ccdb0e61 3c6c17c5 f459e591 04b10df1 f305d40a 6662e4a0 2bf85e68 44a9bcf5 80a2b0e3 76d7ab87 7e1d1f45 119ee8cd 6d1982e5 b8391d16` |
| `joint.r1cs` sha256 | `11a94f20125fe1cb66cb9f65deb5f71ff117448e6e5ae551ee9eb7ca48289a57` (circom 2.2.3, rebuilt, not committed) |
| `joint.sym` sha256 | `add4baf9a5b252a04aa5ab9195ead8b565a4885eb470321b834a2c7610ed9879` (committed: the joint prover reads the wires' names) |
| `joint.wasm` sha256 | `b80697060c25d7f67fa8d547c2ed234286ba070a92fc6f3a01df08e1048722ca` |
| `joint.zkey` sha256 | `d12e609f8fda977e1000ea59b1362ae26b3bc4a28a3de9c9df9517b75190fd3f` |

## Run

```bash
RUN=r1 npx tsx experiments/52-joint-comparison/run.ts    # about 12 minutes: two joint proofs and the deadlines
JOINT=1 npx vitest run experiments/52-joint-comparison/joint.test.ts
```

`RUN` labels the sessions and the commitments' randomness, so a second run uses new sessions.
Alice's and Bob's accounts are derived from `PRIVATE_KEY` and funded by it.

## Results (2026-10-21, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

SealedPair is `0xce0b5185AE181091A0e5580414858f90C8244d3d`, its verifier
`0xd766b133ABfC7635c5068566D9bD1d5aa1c388D1`; Alice `0xD7a35A7D…bB76`, Bob `0x37d22e72…eed3`.
Alice bid 700 and Bob 650; bonds of 0.001 ETH.

| Step | Tx | Block | `gasUsed` | Frames: execution + state gas |
|---|---|---|---|---|
| deploy the verifier and SealedPair; fund Alice, Bob and the contract | [`0x13ce1c8c...`](https://dora.privacy.ethrex.xyz/tx/0x13ce1c8c5860d9971d78553a9adb6bffe96300268b0d83d0078dfd8c92c43058) | 491,440 | 4,757,070 | |
| Alice opens sessions 1 to 5 with `Ca` and a bond each | [`0x312fc5ea...`](https://dora.privacy.ethrex.xyz/tx/0x312fc5ea33bd652e5b3d60332d004e66fde2ddbf890ddc9f44048559729e220f) | 491,441 | 3,373,679 | |
| Bob joins sessions 1, 3, 4 and 5 with `Cb` and a bond each | [`0x7c6d8e76...`](https://dora.privacy.ethrex.xyz/tx/0x7c6d8e76ccb4d57dd9ae06d073d3c6dbc245f0ba9b078ad7275374b1a3c6c27d) | 491,442 | 573,439 | |
| S1: Alice posts her share of `pi_c` | [`0x2a6619a4...`](https://dora.privacy.ethrex.xyz/tx/0x2a6619a4179937f1d5b304ca9599baa74b98ccb2f6a8d6c3fe636f35c1aa3653) | 491,468 | 40,171 | |
| **S1: Bob settles, the joint proof checked in `VERIFY`** | [`0x13b84f26...`](https://dora.privacy.ethrex.xyz/tx/0x13b84f26eeb5e26e6f3a177633b62ee7634b4c19964aacde8eb02b450b4eb108) | 491,469 | **493,099** | expiry 3,051 · VERIFY **220,481** + 97,920 · settle 54,890 + 97,920 |
| S4: Alice posts her share of `pi_c` | [`0x65c756aa...`](https://dora.privacy.ethrex.xyz/tx/0x65c756aa0213f80d8346ff428a708782f03ed3e480b623bcaa0a238b4b2d7bd9) | 491,494 | 40,159 | |
| **S5: the control, one prover's proof, settled the same way** | [`0xad49fd2a...`](https://dora.privacy.ethrex.xyz/tx/0xad49fd2a7df996864765f145bb51873e6b4b58bc90ef02775b5f5183c7ceefd6) | 491,495 | **493,063** | expiry 3,051 · VERIFY **220,481** + 97,920 · settle 54,890 + 97,920 |
| S2, after its deadline: Alice reclaims | [`0xe95fc76a...`](https://dora.privacy.ethrex.xyz/tx/0xe95fc76aab34130e6caa2d513b0de6db3da3dcc10d704f914836efb173107258) | 491,496 | 52,519 | |
| S3, after its deadline: Bob calls reclaim; each gets its own bond | [`0x59cda0cb...`](https://dora.privacy.ethrex.xyz/tx/0x59cda0cbf499753740e88e0a063ef462ca683beb04a2fb014e25211a78463e64) | 491,497 | 64,606 | |
| S4, after its deadline: Alice reclaims both bonds | [`0xa323d853...`](https://dora.privacy.ethrex.xyz/tx/0xa323d8537d5f0ad28589ed917a9ebfb94dff0f3c7e2c9a6d68cd9579788a09e1) | 491,521 | 52,585 | |

| Refused | How | Reason |
|---|---|---|
| S1's settlement with `out` = 0 | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": the proof is for 1 |
| S1's reclaim before its deadline | simulation | the reclaim frame reverts |
| S4's settlement by Bob after its deadline, with the valid proof | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": the expiry frame's deadline is past the session's |

A refusal leaves no hash; these are the run's reported outcomes.

### Every place to stop

The payouts are read from Alice's and Bob's balances at the block before and the block of each
transaction, with the fee added back for whoever paid it.

| Session | Who stops, and where | What the one who stops had learned | Alice gets | Bob gets |
|---|---|---|---|---|
| S2 | Bob, before joining | `Ca`, a hiding commitment | her bond, +0.001 | nothing locked |
| S3 | Bob, in the joint witness at level 2 (flight 6 of 22) | Alice's Paillier ciphertexts: nothing | her bond, +0.001 | his bond, +0.001 |
| (not run) | either, later in the prover | ciphertexts, masked values, and the opened `pi_a`, `B1`, `pi_b`, which are uniformly random | as S3 | as S3 |
| (not run) | Alice, after the prover and before posting her share | her share of `pi_c`: not the output | as S3 | as S3 |
| S4 | Bob, after Alice's share | **the output**, one bit | both bonds, +0.002 | nothing |
| S1 | nobody: Bob settles | the output, now public | her bond, +0.001 | his bond, +0.001 |

Every abort left the one who did not abort with at least what it put in. The two rows not run
pay as S3 does, because the contract cannot tell them from it: the session is joined and Alice's
share is not posted.

### Communication

Eleven round trips, 22 flights, the same for S1 and S4:

| Flights | What | Alice sends | Bob sends |
|---|---|---|---|
| 1 to 14 | the joint witness: the leaves, then six levels of the tree | 160,768 B in 7 messages | 96,768 B in 7 |
| 15, 16 | the QAP's 253 cross rows | 193,536 B (378 ciphertexts) | 129,536 B (253) |
| 17, 18 | `a * b` on the coset, 2,048 points | 2,097,152 B (4,096 ciphertexts) | 1,048,576 B (2,048) |
| 19, 20 | the shares of `pi_a`, `B1` and `pi_b` | 256 B | 256 B |
| 21, 22 | `r * s` | 1,024 B | 512 B |
| | in all | **2,452,736 B** | **1,275,648 B** |

On this machine, both parties in one process: the joint witness 9.8 s and the joint prover 132.8 s
in S1 (10.1 s and 132.8 s in S4). The coset's products dominate: Alice's encryptions 37.6 s, Bob's
answers 47.2 s, Alice's decryptions and the multi-scalar multiplications 40.6 s. snarkjs alone
proved the same statement in 0.23 s. Loopback in effect, so no network time is in these figures.

## Observations

1. **Done when: met. Would show it wrong: not observed.** Two owners, each with only its own bid,
   made one Groth16 proof of `a > b` over their posted commitments, with no third party; it
   settled in one frame transaction checked in `VERIFY` (220,481 gas, inside the testnet's
   500,000); and no abort left the other side below what it put in.

2. **The chain cannot tell the joint proof from one prover's.** The two settlements have the same
   frames, limits, sender, signatures and fees, and the same gas in every frame. Their `gasUsed`
   differs by 36, the calldata price of different random proof points. A Groth16 proof is three
   random-looking points for its statement, however it was made. What the chain does see is the
   session around it: two accounts opened and joined, and Alice posted a point before Bob
   settled. A collaborative proof settles like a self-update only if it is used without such a
   session, where an abort is harmless.

3. **Economic fairness, measured.** Bob learns the output first, whatever the order, because one
   party must complete the proof first. In S4 he learned it and stopped, and paid his bond to
   Alice. An owner who values that bit above the bond still stops. The bond is the price of
   fairness here, and its size is the application's decision.

4. **A hole the semi-honest model hides.** Alice's posted share is not checked on chain, and
   cannot be on its own. A malicious Alice could post a wrong share, so that Bob can never
   settle, and then take both bonds at the deadline. Closing it needs Alice's share to be
   checkable, for example a proof that it is the share the protocol computes, and this
   experiment does not build one.

5. **Most of the cost is one step.** Of the 3.7 MB exchanged, 3.1 MB is the coset's pointwise
   product, and so is most of the 133 s. It grows with the circuit's domain, so a larger
   statement, such as experiment 32's kernel, whose 33,973 wires need a domain of 65,536, would have
   32 times as many points in that step (derived, not run). The comparison itself, the part that needs both bids,
   is 7 of the 11 round trips and 0.26 MB.

6. **What is not tested:** malicious parties, a network between them (both ran in one process),
   and any statement larger than this comparison. Alice's Paillier key is made once and used for
   every session of the run.

7. **Added after the run, from a later reading; no claim changes.**
   - **Who could compute the output, at each step.** Before Alice posts her share of `pi_c`,
     nobody: the output wire stays shared, and each half of `pi_c` alone verifies for neither
     output (`joint.test.ts`). After she posts it, Bob alone, who holds the other half. After
     Bob settles, everyone. Alice never holds both halves before the chain does. The reading
     agrees with the bond's rule as built: the side that stops after the other has posted pays
     (S4).
   - **"Told apart from a self-update" turns on the transaction's public shape,** not on the
     proof's format: which notes are consumed, what outputs are written, who pays. Observation 2
     compares two settlements of the same shape; a sealed comparison's session (two accounts
     opening and joining, a share posted) is a shape a lone owner's update does not have.
