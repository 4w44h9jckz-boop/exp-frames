# 53 - A note's opening handed to a committee

Experiments 50 to 52 kept a note's opening with its owner, or with the two owners who compute on
it. The next step down the trust gradient hands the opening to someone else. Post 25's appendix
on private owned state describes that step: the owner exports an encrypted form of the state
with a proof that it matches the note, a committee evaluates, and the result comes back through
a `VERIFY` frame that checks the committee's signature or proof. Post 29's committee trap is the
other half: enough members together can read whatever was shared with them, after the fact,
without leaving a trace.

This experiment takes the committee the end-to-end runs already keep, `co-withdraw`: three
members proving the privacy pool's withdrawal with TACEO's co-snarks (REP3, secure against one
semi-honest member), pinned at exp-e2e-frames `c8eb5cc` and used unmodified. The owner's note is
a fresh deposit in experiment 06's keyed pool. Its opening, the nullifier and the secret, goes to
the committee as three replicated shares of the withdrawal's witness. The committee proves, and
the proof is mined through the pool's own `VERIFY`.

## Written before any run

**The claim.**
- The committee can be handed a note's opening in a form no single member can read, and can
  check, inside its own computation, that the opening is the one the chain committed to; the
  chain checks the result in `VERIFY`, and the result names the note it spent.
- After the evaluation, the committee holds nothing that reads the note, provided its members
  delete what they were given. Nothing on chain or in the protocol shows whether they did.

**It would be shown wrong if any of these is observed:**
- there is no way, for the committee or the chain, to check that what was exported matches the
  note, other than a check that costs more than the evaluation itself;
- after the evaluation, members of the committee still hold, by the protocol's own output, what
  reads the note's opening (the claim's proviso is then the whole claim);
- the result mined on chain cannot be tied to the note it spent.

The second condition is expected to be observed: the members are given their shares as files,
and the protocol does not erase them. The run measures how many members it takes.

**It is done when** a fresh note's opening, secret-shared to the three members, is checked
against the note's commitment inside the committee's proof, and that proof is mined through the
keyed pool's `VERIFY` on the testnet; the README records what each member sent and received, the
gas, and what the members hold afterwards. The half with an FHE committee is priced from what the
wallet and the committee sessions measured, not run.

**The plan, fixed before the run:**
- The note: 31 random bytes of nullifier and 31 of secret, derived from `PRIVATE_KEY` and a label;
  its commitment deposited in experiment 06's keyed pool (0.001 ETH).
- The owner builds the circuit's inputs from the pool's leaves on chain, with `co-withdraw`'s own
  library (`circuit_inputs`), and then runs `co-withdraw split` and `co-withdraw local`
  unmodified, from the pinned commit.
- A thin tool here, `committee-tool`, calls that library for what its command line does not
  offer: the note's commitment, the inputs from the chain's leaves, and the reconstruction of the
  witness from two members' share files.
- The withdrawal: the committee's proof in experiment 06's keyed withdrawal, the pool as sender
  and payer, the nullifier hash as the nonce key, mined.
- Refused: the committee given shares of a witness whose secret is changed by one (expected: no
  valid proof, since the commitment no longer opens); the mined proof with another recipient.
- Afterwards: members 0 and 1's share files, summed, are compared with the owner's witness, and
  the nullifier and secret are read back from them. Each member alone is checked to hold values
  that are not the witness.
- The FHE half: the input format of the committee session's C1 and its proof's verifying cost
  from the wallet session's experiment 41, set against what an export with a proof of matching
  the note would need.

## Design

