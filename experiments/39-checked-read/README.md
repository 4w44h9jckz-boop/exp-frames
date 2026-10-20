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

It would be shown wrong if any of these holds:
- the branch cannot reach the reader through the private read at a cost the read can carry;
- a wrong answer passes the reader's check;
- a signed wrong answer cannot be shown wrong by a third party from public data alone.

It is done when one read is checked against a testnet header, one deliberately wrong answer is
refused by the reader, and its signed form is shown wrong by a third party holding only public
data.

How this experiment reads "a cost the read can carry", fixed here before the run: on the
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
