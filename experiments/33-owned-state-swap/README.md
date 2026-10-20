# 33 - Two wallets swap owned state, with the chain as rendezvous and settlement

Experiment 32's registry lets an owner update a note alone. This experiment has two owners who do
not know each other trade notes directly. Alice holds 0.002 ETH of asset A and wants 0.001 ETH of
asset B; Bob holds that. They find each other through an encrypted announcement on the chain, agree
through a second one, exchange proofs, and settle in one frame transaction that spends both notes
or neither. No committee, no relayer, no signature, and nobody else holds anything.

The question has two halves. Does settlement need a third party? And does an abort, at any step,
leave either side worse off than before it began?

## Design

**Registry version 2** ([`OwnedStateRegistry.yul`](OwnedStateRegistry.yul)) is experiment 32's,
with two changes. The tree, the deposits, the applications' rules, the kernel and its verifier are
unchanged, and the verifier is the one experiment 32 deployed.

1. **Every proof binds a deadline.** The transaction starts with an expiry verifier frame, which
   the protocol runs, and each proof binds its deadline:
   $\mathrm{binding} = \mathrm{keccak256}(\mathrm{recipient} \parallel \mathrm{fee} \parallel \mathrm{link} \parallel \mathrm{deadline}) \gg 8$.
   A proof handed to the other side stops being usable at a time its maker chose.
2. **A pair is fair, not only atomic.** Each update's `link` is
   $\mathrm{keccak256}(\mathrm{nullifier} \parallel \mathrm{newCommitment})$ of the other. In
   experiment 32 the link named only the other's nullifier. Bob could then have spent his own note
   in the same transaction, with the change sent to himself, and taken Alice's. Here Alice's proof
   is valid only beside the very update she computed for Bob: his note, less the fee, as a note of
   asset B for her.

| Frame | Mode | Target | What |
|---|---|---|---|
| 0 | VERIFY | `0x8141` | the expiry verifier frame: the deadline |
| 1 | VERIFY | `0x8272` | the EIP-8272 verifier frame: `source_id ‖ slot ‖ root` |
| 2 | VERIFY | the registry, scope 3 | layout, root, nonce keys, the applications' rules, the proofs, the links |
| 3 | SENDER | the registry | `update(root, updates)`: both change notes inserted |

**The swap.** Each side spends its whole note. It takes out only the fee, and leaves the rest as a
change note owned by the other side. The other side gives the `inner` for it, $H(\mathrm{nullifierSecret}, \mathrm{secret})$,
which reveals nothing about the secrets. Each side can compute the other's change note from the
offer and the answer, so each proof can name the other update before that update exists.

**The board** ([`Board.yul`](Board.yul)) logs whatever is posted to it. A message is sealed to the
recipient's secp256k1 key ([`announce.ts`](announce.ts)): ECDH with a fresh key, HKDF-SHA256,
AES-256-GCM, and a one-byte view tag so a scanner skips most messages. A wallet scans every
`Posted` event and opens what it can.

| Message | From | Sealed to | Says |
|---|---|---|---|
| offer, 182 bytes | Alice | Bob's key | the registry; what she gives and wants (application, amount); the deadline; her note's nullifier; her `inner` for the note she will receive; her key for the answer |
| answer, 137 bytes | Bob | the key in the offer | the offer's hash; his note's nullifier; his `inner` for the note he will receive; the root and slot to prove against |

The proofs then pass between the two wallets off chain, here in one process. A real channel,
such as an authenticated stream opened after the answer, is not built.

| File | What |
|---|---|
| [`OwnedStateRegistry.yul`](OwnedStateRegistry.yul) | The registry, version 2: 2,779 B of creation code |
| [`Board.yul`](Board.yul) | The board |
| [`announce.ts`](announce.ts) | Sealing, opening and scanning; the offer and the answer |
| [`swap.ts`](swap.ts) | Version 2's addresses, the swap's two spends, an owner's own spend, `updateTx` |
| [`run.ts`](run.ts) | N1 to N3 |
| [`rebuild.test.ts`](rebuild.test.ts) | The mined updates rebuilt byte for byte and their proofs verified; the posts' shapes; `vector.json` |
| [`vector.json`](vector.json) | An offer and an answer sealed with keys from a public seed, for kohaku-rs |

## Run

```bash
npx tsx experiments/33-owned-state-swap/run.ts      # run label 1; pass another label to run again
```

