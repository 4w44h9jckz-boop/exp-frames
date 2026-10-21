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

## Short answers

1. **Done when: met.**
   - kohaku-rs issued two bound tickets, blind, and spent both on the testnet: from a fresh
     sender, and on a withdrawal from experiment 06's keyed pool that no one else signed. The
     bound paymaster checked each in its `VERIFY` frame.
   - The binding costs 227 to 344 gas in the paymaster's check, and about 4,700 to 4,850 gas
     over the whole transaction, mostly the binder's signature entry.
2. **Would show it wrong: not observed.**
   - *Paying for another transaction:* each of the bound withdrawal's three copies was refused
     before inclusion, while the original was pending.
     - Fees raised, the binder's signature kept: the protocol refused the signature itself.
     - The binder's entry removed: the paymaster refused.
     - Another key named in the frame's data, signing: the pairing failed.

     The unbound control's copy, raised the same way and signed by no one, was accepted in its
     original's place and mined.
   - *The issuers at spend time:* none. They answered once, at issuance.
   - *The budget:* the bound check used 122,233 and 122,350 gas, against experiment 36's
     122,006. The whole validation prefix of the pool's withdrawal, root check, pool and
     paymaster, used 372,629, inside the testnet's 500,000.
   - *Linking through the key:* the issuers saw twelve points, three per ticket, each
     uniformly random. No point a ticket signs and no binder is among them. The binder first
     appears in the spend, and it is a key derived for that one ticket.
3. **What the binding binds.** Everything `compute_sig_hash` covers: fees, frames, the
   payer's frame and the ticket in it. The one-time key is ECDSA, so the wallet may sign a
   replacement with it, at the replacement bump, as the mempool's profile allows.

| File | What |
|---|---|
| [`BoundTicketPaymaster.yul`](BoundTicketPaymaster.yul) | The bound paymaster: experiment 36's, with the 152-byte message, 188 bytes of frame data, and the binder's entry required |
| [`rebuild.test.ts`](rebuild.test.ts) | The templates compiled and hashed; every spend's ticket and binder signature checked; each copy's refusal traced to its cause; the control; what the issuers saw |
| [`record.json`](record.json) | The run: every transaction and every copy, the node's answers, what each issuer saw, the templates. No key, mnemonic or blinding factor |

The run is kohaku-rs's `kohaku-frame-ticket` `bound` module and `kohaku-frame-secrets`'
`bound_ticket` example (branch `experiment/bound-ticket`).

## Run

```bash
# kohaku-rs, crates/; with experiment 45's SEED_FILE:
SEED_FILE=... PRIVATE_KEY=0x... RECORD=record.json \
  cargo run --release -p kohaku-frame-secrets --example bound_ticket
# here, offline:
npx vitest run experiments/48-bound-ticket
```

## The template, for the mempool's profile

The code a node recognises a bound ticket paymaster by is its deployed code before the 256-byte
key and the 32-byte denomination:

| Template | Length | keccak256 |
|---|---|---|
| bound, this experiment's | 1,185 bytes | `0x52c656815e560bb189c3fb362c9628432ca1ed6b720e239857775236c18bc1d3` |
| unbound, experiment 36's | 1,105 bytes | `0xec9f3f855524392a3891f2f2eb554781236d5565520d68388e455be74bdf3fe0` |

Both were read from the paymasters deployed in this run, and both are what this repository's
compiler gives from the Yul (the test checks it). The unbound one matches the mempool
profile's own.

## Results (Hegota testnet, chain 8141, 2026-10-21)

The bound paymaster is `0xcA7Aa9eb83846186c1562ABAb968D1568Ad55228`, and the unbound one,
for the same committee key, is `0x4687b01B7E3642144E1386a8c128Bd16A8C722a9`. The committee is
four issuers with a quorum of three, from Commonware's DKG. The tickets are experiment 45's seed's
7 to 10, each one-time key `ticket/<k>/binder`.

