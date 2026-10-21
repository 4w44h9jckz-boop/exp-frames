# 46 - Guardians who hold a recovery key, not the seed

Experiment 31 recovered an account from two of the owner's own devices, with nobody else holding
anything. It left the case it could not cover: the user who loses every device. That case needs
someone else. Post 30 states the risk: "A recovery committee that holds shares for years is a
persistent operator again", and it orders the remedies: "the user's own devices before any
guardian, a protocol-enforced delay before any committee, and a committee, if at all, with
rotation and a way out". Its guideline 11: "recovery must not quietly rebuild the operator the
design removed".

This experiment gives the guardians shares of a recovery key, never of the seed, puts the
recovery behind the account's delay, which the owner can cancel, and rotates the guardians.

## Written before any run

**The claim.** Guardians can hold shares of a recovery key, and never of the seed, behind a
delay the owner can cancel, so that `t` of `n` of them recover the account and no fewer can. The
set can be replaced without the old set taking part, and none of them learns the account, its
balance or its notes from what it holds.

**It would be shown wrong if any of these is observed:**
- guardians recover without waiting out the delay, or the owner cannot cancel their attempt;
- a guardian learns the account, its balance or its notes from what it holds;
- replacing the set needs the old set to take part, or leaves the old set able to recover;
- recovery needs a party to hold a share for longer than the recovery itself (experiment 31's
  own test).

**It is done when,** on the testnet, `t` of `n` guardians recover an account after its delay, the
owner cancels a hostile attempt, the set is replaced and the old set's attempt is refused, and
what each guardian holds and learns is listed.

**The plan, fixed before the run:**
- The account is experiment 45's account 0, an unchanged `DeviceRecoveryAccount` (experiment 31)
  with the EIP's time rule and a delay of 120 s. Its one "device" is a recovery key `R`: the
  owner sets the commitment `keccak256(salt || 1 || address(R))` with `0x04`, the salt from the
  seed (`account/0/recovery-salt/<r>`).
- `R` is a fresh key for each guardian set, not derived from the seed. It is split 2-of-3 with
  Shamir's scheme over secp256k1's scalar field, and erased: it exists whole only when it is made
  and when a recovery uses it. A guardian holds an index and 32 bytes.
- The account's delay binds what the chain enforces. The seed is not on the chain: whoever opens
  it has every note at once, whatever the account says. So the seed's words are sealed in an
  envelope, posted to experiment 33's board from a fresh sender paid with a blind ticket, under a
  key that needs `R` and a phrase the user keeps (stretched with Argon2id), which no guardian
  holds. The run also seals one under `R` alone, the construction the claim would fail under,
  to show what a quorum gets from it.
- Recovery: the user's new device makes a transport key; two guardians post their shares sealed
  to it on the board; the device joins them into `R`, finds the envelope by a locator from
  `address(R)`, opens it with the phrase, and so has the seed, the account and the salt. `R`
  signs the start, naming owner 1 of the same seed; owner 1 finishes after the delay.
- A hostile attempt: two guardians who also know the account and the salt start a recovery to
  their own key. The owner cancels inside the delay.
- Rotation: the owner sets a commitment for a new `R`, split to a new set of three, and posts a
  new envelope. The old set's attempt is sent, and must be refused before inclusion.
- Recorded for each guardian: what it holds, what it receives, and what it can compute.
