# 39 - A private read's answer, checked by the reader and signed by the server

Experiment 37's reader took the server's answers on its word. Appendix E of "How to NOT Build a
Rollup" lists, among the promises of a private read paid with a ticket:

| Promise | Rests on | Visible? | Enforceable? |
|---|---|---|---|
| the answer is correct | a Merkle branch against a header the reader trusts | yes, to the reader; to anyone, if the server signed the answer | yes, if signed |

This experiment tests that row. The server puts each account's Merkle branch into the table the
private read is answered from, and signs every answer. The reader checks the branch against a
block header it fetched itself from the testnet's RPC, never from the server.

## Written before any result

The claim: the answer is correct, visible to the reader, visible to anyone if signed, and
enforceable if signed.

It would be shown wrong if any of these is observed:
- the private read cannot bring the branch to the reader without costing more than the read
  can bear;
- the reader's check accepts an answer that is wrong;
- a wrong answer the server signed cannot be proved wrong by someone else using nothing but
  public data.

It is done when a read has been checked against a block header from the testnet, an answer made
wrong on purpose has been refused by the reader, and someone holding nothing but public data has
proved its signed form wrong.

*These three conditions were pushed before any run, in `b463cbb`, and restated here in this
repository's own words on 2026-10-20, with the same meaning.*

How this experiment reads "a cost the read can bear", fixed here before the run: on the
testnet's table, the time the branch and the signature add to the server's work per read stays
below the ticket check, which the read already pays for (about 1 ms in experiment 37), so a
price that covers the check covers the branch. The bytes the branch adds are recorded as they
are, per read and once per reader, beside experiment 37's, and are not given a pass mark.

The plan, also fixed before the run:
- The branch travels inside the private read: each record of the PIR table is the account and its
  branch, so the server still learns neither the address nor the bucket.
- The top of the state trie is the same for every reader. One layout puts the whole branch in each
  record; the other puts the top levels in a set every reader downloads once, the same for all,
  and only the rest of the branch in the record. The reader checks both the same way: it walks
  from the header's state root, taking each node by its hash, so where a node came from does not
  matter.
- The server signs each answer with a secp256k1 key whose address is its identity, the one a
  read ticket names. What it signs commits to the snapshot block and state root, the table's
  shape, the hint, the query and the answer.
- A PIR answer is encrypted for the reader, so a third party can read it only once the reader
  opens its query. The evidence is the signed answer, the query's secret, and the hint rows of the
  disputed record. The third party checks that the query was well formed, so that a reader cannot
  frame an honest server with a noisy query, decodes the record, and compares it with the account
  as the chain holds it, by a branch it fetches itself against a header it fetches itself.
- Two deliberate lies: a record whose balance is changed while its true branch is kept, and one
  whose leaf is re-encoded with the changed balance.

## Short answers

1. **A wrong answer did not pass.** Two lying servers changed the target's balance by 1 ETH, one
   keeping the true branch and one forging the leaf to match. The reader refused both: the first
   branch proves another account, the second does not reach the header's state root.
2. **A signed wrong answer was shown wrong from public data.** A third party holding the published
   evidence, the snapshot's header and the target's branch, both fetched by itself from the
   testnet's RPC, found that the server signed a balance of 1,000,972,538,999,807,773 wei where the
   chain holds 972,538,999,807,773. `judge.ts` here, written apart from the Rust, finds the same
   from the same three things.
3. **The branch reached the reader through the private read, and cost the server little time.**
   Per read, the larger scan and the signature added at most 112 microseconds of server time,
   beside a ticket check of 1,059. What the branch costs is bytes: the hint a reader downloads
   once grows with each record, from 2.0 MB without a branch to 5.5 MB with the trie's top split
   off, and 68 MB with the whole branch in every record.

| File | What |
|---|---|
| [`judge.ts`](judge.ts) | The third party, in TypeScript: the signature, the hint rows, the query's error, the record, and the chain's account |
| [`rebuild.test.ts`](rebuild.test.ts) | The run read back: the purchase, the tickets, the header, the reads, the lies, the evidence judged again, the sizes and the times |
| [`record.json`](record.json) | The run: the purchase, the issuance, the tickets, the header, the layouts, the servers' manifests, the reads and checks, the refusals, the third party's verdicts and the branch it fetched, the servers' logs, the cost |
| [`evidence.json`](evidence.json) | The first liar's signed answer as the reader published it, 563,204 bytes |
| [`kohaku-rs-output.txt`](kohaku-rs-output.txt) | The run's output |

