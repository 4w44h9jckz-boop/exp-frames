# 36 - Blind tickets: a fresh sender pays with a ticket nobody can match to its purchase

A private sender sends from a fresh key, on purpose, so it has no ether. Someone else has to pay
its gas, and whoever pays should not learn which sender it paid for. This experiment builds the
mechanism the public wording calls "a blind threshold signature network that issues blind tickets
to pay for frame transactions", and runs it on the Hegota testnet:

1. **Buy.** A buyer pays a paymaster on chain for `k` tickets. The paymaster logs
   `Bought(buyer, k)`.
2. **Issue.** A committee of issuers holds the ticket key in shares, from a DKG among themselves.
   For each ticket the buyer picks a fresh sender, writes the ticket's message for that sender's
   first slot, hashes it to a point `H(m)` of BLS12-381's G1, and sends the issuers the blinded
   point `B = r * H(m)`, signed with the key that bought. A quorum answers `x_i * B` each.
3. **Unblind.** The buyer interpolates `x * B` from the answers and multiplies by `1 / r`. The
   result, `x * H(m)`, is the committee's ordinary BLS signature on `m`: the ticket.
4. **Spend.** The fresh sender's first transaction carries the ticket in a `VERIFY(PAYMENT)` frame
   to the paymaster, which rebuilds `m` from the transaction and checks the signature on
   EIP-2537's precompiles.

The issuers saw `B`, a uniformly random point whatever `m` is. Three questions:
1. Does the check fit a `VERIFY` frame, and what does it cost?
2. Can the issuers' answers be matched to the spends?
3. What does a deployment need besides the cryptography?

Short answers:
1. **Yes.** 122,006 gas of execution for every ticket, plus 183,600 state gas for the sender's
   new account, which the paymaster also pays. That fits the testnet's validation budget of
   500,000, an ethrex node flag, and not EIP-8141's `MAX_VERIFY_GAS` of 100,000. By EIP-2537's
   prices the pairing alone is 102,900.
2. **Not by anything they or the chain hold.** Pooled, the issuers' answers give the committee's
   signature on six points that no spend carries, and every answer and every spend satisfy the
   same equation under the same key. What does narrow a spend down is the crowd: it came from
   one of the buyers who held a ticket under this key, here two.
3. **Two things.** The issuers must share one count of what each buyer was issued. Counted per
   issuer, 4 issuers with a quorum of 3 issue 4 tickets for 3 bought. And the mempool lets a
   non-canonical paymaster sponsor one pending transaction at a time: a second spend sent at
   once was refused until the first was mined.

| File | What |
|---|---|
| [`TicketPaymaster.yul`](TicketPaymaster.yul) | The paymaster: sells tickets, and checks one in its `VERIFY`. Reads no storage and no balance; the committee's key is appended to its code |
| [`tickets.ts`](tickets.ts) | The ticket message, its hash to G1 and the pairing check with noble's BLS12-381, and the spend's layout |
| [`rebuild.test.ts`](rebuild.test.ts) | The run read back: every spend rebuilt byte for byte, every ticket and every issuer's answer checked, the pooled answers against the spends |
| [`record.json`](record.json) | The run: every transaction, the issuers' transcripts, the committee's public keys. No private key and no blinding factor |
| [`kohaku-rs-output.txt`](kohaku-rs-output.txt) | The run's output |

The issuers, the buyers and the spends are kohaku-rs's `kohaku-frame-ticket` (branch
`claude/nifty-einstein-llp9cd`, commit `2770696`), on Commonware's `commonware-cryptography`
2026.9.0.

## Run

```bash
# kohaku-rs, crates/:
PRIVATE_KEY=0x... RECORD=record.json cargo run --release -p kohaku-frame-ticket --example blind_tickets
# here, offline:
npx vitest run experiments/36-blind-tickets
```

## The construction

**The ticket's message** binds one slot, a sender at one nonce, and nothing about the buyer:

