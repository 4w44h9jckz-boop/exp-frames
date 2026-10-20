# 32 - One registry for the private owned state of many applications

Experiment 06's keyed pool is one application: its notes, its tree, its nullifiers, its `VERIFY`.
This experiment pulls the general part out into a **registry** that is its own sender and holds the
notes of any number of applications in one tree. An application is reduced to its tag and a rule.
A note's owner updates it with a kernel proof checked in the registry's `VERIFY`, and nobody else
takes part: no relayer, no sequencer, no signature.

The question is whether a second application can share the tree, the nullifier space and the
registry's `VERIFY` with the first, so that:

- the same secrets used in two applications give two nullifiers that do not collide, and a
  nullifier of one application is refused by the other;
- the check needs no storage outside the sender, which the public mempool's trace rules refuse.

## Design

A note is a leaf of Tornado Cash's height-20 MiMC tree, and spending it reveals the application's
nullifier:

$$\mathrm{leaf} = H(\mathrm{tag}, \mathrm{inner}, \mathrm{state}), \qquad \mathrm{inner} = H(\mathrm{nullifierSecret}, \mathrm{secret}), \qquad \mathrm{nullifier} = H(\mathrm{tag}, \mathrm{nullifierSecret})$$

$H$ is circomlib's MiMCSponge with 220 rounds and key 0, the function experiment 06's deployed
hasher computes. `tag` is the application's address and `state` a 64-bit amount of wei the
registry holds for the note. The registry computes the leaf at deposit, so a note is worth the
ether that came in with it.

The kernel ([`kernel.circom`](kernel.circom), 33,287 constraints) proves, for public `root`,
`nullifier`, `newCommitment`, `tag`, `withdrawn` and `binding`:

- a leaf $H(\mathrm{tag}, H(\mathrm{nullifierSecret}, \mathrm{secret}), \mathrm{state})$ is in the tree under `root`;
- $\mathrm{nullifier} = H(\mathrm{tag}, \mathrm{nullifierSecret})$;
- $\mathrm{state}$, $\mathrm{withdrawn}$ and $\mathrm{state} - \mathrm{withdrawn}$ are all below $2^{64}$;
- $\mathrm{newCommitment} = H(\mathrm{tag}, \mathrm{newInner}, \mathrm{state} - \mathrm{withdrawn})$, a change note of the
  same application for whoever owns `newInner`; or $\mathrm{newCommitment} = 0$, allowed only when
  nothing is left.

The registry binds $\mathrm{binding} = \mathrm{keccak256}(\mathrm{recipient} \parallel \mathrm{fee} \parallel \mathrm{link}) \gg 8$
to the proof.

An update is a frame transaction with `tx.sender` = the registry, no signature, the nullifiers as
its EIP-8250 nonce keys at sequence 0, and exactly this layout:

| Frame | Mode | Target | What |
|---|---|---|---|
| 0 | VERIFY | `0x8272` | the EIP-8272 verifier frame: `source_id ‖ slot ‖ root` |
| 1 | VERIFY | the registry, scope 3 | checks the layout, the root, the nonce keys, the application's rule and the proof; approves, and pays |
| 2 | SENDER | the registry | `update(bytes32 root, uint256[15][] updates)`: pays out `withdrawn − fee`, inserts the change note |

The fee reimburses the registry's gas, so `VERIFY` requires the fees to cover the transaction's
maximum cost, and floors frame 2's gas so nobody can starve it after the nonce keys are consumed.
The registry accepts one update, or a pair whose `link` words name each other's nullifier, so that
neither proof is valid alone. The pair is not exercised here, and it is not fair: it binds only
the other side's nullifier, so the other side could spend its note in the same transaction and
keep the change. Experiment 33's version 2 binds the other side's change note too.

`VERIFY` reads no storage. The root comes from frame 0, which the protocol checks against the
predeploy; a spent nullifier is a used nonce key, which the protocol refuses; the rule is a call
that reads only the application's code; the proof is a call to a verifier that reads only its own.

