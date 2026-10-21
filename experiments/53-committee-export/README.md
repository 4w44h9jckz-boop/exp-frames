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