The reader, the servers and the third party are kohaku-rs's `kohaku-checked-read` (branch
`experiment/checked-read`; the run is `examples/checked_read.rs` at `7159ed4`), over experiment 37's `kohaku-ticket-read` and experiment 36's
`kohaku-frame-ticket`.

## Run

```bash
# kohaku-rs, crates/:
PRIVATE_KEY=0x... RECORD=record.json EVIDENCE=evidence.json \
  cargo run --release -p kohaku-checked-read --example checked_read
# here, offline:
npx vitest run experiments/39-checked-read
```

## The construction

```
 reader                              its own node            read server
 ------                              ------------            -----------
 header of block B  <--------------  eth_getBlockByNumber
 hash its fields again; = block hash
 GET /manifest, /hint, /top (once) ------------------------>  B, state root, shape, hint root,
 hint against the hint root                                   signing address; H = D A; the top
 POST /read {query, ticket} ------------------------------->  ticket first, then answer = D q,
 signature? decode; record?         <-----------------------  and a signature on the statement
 walk from B's state root to the account,
 nodes taken by hash from the top and the record
```

**The table.** Experiment 37's account table, each record followed by the account's branch below
a split depth: `address (20) || delegate (20) || balance (12) || nonce (8) || n (2) || nodes (n)`,
padded to the longest record. The nodes above the split are the trie's top, the union over the
table's accounts: every reader downloads the same set once, so it says nothing about any read.
The reader walks from the state root of a header it fetched itself, taking each node by its
hash, so it does not matter which of the two a node came from.

**The header.** The reader asks the testnet's RPC for block B, rebuilds the header's RLP from the
fields and checks that it hashes to the block hash. On this testnet the fields hash in Prague's
order followed by `blockAccessListHash` (EIP-7928) and `slotNumber` (EIP-7843).

**The signature.** The server's identity, the one its read tickets name, is its secp256k1 address,
left-padded. Per answer it signs, with that key,

```
commitment = keccak256("kohaku-checked-read-v1" || server || block || state root || seed of A
                       || salt || rows || cols || capacity || record || hint root)
digest     = keccak256(commitment || keccak256(query) || keccak256(answer))
```

where the hint root is a binary keccak tree over the hint's rows. It cannot know which bucket it
answered, so it signs what it computed.

**The evidence.** A PIR answer can only be read with the query's secret. To publish a refused
answer the reader opens its query: the evidence is the manifest, the query, the answer, the
signature, the secret, the column, the record's slot, and the 60 hint rows that decode the
record's `address || value`, each with its path to the hint root. The third party:
1. recovers the signer from the digest, and checks it is the server's identity;
2. checks the header it fetched is block B, with the manifest's state root;
3. checks the query is an encryption of the stated column whose error is small enough
   (255 times its sum below 2^23) that an honest server's record decodes exactly, so a reader
   cannot frame an honest server with a noisy query;
4. checks each hint row against the hint root, and decodes the record;
5. compares the record with the account under the header's state root, by a branch it fetched
   itself with `eth_getProof`.

## Results (Hegota testnet, chain 8141, 2026-10-20)