| Negotiation | Notes | What happens |
|---|---|---|
| **N1** | Alice's 1, Bob's 1 | offer, answer, Alice's proof, Bob's proof, the swap. At each step both notes are checked to be spendable by their owners alone. Between the proofs, Bob tries to settle without giving his note. Then Alice spends what she received |
| **N2** | Alice's 2, Bob's 2 | the same up to both proofs, with a deadline 150 s away. Nobody settles, and the deadline passes |
| **N3** | Alice's 2, Bob's 2 | the same with a deadline 30 min away; Alice cancels by spending her note herself |

"Spendable by its owner alone" means the owner's own update of the note, everything out to the
owner's address, is valid in simulation. Each was proven once and simulated after every step.

## Results (2026-10-20, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

Registry version 2 is `0x755e6d982048bf6F97C0f9C1e2174233Add3c02c`, asset A experiment 32's
Balance `0x0E2180d727a6CD4B2216cB16BD3e9e607a7Ebf0a`, asset B the same rule deployed again at
`0x1BCDda250187F6be61a19e4cE2eC898fF64AFd86`, and the board
`0x93DD748B72dA1b1B6F1d5ec78Cb91ee52F01727d`. Setup:
[`0x5b633741...`](https://dora.privacy.ethrex.xyz/tx/0x5b6337411c4dc5f064d997092c7bc402945ec72d79eab80464ed51561cde08b8)
(block 479,534) deployed them, and
[`0x24410da1...`](https://dora.privacy.ethrex.xyz/tx/0x24410da16729b59beae6f3c4744de8751e6f4dfe68f2e7d32ef964a9b62e0cf9)
(479,535) deposited the four notes.

| Step | Outcome | Tx | Block | `gasUsed` | Frames: execution + state |
|---|---|---|---|---|---|
| N1. Alice posts her offer, sealed to Bob | mined | [`0x3b738bc4...`](https://dora.privacy.ethrex.xyz/tx/0x3b738bc4148383dd59b95cb25f072060152a5374238e8a53144da3c1bdececf5) | 479,540 | 40,838 | post 6,427 |
| N1, after the offer | both notes spendable by their owners alone | | | | |
| N1. Bob scans the board | opens the offer: gives 0.002 of A, wants 0.001 of B | | | | |
| N1. Bob posts his answer, sealed to Alice | mined | [`0xcaf0a675...`](https://dora.privacy.ethrex.xyz/tx/0xcaf0a6750deecf96ccbb5343f70e9d53c487ad3748e98169bf734509515d3758) | 479,542 | 36,742 | post 5,903 |
| N1, after the answer | both spendable alone | | | | |
| N1, Alice's proof with Bob | both spendable alone | | | | |
| N1. Bob settles with Alice's proof alone | **refused**: "validation prefix frame reverted" | | | | |
| N1. Bob pairs it with his note paid to himself | **refused**: "validation prefix frame reverted" | | | | |
| N1, both proofs exchanged | both spendable alone | | | | |
| **N1. Bob settles the swap** | **mined** | [`0x5c365fc1...`](https://dora.privacy.ethrex.xyz/tx/0x5c365fc175720516a5b42c6698bb6c5c49d04a3ee6e7afeeed0417163b5b31c6) | 479,546 | **2,495,532** | expiry 3,051 · 8272 5,579 · VERIFY **454,891** + 195,840 · update 1,708,307 + 97,920 |
| N1, after the swap | Bob's new asset-A note spendable alone; both old notes spent | | | | |
| N1. Alice spends the asset-B note she got | mined | [`0xb3ad9012...`](https://dora.privacy.ethrex.xyz/tx/0xb3ad9012421ceb90f2036ac487245f1287ad00b686b00354623da809f397a59d) | 479,550 | 556,717 | expiry 3,051 · 8272 5,579 · VERIFY 229,445 + 97,920 · update 14,670 + 183,600 |
| N2. offer and answer | mined | [`0x26c2a5db...`](https://dora.privacy.ethrex.xyz/tx/0x26c2a5dbd21c43b5dae25d297b3b16a30afe107e4537d21763f289eb898278f7), [`0x112912ee...`](https://dora.privacy.ethrex.xyz/tx/0x112912eeb61a6cafc5d88af3ea32425ffb9b66c07be4da76b84abce890f94d4b) | 479,554, 479,556 | | |
| N2. the swap, both proofs exchanged | valid in simulation 120 s before its deadline; not sent | | | | |
| N2. Bob settles after the deadline | **refused**: "validation prefix frame reverted" | | | | |
| N2, after the deadline | both spendable alone | | | | |
| N3. offer and answer | mined | [`0xbd11755a...`](https://dora.privacy.ethrex.xyz/tx/0xbd11755a16be048d3230aa886417a9d82a9bdaf3010dac6de0425aabdf8d3e15), [`0xcb150c49...`](https://dora.privacy.ethrex.xyz/tx/0xcb150c4958a7297544b2cabc6354f1c5648c2f4874cb05863e970b71f0263625) | 479,577, 479,579 | | |
| N3. Alice cancels: she spends her note herself | mined | [`0x7cf64acf...`](https://dora.privacy.ethrex.xyz/tx/0x7cf64acf879235591a839a839245eaf695a9388e6092be939f35b9df4b75a3a5) | 479,582 | 556,717 | as Alice's spend above |
| N3. Bob settles after the cancel | **refused**: "Nonce mismatch: expected 1, got 0" | | | | |
| N3, after the cancel | Bob's note spendable alone | | | | |

Every refusal was given by simulation and again by `eth_sendRawTransaction`. Every mined
transaction is a fixture in `test/fixtures/chain/`. `rebuild.test.ts` rebuilds the swap and the two
owners' updates with `updateTx`, byte for byte. Every proof verifies with its deadline bound, and
fails with experiment 32's binding. kohaku-rs's `kohaku-frame-registry` (branch
`claude/nifty-einstein-llp9cd`) rebuilds the same three, verifies the proofs in Rust, seals
`vector.json` to the same bytes, and scans the testnet board from Rust: with the experiment's
keys, its `scan_board` example found the 3 offers and 3 answers. For N1, the two notes the swap
had to create, computed from the decrypted terms alone, were both in the registry.

## Gas

| | Gas | Against |
|---|---|---|
| The pair's `VERIFY`: two Groth16 checks, two rules, two links | 454,891 | the testnet's 500,000 for the whole prefix (limits 5,000 + 6,000 + 480,000); EIP-8141's 100,000 |
| One update's `VERIFY` in version 2 | 229,445 | experiment 32: 229,302 to 229,326 |
| The swap's update frame: two change notes | 1,708,307 + 97,920 state | |
| The whole swap | 2,495,532 | two of experiment 32's B, an update with change: 2 × 1,628,338 |
| A post | 36,742 to 40,838 | |

The swap costs 761,144 less than two of experiment 32's B. Part of that is B's payout to a fresh
address, 14,670 + 183,600 each, which a swap does not make. The rest is one transaction instead of
two, with one root publication.

## Observations

1. **Settlement needs no third party.** The swap transaction has no signature, the registry pays
   its gas from the two fees, and anyone holding both proofs can send it. Bob did, through the
   public RPC. The board is a contract that logs; nobody runs it.

2. **No abort left either side worse off, with two costs stated plainly.** At every step of N1,
   after the deadline in N2 and after the cancel in N3, each note was still spendable by its owner
   alone. The swap was refused unless it carried both notes, each to the other side as agreed.
   That covers Alice's proof alone, and her proof beside Bob's note paid to himself. The costs:
   - **Between the exchange of proofs and the deadline, the holder of both has an option.** Either
     side can settle at the agreed terms whenever it likes until the deadline (N2: valid 120 s
     before it). After the deadline nobody can, and the abort costs nothing (N2).
   - **Cancelling before the deadline costs one update.** Alice's cancel was an update of her own
     note, 556,717 gas paid from a 10^10 wei fee (N3). Version 1 had no deadline, so a cancel was
     the only way out.

3. **The board hides who and what, but not that.** A message reveals nothing to anyone but its
   recipient, except a one-byte view tag. Its length says whether it is an offer (233 bytes) or an
   answer (188); padding to one length would hide that. The posting transaction's sender is
   public: here the funder posted every message, standing in for whoever relays them. A wallet
   that posts from its own account links itself to the negotiation.

4. **The two sides learn each other's nullifiers.** The offer and the answer carry them, so each
   side can later recognise the other's note being spent, in this swap or a cancel. Nobody else
   can.

5. **Experiment 32's pair would have been unfair.** Version 1 binds only the other side's
   nullifier. The Rust builder now refuses that link under version 2, and experiment 32's README
   records it.
