# 48 - A blind ticket that pays only for the transaction its buyer signed

Experiment 36's ticket names a slot: a chain, a sender, its nonce keys and sequence, an epoch and
a salt. Nothing in it says what the transaction at that slot does, or what it pays. When the
sender signs, as a fresh sender does, its signature covers the rest. When nobody signs, as when a
privacy pool is its own sender, nothing does: anyone who sees the transaction pending can send it
again with higher fees or other data, at the same slot, and the same ticket pays. Experiment 40
showed what that costs when the registry pays; with a ticket paymaster, the ticket's value is what
leaks.

The mempool's claim-gated admission gained a binding for this (its version 6, clause CG-12): the
ticket's message also names a one-time key the buyer picks, and the ticket counts only when that
key has signed the whole transaction. This experiment builds the wallet's side and the paymaster
that checks it on chain.

## Written before any run

**The claim.** A blind ticket can commit to a one-time key of its buyer's choosing without the
issuers learning it, and a paymaster can require, in its `VERIFY` frame, that this key signed
the transaction's signature hash. Then a transaction that differs in any signed field (its
fees, its data, its payer) is not paid by that ticket, and spending needs nothing from the
issuers.

**It would be shown wrong if any of these is observed:**
- a bound ticket pays for a transaction other than the one its one-time key signed;
- spending a bound ticket needs the issuers to do anything after issuance;
- the paymaster's check no longer fits the validation budget a ticket paymaster has on the
  testnet;
- the issuers can tie a bound ticket to its spend through the one-time key.

**It is done when** kohaku-rs issues a bound ticket and spends it on the testnet, the paymaster
checks the binding there, and the gas the binding adds is measured against an unbound ticket.

**The plan, fixed before the run:**
- The message is CG-12's, 152 bytes: experiment 36's 132, then the one-time key's 20-byte
  address. The issuers sign it blind, under the same namespace and with the same blinding as
  before, so they see a uniformly random point.
- The paymaster is experiment 36's, with three changes: its frame data is 188 bytes, epoch, salt,
  the one-time key's address and the signature; it rebuilds the 152-byte message; and after the
  pairing it requires one signature entry whose scheme is secp256k1, whose `msg` is empty and
  whose resolved signer is that address. The protocol has already checked that entry's signature
  over the signature hash before any frame runs.
- The one-time key is derived from the seed, experiment 45's derivation with a new label,
  `ticket/<k>/binder`, one key per ticket.
- The same committee backs two paymasters, one bound and one as experiment 36's, so every run has
  an unbound control beside it.
- Spends: a fresh sender's first transaction, unbound and bound, for the gas; and a withdrawal from
  experiment 06's keyed pool, with the pool as its own sender and no other signer, paid by a
  ticket for the pool's slot.
- Copies of the withdrawal, each simulated and sent, before the original is sent: its fees raised
  by the replacement bump, keeping the one-time key's signature; the same with that signature
  entry removed; and the same re-signed by another key named in the frame's data. The bound ones
  must all be refused before inclusion. The unbound control's copy with raised fees is expected
  to be accepted.
- What the issuers saw is recorded, to compare with what the spends reveal.