```text
message  = chain_id (32) || sender (20) || nonce_keys_hash (32) || nonce_seq (8)
           || epoch (8) || salt (32)                                          132 bytes
pay data = epoch (8) || salt (32) || signature (128, EIP-2537's G1)          168 bytes
```

`nonce_keys_hash` is EIP-8250's, the word `TXPARAM(0x0F)` reads. The epoch is the block timestamp
divided by 384; the paymaster does not check it, and it is there for a mempool that admits
tickets per epoch. The salt lets a sender hold two tickets for one slot. The message layout is
this experiment's. A mempool that checks tickets before admission may fix another, and the run
would be repeated with it.

**The signature** is Commonware's `MinSig` (signatures in G1, keys in G2), over
`union_unique(namespace, message)`, the namespace's length as a varint, then `kohaku-ticket-v1`,
then the message. It is hashed with RFC 9380's `BLS12381G1_XMD:SHA-256_SSWU_RO_` suite under the
tag `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_`, exactly as `ops::verify_message::<MinSig>`
checks it.

**The paymaster's `VERIFY`**, with scope `PAYMENT` and the pay data as its frame's data:

| Step | How | Precompile |
|---|---|---|
| rebuild `m` | `CHAINID`, `TXPARAM` 0x02 (sender), 0x0F (nonce keys hash), 0x01 (nonce sequence), the epoch and salt from the frame | |
| `expand_message_xmd` to 128 bytes | 5 SHA-256 calls | `0x02` |
| two field elements | each 64 bytes reduced modulo `p` | `MODEXP` `0x05` |
| `H(m)` | map each to G1 (with cofactor clearing), and add | `MAP_FP_TO_G1` `0x10`, `G1ADD` `0x0b` |
| the check | `e(signature, -g2) * e(H(m), key) = 1` | `PAIRING_CHECK` `0x0f` |
| the price | `TXPARAM(0x06)`, the maximum cost, at most the denomination | |

Then `APPROVE(PAYMENT)`. kohaku-rs's `tests/ticket.rs` checks that these steps give Commonware's
`H(m)`.

**The spent mark is the nonce.** A ticket names its slot, and the protocol consumes a slot once,
so the paymaster keeps no record of spent tickets and reads no storage. That is what lets it run
in a public-mempool `VERIFY` frame. A replacement at the same slot can carry the same ticket.

**The issuers** are four, with a quorum of three, and their key comes from one round of
Commonware's Joint-Feldman DKG (`dkg::feldman_desmedt`), each issuer a dealer and a player. Each
answers a request only if it is signed by a buyer and is on the shared list of that buyer's
requests, which holds at most as many requests as the buyer bought tickets. A request already on
the list may be answered by any issuer: any quorum's answers to it make the same ticket.

The blind layer needed no change to Commonware. Its threshold signing hashes the message itself,
so no issuer can be asked to sign a point the buyer chose, but the public API has every piece:
`ops::hash_with_namespace` for `H(m)`, `Private::expose` for an issuer's `x_i * B`,
`PartialSignature`'s public fields, `Variant::verify` to check an answer against an issuer's
public share, and `threshold::recover` to interpolate.

```
 TICKET-PAID SPEND    sender = a fresh key (no ether, no code, nonce 0)   signatures = [sender]
 ----------------------------------------------------------------------------------------------
 [0] VERIFY -> sender       default code: APPROVE(EXECUTION)                    20,000
 [1] VERIFY -> paymaster    the ticket check: APPROVE(PAYMENT)                 130,000, state 183,600
 [2] SENDER -> board        post("paid with a blind ticket")                    30,000
```

## Results (Hegota testnet, chain 8141, 2026-10-20)

Paymaster `0xaac74de2Ec4DD90656B7f029610dc9fE2F19CEb4`,
0.001 ETH a ticket. The funder `0xEB8e3354…` deployed it, bought 3 tickets and funded a second
buyer, `0x35be31B0…`, who bought 3:

| Transaction | Block | Gas |
|---|---|---|
| deploy, buy 3, fund the second buyer: [`0xcc5ac779…`](https://dora.privacy.ethrex.xyz/tx/0xcc5ac779755b146bd9c98c6a28b9c7833c27d40d0e1924d4d3e17aca42e22a0b) | 480,699 | 2,625,936 |
| the second buyer buys 3: [`0x9941554a…`](https://dora.privacy.ethrex.xyz/tx/0x9941554a01980fb70d8bec1a8582f4378cd7d60f92390f52a5487cbe7f1e1d3c) | 480,701 | 27,461 |

**Issuance.** Six tickets, each from a different quorum: every ticket's request went to every
issuer but one, in turn. Every answer checked against its issuer's share, and every unblinded
ticket verified. A seventh request, from the second buyer, was refused by the first issuer it
reached: "has no ticket left to be issued".

**Spends**, one after another, in an order shuffled away from the order of issuance:

| Spend | Ticket of | Block | Gas used | Ticket check (pay `VERIFY`) |
|---|---|---|---|---|
| [`0x31181599…`](https://dora.privacy.ethrex.xyz/tx/0x31181599fa5f180659d69d8dca1699ad33b2e9823de76e2ffedc17b5013ead5e) | second buyer | 480,703 | 330,604 | 122,006, state 183,600 |
| [`0xc7c6f19f…`](https://dora.privacy.ethrex.xyz/tx/0xc7c6f19fbef1ba591adc532c9103259ae8bc4b4f28af97e15729ea5a52109fd2) | funder | 480,705 | 330,592 | 122,006, state 183,600 |
| [`0x38329fb7…`](https://dora.privacy.ethrex.xyz/tx/0x38329fb7e5f47f7f0f704e91b899ca24adb280716a05e0915fe3d09b1c419cb5) | second buyer | 480,707 | 330,616 | 122,006, state 183,600 |
| [`0xb7c37cc3…`](https://dora.privacy.ethrex.xyz/tx/0xb7c37cc3b669520803ba1ccae9e1ce60b0c9ff1db0b86ad3b35336e4867a11d1) | funder | 480,709 | 330,616 | 122,006, state 183,600 |

**Two at once**, one ticket of each buyer, the second sent before the first was mined:

| Spend | Sent at once | Block |
|---|---|---|
| [`0xb6454e7c…`](https://dora.privacy.ethrex.xyz/tx/0xb6454e7c06fc1b703289629e39d0f6648c8c78bece439908984f0d4414dbaf41) | admitted | 480,711 |
| [`0x7c0944bb…`](https://dora.privacy.ethrex.xyz/tx/0x7c0944bb5e2d7737d9bf59bb927a462d56a45e2b2137d3ffe61fa813a4a4c952) | refused: "Non-canonical paymaster already sponsors the maximum number of pending frame transactions"; sent again once the first was mined | 480,713 |

**Refused at the paymaster's `VERIFY`.** Each was refused by `ethrex_simulateFrameTransaction` and
by `eth_sendRawTransaction` with "validation prefix frame reverted":

| Transaction | What |
|---|---|
| `0x0f1f9e98…` | a fresh sender with a random G1 point for a signature |
| `0x0a6863c8…` | the first spend's ticket, carried by another fresh sender |
| `0x13f9087a…` | the first spend's ticket, by its own sender at nonce 1 |

**Read back here.** `rebuild.test.ts` rebuilds every mined spend byte for byte from what the
wallet decides (the sender, the fees, the pay data). It checks every ticket with noble's
BLS12-381: the message rebuilt from the transaction, hashed to G1 by noble's RFC 9380 hasher, and
the pairing. Each ticket verifies under the committee's key, and not under one issuer's key nor
for the same sender at its next nonce. So three implementations agree on every ticket: blst
through Commonware, which issued them; ethrex's EIP-2537 precompiles, which paid for them; and
noble.

## Observations

1. **The ticket check fits a `VERIFY` frame, at a fixed cost.** It read nothing but the
   transaction, and cost 122,006 gas of execution in all six spends. By EIP-2537's prices the
   pairing of two pairs is 102,900, the two maps 11,000 and the addition 375: 114,275. The rest,
   7,731, is SHA-256, `MODEXP` and the contract's own work; they were not measured one by one.
   With the sender's own `VERIFY`, the prefix declares 150,000 gas of limits before the signature
   check. That is within the testnet's 500,000 and over EIP-8141's 100,000, so under the EIP's value, or as headroom over
   a floor ([PR-12301](https://github.com/ethereum/EIPs/pull/12301)), not every node would carry a
   ticket-paid transaction.

2. **Nothing the issuers or the chain hold matches an answer to a spend.** An issuer's transcript
   holds, per request, the buyer, the blinded point `B` and its answer `x_i * B`. The chain holds,
   per spend, the sender, `H(m)` and `x * H(m)`. `B` is `H(m)` times a random scalar the issuers
   never see, so it is a uniformly random point whatever `m` is. And every pair of an issued `B`
   and a spent `H(m)` is consistent: there is a scalar taking one to the other, under which the
   answers and the signature agree. The test pools the issuers' answers for each request into
   `x * B` and finds it is the committee's signature on `B`, and is none of the six signatures on
   chain.

3. **What does narrow a spend down is the crowd and the clock.** A spend's ticket was issued
   under the paymaster's key to one of the buyers who bought under it: here two, so each spend is
   the funder's or the second buyer's with nothing to tell which. In this run the spends followed
   issuance within a few minutes, and a ticket names an epoch of 384 seconds. A mempool that admits
   a ticket only in its epoch makes the buyer ask for it in the epoch it spends in, so the
   issuers learn which buyers asked in each epoch, and the crowd is those buyers. The purchase
   itself can be long before: the tickets are prepaid.

4. **The issuers must share one count.** A blinded request carries nothing an issuer can match to
   another, so an issuer that counts its own answers cannot tell a quorum it joined from one it
   did not. With `n` issuers, a quorum of `q` and `k` tickets bought, a buyer who sends each
   request to a different quorum gets `n * k / q` tickets, rounded down. kohaku-rs's test
   `issuers_who_count_alone_issue_more_tickets_than_were_bought` gets 4 tickets for 3 bought from
   4 issuers with a quorum of 3. Then the paymaster would pay for a spend nobody paid for. With
   one list of each buyer's requests that all issuers share, it gets 3. In this run the list was
   one structure in memory. Between real issuers it is a log they agree on, which is the public
   wording's "issuance count that anyone can read".

5. **A ticket paymaster needs to sponsor more than one pending transaction.** EIP-8141's public
   mempool lets a non-canonical paymaster sponsor one pending transaction at a time, and ethrex
   refused the second of two spends sent at once until the first was mined. One paymaster then
   serves one ticket-paid sender per block. The canonical paymaster has the standing to sponsor
   many, which a ticket paymaster would need. Experiment 24 describes what that standing rests on:
   ether that leaves only as gas it approves, or through a timelocked withdrawal. This
   paymaster's ether leaves only as gas.

6. **The surplus stays with the paymaster.** A spend cost about 330,600 gas at about 1 gwei, a
   third of the 0.001 ETH ticket, and the rest stays in the paymaster. A paymaster that refunded
   it would need to know whom to refund, which is what the ticket hides. The price of a ticket
   is the price of the most a spend may cost.

## Not done here

- The issuers ran in one process. The DKG's messages and the buyers' requests passed in memory,
  not over Commonware's `p2p::authenticated`; the shared list was one structure, not a log the
  issuers agree on; and Commonware's `collector` was not used to gather answers.
- No mempool node checked a ticket before admission. The node admitted these spends because the
  paymaster's `VERIFY` approved them.
