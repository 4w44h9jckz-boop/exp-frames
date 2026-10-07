# 06 — A privacy pool that is its own sender

A Tornado Cash pool whose withdrawals are frame transactions with `tx.sender` = **the pool**
and **no signature anywhere**. The pool's VERIFY frame checks the zero-knowledge proof, so the
proof is the authorisation. A withdrawal needs no relayer and no EOA, and with the pool paying
the gas, no paymaster either. Anyone holding the proof can hand it to any node.

The design is the one in Nero_eth's
[Frame transactions and the three gates to privacy](https://ethresear.ch/t/frame-transactions-and-the-three-gates-to-privacy/24666)
(2026-04-16). This experiment builds it on the testnet, and builds a second variant whose VERIFY
reads no storage at all, using two EIPs the testnet ships next to EIP-8141:
- [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250): keyed nonces;
- [EIP-8272](https://eips.ethereum.org/EIPS/eip-8272): recent roots.

The circuit, the notes, the trusted setup and the proofs are Tornado Cash's, unchanged. Proofs come
from [kohaku-rs](https://github.com/4w44h9jckz-boop/kohaku-rs) (branch `experiment/frames`, crate
`kohaku-frame-pool`): its existing Tornado prover, behind a small JSON CLI. Only the contract that
checks the proof is new, along with the transaction that carries it.

## The pool

[`FramePool.yul`](FramePool.yul): 1,941 bytes of runtime, followed by Tornado's 21 zero hashes and
six constructor words (verifier, hasher, denomination, mode, history, salt).

- **Deposits** are ordinary calls, `deposit(bytes32)` with 0.001 ETH. They insert into Tornado's
  height-20 MiMC tree through Tornado's hasher. The ABI and events are Tornado's.
- **Withdrawals** run in two frames:
  - The pool's **VERIFY** frame reads the withdrawal frame's calldata with `FRAMEDATALOAD`. It checks the
    frame layout, the root, the nullifier and the gas floors, then copies the proof out with `FRAMEDATACOPY`
    and `STATICCALL`s Tornado's Groth16 verifier. If all of that passes, it calls `APPROVE`.
  - The **SENDER** frame `W` calls `pool.withdraw(...)` *as the pool*. The pool accepts that call
    only when `caller == address(this)`, which only a transaction it approved can produce. `W`
    pays the recipient and, when the note names one, credits a sponsor.

Two ways of tracking roots and nullifiers are chosen at deployment:

| | mode 0, **storage** (the three-gates design) | mode 1, **keyed** |
|---|---|---|
| root | `knownRoots[root]` in the pool's storage. `history` = 0 keeps every root, H keeps the last H in a ring (Tornado: 30) | each deposit writes the root to the EIP-8272 predeploy. The withdrawal names `(source_id, slot, root)` in a recent-root VERIFY frame, frame 0, and the protocol checks it |
| nullifier | `nullifierHashes[n]` in storage: VERIFY checks it, `W` sets it | the nullifier hash **is the transaction's only nonce key**, at `nonce_seq` 0. The protocol refuses a second use |
| VERIFY reads storage | yes | **no** |
| nonce | the pool's account nonce, key `[0]` | `nonce_keys = [nullifierHash]` |

Frame layouts the pool's VERIFY accepts. `W` is always last:

| | frame 0 | frame 1 | frame 2 | frame 3 |
|---|---|---|---|---|
| storage, pool pays | VERIFY pool, `APPROVE_EXECUTION_AND_PAYMENT` | SENDER `W` | | |
| storage, sponsor pays | VERIFY pool, `APPROVE_EXECUTION` | VERIFY sponsor, `APPROVE_PAYMENT` | SENDER `W` | |
| keyed, pool pays | VERIFY `0x…8272` (recent-root tuple) | VERIFY pool, `APPROVE_EXECUTION_AND_PAYMENT` | SENDER `W` | |
| keyed, sponsor pays | VERIFY `0x…8272` | VERIFY pool, `APPROVE_EXECUTION` | VERIFY sponsor, `APPROVE_PAYMENT` | SENDER `W` |

**When the pool pays**, the note's `relayer` must be the pool and its `fee` must cover the
transaction's maximum cost (`TXPARAM(0x06)`). The pool keeps the fee and pays the builder from its
own balance, so the gas is paid by the note. **When a sponsor pays**,
[`PoolSponsor.yul`](PoolSponsor.yul) approves payment only for a transaction whose sender is the pool
and whose `W` names the sponsor as `relayer`, with a fee that covers the maximum cost. The proof binds
both fields.

Every SENDER frame runs as the pool, so the VERIFY path checks the layout *exactly*. It also floors
`W`'s execution (100,000) and state gas: 183,600 for a new recipient account, plus 97,920 for the
nullifier slot in mode 0, plus 97,920 for the sponsor's first credit. Nobody can starve `W` after
approval. In mode 1 a failed `W` would burn the note, because the nonce key is consumed when payment
is approved. For the same reason `W` never reverts: a recipient that refuses ETH is credited
instead (`owed`, `claim`).

### Vendored and patched

[`vendor/`](vendor/) holds Tornado's MiMCSponge hasher and Groth16 verifier as kohaku-rs ships them
(`crates/fork-kit/fixtures/{hasher,verifier}.json` at `68e80ad`). The verifier calls each pairing
precompile as `staticcall(sub(gas(), 2000), …)`, which compiles to `PUSH2 0x07d0, GAS, SUB, STATICCALL`.
A validation trace may use `GAS` only immediately before a `*CALL`. `patchVerifier` in
[`pool.ts`](pool.ts) rewrites those five bytes as `PUSH0 POP PUSH0 POP GAS`. The length, the stack
effect and every jump offset are unchanged, and the call forwards all gas instead of all but 2,000.
Both versions are deployed.

### Proofs

`pool.ts` calls kohaku-rs's `frame-pool` binary: `note` (commitment and nullifier hash), `zeros`, and
`prove` (note, leaves, recipient, relayer, fee → proof and public inputs). Notes are derived from
`PRIVATE_KEY`, as experiment 05 derives its owners, so nothing new is stored. A proof takes 1.7 s
in release mode. `withdraw.ts` checks each pool's on-chain root against the Rust tree before it
withdraws.

## Run

```bash
cargo build --release -p kohaku-frame-pool --manifest-path ../kohaku-rs/crates/Cargo.toml  # or set FRAME_POOL_CLI
npx tsx experiments/06-privacy-pool/setup.ts        # deploy everything, deposit the notes (idempotent)
npx tsx experiments/06-privacy-pool/withdraw.ts     # the four layouts, mined
npx tsx experiments/06-privacy-pool/concurrency.ts  # two withdrawals at once, five ways (mined)
npx tsx experiments/06-privacy-pool/ring.ts         # ring history vs append-only (one shot, mined)
npx tsx experiments/06-privacy-pool/negative.ts     # simulations only
# the keyed deposit and withdrawal again, all in Rust (reads PRIVATE_KEY from the environment):
cargo run --release -p kohaku-frame-pool --example keyed_withdrawal --manifest-path ../kohaku-rs/crates/Cargo.toml
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

| Contract | Address | Code |
|---|---|---|
| MiMCSponge hasher | `0x38955FBe81DBf136A84A1c711619C0Ab8Ce7813b` | 11,035 B |
| Groth16 verifier, stock | `0xfFB8225aD722945Cd681635D53720EFC6Ef865D1` | 4,304 B |
| Groth16 verifier, patched | `0x87a7C1f76b03dA00de489897d436BbEDDd2133b7` | 4,304 B |
| pool, storage, every root kept | `0xa082522bF0745bDC93e91427ea0321Ec605f508c` | 2,805 B |
| pool, storage, ring of 2 | `0xA3fc00a996A24b1ec1338dd446599E48Add485B5` | 2,805 B |
| pool, keyed | `0x73e47a8DA2C83Beb802708Fc473B5B7D094f3eE6` | 2,805 B |
| pool, storage, stock verifier | `0x2c6F36eD948D5698d2C7f5b3D5DaBF110B1F58b7` | 2,805 B |
| sponsor for the storage pool | `0x33B0D552fcD46b67f5FaB4E3CDB42cCE32C0C5d2` | 251 B |
| sponsor for the keyed pool | `0x69e45f4AaA9CdF2ed9c083E0f73C56b03929140C` | 251 B |

A deposit costs about 1.0M execution gas for the first note and about 740k after. That is 40
MiMCSponge calls, plus state gas for fresh slots.

### Withdrawals (`withdraw.ts`, mined)

Recipients are fresh addresses, so every payout creates an account. Execution gas is shown as used
/ limit, and state gas as used.

| Tx | Layout | Frames: execution / state gas | `gasUsed` |
|---|---|---|---|
| [`0x9d827f05…`](https://dora.privacy.ethrex.xyz/tx/0x9d827f05d02355ad4a06707b8bea44cdb4910b88e98cc04760c598728e9a1ed0) | storage, pool pays; proven against the root after the *first* deposit | VERIFY **248,982**/0 · W 24,694/281,520 | 574,662 |
| [`0xa119ee00…`](https://dora.privacy.ethrex.xyz/tx/0xa119ee0009edecf6d7da588978ff3c49fa6b1c9a55ff00292d37c8d44ab7720b) | storage, sponsor pays | VERIFY **248,991**/0 · sponsor 3,353/0 · W 37,026/379,440 | 688,775 |
| [`0x7c36ba99…`](https://dora.privacy.ethrex.xyz/tx/0x7c36ba99b08c3aadeea368065288f662f857a05be343d7d23343aee9d1a9a869) | keyed, pool pays | 8272 5,579/0 · VERIFY **244,808**/97,920 · W 14,381/183,600 | 567,845 |
| [`0x35a01d11…`](https://dora.privacy.ethrex.xyz/tx/0x35a01d1149d8b34185c02a50a41e08c4b86bb0b6a71f96e8ada4817dc4a724c6) | keyed, sponsor pays | 8272 5,579/0 · VERIFY **244,817**/0 · sponsor 3,353/97,920 · W 26,713/281,520 | 681,946 |

Each recipient received 0.001 ETH − 10^10 wei (the fee). Every `gasUsed` is intrinsic + execution
+ state exactly; the calldata floor (46–54k) never binds. Intrinsic gas is 19,466 to 22,044:
12,000, plus 475 per frame, plus 6.5–8.1k of calldata for the 516-byte `W` and the 72-byte
recent-root tuple. State gas is the same in both modes: 97,920 for the nullifier slot in mode 0,
or for the first use of the nonce key in mode 1, which the frame that approves payment pays.

### The same flow from Rust (kohaku-rs, mined)

kohaku-rs `experiment/frames` now carries the transaction side as well as the prover. The crate
`kohaku-frame-kit` covers the envelope, the signature hash, gas, secp256k1 and P256 signing, and
simulation and submission. `kohaku-frame-pool` adds a withdrawal builder, and its test rebuilds
every withdrawal in the table above byte for byte. Its example `keyed_withdrawal` runs a deposit
and a withdrawal on the keyed pool with no TypeScript involved:

| Tx | What | Frames: execution / state gas | `gasUsed` |
|---|---|---|---|
| [`0x2e1062ef…`](https://dora.privacy.ethrex.xyz/tx/0x2e1062eff41081693e9f1e5c0c30831be92e716e5eb43d104fce677d290d90fd) | deposit, signed in Rust by the funder | VERIFY 100/0 · SENDER 1,003,810/195,840 | 1,223,152 |
| [`0x7fa5825c…`](https://dora.privacy.ethrex.xyz/tx/0x7fa5825c354120258bde7201b5a9d9342b04d1cfbea8fb99b80f27362f029017) | keyed, pool pays, built in Rust | 8272 5,579/0 · VERIFY **244,808**/97,920 · W 14,381/183,600 | 567,821 |

Every frame's gas matches `0x7c36ba99…`. The `gasUsed` is 24 lower because the calldata differs:
a different proof, root, nullifier and recipient, and calldata is priced per byte. Both
transactions are in `test/fixtures/chain/`, so the TypeScript encoder checks the Rust-built ones,
and kohaku-rs keeps the same fixtures for its own checks.

### Two withdrawals at once (`concurrency.ts`, mined)

Each pair is built and proven first, then sent with `eth_sendRawTransaction` about 220 ms apart.

| Pool and payer | Second withdrawal | Result |
|---|---|---|
| keyed, pool pays | another note | **both admitted, both mined in block 304240** (`0x5fb29fe1…`, `0x2719e945…`) |
| keyed, sponsor pays | another note | refused: `Non-canonical paymaster already sponsors the maximum number of pending frame transactions` |
| storage, pool pays | another note, same nonce | refused: `Attempted to replace a pooled transaction with an underpriced transaction` |
| storage, pool pays | another note, nonce + 1 | refused: `validation-prefix simulation failed: … Nonce mismatch: expected 5, got 6` |
| storage, pool pays | another note, same nonce, **double the fees** | **admitted, and the first withdrawal vanished from the pool**. The second was mined. The first had to be rebuilt on the new nonce and sent again |
| keyed, pool pays | **the same note**, to another recipient | refused: `Attempted to replace a pooled transaction with an underpriced transaction`. Same nonce key, so it can only replace the first |

The sponsored keyed withdrawal that was admitted landed in block 304240 too: three withdrawals
from the same `tx.sender` in one block.

### Root history (`ring.ts`, mined, pool keeping 2 roots)

| Step | Same withdrawal, simulated |
|---|---|
| 1 deposit; proof against R1, the newest root | valid, VERIFY 251,065 |
| 2 deposits; R1 is the older of two | valid, VERIFY 253,278 |
| 3 deposits; R1 rotated out | **invalid**: validation prefix frame reverted |
| proven again against the current root | mined, [`0x630cd8d6…`](https://dora.privacy.ethrex.xyz/tx/0x630cd8d64f490a3887f84186ae222b5045966b530052d4f9f66a2d675cff872f) |

In the append-only pool, the first withdrawal above was proven against the root after the first of
three deposits and was accepted (VERIFY 248,982).

### What VERIFY and the node refuse (`negative.ts`, simulated)

| Case | `valid` | Node says |
|---|---|---|
| **storage pool, pool pays** | | |
| valid | true | VERIFY 248,982 gas |
| an extra SENDER frame moves 0.0005 ETH out of the pool | false | validation prefix frame reverted |
| recipient swapped in the withdraw frame | false | validation prefix frame reverted |
| fee lowered in the withdraw frame | false | validation prefix frame reverted |
| root replaced by one the pool never had | false | validation prefix frame reverted |
| a spent note | false | validation prefix frame reverted |
| relayer is not the pool, while the pool pays | false | validation prefix frame reverted |
| withdraw frame execution limit 99,999 | false | validation prefix frame reverted |
| withdraw frame state limit one short of the floor | false | validation prefix frame reverted |
| withdraw frame carries value | false | validation prefix frame reverted |
| withdraw frame has the atomic-batch flag | false | `Frame 1: atomic batch flag on last frame` |
| max fee 20,000 wei: max cost exceeds the note fee | false | validation prefix frame reverted |
| VERIFY limit 100,000 (the spec's `MAX_VERIFY_GAS`) | false | `BannedOpcode(254)` |
| VERIFY limit 500,001 | false | `prefix gas budget exceeded: 500001 > 500000 (MAX_VERIFY_GAS)` |
| sponsored: valid | true | VERIFY 248,991 gas |
| sponsored: the paying sponsor is not the one the note names | false | validation prefix frame reverted |
| **storage pool, stock verifier** | | |
| valid layout, `PUSH2 2000, GAS, SUB, STATICCALL` | false | `BannedOpcode(90)`: `GAS` |
| **keyed pool, pool pays** | | |
| valid, proven against a root of an earlier slot | true | VERIFY 244,808 gas |
| nonce key is not the nullifier hash | false | validation prefix frame reverted |
| a second nonce key besides the nullifier hash | false | validation prefix frame reverted |
| legacy nonce key `[0]` | false | validation prefix frame reverted |
| a spent note, `nonce_seq` 0 | false | `Nonce mismatch: expected 1, got 0` |
| **a spent note, `nonce_seq` 1**: the protocol's nonce check passes | false | validation prefix frame reverted: the pool requires sequence 0 |
| recent-root frame names a root since overwritten in its slot | false | `EIP-8272 recent-root reference is not committed in the RECENT_ROOT_ADDRESS predeploy at head state` |
| recent-root frame: slot off by one | false | same |
| recent-root frame: another salt, so another source | false | same |
| no recent-root frame | false | validation prefix frame reverted |
| sponsored: valid | true | VERIFY 244,817 gas |
| sponsored: sponsor frame without state for the nonce key | false | validation prefix frame reverted |
| pool pays: VERIFY frame without state for the nonce key | false | validation prefix frame reverted |

## Observations

1. **The proof is the signature.** No transaction above carries a signature. In the pool-pays
   layouts the pool is the only account that sends, approves or pays. There is no relayer to trust,
   pay or find, and no EOA to fund from somewhere linkable. The fee comes out of the note: the pool
   pays the builder from its balance and keeps the note's fee. After the 16 withdrawals here, each
   pool holds its unspent notes plus a surplus just under 10^10 wei per withdrawal it paid for.
   - Tornado's classic flow needs a relayer EOA. Its 4337 version in kohaku-rs needs a bundler run
     with `--safe-mode false` and a paymaster that calls `withdraw` during validation.
2. **Groth16 fits the testnet's `MAX_VERIFY_GAS` and not the spec's.**
   - VERIFY is 245–249k, almost all of it the verifier's precompile calls (6 `ecMul`, 6 `ecAdd`,
     one 4-pair pairing). That is under the testnet's 500,000 and two and a half times the EIP's 100,000.
   - At a 100,000 limit the node does not report out-of-gas. It reports `BannedOpcode(254)`:
     Tornado's verifier executes `INVALID` when a pairing precompile call fails, and `INVALID` is
     banned in a validation trace.
   - A Groth16 pool in the public mempool needs the cap at roughly 250k, or a cheaper verifier.
3. **No stock snarkjs-style verifier can run in VERIFY.**
   - Tornado's verifier and snarkjs's current template (`templates/verifier_groth16.sol.ejs`,
     master, read 2026-10-07) both call the precompiles with `staticcall(sub(gas(), 2000), …)`.
     The `GAS` that is not immediately followed by a call is banned (`BannedOpcode(90)`).
   - The fix is five bytes and changes no behaviour that matters. But every ZK application would
     have to know it, and it bites only at mempool admission, never in a block or in `eth_call`.
4. **In the storage design, the whole pool has one pending withdrawal, and its users can evict
   each other.**
   - Every withdrawal has the same sender. Its prefix reads the pool's storage, so EIP-8141's
     one-pending-per-sender rule applies.
   - A second withdrawal built on the same nonce is a replacement: refused when it pays the same
     fee, and *evicting the first user's withdrawal* when it pays double.
   - A second withdrawal on the next nonce is refused, because the prefix is simulated against
     head state.
   - At one pending transaction per pool, withdrawals serialise behind one another.
5. **The keyed design makes VERIFY storage-free, and the node then admits concurrent
   withdrawals.**
   - With the nullifier as the nonce key and the root in an EIP-8272 frame, the prefix reads no
     sender storage. ethrex's `keyed_concurrency_verdict` (`crates/blockchain/mempool.rs`) then
     admits transactions on disjoint keys side by side. Two withdrawals from the same sender were
     pending together and mined in the same block.
   - Double-spending is the protocol's problem. Two transactions with the same note share a key,
     so the second is a replacement, not a second spend (measured). Once mined, the key's sequence is 1.
   - **The pool must still insist on `nonce_seq == 0`.** A spent note sent with `nonce_seq` 1
     passes the protocol's nonce check. Only the pool's check stops it being paid twice.
   - This is admission policy: EIP-8250 keeps "one pending frame transaction per sender", and
     ethrex documents this as a deliberate divergence (`docs/eip-8250.md`; ethereum/EIPs#12039
     proposes it upstream).
6. **A sponsor brings the bottleneck back.** A non-canonical paymaster may have one pending
   transaction, so a sponsored keyed pool is again one-at-a-time per sponsor. The pool paying from
   the note's fee is the layout that scales. The canonical paymaster cannot help: it authorises by
   signature and cannot read a proof.
7. **Which deposits invalidate pending withdrawals depends on how roots are kept.**
   - **Ring buffer:** a withdrawal stops being valid once H more deposits have rotated its root
     out. It goes from valid to invalid with no change of its own. Each older probe also costs
     VERIFY 2,213 gas, so a root at the far end of Tornado's 30 adds about 64k.
   - **Append-only:** never invalidates, at one `SLOAD`. A deposit writes no slot a pending
     withdrawal's VERIFY read: it adds a fresh `knownRoots` entry. A ring deposit overwrites the
     current index and a ring slot, both of which VERIFY reads.
   - **Keyed pool:** roots expire by time, not by deposit count. The window is 8,191 slots: 13.7
     hours on this testnet, whose slots are 6 seconds, and 27.3 hours at mainnet's 12. Anyone can
     refresh the root with `republish()`.
8. **EIP-8272 keeps one root per source per slot.** Its storage key is `slot mod 8192`, so a second
   write in the same slot replaces the first. The keyed pool's first four deposits went in one
   transaction, and only the fourth root remained usable: proving against the first is refused at
   admission. A wallet must prove against the last root of a slot. Earlier slots stay usable: a
   withdrawal proven against the previous slot's root, one deposit old, was valid.
9. **What an observer sees is Tornado's withdrawal, minus the relayer.** The envelope shows the
   pool as sender (and payer, or the sponsor), plus the proof's public inputs: root, nullifier
   hash, recipient, fee. In the keyed design the nullifier hash appears a second time, as the
   nonce key. That reveals nothing new, since it is already in the calldata, but it is now
   protocol state in `NONCE_MANAGER`, one slot per spent note, forever.
10. **Nothing binds the envelope but the pool.** With no signature, anyone can take a pending
    withdrawal and resubmit it with other fees, gas limits or frames. The proof binds recipient,
    relayer and fee. Everything else is bound by VERIFY:
    - the exact layout;
    - the floors on `W`;
    - `fee >= max cost`, which caps what a re-priced copy costs the pool;
    - in mode 1, the nonce key and sequence.

    The payout cannot change. The negative table exercises each of these.
11. **The post's three gates (mempool admission, FOCIL, node capability), as far as this
    experiment reaches.**
    - *Mempool admission* is what was measured: it passes on this testnet with the 500k cap and the
      patched verifier, and would not under the spec's 100k. Concurrency comes only with the keyed
      design.
    - *FOCIL* was not exercised. From the source, ethrex's EIP-8369 profile 2 limits validation
      reads to a "VOPS surface" of a sender's first slots. The keyed design's VERIFY reads no
      storage; the storage design reads `keccak`-addressed mapping slots.
    - *Node capability* was not tested separately: everything ran on one client, ethrex.