| Application | Deposit rule | Update rule |
|---|---|---|
| [`FixedPool`](FixedPool.yul): experiment 06's pool as a rule | exactly 0.001 ETH | the whole 0.001 ETH, no change note |
| [`Balance`](Balance.yul): a balance of any size | any amount above zero | at most 0.002 ETH out, with or without a change note |
| [`StoredRule`](StoredRule.yul): the control | any amount above zero | at most the cap **in its own storage** |

| File | What |
|---|---|
| [`kernel.circom`](kernel.circom) | The kernel |
| [`OwnedStateRegistry.yul`](OwnedStateRegistry.yul) | The registry, 2,567 B of creation code with the tree's zeros |
| [`Groth16Verifier.yul`](Groth16Verifier.yul) | A BN254 Groth16 verifier with the key appended to its code. It forwards gas only as `GAS` immediately before `STATICCALL`, so it can run in `VERIFY` |
| [`FixedPool.yul`](FixedPool.yul), [`Balance.yul`](Balance.yul), [`StoredRule.yul`](StoredRule.yul) | The applications |
| [`registry.ts`](registry.ts) | Addresses, notes, the tree, proofs, `updateTx` |
| [`run.ts`](run.ts) | Setup, then A to E |
| [`rebuild.test.ts`](rebuild.test.ts) | The mined updates rebuilt byte for byte; their proofs verified against the key; the deposits' leaves recomputed |
| `build/` | The compiled circuit (`kernel.wasm`), the proving key (`kernel.zkey`, 19 MB) and the verifying key |

### The proving key

