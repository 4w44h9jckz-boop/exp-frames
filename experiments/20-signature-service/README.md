# 20 — Signatures as a service: contracts that read the protocol's verdicts

A frame transaction carries a list of signatures. The protocol verifies every SECP256K1 and P256
entry before the first frame runs, and refuses the whole transaction if one fails. An entry can
sign the transaction's sig hash (`msg` ∅), or an explicit 32-byte digest that someone else chose.
Any contract running in any frame can read an entry's metadata with `SIGPARAM`: its scheme, its
`signer`, and its `msg`. The signature bytes themselves are not readable. "Entry 1 is scheme 1,
signer S, msg D" therefore means "S signed D", checked by the protocol rather than by the
contract.

Every experiment so far used this for accounts, which read the entries in VERIFY. This one gives it
to ordinary contracts:
- a token whose holders move tokens by signature;
- an exchange that fills signed orders;
- a vote counter.

Each is compared with the contract checking the same signature itself, with `ecrecover` or with
the `P256VERIFY` precompile at `0x100`, which exists on this testnet. The question is the one the
plan asked (Track E): does a contract gain anything from letting the protocol check signatures for
it, and what does it cost?

[`SigReader.yul`](SigReader.yul) is 78 bytes. It returns `[scheme, signer, msg]` for a range of
entries. Solidity cannot emit `SIGPARAM`, so the Solidity contracts STATICCALL it. That makes
"signatures as a service" literal: one deployed contract that any other contract can ask.
[`SigService.sol`](SigService.sol) holds the rest. `SigUser` asks the reader, and `Eip712` builds
domain-separated digests and runs the two in-EVM checks with the same rules the protocol applies
(low s, `v` 0 or 1, the P256 signer as $\texttt{keccak256}(q_x \Vert q_y)_{[12:]}$).

| Contract | Function | Signature checked by |
|---|---|---|
| `SigToken` | `transferBySig(from, to, value, index)`, `approveBySig(owner, spender, value, index)` | the protocol: entry `index` must be `from`'s, over the EIP-712 digest at `from`'s nonce |
| | `transferByEcrecover(from, to, value, v, r, s)` | the token, with `ecrecover` |
| | `transferByP256(from, to, value, r, s, qx, qy)` | the token, with `P256VERIFY` |
| `Exchange` | `fill(order, index)` | the protocol: entry `index` must be the maker's, over the order digest |
| `Quorum` | `countBySig(proposal, choice, first, n)` | the protocol: `n` entries over one vote digest, signers ascending |
| | `countByEcrecover(proposal, choice, sigs)`, `countByP256(…)` | the contract, `n` times |

| File | What |
|---|---|
| [`SigReader.yul`](SigReader.yul) | `SIGPARAM` as a callable service |
| [`SigService.sol`](SigService.sol) | `SigUser`, `Eip712`, `SigToken`, `Exchange`, `Quorum` |
| [`service.ts`](service.ts) | Keys (bob, carol, alice as secp256k1 and as P256, voters), addresses, `signedEntry`, `relayed` |
| [`example-sigs.ts`](example-sigs.ts) | Setup; A, one transfer four ways; B, a passkey-signed order; C, entries lifted by someone else |
| [`quorum.ts`](quorum.ts) | The cost of one more signature, four ways; the most entries one transaction can carry |
| [`negative.ts`](negative.ts) | What the protocol refuses and what is left to the contract |

## Run