| File | What |
|---|---|
| [`committee-tool/`](committee-tool/) | A thin Rust tool over `co-withdraw`'s library at exp-e2e-frames `c8eb5cc`, its own workspace seeded with that commit's `Cargo.lock`: `note` (commitment and nullifier hash), `inputs` (`circuit_inputs` from the pool's leaves), `witness` (the extended witness, optionally one wire changed), `reconstruct` (pairs of members' share files against the owner's witness) |
| [`run.ts`](run.ts) | The deposit, the owner's split, the committee, R1, R2, the withdrawal, and the reconstruction |
| [`rebuild.test.ts`](rebuild.test.ts) | The deposit and the withdrawal rebuilt from the record; the members' agreement and traffic; the reconstruction's outcome |
| [`record-r1.json`](record-r1.json) | The run: the note's commitment and nullifier hash (public on chain anyway), the members' proof, public inputs and traffic, and the reconstruction's booleans. Never the opening |

The run's working files, the inputs and the shares, hold the note's opening and stay in the
gitignored `work/`.

```bash
cd ../4w44h9jckz-boop/exp-e2e-frames && git checkout c8eb5cc && cd committee && cargo build --release -p co-withdraw
cd -; cd experiments/53-committee-export/committee-tool && CARGO_TARGET_DIR=<that committee>/target cargo build --release
RUN=r1 npx tsx experiments/53-committee-export/run.ts   # CO_WITHDRAW_BIN names the release directory
```

## Results (2026-10-21, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

The pool is experiment 06's keyed pool, `0x73e47a8DA2C83Beb802708Fc473B5B7D094f3eE6`. The note's
commitment, `0x0aec3999…c7ba`, is its leaf 19.

| Step | Tx | Block | `gasUsed` | Frames: execution + state gas |
|---|---|---|---|---|
| deposit the note, 0.001 ETH | [`0x90a8c76e...`](https://dora.privacy.ethrex.xyz/tx/0x90a8c76e569f80f81f599a67aa601c82a1a9bb5dd22f61c088e108bb95be7678) | 493,524 | 1,202,990 | |
| **A.** the withdrawal, the committee's proof checked in the pool's `VERIFY` | [`0x5a28ca2e...`](https://dora.privacy.ethrex.xyz/tx/0x5a28ca2e484b69ec10a1c5740b9eeb3210745dd7a679a30a32bfd3fd1f428f2a) | 493,526 | **567,857** | 8272 5,579 · VERIFY **244,808** + 97,920 · withdraw 14,381 + 183,600 |

The recipient, a fresh address, received 0.00099999 ETH: the denomination less the 10^10 wei fee
the pool keeps for its gas.

| Case | How | Outcome |
|---|---|---|
| **R1a.** the owner extends a witness from inputs whose secret is changed by one | `co-withdraw split --inputs` | refused by the owner's witness extension: the Merkle root it computes is not the root (`merkleTree.circom` line 50) |
| **R1b.** the committee given shares of a full witness whose secret wire is changed by one, the owner's check skipped | `committee-tool witness`, `split --witness`, `local` | the three members proved, and `co-withdraw` refused the result: "the proof does not verify" |
| **R2.** the committee's proof, with the withdrawal paying another recipient | simulation and `eth_sendRawTransaction` | refused: "validation prefix frame reverted" |

The plan put R1 before the withdrawal. In the run, R1a ran there and stopped at the owner, so the
committee never saw the wrong opening; R1b, which is what the plan meant, was run after A by hand
with the commands `run.ts` now carries, on the same working files.

### What the members hold afterwards

`committee-tool reconstruct` on the three share files the members were given:

| Members | Their files give the owner's witness (28,293 private values) |
|---|---|
| 0 and 1 | yes |
| 1 and 2 | yes |
| 2 and 0 | yes |
| any one alone | no: none of its 2 × 28,293 values is a witness value |

From members 0 and 1's files, wire 7 is the note's nullifier and wire 8 its secret, equal to the
owner's. The opening's commitment is leaf 19 of the pool, and its nullifier hash is the nonce
key of A: whoever holds two files links the deposit to the withdrawal, now and later.

### Communication

| | Per member |
|---|---|
| from the owner | one share file, 1,811,012 bytes |
| to the other members | 6 messages, at most 448 bytes to one peer, 752 to 784 bytes in all |
| proving | 1,242 ms; the three members 1,578 ms in all, on loopback TCP on one machine |
| the owner's split | 483 ms |

### The FHE half, priced and not run

What it would take to hand the same opening to the FHE committee of the committee session's C1,
from that session's records and the wallet session's experiment 41:
- **The export.** C1's input is one `FheUint64` in a proven compact list, 18,786 bytes, with a
  proof over BLS12-446 that the sender knows the plaintext. The opening is two 248-bit values,
  so eight such limbs, or a wider type.
- **A proof that it matches the note.** The input's proof says the sender knows what it
  encrypted. It does not say that this is the opening of a commitment in the pool's tree.
  Nothing in either library proves that; it would be a proof about a lattice encryption's
  plaintext and a Pedersen commitment together, which is not built anywhere this experiment
  reads.
- **Checking even the knowledge proof in `VERIFY`.** On BLS12-446, which C1's tfhe-rs fixes, the
  EVM has no precompile. On BLS12-381, experiment 41 measured a floor of 3,936,012 gas for one
  such proof: 7.9 times the testnet's 500,000.
- **The result.** C1's members decrypt with 9 messages and 6,660 bytes each in 3 rounds, and
  three of four sign under a BLS key from a DKG; the precompile accepted the signature (C1's
  record). That half fits; the export does not.
- **What the committee keeps.** C1's TFHE key was dealt: the dealer held the whole key once, and
  any quorum of members can decrypt any input ever sent, as long as they keep their shares.

## Observations

1. **Done when: met.** A fresh note's opening went to the committee as three replicated shares;
   the committee's proof opened the note's commitment inside its computation, and the proof was
   mined through the keyed pool's `VERIFY`.

2. **Would show it wrong: the second condition is observed, as predicted.** Any two of the three
   members, from the files the protocol gave them, rebuild the note's nullifier and secret. The
   claim's proviso, that members delete what they were given, is all that stands between the
   evaluation and a permanent link from this deposit to this withdrawal, and nothing on chain or
   in the protocol shows whether it was kept. Post 29's committee trap, measured: two of three
   members, not a threshold the owner chose.

3. **The other two conditions are not observed.** The check that the export matches the note
   costs nothing beyond the evaluation: it is part of the circuit the committee proves, and a
   wrong opening fails closed (R1b). The result names the note: its nullifier hash is the
   withdrawal's nonce key.

4. **The chain cannot tell the committee's proof from the owner's.** The pool's `VERIFY` cost
   244,808 gas, exactly what experiment 06's keyed withdrawal costs when the wallet proves alone
   (experiment 32, "Gas"). As with experiment 52's joint proof, what differs is off chain: here,
   who saw the opening.

5. **The price of no committee, set beside it.** The committee proved a circuit of 28,300 wires
   in 1.6 s, with under 1 KB between members. Experiment 52's two owners, with no committee,
   needed 133 s and 3.7 MB for a circuit of 1,549 wires. A committee with an honest majority is
   cheap for the same reason it is a trust: replicated secret sharing among three lets any two
   reconstruct.

6. **The FHE half does not fit, on two counts.** No proof that a TFHE export matches a note
   exists in the libraries read, and the knowledge proof that does exist costs 7.9 times the
   testnet's `VERIFY` budget at least.