| Step | Tx | Block | `gasUsed` | Frames: execution + state |
|---|---|---|---|---|
| the funder tops up owner 0 | [`0xeb3cd414…`](https://dora.privacy.ethrex.xyz/tx/0xeb3cd414c1432d6c3d7558012c737c25def6d6a154537d09aea7e8bd57294766) | 491,564 | 26,102 | |
| owner 0 deploys both paymasters, buys 2 tickets on each | [`0xf1f99cda…`](https://dora.privacy.ethrex.xyz/tx/0xf1f99cdafc3e47cacd773617d8aa0bda45ea64d410e0d083d7d7492b9838cb60) | 491,566 | 4,976,427 | 100 · 16,353 + 2,437,290 · 13,387 + 2,314,890 · 1,623 · 1,623 |
| owner 0 deposits keychain notes 1 and 2, leaves 17 and 18 | [`0x8dfe6c3e…`](https://dora.privacy.ethrex.xyz/tx/0x8dfe6c3e2d19ce2ddcf2c0ef9f8fa622f7dc8d9cfd469cb59fc0373dd9b85c84), [`0x35cb1c55…`](https://dora.privacy.ethrex.xyz/tx/0x35cb1c55d48cef92a32b7d4f88d6b9be4f2bc27efc05fe30cd78aee4d9e13aa0) | 491,568, 491,570 | | |

**Fresh senders,** for the gas of the binding:

| Spend | Tx | Block | `gasUsed` | Pay `VERIFY` | Signatures |
|---|---|---|---|---|---|
| unbound ticket | [`0xfda8fd18…`](https://dora.privacy.ethrex.xyz/tx/0xfda8fd1884e5a4ccbcee52d48f6835483c649c25a773f9f02d9cf71dfffb0170) | 491,572 | 330,592 | 122,006 + 183,600 | the sender |
| bound ticket | [`0xf3a3e70e…`](https://dora.privacy.ethrex.xyz/tx/0xf3a3e70e7e5c2308aab9d8090a1593c6fd83e2356aa553e76ffdb958a57774fc) | 491,574 | 335,440 | **122,350** + 183,600 | the sender, the binder |

**The pool's withdrawals,** paid by a ticket for the pool's slot, with the note's nullifier as
the nonce key. The tip is 0.1 gwei, so that the max cost stays under one ticket:

| Transaction | Answer | Block | `gasUsed` |
|---|---|---|---|
| unbound: note 1's withdrawal, `0x3e158d69…` | admitted | replaced | |
| unbound: a copy, fees raised by the bump, signed by no one, `0x2b193135…` | **admitted, and mined in the original's place** | 491,576 | 692,548: root 5,579 · pool 244,817 · pay 122,006 + 97,920 · payout 14,410 + 183,600 |
| bound: note 2's withdrawal, `0x266284a1…` | admitted | 491,578 | 697,255: root 5,579 · pool 244,817 · pay **122,233** + 97,920 · payout 14,410 + 183,600 |
| bound: a copy, fees raised, the binder's signature kept, `0x38739fed…` | **refused**: "frame signature list does not authenticate the sender"; sent: "Invalid frame transaction signature" | | |
| bound: the same, the binder's entry removed, `0x492ad775…` | **refused**: "validation prefix frame reverted" | | |
| bound: the same, another key named in the frame's data and signing, `0x3683b748…` | **refused**: "validation prefix frame reverted" | | |

The control's copy raised the tip from 0.1 to 0.11 gwei. The paymaster, not the note, paid the
difference, 0.01 gwei on each of 692,548 gas, about $6.9 \times 10^{12}$ wei, to the block's producer. That is the leak the
binding closes. Every mined transaction above is a fixture in `test/fixtures/chain/`.

## Observations

1. **The protocol does half of the check.** A copy that keeps the binder's signature but changes
   any signed field fails before any frame runs: EIP-8141 verifies every protocol signature over
   the new hash, and that one no longer recovers to its signer. The paymaster only has to find
   the entry. Its loop over `SIGPARAM` costs 227 gas for one signature and 344 for two.
2. **The binder costs more as calldata than as code.** About 4,700 to 4,850 gas per transaction:
   20 bytes more in the frame's data, and a 65-byte signature entry with its 20-byte signer. The
   paymaster's own work is under 350 of them.
3. **The issuers learn nothing more than before.** The binder is inside the message the buyer
   blinds, so the issuers' view is experiment 36's: uniformly random points. On chain, the binder
   appears in the spend beside a fresh sender or a pool. It is a key derived for one ticket, so
   it ties the spend to nothing else, the seed aside.
4. **The pool's withdrawal needed no change to the pool.** The pool approves execution, the bound
   paymaster approves payment, and no fee leaves the note, because the ticket paid. Without the
   binding, that layout is exactly what a copier exploits: the control shows it.
5. **The seed now rebuilds one more secret.** `ticket/<k>/binder` joins experiment 45's paths. A
   ticket's binder must survive until the ticket is spent, and it does, being derived.
6. **Post-quantum status.** The binding is as strong as ECDSA on secp256k1: a quantum adversary
   who sees the binder's public key in a pending transaction could sign a copy. The ticket's
   unlinkability is perfect, so it holds. The committee's BLS key does not hold. A hash-based
   one-time key would hold, at the cost of never signing a replacement.