```bash
npx tsx experiments/20-signature-service/example-sigs.ts   # setup (once), then A, B, C
npx tsx experiments/20-signature-service/quorum.ts         # N = 1 .. 64, four ways
npx tsx experiments/20-signature-service/quorum.ts limit   # the MAX_VERIFY_GAS edge
npx tsx experiments/20-signature-service/negative.ts
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

| Name | Address |
|---|---|
| SigReader | `0x00c10FB166Cd1c3f707A4B8956596952629B74D1` |
| SigToken TKA / TKB | `0xABf8ECCc911f44885340b0358F1e711C9104579F` / `0x871164AFFd20aC711198d9Eca10f1BD080d17163` |
| Exchange | `0x72F7634A32cEEe7BB52528856bbFe0891e5aEbcE` |
| Quorum | `0x84922e0a492f2BC6d555Dd07d25005EEdD48d6CC` |
| bob (relays, takes) / carol (receives, front-runs) | `0x0F8b0c9CbE0a0815F4079171f8ea51972DD67a76` / `0xdA0d6a42Fbc679ad6952f76A8F3E1515B1986C3E` |
| alice, secp256k1 key, never funded | `0xA9F980B6bC11BCE30a9aC27BA555b0865c60223E` |
| alice, P256 key: $\texttt{keccak256}(q_x \Vert q_y)_{[12:]}$, no secp256k1 key exists | `0x31A7e44E026fD179786E92aCDC50C92cd365f207` |

Setup deployed the five contracts in one transaction,
[`0xbb57dbc8…`](https://dora.privacy.ethrex.xyz/tx/0xbb57dbc8a388c004882c31e4d0be09f22e275dbf3d8dd68ce152eff1c58ef2be),
for 26,745,004 gas, nearly all of it code at 1,530 gas a byte. A second transaction funded bob and
carol and minted,
[`0xc82e569a…`](https://dora.privacy.ethrex.xyz/tx/0xc82e569a3c78c523e180b09a2fb936d776882876870c82d66c7e74e5f54a0eb3).

### A. A gasless transfer, four ways

bob relays `1 TKA` from alice to carol and pays the gas. Alice's only act is a signature. The
transaction is `[VERIFY(bob), SENDER(bob → TKA)]`. In the protocol rows, the signature list is
`[bob ∅, alice over the digest]`. Round 1 includes the first write of alice's nonce slot (97,920
state gas), paid by whichever method ran first for that key. Round 2 is the comparison.

| Round | Method | Tx | `gasUsed` | intrinsic | floor | transfer frame |
|---|---|---|---|---|---|---|
| 1 | SIGPARAM, secp256k1 entry | [`0xa81dc047…`](https://dora.privacy.ethrex.xyz/tx/0xa81dc047f14046367d924355b998c18b3fd0a67a1c5dc4a28638e7398c907f9f) | 168,939 | 22,638 | 38,838 | 48,281 + 97,920 state |
| 1 | `ecrecover` | [`0xc382e06c…`](https://dora.privacy.ethrex.xyz/tx/0xc382e06ce42357dbfba1d2f7c2fe99470b79c6419b0179165abf27b6fba5754a) | 66,192 | 18,978 | 32,646 | 47,114 |
| 1 | SIGPARAM, P256 entry | [`0xcc0ec867…`](https://dora.privacy.ethrex.xyz/tx/0xcc0ec867f65e0ecec390fca9c8c1030ab0a20d479eb5cdd67c8dda6c5c331619) | 173,849 | 27,534 | 46,770 | 48,295 + 97,920 state |
| 1 | `P256VERIFY` | [`0xd76f03f0…`](https://dora.privacy.ethrex.xyz/tx/0xd76f03f0de58a92056d49e1e253da9fce3c90e193b2e0925ab71dd795f20f24f) | 71,328 | 19,874 | 34,694 | 51,354 |
| 2 | SIGPARAM, secp256k1 entry | [`0x13a2d8a6…`](https://dora.privacy.ethrex.xyz/tx/0x13a2d8a6511f35afb8aff671a90a0a63e11f4373b7ee9936d5882a5d6f085767) | **71,019** | 22,638 | 38,838 | 48,281 |
| 2 | `ecrecover` | [`0xf24cbdb1…`](https://dora.privacy.ethrex.xyz/tx/0xf24cbdb1ecf616bf0a5f491419cc8830e05a0ee23a3f3720f640006606065012) | **66,204** | 18,990 | 32,646 | 47,114 |
| 2 | SIGPARAM, P256 entry | [`0x9790756d…`](https://dora.privacy.ethrex.xyz/tx/0x9790756d730306caeb674f25530ddcc2eeea0969f2343c5901697b9aad11cc11) | **75,929** | 27,534 | 46,770 | 48,295 |
| 2 | `P256VERIFY` | [`0xcafc2725…`](https://dora.privacy.ethrex.xyz/tx/0xcafc27256e9f120f6f0924f1b8830f7a63707c7922963a36f645c1bf0bc0c76a) | **71,292** | 19,838 | 34,694 | 51,354 |

### B. A passkey-signed order, filled by bob

Alice's P256 address holds TKA and has never had code, ETH or a secp256k1 key. She signs two
digests: an approval of the exchange for 10 TKA, and an order selling 10 TKA for 5 TKB. bob's
transaction carries both as entries 1 and 2, behind his own entry 0. Frames 1-3 are one atomic
batch:
1. `TKA.approveBySig(alice, exchange, 10, 1)`;
2. `TKB.approve(exchange, 5)`, bob's own;
3. `Exchange.fill(order, 2)`.

| | alice (P256) | bob |
|---|---|---|
| before | 996 TKA / 1 TKB | 0 TKA / 1000 TKB |
| [`0xe4a94f7b…`](https://dora.privacy.ethrex.xyz/tx/0xe4a94f7b09f0fb9818914b5ffce1c59a0d4eeaf8cbba85792c2a9daca3b16a50), 349,105 gas | | |
| after | 986 TKA / 6 TKB | 10 TKA / 995 TKB |

Most of the 349,105 is state: 195,840 for two fresh slots at 97,920 each, the order marked filled
and bob's first TKA balance, all charged to the fill frame. The two allowances, alice's TKA and
bob's TKB, go from zero to the order's amounts and back to zero inside the transaction, so their
frames are charged no state gas, and restoring each originally empty slot refunds 10,000 at
settlement. The simulation reported 369,105, the 20,000 more than the receipt that
`ethrex_simulateFrameTransaction`'s `gasUsed` leaves out because it does not apply the refund.

### C. The same entries, lifted by carol

An explicit-digest entry is a signature over a digest, not over a transaction. The script builds
and signs bob's transaction for a fresh order, which is what a public pool would show anyone. carol
copies alice's two entries byte for byte into a transaction of her own, with the same frames:

| Order | carol's copy | bob's own fill, afterwards |
|---|---|---|
| open (taker 0) | **mined, success**: [`0xfb8bb650…`](https://dora.privacy.ethrex.xyz/tx/0xfb8bb650f4d4ff7fb846e4bedcbc4ea5f7c563b515e7a1b37c3a48608af3fb31), 251,161 gas; carol receives the 10 TKA and pays the 5 TKB | simulates valid, with frame 1 failing (alice's approve nonce is spent): bob would pay for nothing |
| for bob only (`taker` = bob) | mined, batch reverted at the fill: [`0x79b57ad5…`](https://dora.privacy.ethrex.xyz/tx/0x79b57ad51e64dada11d2133ad54996910f6acfbac12be7232d817cce4d7a11b4), 101,435 gas, paid by carol | **mined, success**: [`0x2498fe31…`](https://dora.privacy.ethrex.xyz/tx/0x2498fe3185593ae6c2c689a8de77cb3b399a8103876ed674fac4fc2f62365446), 251,632 gas. carol's failed batch had rolled back alice's approval, so the same entries still worked |

### D. One more signature, four ways

bob relays one transaction per row, counting $N$ votes over one digest. In the protocol rows, the
votes are $N$ explicit-digest entries after bob's own, and `countBySig` reads them through one
SigReader call. In the in-EVM rows, the same signatures are frame data: 65 bytes each for
`ecrecover`, and 128 for `P256VERIFY` ($r, s, q_x, q_y$). Every signer is distinct and they are
sorted. "Bound" says which side of the settlement rule set `gasUsed`: the transaction's execution,
or the calldata floor.

| $N$ | Method | Tx | `gasUsed` | bound | count frame |
|---|---|---|---|---|---|
| 1 | protocol, secp256k1 | [`0xa7426464…`](https://dora.privacy.ethrex.xyz/tx/0xa74264647251200f15dbfe603f10e0c951cdfdb9b03dced3b67310cc594ca9f4) | 38,838 | floor | 10,810 |
| 1 | `ecrecover` | [`0xe4873853…`](https://dora.privacy.ethrex.xyz/tx/0xe4873853882b71e03ea01536ebd3b680b1c7f50a315c220e0f18e3f1d8f12d87) | 34,694 | floor | 10,643 |
| 1 | protocol, P256 | [`0x9a7c0e1a…`](https://dora.privacy.ethrex.xyz/tx/0x9a7c0e1a075c346defb4bdea433fee2a31b7f227522cf605c4bd9f1cca48cfd8) | 46,770 | floor | 10,824 |
| 1 | `P256VERIFY` | [`0xbe65dda1…`](https://dora.privacy.ethrex.xyz/tx/0xbe65dda1a2bb84772d5fc474ca56a6454366e3b29628ef6b4ba37ada661784ab) | 36,742 | floor | 15,263 |
| 2 | protocol, secp256k1 | [`0x94b50b52…`](https://dora.privacy.ethrex.xyz/tx/0x94b50b526777b907e067c76f61b7d63ed843cbb944da53e8c78d819c8a3d33b3) | 49,126 | floor | 12,059 |
| 2 | `ecrecover` | [`0x4dac0b0d…`](https://dora.privacy.ethrex.xyz/tx/0x4dac0b0dace6890ab1780aafc608a1762d136788e39b6c08c2976022780fa8e7) | 38,790 | floor | 15,214 |
| 2 | protocol, P256 | [`0xcef20e3a…`](https://dora.privacy.ethrex.xyz/tx/0xcef20e3a535a038780ad32b6b69856648247551e01ea5140d5166ddade7425c8) | 64,990 | floor | 12,087 |
| 2 | `P256VERIFY` | [`0x2be89ade…`](https://dora.privacy.ethrex.xyz/tx/0x2be89ade8282c39018b6179ab70cf7021d5fdeed441fc3f791ba709ad422fa62) | 46,115 | execution | 24,469 |
| 4 | protocol, secp256k1 | [`0xbd65c3ad…`](https://dora.privacy.ethrex.xyz/tx/0xbd65c3ad1e6c5570899f1d936ca938870b97e89d2a1d427603bd8040ebb8616c) | 69,702 | floor | 14,560 |
| 4 | `ecrecover` | [`0xcc5c2fa4…`](https://dora.privacy.ethrex.xyz/tx/0xcc5c2fa4e62e586e09382e46c524f251938fd931cc5ec28eeb98e5a9be0ef7cc) | 46,982 | floor | 24,356 |
| 4 | protocol, P256 | [`0xf1e4bca4…`](https://dora.privacy.ethrex.xyz/tx/0xf1e4bca4aaa8dbd459fef93076f6e2c6f1270bd2fc4e0200a6a711671565b817) | 101,430 | floor | 14,616 |
| 4 | `P256VERIFY` | [`0xa7d3d128…`](https://dora.privacy.ethrex.xyz/tx/0xa7d3d12825500c93d037c50b92ae8cd520f2f6684b7e83991f27a5789ce0ab58) | 68,601 | execution | 42,883 |
| 8 | protocol, secp256k1 | [`0x8e82adb4…`](https://dora.privacy.ethrex.xyz/tx/0x8e82adb48a11c16f19dbc3b8f1c95a0b6bcb2ad9b77c919dbab49a548ba0344b) | 110,854 | floor | 19,572 |
| 8 | `ecrecover` | [`0x784311ca…`](https://dora.privacy.ethrex.xyz/tx/0x784311ca0e63c63c18b2d8e08e4c54fa71f82de8fd23f61b225364ed7f969153) | 68,511 | execution | 42,641 |
| 8 | protocol, P256 | [`0x00c7431e…`](https://dora.privacy.ethrex.xyz/tx/0x00c7431e3ba1d1a0aac08d5312f4532b7cb7e8984ece41f02b051c73c54562ed) | 174,310 | floor | 19,684 |
| 8 | `P256VERIFY` | [`0x79df7de2…`](https://dora.privacy.ethrex.xyz/tx/0x79df7de2f4e95650ff01327780cd374069e058e8f4c24ea9e9214036fa4c3bee) | 113,615 | execution | 79,717 |
| 16 | protocol, secp256k1 | [`0xb3535b42…`](https://dora.privacy.ethrex.xyz/tx/0xb3535b427b24ea620e0442a24def957c02c599e6bae1bb943bd7237c9874c6b9) | 193,158 | floor | 29,633 |
| 16 | `ecrecover` | [`0x4758efe5…`](https://dora.privacy.ethrex.xyz/tx/0x4758efe556639b7ce497e94b849a26d8d33a45ec44e9c88497522c92a93c4d62) | 113,284 | execution | 79,210 |
| 16 | protocol, P256 | [`0x5695d242…`](https://dora.privacy.ethrex.xyz/tx/0x5695d242f5d68085fb8baf83bafc9c295566baa9744d35577bdf5d519077746e) | 320,070 | floor | 29,857 |
| 16 | `P256VERIFY` | [`0x6a54e4d8…`](https://dora.privacy.ethrex.xyz/tx/0x6a54e4d8ef99284e8ff32be55becef73fbff3705a2880125edb92aec8e6715a9) | 203,654 | execution | 153,408 |
| 32 | protocol, secp256k1 | [`0x46d84a31…`](https://dora.privacy.ethrex.xyz/tx/0x46d84a317f34f5009bed428fdb610aa0c5a4e3aae03462fdb6c35da494aa89a5) | 357,766 | floor | 49,910 |
| 32 | `ecrecover` | [`0x6f358212…`](https://dora.privacy.ethrex.xyz/tx/0x6f3582128cb2f411c7d9d8c569fa5a5bbfcc34182b89d2e3aad7252501e8e1f0) | 202,890 | execution | 152,348 |
| 32 | protocol, P256 | [`0xcd62925a…`](https://dora.privacy.ethrex.xyz/tx/0xcd62925a0eb3f74855705e6596d36632a343184d1e28ae759a8e5b128f345d2c) | 611,590 | floor | 50,358 |
| 32 | `P256VERIFY` | [`0x537f6a86…`](https://dora.privacy.ethrex.xyz/tx/0x537f6a860816d58f88c4bfb9b57d98bdc34cf2f6585f5082ff31ec3d06aa353e) | 383,822 | execution | 300,880 |
| 64 | protocol, secp256k1 | [`0x65ee774e…`](https://dora.privacy.ethrex.xyz/tx/0x65ee774e0965e996a13b4e7f2ea07dab8c540bb71af2a889965da4d23eafc68c) | 686,982 | floor | 91,079 |
| 64 | `ecrecover` | [`0x8a7a794c…`](https://dora.privacy.ethrex.xyz/tx/0x8a7a794c81adb019ce7e27193631dba10e5729c97d22d68dc1fd9a9bc8d19c4b) | 382,186 | execution | 298,628 |
| 64 | protocol, P256 | [`0xb7befa61…`](https://dora.privacy.ethrex.xyz/tx/0xb7befa61ae12ea214af6d79ea121bcddfda1d092c138de820663831885a915aa) | 1,194,630 | floor | 91,975 |
| 64 | `P256VERIFY` | [`0x8149a675…`](https://dora.privacy.ethrex.xyz/tx/0x8149a675376019164a53c2f34b0dc400644c7abe1af712f9009812ad11ffccea) | 744,376 | execution | 596,186 |

Per signature, from the $N = 32$ and $N = 64$ rows (the least-squares fit over all seven agrees for
the protocol rows to the gas):

| Method | Gas per signature | Where it comes from |
|---|---|---|
| protocol, secp256k1 | **10,288** | exactly $2{,}800 + 117 \times 64$: the signature gas, and the entry's signer, `msg` and signature bytes at the floor's 64 gas a byte |
| `ecrecover` | **5,603** | execution: the precompile's 3,000, 65 bytes of calldata, the loop |
| protocol, P256 | **18,220** | exactly $6{,}700 + 180 \times 64$ |
| `P256VERIFY` | **11,267** | execution: the precompile's 6,900, 128 bytes of calldata, the loop, a keccak for the signer |

**How many entries one transaction can carry.** The public mempool counts every entry's
signature gas against `MAX_VERIFY_GAS`, including entries that no VERIFY frame reads. With bob's
VERIFY limit at 20,000 and this testnet's 500,000:

| $N$ secp256k1 entries | prefix budget (VERIFY 20,000 + signatures) | simulation | `eth_sendRawTransaction` |
|---|---|---|---|
| 170 | 498,800 | valid | accepted, mined: [`0x0937aec8…`](https://dora.privacy.ethrex.xyz/tx/0x0937aec8df57ab08729b8d15e1e621f388341456f3378a6f4119ee474f95efc6), 1,777,510 gas, all at the floor |
| 171 | 501,600 | invalid: `prefix gas budget exceeded: 501600 > 500000 (MAX_VERIFY_GAS)` | refused: `Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS` |

### What the protocol refuses, and what it leaves to the contract

carol relays `transferBySig(alice, carol, 1 TKA, 1)`, with something wrong in entry 1. All cases
were simulated, and those the simulation called invalid were also offered to
`eth_sendRawTransaction`:

| Entry 1 | Simulation | Transfer frame | `eth_sendRawTransaction` |
|---|---|---|---|
| alice signs the digest (baseline) | valid | success | |
| mallory signs, the entry names alice | invalid: `frame signature list does not authenticate the sender` | | refused: `Invalid frame transaction signature` |
| a P256 signature, the entry names alice's secp256k1 address | invalid: the same message | | refused: the same |
| explicit `msg` of 32 zero bytes | invalid: `Signature 1: explicit msg must not be zero digest` | | refused: the same |
| mallory signs as mallory | valid | reverts | |
| alice signs the digest for 2 TKA | valid | reverts | |
| alice signs an already-used nonce | valid | reverts | |
| alice signs the sig hash instead (`msg` ∅) | valid | reverts | |
| an ARBITRARY entry holding alice's signature bytes | valid | reverts | |
| `index` 5, past the end of the list | valid | reverts (`SIGPARAM` halts inside the reader) | |

Outside a frame transaction:
- An `eth_call` to SigReader fails with `execution halted: reason=Invalid Opcode` and consumes
  all 200,000,000 gas it was given.
- An `eth_call` of `transferBySig` reverts with `sigreader`, after the reader's halt has used 63/64
  of the gas forwarded to it.

## Observations

1. **Letting the protocol check a signature does not save gas. Under the calldata floor, it costs
   more.**
   - **One signature (A, round 2).** The protocol path cost 4,815 more than `ecrecover` (71,019
     against 66,204), and 4,637 more than `P256VERIFY` (75,929 against 71,292). The secp256k1 gap
     has two measured parts. The intrinsic gas is 3,648 higher: the entry's 2,800 signature gas and
     its 117 bytes, against `v, r, s` as ABI words in the frame data. The transfer frame is 1,167
     higher: SigReader's cold call (2,600) and its ABI decoding, against the `ecrecover`
     precompile (3,000) and its checks. A Yul token that executes `SIGPARAM` itself would avoid
     the cold call. By these parts the two would then come out about even, an estimate this
     experiment did not measure.
   - **Each further signature (D).** Here the reader's fixed cost is gone, and the protocol path
     is clearly dearer: **10,288 gas per secp256k1 signature against 5,603 for `ecrecover`, and
     18,220 per P256 signature against 11,267 for `P256VERIFY`**. That is 1.8 and 1.6 times. The
     cause is the calldata floor of EIP-7976, which this testnet runs: 64 gas for every byte of
     every data field, signature entries included. An explicit-digest entry carries its signer
     (20 bytes) and digest (32 bytes) besides the signature, where the in-EVM path carries the
     signature alone, recovers the signer and recomputes the digest. The floor's mandatory part
     also includes the signature gas, so that adds to the bytes. A precompile's cost is execution,
     which only competes with the floor. The protocol rows sit on the floor at every $N$, and
     their slope is exactly signature gas plus 64 gas a byte.

   The protocol verifies the signature either way, and the transaction pays for it either way. The
   service moves the check, not its cost.

2. **What the service does buy: one code path for every scheme, and holders that are only keys.**
   `transferBySig` is one function for secp256k1 and P256 alike, and for any scheme the protocol
   adds later: a post-quantum one, or an aggregate one. The EIP keeps protocol signatures'
   bytes out of the EVM's reach for the sake of future aggregation. A contract that reads
   `SIGPARAM` would get such schemes with no change. B shows the other half. Alice's P256 address
   holds tokens and trades them, and it has no code, no ETH and no secp256k1 key. It cannot be a
   frame transaction's sender, because the default code accepts only SECP256K1. It never needs to
   be: a contract that trusts `SIGPARAM` lets a passkey act through anyone's transaction.

3. **An explicit-digest entry is a bearer instrument.** The protocol checks that alice signed
   the digest. It does not check that she agreed to the transaction it travels in, because the
   sig hash covers the entry but alice signed only the digest. In C, carol lifted alice's entries
   from a transaction she could have seen in the pool, and filled the open order herself. bob's
   transaction would then have been mined with a failing batch, at his expense. Only what is
   inside the digest protects the signer: a taker, a nonce, a deadline. The order that named bob
   could not be stolen. carol's attempt reverted at her own expense and, being an atomic batch,
   took alice's approval back with it. This is the familiar rule for EIP-712 signatures. What
   frames change is the channel: the entries cross the public mempool in the clear, attached to
   someone else's transaction, before anything is executed. The EIP's security considerations say
   the same about validators that approve on an explicit `msg`.

4. **The protocol refuses forgeries; everything else is the contract's job.** A signature that
   does not verify, a zero digest, and a P256 key claiming a secp256k1 address make the whole
   transaction invalid, so it never reaches a block. A real signature that answers a different
   question passes the protocol and has to be refused by the contract:
   - the wrong signer, amount or nonce;
   - an ARBITRARY entry;
   - an entry with `msg` ∅.

   Three checks cover all of these: scheme, signer, digest. An entry with `msg` ∅ reads as `msg` 0,
   and a keccak digest is never 0, so the digest check also refuses the sig-hash case (experiment
   18, observation 3). ethrex reports a bad co-signer's entry with the message it uses for the
   sender's, `frame signature list does not authenticate the sender`, which misleads when the bad
   entry is someone else's.

5. **A contract that reads `SIGPARAM` works only inside frame transactions, and outside them it
   burns gas.** `SIGPARAM` halts exceptionally outside a frame transaction, and an exceptional halt
   consumes all the gas the frame had. A token like `SigToken`, called from an ordinary
   transaction, loses 63/64 of the gas it forwards to the reader. A real deployment should cap
   that call's gas, or keep `SIGPARAM` paths in functions that only frame transactions call.

6. **A transaction can carry only as many protocol signatures as the validation budget allows.**
   The EIP counts signature validation against `MAX_VERIFY_GAS`, for every entry, whether or not a
   VERIFY frame reads it. On this testnet, 170 secp256k1 entries with a 20,000 VERIFY fitted and
   171 did not (D). The spec's 100,000 would allow $\lfloor (100{,}000 - 20{,}000 - 2{,}800) / 2{,}800 \rfloor = 27$
   co-signers, or 11 P256 ones: fewer if VERIFY needs more, a few more if it needs less. Signatures
   checked in the EVM, in a SENDER frame, are outside the prefix and bounded only by the
   transaction gas cap. A vote count, a batch of permits, or a set of order fills larger than that
   has to check its signatures itself.
