# 43 - A withdrawal the wallet does not prove: its witness, shared with a proving committee

Experiment 30's withdrawal is proved by the wallet, on the device. Here the wallet builds the same
withdrawal but proves nothing. It extends the circuit's witness, splits it into three replicated
secret shares, and hands one to each member of a committee that proves with TACEO's co-snarks.
The committee's proof then goes into the transaction the wallet would have built around its own.

The question: **can a wallet write a withdrawal's witness in the committee's share format, so
that the committee proves it and the chain accepts the withdrawal unchanged?**

This entry was not pre-registered. It is the wallet half of a format another session fixed, so
it was built and run against that format directly, and is written up after the run. What would
have shown it wrong is stated below, beside what happened.

## Pieces

| Piece | Pin | Role |
|---|---|---|
| kohaku-rs | branch `experiment/witness-share`, `7863a47` | crate `witness-share`: extends the witness and splits it with co-snarks' `share_rep3`; examples `share_withdrawal` and `assemble_withdrawal` |
| co-snarks | `436f63fa17f2f10ece38c6650df68da99fbc0307` | `co-circom-types` and `mpc-core`, unmodified: the sharing and its encoding |
| the committee | exp-e2e-frames `c8eb5cc`, `committee/co-withdraw` | three members proving with co-groth16's REP3 prover over the wallet's own proving key, run unmodified from that commit |
| the pool | experiment 30's `RefundPool`, `0xe1960585...` | the withdrawal's sender and payer; its verifier is unchanged |

`pins.json` gives each with its licence.

**The format** is the committee's, "The witness's share format (fixed)" in
`committee/co-withdraw/README.md` at `c8eb5cc`. It covers:

- the whole websnark witness: 28,300 values, the constant 1, the six public inputs, then 28,293
  private signals;
- REP3 shares of the private signals only, over BN254's scalar field;
- co-snarks' `CompressedRep3SharedWitness` in bincode 1, replicated;
- one file per member, and `public.json`.

## Run

```text
PRIVATE_KEY=0x... OUT_DIR=shares cargo run --release -p kohaku-witness-share --example share_withdrawal
co-withdraw local --shares shares --out members.json      # exp-e2e-frames c8eb5cc, committee/
co-withdraw verify --proof members.json
SEND=1 cargo run --release -p kohaku-witness-share --example assemble_withdrawal -- shares/withdrawal.json members.json
```

`share_withdrawal` prints the note to standard error before the deposit, as experiment 30's
wallet does. It was discarded here, so the note exists nowhere but in the shares.

## Results (2026-10-21)

The record is `record/`, and `rebuild.test.ts` reads it back. The shares are 5.4 MB together and
are not committed; `record/shares.sha256` names them.

1. **The wallet:**
   - a fresh deposit, `0xdf36bedc...` in block 493,475, leaf 9;
   - the withdrawal's inputs, at the worst-case fee for the pool's default limits, 173,077,600,000,000 wei;
   - the witness extended, and three shares written, 1,811,012 bytes each, the size the format
     gives for this circuit.
2. **The committee:** `co-withdraw local`, the three members on loopback TCP at `c8eb5cc`, proved
   from the wallet's shares in 1.5 s.
   - All three wrote the same proof, and it verifies under the pool's key (`co-withdraw verify`:
     "verified").
   - Each member sent 752 to 784 bytes to its two peers.
3. **The chain:** `assemble_withdrawal` built the withdrawal around that proof, and it simulated
   valid. It was mined in block 493,514 (`0x1a7c9606...`), status 1, 579,697 gas, with the pool as
   sender and payer and no signature. The mined transaction's frames carry the committee's proof
   word for word (`record/chain.json`).

| frame | execution | state |
|---|---:|---:|
| EIP-8272 root | 5,579 | 0 |
| the pool's `VERIFY` | 244,744 | 97,920 |
| `withdraw` | 14,255 | 183,600 |
| the fee's refund | 11,531 | 0 |

These are the gas figures of experiment 30's own withdrawal, frame by frame: the chain cannot
tell a committee's proof from the wallet's.

**What would have shown it wrong, beside what happened:**

- *A member refuses a share, or the members' proofs differ.* Not seen: all three accepted their
  shares and wrote one proof.
- *The proof fails the pool's verifier.* It verified off chain and in the pool's `VERIFY` frame.
- *A share carries a private value in the clear.* The crate's test reconstructs the witness from
  all three shares. It checks that each share replicates its neighbour as the format says, and
  that the note's nullifier and secret appear in no share's bytes.
- *The transaction differs from the one the wallet would have sent.* `assemble_withdrawal` builds
  it with the wallet's own `withdrawal_tx`, and its gas is experiment 30's.

## Observations

1. **The fee is coarser.** A wallet that proves alone proves a draft, simulates it, tightens the
   limits and proves again with the fee they set (`chain::priced_withdrawal`). A wallet that hands
   its witness to a committee has no draft. It fixes the fee at the worst case for the default
   limits before sharing, because the proof binds the fee. The refund pool returns the surplus,
   so the note still pays about its gas. A pool without a refund would make the committee route
   dearer.
2. **The wallet still does the witness's work.** Extending the witness is most of what the wallet
   computes before it proves: 28,300 values from the inputs. Proving is what moves to the
   committee. The note's secrets reach the members only as shares, and any two members together
   hold enough to open them. That trust is the committee's to state, not this entry's.
3. **Nothing in co-snarks or the committee changed.** The sharing is co-snarks' own, and the
   committee ran from its pinned commit.
