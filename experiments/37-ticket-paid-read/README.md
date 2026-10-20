# 37 - A private read of account state, paid with a blind ticket

A wallet that reads its own balance from an RPC node tells the node which account is its own.
Private information retrieval answers a read without the server learning what was read. But
someone has to pay the server, and paying from an account tells it who reads, when and how
often. This experiment pays with experiment 36's blind tickets instead. The reader buys them in
public and spends one per read; the server checks the ticket before it does any work.

The questions: can a server answer a private read having seen only a ticket and a query? And
what does a read cost it, beside what a ticket costs?

Short answers:
1. **Yes.** Three reads of testnet accounts went through `kohaku-pir-rpc`, upstream kohaku-rs's
   router, each spending one ticket, and each answer matched the node's. The server's log holds,
   per request, a ticket's serial, its verdict, timings and sizes, and no address. A spent ticket,
   a ticket for another server and a forged one were refused before any work.
2. **On the testnet's table, the ticket check is the cost.** The table of the 47 code-free
   accounts active in the last 3,000 blocks is 8,640 bytes. An answer took 5 to 10 microseconds,
   and checking the ticket about 1.1 milliseconds. The server's work grows with the table at
   3.03 GB per second on one core: a 64 MiB table took 22.2 ms. So the work behind a ticket
   passes the check at about 3.0 MB of table.

| File | What |
|---|---|
| [`rebuild.test.ts`](rebuild.test.ts) | The run read back: the shop's code and key, every read ticket checked with noble for its server and no other, the reads against the node, the server's log |
| [`record.json`](record.json) | The run: the purchase, the issuers' transcript, the tickets (all spent but one, which names another server), the table's shape, the reads, the refusals, the server's log, the timings |
| [`kohaku-rs-output.txt`](kohaku-rs-output.txt) | The run's output |

The reader, the server and the issuers are kohaku-rs's `kohaku-ticket-read` and
`kohaku-frame-ticket` (branch `claude/nifty-einstein-llp9cd`, commit `eea02a3`).

## Run

```bash
# kohaku-rs, crates/:
PRIVATE_KEY=0x... RECORD=record.json cargo run --release -p kohaku-ticket-read --example ticket_read
# here, offline:
npx vitest run experiments/37-ticket-paid-read
```

## The construction

```
 reader                                  issuers                    read server
 ------                                  -------                    -----------
 buy 4 tickets on chain  ------------->  count what was bought
 blind serials, signed by the buyer ->   sign blinded points
 unblind
 GET /manifest, /hint (once) ---------------------------------------->  table shape, seed, key
 POST /read {query, ticket}  ---------------------------------------->  signature? unspent?
                                                                        then answer = D q
 decode; find the record     <----------------------------------------  {answer}
```

**The ticket.** A read ticket is the committee's signature on `server (32) || serial (32)`,
under the namespace `kohaku-read-ticket-v1`. It is issued exactly as experiment 36's gas tickets
are, by the same committee under the same key, against the same purchases and the same shared
count. The issuers see a blinded point either way, so they cannot tell a read ticket from a gas
ticket. The namespace keeps either from paying for the other. Naming the server lets it keep its
own spent set: another server would not know the ticket was spent.

**The shop** is experiment 36's `TicketPaymaster`, deployed for this committee's key, at
`0x7c0Ae8aBd821E273F8d194C96702B1338ACa8A6B`. The funder deployed it and bought 4 tickets in one
transaction,
[`0x836730dc…`](https://dora.privacy.ethrex.xyz/tx/0x836730dc981947826257b52053f7f1bd9dc2ee9cf51ea5e41364afb0d4ee154b),
block 481,082. Its ether can only pay for gas, so it cannot pay the read server. How a server
redeems spent tickets is not part of this experiment.

**The read.** The server holds the account table as `kohaku-pir-rpc` decodes an account:
`address (20) || delegate (20) || balance (12) || nonce (8)`, in buckets placed by
`keccak256(salt || address)`. The reader fetches its address's whole bucket with single-server
PIR in the style of SimplePIR, with SimplePIR's parameters (LWE dimension 1024, modulus 2^32,
error width 6.4, a byte per entry). The query is an LWE encryption of the bucket's position, so
the server learns neither the address nor the bucket. The server multiplies the whole table by
the query, and the reader decodes the bucket with the hint it downloaded once. The
implementation is kohaku-rs's own and is not audited.

