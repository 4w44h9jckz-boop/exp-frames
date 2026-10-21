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
