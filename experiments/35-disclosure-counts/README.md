# 35 - How many could make the statement: a disclosure warning, from chain data

A zero-knowledge proof reveals nothing beyond its statement. But a statement can fit so few people
that making it names the prover. So a wallet should show the crowd before the user proves:
how many accounts or notes could truthfully make the same statement. This experiment asks
whether that count can be computed from public chain data for common statements. It computes
it, for three kinds, on mainnet.

It is a read-only analysis, as experiment 30's `mainnet.ts` is, and it sends nothing.

| Statement | Crowd | How it is counted |
|---|---|---|
| "I deposited into this pool before date D" | Tornado Cash deposits before D | the pool's `nextIndex()` at the last block before D, an archive call |
| "I hold an unspent note worth at least T" | unspent Tornado Cash ETH notes of at least T | an ETH pool holds exactly its denomination per unspent note, so the sum of balance / denomination over the pools of at least T |
| "My deposit is in the association set" | labels in Privacy Pools' latest association set | the provider publishes the set's root on chain with the IPFS CID of the whole tree; the tree is fetched, every level recomputed with Poseidon, and its top checked against the root |

Each count is checked once by hand:
- the deposits on either side of a date boundary;
- the identity behind statement 2 across one day of deposits and withdrawals;
- one label of the set traced to its deposit.

| File | What |
|---|---|
| [`counts.ts`](counts.ts) | The analysis |
| [`results.md`](results.md) | Its output at the snapshot: generated, not edited |
| [`kohaku-rs-output.txt`](kohaku-rs-output.txt) | The same counts from the Rust wallet, with the warning it shows for each |

## Run

```bash
npx tsx experiments/35-disclosure-counts/counts.ts 26231840     # writes results.md
# kohaku-rs, crates/:
cargo run --release -p kohaku-frame-wallet --example disclosure 26231840
```

`MAINNET_RPC_URL` overrides Tenderly's public gateway, and `IPFS_GATEWAY` Pinata's. The snapshot
is block 26,231,840 (2026-10-20 05:55:35 UTC), the finalized block when the analysis first ran.
`ipfs.io` and `dweb.link` answered 429 that day.

## Results

From [`results.md`](results.md), at block 26,231,840:

| Statement | Count |
|---|---|
| Deposited into Tornado 1 ETH before 2021-01-01 | 7,428 |
| Deposited into Tornado 1 ETH before 2025-01-01 | 62,341 |
| Deposited into Tornado 100 ETH before 2021-01-01 | 4,925 |
| An unspent Tornado note of at least 0.1 ETH | 15,168 |
| An unspent Tornado note of at least 100 ETH | 2,266 |
| A deposit in Privacy Pools' association set | 7,022 |
| An approved deposit into Privacy Pools' ETH pool | 5,418 |
| An approved ETH-pool deposit of at least 10 ETH | **96** |
| An approved ETH-pool deposit of at least 100 ETH | **3** |

The checks by hand, also in `results.md`:
- **Date boundary.** Tornado 1 ETH's deposit 62,340 is at 2024-12-31 22:49:11 UTC and deposit
  62,341 at 2025-01-01 14:14:59, so the count across that date is 62,341.
- **Unspent notes.** Over the last 7,200 blocks, Tornado 10 ETH took 74 deposits and paid 67
  withdrawals, and its unspent notes went from 2,283 to 2,290. Every pool's balance was an exact
  multiple of its denomination.
- **Association set.** The set's first label is the ETH-pool deposit of 0.1 ETH in block
  22,167,294.

kohaku-rs's `kohaku-frame-wallet` (branch `claude/nifty-einstein-llp9cd`) computes every count
above from the same reads, with its own Poseidon and its own check of the tree, and they are
equal. Its `disclosure` module words the crowd: under 10 "would all but name you", under 100
"narrows you down".

## Observations

1. **The count can be computed from public data for all three kinds.** Two need an archive node
   (a call and a balance at a past block), and one needs the set the provider publishes off
   chain. That set's root is on chain, so the wallet can check what any gateway served it.
   Nobody else's word is needed.

2. **The crowds in the wild are large until the statement is narrowed.** Each kind alone fits
   thousands. Joining two facts that are public on their own shrinks the crowd fast:
   "approved" and "at least 100 ETH" leave 3 deposits. A proof of that statement is, for
   practical purposes, a disclosure of which deposit is the prover's. That is the case the
   warning is for, and it comes from public data alone.

3. **Some joins cannot be counted, and say so.** "Deposited before D *and* still unspent" needs
   to know which deposits were withdrawn, which the pools hide by design. The best the wallet
   can show is a bound: at most the smaller of the two counts.

4. **A balance over all accounts is a blind spot.** "My account holds at least T ETH" fits every
   account with that balance. Counting them needs the state's account range. Neither Tenderly's
   gateway nor the Hegota testnet's RPC serves `debug_accountRange` ("method not found", "not
   available on this endpoint"). An indexer could answer, but the wallet would then tell the
   indexer what it is about to prove. So the warning works for statements about a pool's public
   entries, and not, through an RPC, for statements about account balances.

5. **The association set mixes pools.** Of its 7,022 labels, 5,418 are ETH-pool deposits. The
   rest belong to the entrypoint's other pools. And 914 of the ETH pool's 6,332 deposits are not
   in the set. The crowd for "my ETH deposit is approved" is 5,418, not 7,022. A wallet has to
   count the statement it will actually prove.