Phase 1 is the Privacy & Scaling Explorations perpetual powers of tau after 80 contributions,
`ppot_0080_16.ptau` from `https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/`
(sha256 `ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`, retrieved 2026-10-20;
Hermez's `powersOfTau28_hez_final_16.ptau` returned 403 from both of its usual hosts). Phase 2 has
one contribution, made in this session with 64 random bytes that were never printed or stored:

| | |
|---|---|
| circuit hash | `c8cad89b 3ba09da2 2c384327 da1adc60 6fe6c25a 326fbc74 1ac68693 3abdc4b7 88c88984 64cd1e48 c408ed82 55544f99 9cf6e8b6 9f855a03 f8ac240d 3efa65cc` |
| contribution hash | `c35960f2 c2b18efa 1ec92275 ed3dfe6e 881b688d fdba822f 9e1c0a57 afd6fa41 ac3883f7 09d97548 eb81eef1 b559f2be 059f29f1 7d5c8b28 ff9546ba f4acd07a` |
| `kernel.zkey` sha256 | `c9f370dc26f4d51a63c291f299b9d5d66231da77d723c99ccca25cfc94984d71` |

`snarkjs zkey verify` accepts the key against the circuit and phase 1. The circuit compiles to the
same `kernel.r1cs` (sha256 `1f0367b9…`) and `kernel.wasm` (sha256 `ce547b0c…`) each time with
circom 2.2.3. A single contribution is a test network's setup: whoever made it could forge proofs
had they kept it. The key is committed because the entropy is gone, so no one could prove against
the deployed verifier without it.

```bash
B=experiments/32-owned-state/build
npx circom2 experiments/32-owned-state/kernel.circom --r1cs --wasm -l node_modules -o $B
npx snarkjs groth16 setup $B/kernel.r1cs ppot_0080_16.ptau $B/kernel_0.zkey
npx snarkjs zkey contribute $B/kernel_0.zkey $B/kernel.zkey -e="<random>"
npx snarkjs zkey export verificationkey $B/kernel.zkey $B/kernel.vkey.json
npx snarkjs zkey verify $B/kernel.r1cs ppot_0080_16.ptau $B/kernel.zkey
```

## Run

```bash
npx tsx experiments/32-owned-state/run.ts --dry-run   # simulate only
npx tsx experiments/32-owned-state/run.ts             # setup, A to C mined, D and E refused
```

Each step is skipped once done, so the script can be run again. A proof takes about 6 s in snarkjs.

## Results (2026-10-20, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

The registry is `0xbC85035Ae5aE1a35E638Ae54E58eAAa1DC2eE990`, the verifier
`0xFe46ff84b94D2Dcb381E2B0A5c5a5a8A886829bc`, and the applications FixedPool
`0xDce509d999D5a8Cca2873FD4c431665d4eB7f9F6`, Balance `0x0E2180d727a6CD4B2216cB16BD3e9e607a7Ebf0a`
and StoredRule `0xA41c6f469AFB82074B0508Ca850A5060fd946E8E`. The registry uses experiment 06's
hasher.

| Step | Tx | Block | `gasUsed` | Frames: execution + state gas |
|---|---|---|---|---|
| deploy the verifier, the registry and the applications | [`0x42741335...`](https://dora.privacy.ethrex.xyz/tx/0x42741335b5d25984f9b1751c5b2aa648ebd0331a1437d3b03dc138c2c75f52d1) | 479,285 | 7,715,644 | |
| deposit five notes: the shared secrets in FixedPool (0.001 ETH) and in Balance (0.003 ETH), and three for E | [`0xae640af2...`](https://dora.privacy.ethrex.xyz/tx/0xae640af20f516dbd96c758097667615bb3126d8cc96affa6adfb42e0c2abe7d0) | 479,286 | 6,458,539 | first 1,059,570 + 2,252,160 (23 fresh slots); then 771,809 to 774,790 + 0 each |
| **A.** FixedPool: the shared secrets' note spent whole | [`0x511572f1...`](https://dora.privacy.ethrex.xyz/tx/0x511572f1bad85edc4be60bfe71126373d4be0f5bd8fe0d4a53f6f0e49d23a03d) | 479,289 | **552,992** | 8272 5,579 · VERIFY **229,314** + 97,920 · update 14,670 + 183,600 |
| **B.** Balance: the same secrets' note, 0.001 ETH out, 0.002 ETH in a change note | [`0xa5b18e15...`](https://dora.privacy.ethrex.xyz/tx/0xa5b18e15e3bb1b8c4a137ac6c409029e833658fab85ab2ebfc156c8f89e82f76) | 479,291 | **1,628,338** | 8272 5,579 · VERIFY **229,326** + 97,920 · update 991,736 + 281,520 |
| **C.** Balance: the change note spent, 0.002 ETH out | [`0x587e541e...`](https://dora.privacy.ethrex.xyz/tx/0x587e541e7ad9192c57ac7e9b687a4d2222f5d1f22cc2ef1685c9429409a8492c) | 479,292 | **552,932** | 8272 5,579 · VERIFY **229,302** + 97,920 · update 14,670 + 183,600 |

The shared secrets' nullifiers are `0x1ddb7524...` in FixedPool and `0x0bff55d0...` in Balance.
Each recipient is a fresh address and received `withdrawn` less the 10^10 wei fee.

| Refused | How | Reason |
|---|---|---|
| **D1.** A's update with Balance's tag, before A was mined | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": the proof binds the tag |
| **D2.** A Balance update with FixedPool's nullifier | the prover | the witness fails at the root: no Balance leaf opens to that nullifier |
| **D3.** A again, after A | simulation and `eth_sendRawTransaction` | "Nonce mismatch: expected 1, got 0": the nonce key is used |
| **D4.** A's nullifier with Balance's tag, after A | simulation and `eth_sendRawTransaction` | the same: the nonce key is the registry's, whichever application claims it |
| **E1.** FixedPool: half out, half in change, with a valid kernel proof | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": FixedPool's rule |
| **E2.** Balance: 0.003 ETH out, above the cap | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": Balance's rule |
| **E3.** StoredRule's note, whose rule reads its own storage | simulation and `eth_sendRawTransaction` | **`StorageReadNonSender`** |
| **E4.** Balance: frame 2 given 50,000 execution gas, below the floor | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": the floor |

`eth_sendRawTransaction` gave every refusal as "Missing or invalid parameters."; only the
simulation names the reason.

Every mined transaction above is a fixture in `test/fixtures/chain/`. `rebuild.test.ts` rebuilds
the three updates with `updateTx` from what they carried, byte for byte, verifies each proof
against `build/kernel.vkey.json`, and recomputes each deposit's leaf from its call. kohaku-rs's
`kohaku-frame-registry` (branch `experiment/frames`) does the same from Rust, with
`kohaku-tornadocash`'s MiMC and a Groth16 check of its own, and matches this experiment's kernel
input for a spend, signal by signal.

## Gas

| | Gas | Against |
|---|---|---|
| The registry's `VERIFY`, one update | 229,302 to 229,326 | EIP-8141's 100,000; the testnet's 500,000 |
| Experiment 06's keyed pool `VERIFY`, for comparison | 244,808 | |
| Frame 2, a payout to a fresh address | 14,670 + 183,600 state | floor 100,000 + 183,600 per update |
| Frame 2, a change note: 40 MiMC permutations through the hasher, and the root's publication | 977,066 + 97,920 state | floor 1,200,000 + 195,840 per change note |

The registry's `VERIFY` costs 15,494 less than the keyed pool's, although it also calls the
application's rule: [`Groth16Verifier.yul`](Groth16Verifier.yul) is leaner than Tornado's
Solidity verifier. A self-update without change, 552,992 gas, costs 14,853 less than the keyed
pool's withdrawal (567,845). On the spend, the rule's call costs less than the verifier saves. The
change note costs 1,075,346 more (B against A), and is what a balance needs that a fixed note does
not.

## Observations

1. **A second application shares the tree without colliding with the first.** The same secrets
   were deposited in both applications and gave two nullifiers, both used as nonce keys of the
   one registry and both mined (A and B). The tag is in the leaf, the nullifier and the change
   note, so a note cannot move between applications: a proof with the other tag fails before
   inclusion (D1), and cannot even be made (D2). Once a nullifier is used it is refused whatever
   application claims it (D4), because nonce keys belong to the sender, and the sender is the
   registry. Both conditions of the question hold.

2. **The check needs no storage outside the sender, and the testnet enforces the rule.** The
   registry's `VERIFY` reads no storage at all, its own included, and every update was admitted.
   The control's rule reads one slot of its own contract, and the node refused it with
   `StorageReadNonSender` (E3), ethrex's validation-trace observer
   (`crates/vm/levm/src/validation_observer.rs` at `64b8fc09`). So what an application can check
   in `VERIFY` is limited to rules that read nothing but code. An application that keeps state in
   its own contract has to move that state into the note, into the proof, or into the registry's
   own storage, which `VERIFY` may read but which then becomes a dependency of every pending
   update.

3. **A shared tree is not a shared crowd.** The tag is public: it is a public input, it is in
   frame 2's calldata, and it is the `Updated` event's indexed topic. So an observer learns which
   application each update belongs to, and the anonymity set of an update is that application's
   notes, not the tree's. The registry gives the applications one root publication, one verifier
   and one nonce-key space, not more privacy. Hiding the tag would mean checking the application's
   rule inside the proof, an application circuit under the kernel, so that `VERIFY` never learns
   which application it is.

4. **The fee is still fixed before the gas price is known.** As in experiment 06, the proof binds
   the fee, 10^10 wei, and the registry keeps the difference from the gas it paid: after A to C
   it held 29,978,125,904 wei of surplus beyond the three unspent notes' 0.005 ETH. Experiment
   30's refund frame would return it.

5. **A change note costs a deposit.** Inserting the change note is a deposit's work, 977,066 gas
   through experiment 06's hasher contract, and it publishes a new root to EIP-8272. The
   deposits after the first in the setup paid no state gas for the publication, because a second
   write in the same slot replaces the first. B's publication was the first of its slot and paid
   one fresh slot.
