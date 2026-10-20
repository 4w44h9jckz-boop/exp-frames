# 34 - Two withdrawals from one wallet, at once, through a mempool node

Experiment 06 sent two withdrawals from the keyed pool straight to ethrex, 220 ms apart, and both
were mined in one block. Here the same pair is built by a wallet, kohaku-rs's
`chain::keyed_batch`, and sent through skandha, a mempool node that checks frame transactions
itself. Its pool runs the mempool specification's `hegota-testnet` profile, whose `disjoint-keys` rule lets one sender
have several pending transactions when their nonce keys do not overlap.

The question is whether owned state inside a shared contract forces a wallet to serialize its
spends. That is, must the wallet wait for one spend to be mined before sending the next? And are
two concurrent spends linked by something the chain or a node sees?

## Setup

- **The pool:** experiment 06's keyed pool, `0x73e47a8DA2C83Beb802708Fc473B5B7D094f3eE6`. Each
  withdrawal has the pool as sender and payer and no signature, and its nullifier hash is its
  only EIP-8250 nonce key.
- **The wallet:** kohaku-rs, branch `experiment/frames`,
  `crates/frame-pool/examples/concurrent_withdrawals.rs`. It deposits two fresh notes and builds
  both withdrawals against the root after the second deposit, each priced as experiment 30
  prices one. It hands both to the node back to back. Then it hands over a second spend of the
  first note, to another recipient, while the first is still pending.
- **The node:** skandha at the mempool session's `7697963`,
  built with `bun install && bun run build`. One node, with `--frames.enable --frames.handoff`, as
  in its `FRAMES.md`, so that what it admits goes to ethrex's `eth_sendRawTransaction`. Its log
  for the run is [`node-a.frames.jsonl`](node-a.frames.jsonl).

```bash
# the node, from skandha's root (FRAMES.md has the config file)
NODE_BACKEND=js ./skandha node --configFile hegota.json --dataDir /tmp/a \
  --api.port 14337 --api.wsPort 14437 \
  --p2p.port 14000 --p2p.host 127.0.0.1 --p2p.enrHost 127.0.0.1 --p2p.enrPort 14000 \
  --frames.enable --frames.handoff --frames.name A --frames.log a.frames.jsonl
# the wallet, from kohaku-rs's crates/
PRIVATE_KEY=0x... SEND_RPC_URL=http://127.0.0.1:14337/rpc/ RECORD=record.json \
  cargo run --release -p kohaku-frame-pool --example concurrent_withdrawals
```

[`record.json`](record.json) is the example's record of the run: both withdrawals' bytes and the
node's answers, and the second spend of the first note, kept as bytes because it was never mined.
After the run, a lint-only change to the example split it into helpers and dropped the record's
`value` field, which was always zero.

## Results (2026-10-20, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

| Step | Tx | Block | `gasUsed` | Frames: execution + state |
|---|---|---|---|---|
| deposit, note 1 (leaf 14) | [`0x0413fe4d...`](https://dora.privacy.ethrex.xyz/tx/0x0413fe4dfebcc11f35fded72052adca16695fff2c9e8dbd5dcd4943b014eab08) | 479,755 | 1,202,966 | |
| deposit, note 2 (leaf 15) | [`0x3318508f...`](https://dora.privacy.ethrex.xyz/tx/0x3318508f30cc5ac3fcd4212ed47bec76b2fb6b8c11ffc5e1779ad23e62322696) | 479,757 | 1,192,909 | |
| **A**, note 1: skandha `ok`, the client `valid`, handed off | [`0x5ce6a700...`](https://dora.privacy.ethrex.xyz/tx/0x5ce6a700497946b229178ad77233febfb473584531f58c3ddab93664405d2e52) | **479,761**, index 1 | 567,869 | 8272 5,579 · VERIFY 244,808 + 97,920 · W 14,381 + 183,600 |
| **B**, note 2, 397 ms later: skandha `ok`, the client `valid`, handed off | [`0xe2e65ff9...`](https://dora.privacy.ethrex.xyz/tx/0xe2e65ff9e541e298fbd17fde4eb7b977f3906248eee076f32accbaf8b34bde74) | **479,761**, index 0 | 567,833 | the same |
| **A again**, note 1 to another recipient, while A is pending | `0x82134f23...` (bytes in `record.json`) | not mined | | skandha: **`ErrReplaceUnderpriced`**; the client alone said `valid` |

The node's log ([`node-a.frames.jsonl`](node-a.frames.jsonl)):

| Time (UTC) | Event |
|---|---|
| 06:01:41.356 | A by `eth_sendRawTransaction`: `ok`, the client's verdict `valid`, head 479,760 |
| 06:01:41.472 | A handed to the client, which agreed |
| 06:01:41.753 | B: `ok`, `valid`, head 479,760, **with A still pending** |
| 06:01:41.911 | B handed to the client, which agreed |
| 06:01:42.603 | A again: `ErrReplaceUnderpriced` (FP-12: same sender, same nonce key, no price bump) |
| 06:01:44.078 | head 479,761: A and B removed, included |

The node had no peers, so its relays went nowhere (`InsufficientPeers`). Its hand-off was the only
submission.

Every mined transaction above is a fixture in `test/fixtures/chain/`.
[`rebuild.test.ts`](rebuild.test.ts) rebuilds A and B, built in Rust, with experiment 30's layout
from what a wallet decides: the proof, the slot, the fees, and limits tightened from each frame's
use, byte for byte. It checks that each note's fee is the worst-case max cost of its own shape,
as kohaku-rs computed it. It also rebuilds the same note's second spend from its bytes. kohaku-rs's
`crates/frame-pool/tests/withdrawal.rs` rebuilds A and B, and checks that they differ only in their
notes.

## Observations

1. **The wallet did not serialize.** It sent B 397 ms after A, with A pending, through a public
   mempool node. The node admitted both at the same head, and both were mined in the next block.
   The pool is one sender, and its notes are owned state inside it. The two spends did not wait
   for each other because each brings its own nonce key, and the pool's `VERIFY` reads no
   storage. A second spend of the same note has the same key, so the node can only treat it as a
   replacement, and it refused it without a price bump. The wallet can therefore send in
   parallel, and the node never holds one note twice.

2. **The two spends were linked, by what the node and the chain saw.** That half of the result is
   what would show the claim wrong, and it was observed, so it is reported as plainly:
   - **The node** received both from one client over one connection, 397 ms apart.
   - **The chain** has them in one block, at indexes 0 and 1, and they are identical except for
     the nullifier, the proof and the recipient. The recent-root frame names the same root and
     slot. The limits, the fees, and the fee each note pays are all the same:
     72,789,600 wei.

   None of these is unique to one wallet in a busy pool. Every withdrawal proven against the
   newest root shares the root and slot. Every wallet that prices with experiment 30's rule
   shares the limits and the fee. Two withdrawals in one block are common when withdrawals are
   common. On this testnet, though, the pool's only other withdrawal since block 479,025 was
   experiment 31's, and block 479,761 held these two transactions and nothing else. So the root,
   the block and the identical shape single the pair out. Sending
   concurrently is itself a signal. A wallet that wants its spends unlinked has to give that up
   in part: different nodes or relays, different times, roots at different depths. Concurrency
   and unlinkability trade against each other, and only the first comes free.

3. **The node's check and the client's differ on the second spend, as the mempool specification
   says they may.** The
   client, asked to simulate the prefix, called A again `valid`, since the nonce key was not yet
   used. The pool refused it on its identity: one sender, one key, already pending. The
   specification's conformance vectors used a stand-in for this case, and `record.json` now holds
   its real bytes.