The shop, experiment 36's paymaster for this committee's key, is at
`0x81747040327ECa208BcDcC2794C42DA70659Ba30`. The funder deployed it and bought 8 tickets in
[`0xecaec1be…`](https://dora.privacy.ethrex.xyz/tx/0xecaec1be193903e56bd61c9fab0bf38eff81255ff0cc6354e978dde89563e7a4),
block 484,104.

The table: the 9 accounts without code, or with a delegation, active in blocks 481,105 to
484,105, at snapshot block 484,165. The snapshot's header, block hash
`0xd39934f8830c3b9e103ce72a5c6e35afd84a3987ac2e7fbe59662399e2153bc3`, state root `0xff5a9584…be183`, was fetched by the reader and hashed again. The branches have 5 or
6 nodes.

The layouts, from the run's table:

| Split depth | Record | Answer per read | Hint, once | Top, once |
|---|---:|---:|---:|---:|
| no branch (experiment 37's layout) | 60 B | 1,920 B | 1,966,080 B | none |
| 0, the whole branch | 2,089 B | 66,848 B | 68,452,352 B | none |
| 1 | 1,557 B | 49,824 B | 51,019,776 B | 532 B, 1 node |
| 2 | 1,025 B | 32,800 B | 33,587,200 B | 4,256 B, 8 nodes |
| 3 | 493 B | 15,776 B | 16,154,624 B | 8,916 B, 17 nodes |
| 4 | 250 B | 8,000 B | 8,192,000 B | 10,271 B, 26 nodes |
| **5, the run's split** | 167 B | 5,344 B | 5,472,256 B | 11,246 B, 35 nodes |

The run took the split that downloads least once, depth 5. At that depth the target's whole
branch is in the top. The whole-branch server, depth 0, is the one whose read carried the
target's branch through PIR. The query is 16 bytes: the table has 4 buckets.

The reads and checks:

| Server | Read | Outcome |
|---|---|---|
| honest, split | `eth_getBalance` of `0x35be31B0…`, through the router | `0x37484e19d1f1d`, proven; the node's at 484,165: the same |
| honest, split | `eth_getTransactionCount` of the same | `0x1`, proven; the node's: the same |
| honest, split | an address not in the table | no record in its bucket: unanswered |
| honest, whole branch | the same account | proven |
| liar, balance + 1 ETH, true branch | the same account | refused: the branch proves another account |
| liar, balance + 1 ETH, leaf forged | the same account | refused: the branch does not reach the header's state root (no node `0xbb553082…`) |

The server still checked the ticket first: a spent ticket, a ticket for another server and a
point that is no ticket were refused before any work, as in experiment 37.

The third party's verdict on the first liar's evidence, and on the second's: wrong, the server
signed 1,000,972,538,999,807,773 wei for `0x35be31B0…`, the chain holds 972,538,999,807,773.
Judging took 4.4 ms in Rust.

**The cost**, medians of 101 runs on one core of the machine that ran it:

| | Time |
|---|---:|
| checking a ticket | 1,059 us |
| signing an answer | 92 us |
| an answer, no branch (1,920 B table) | 0.65 us |
| an answer, split (5,344 B table) | 1.65 us |
| an answer, whole branch (66,848 B table) | 20.2 us |
| the reader's walk of a branch | 1.8 us |

So a branch and a signature add at most 112 us per read beside a 1,059 us ticket check. In the
servers' logs the signatures took 102 to 122 us, except the whole-branch server's only one,
2,457 us, its first.

## Observations

1. **A wrong answer is visible to the reader.** A server cannot make a different account's
   branch reach the header's state root: keeping the true branch shows the change, and forging
   the leaf breaks the hash chain above it.

2. **A signed wrong answer is visible to anyone, but only once the reader opens its query.** The
   server signs an encrypted answer it cannot read. To make it evidence the reader publishes the
   query's secret, which tells whoever holds the evidence which bucket it read, and the record
   names the account. Showing a server wrong costs the reader the privacy of that one read, though
   not who it is, which the ticket and the transport keep.

3. **The evidence cannot be made against an honest server.** The third party checks that the query
   is an encryption of one column with a small error. Within that bound an honest server's record
   decodes exactly, whatever the table holds, so a reader cannot frame an honest server with a
   noisy query. The offline tests show both: an honest answer opened is judged correct, and a noisy
   query is dismissed.

4. **The branch costs bytes, not server time.** The scan grows with the table, but at testnet size
   it stays far below the ticket check, and the signature is a tenth of it. The hint grows by
   4,096 bytes per byte of record: 68 MB for whole branches. Splitting off the trie's top, the same
   for every reader, brings it to 5.5 MB plus 11 KB. As in experiment 37, on a table this small,
   downloading the table and every branch (at most 9 records of 2,089 bytes, under 19 KB) would be
   cheaper and as private.

5. **No record is no answer.** A key with no record in its bucket has no branch, so the reader
   cannot tell an account the table leaves out from one a server withheld. It reports the read as
   unanswered; experiment 37's reader returned an empty balance. Withholding is the promise the
   appendix calls not visible, and its remedy is a retry.

6. **Public data has a horizon here.** The testnet's RPC serves `eth_getProof` for about the last
   128 blocks, about 13 minutes at a block every 6 seconds. For older blocks it returns the values
   with an empty branch. A table is built at a recent block, and a third party judges within that
   window or needs a node that keeps older state. Here it judged in the same run, and its branch is
   in the record for the tests.

## What this relies on

- The testnet's header layout, which the reader hashes again (above).
- `eth_getProof` at a recent block (observation 6).
- The reader trusts its own RPC node for the header. A light client would check the header too;
  none was used.

## Not done here

- No on-chain judge: the evidence is checked by a third party off chain, in Rust and in
  TypeScript. A contract that slashed a bonded server would have to decode 60 rows of 1,024 words.
  Its gas was not measured.
- The transport was not anonymous, and the servers ran in the reader's process, behind HTTP.
- The table is small: 9 accounts, a 4-bucket table. A branch on a larger state is deeper.
- No redemption: a spent ticket earns the server nothing here.