**The router.** `kohaku-pir-rpc`, from upstream kohaku-rs's branch `experiments/pir-v1` at
`6dc83a4`, answers `eth_getBalance`, `eth_getTransactionCount` and `eth_getCode` from an account
backend and leaves the PIR scheme to it. Here the backend is `TicketLookup`: each lookup spends a
ticket. On that branch, `kohaku-privacy-rpc` sends the keys themselves to its PIR server, over
Tor, and leaves the scheme to a body codec to come; `TicketLookup` is such a codec, with a ticket.

## Results (Hegota testnet, chain 8141, 2026-10-20)

The table at block 481,083: 47 accounts, every account without code that sent or received a
transaction in blocks 478,083 to 481,083. In buckets of 8 records, it is 480 rows by 18 columns:
8,640 bytes.

| Read, through the router | PIR's answer | The node's, at 481,083 |
|---|---|---|
| `eth_getBalance` of experiment 36's second buyer, `0x35be31B0…` | `0x37484e19d1f1d` | `0x37484e19d1f1d` |
| `eth_getTransactionCount` of the same | `0x1` | `0x1` |
| `eth_getBalance` of a random address, not in the table | `0x0` | `0x0` |

The node's answers are the experiment's check, made beside the reads; the reader does not need
them.

What the server saw, from its log:

| Request | Ticket | Verdict | Ticket check | Answer |
|---|---|---|---|---|
| 1 | `0x96dd6d96…` | answered | 1,100 us | 10 us |
| 2 | `0x79faffb6…` | answered | 1,250 us | 5 us |
| 3 | `0x83726af7…` | answered | 1,065 us | 10 us |
| 4 | `0x96dd6d96…` again | refused: "a spent ticket" | 1,067 us | none |
| 5 | `0x02025ddb…`, issued for another server | refused: "no ticket for this server" | 1,369 us | none |
| 6 | a random point | refused: "no ticket for this server" | 3,252 us | none |

Every request carried 72 bytes of query, one word per bucket, and every answer was 1,920 bytes,
one word per row. The hint, downloaded once, is 1,966,080 bytes: 1,024 words per row.

**The cost**, medians on one core of the machine that ran it:

| | Time |
|---|---|
| checking a ticket (Commonware's `ops::verify_message`, 101 runs) | 0.991 ms |
| an answer on the testnet's table, 8,640 bytes (101 runs) | 2.3 us |
| an answer on a 64 MiB table (11 runs) | 22.2 ms, 3.03 GB/s |

A ticket costs 0.001 ETH. That is a testnet price, with no market behind it. It is also what
the paymaster takes for a gas ticket, whose spend used 330,600 gas in experiment 36.

## Observations

1. **A server can answer a private read having seen a ticket and a query.** Nothing in a
   request names the reader: the serial was blinded when the issuers signed it, and the query
   hides which bucket is read. What remains is the connection itself. Here it was a local
   socket. `kohaku-privacy-rpc` would send it over Tor, as its PIR lookups are sent.

2. **The check comes first, and costs what it costs whatever the table.** Each refusal was
   decided by the ticket check alone, and the server did no PIR work for it. The check took
   about a millisecond, so a server that verifies a junk ticket loses a millisecond, and the
   table's size does not change that.

3. **At the testnet's size the ticket is most of the server's work.** The answer took 5 to 10
   microseconds against a millisecond for the ticket. The work grows with the table, at 3.03 GB
   a second here, and passes the check at about 3.0 MB of table. Checking first is a defence
   for tables well above that size, and for this one it is the larger cost.

4. **At the testnet's size PIR's hint is larger than the table.** The hint is 1,024 words per
   row, 1,966,080 bytes for an 8,640-byte table. Downloading the whole table once would have been
   cheaper and as private, with no server work per read. A PIR scheme with a hint pays off only
   on a table much larger than its hint.

5. **Gas tickets and read tickets can share one crowd.** The issuers signed blinded points
   under one key and could not tell which namespace a ticket would carry. A buyer of read
   tickets therefore hides among buyers of gas tickets, and the other way round. Each server
   still keeps its own spent set, and nothing here pays the server: the shop's ether leaves
   only as gas.

## Not done here

- The reader did not check the answers itself. The router took them on the server's word, as it
  takes an RPC node's. A Merkle branch against a header would make a wrong answer evidence; the
  server did not sign its answers either.
- The transport was not anonymous: a local socket, without `kohaku-privacy-rpc`'s Tor underlay.
- The server ran in the same process as the reader, behind an HTTP boundary, so it held nothing
  but what reached it over HTTP.
- No redemption: a spent ticket earns the server nothing here.
