# 07 — Threshold wallet: a FROST group key behind one account

Experiment 05 built a 2-of-3 wallet the multisig way. Each owner keeps its own key and signs on its
own, the transaction carries one SECP256K1 entry per signer, and the account counts owners. This
experiment builds the same 2-of-3 wallet the threshold way. Alice, bob and carol run a distributed
key generation once. Afterwards there is one group key that none of them knows, and any two of them
produce one Schnorr signature with it in two rounds. The chain sees a single 52-byte signature, and
it has the same shape whichever two signed.

| Frame | Mode | Flags | Target | Signatures |
|---|---|---|---|---|
| 0 | VERIFY | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | ARBITRARY, `msg` ∅: `address(R) ‖ z` (52 bytes) |
| 1 | SENDER | - | funder | |

The protocol has no Schnorr scheme, so the signature travels in an ARBITRARY entry (100 gas, bytes
elided from the sig hash). The account checks it with the `ecrecover` precompile, using the trick
from Chainlink's `SchnorrSECP256K1` contract:

$$c = H(P_x \parallel \mathrm{parity}(P) \parallel m \parallel \mathrm{addr}(R)) \bmod n, \qquad z = k - c\,x, \qquad z\,G + c\,P = R$$

$$\mathrm{ecrecover}(h = -z P_x,\ v = 27 + \mathrm{parity}(P),\ r = P_x,\ s = c P_x) = \mathrm{addr}(R)$$

This works because `ecrecover` returns the address of $r^{-1}(s\,P - h\,G) = c\,P + z\,G$.

| File | What |
|---|---|
| [`frost.ts`](frost.ts) | FROST over secp256k1 for teaching: Pedersen DKG with share checks, round 1 (nonce commitments), round 2 (responses), aggregation with a check of every response |
| [`FrostAccount.yul`](FrostAccount.yul) | The account. 331 B runtime followed by `Px ‖ parity` (395 B deployed). VERIFY requires entry 0 to be ARBITRARY with `msg` ∅ and exactly 52 bytes, $0 < z < n$ and $\mathrm{addr}(R) \neq 0$. It then recomputes $c$ from `TXPARAM(0x08)`, runs `ecrecover`, and approves |
| [`account.ts`](account.ts) | The group (each member's polynomial from its own seed, derived from `PRIVATE_KEY`), the counterfactual account, `signFrost(tx, group, signers)` |
| [`example-frost.ts`](example-frost.ts) | Setup, then A-C on the testnet |
| [`negative.ts`](negative.ts) | What the account refuses, simulated |

`frost.ts` is not production code. Its DKG omits the proofs of knowledge that RFC 9591's setups
use against rogue-key attacks. Its hash domains are ad hoc, and nothing in it is constant-time.

## Run

```bash
npx tsx experiments/07-threshold-wallet/example-frost.ts   # setup (once), then A-C
npx tsx experiments/07-threshold-wallet/negative.ts        # simulations only
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

Group key $P_x$ = `0x09a3227c…`, parity 0; account `0xd0ee122683745B66866859F92705441e12C54680`.

| Tx | What | Frames: execution / state gas | `gasUsed` |
|---|---|---|---|
| [`0x082ce547…`](https://dora.privacy.ethrex.xyz/tx/0x082ce547c15b5050dbb81a5c981b5bf238b6903a7f96ab83cccaf7cd4f4964e2) | setup: the funder deploys and funds the FrostAccount | VERIFY 100/0 · deploy 15,475/787,950 · fund 121/0 | 843,327 |
| [`0xb397ca02…`](https://dora.privacy.ethrex.xyz/tx/0xb397ca02c00313fdaaf1d5683ad561fbab6fa1271dd9b5db3ed9cf6fb3495dd6) | **A.** alice and bob sign; 0.0001 ETH out | VERIFY **3,864**/0 · SENDER 3,000/0 | 26,794 |
| [`0xe0350739…`](https://dora.privacy.ethrex.xyz/tx/0xe035073997e16d43d795939c0b239c97070328d399c6ebd401722774cd7d80ff) | **B.** bob and carol sign | VERIFY **3,864**/0 · SENDER 3,000/0 | 26,782 |
| [`0x0b5d5f84…`](https://dora.privacy.ethrex.xyz/tx/0x0b5d5f84b46e48739e30191f1dadaff791ba562828f9c8f20a6959386a2f235b) | **C.** all three commit in round 1, carol goes silent, the coordinator restarts with alice and bob | VERIFY **3,864**/0 · SENDER 3,000/0 | 26,794 |

A and B differ by 12 gas because $\mathrm{addr}(R)$ and $z$ are random and so is their count of
zero bytes.

The same 2-of-3 transfer, two ways:

| Wallet | entries | signature gas | entry bytes | VERIFY | intrinsic + execution | floor | `gasUsed` |
|---|---|---|---|---|---|---|---|
| multisig, experiment 05 ([`0x936da668…`](https://dora.privacy.ethrex.xyz/tx/0x936da668bb1f2c4f0a94542a55fa2d074c1d0d0c370fe521fbe1899575a98f16)) | 2 × SECP256K1 | 5,600 | 2 × (20 + 65) | 1,129 | 31,423 | **35,622** | 35,622 |
| FROST, this experiment (A) | 1 × ARBITRARY | 100 | 52 | 3,864 | **26,794** | 22,570 | 26,794 |

The threshold transfer costs 8,828 gas (25%) less. The multisig pays 2,800 per signer in signature
gas and is bound by the calldata floor, because each signer adds 85 bytes. The threshold wallet
pays 100 for its one entry and about 3,000 for `ecrecover` in VERIFY, and its cost does not grow
with $t$.

### Refusals (`negative.ts`, simulated)

| Case | valid | Node says |
|---|---|---|
| alice and bob sign (baseline) | true | |
| alice, bob and carol all sign (more than $t$) | true | |
| one byte appended to the 52 bytes | false | `validation prefix frame reverted` |
| last byte dropped | false | prefix reverted |
| $z = 0$ | false | prefix reverted |
| $\mathrm{addr}(R) = 0$ | false | prefix reverted |
| $\mathrm{addr}(R)$ of another nonce | false | prefix reverted |
| alice's round-2 response alone, with the pair's $\mathrm{addr}(R)$ | false | prefix reverted |
| the pair's signature over another transaction (value 0.0002) | false | prefix reverted |
| a different 2-of-3 group signs | false | prefix reverted |
| signature in entry 1, entry 0 empty | false | prefix reverted |
| entry 0 carries the sig hash as an explicit `msg` | false | prefix reverted |

Appending a byte leaves the sig hash unchanged and moves the transaction hash
(`0x19fabf3f…` versus `0xfb83b404…`).

## Observations

1. **The chain cannot tell which members signed.** Transactions A, B and C each carry one 52-byte
   entry: a fresh $\mathrm{addr}(R)$ and a scalar. The same verification key checks all three. Under
   experiment 05's multisig, every entry names its signer, and the account's owner list is on
   chain, so each transaction publishes who approved it. Here the signing subset is known only to
   the members and their coordinator. Membership itself stays hidden too: the chain sees $P$, not
   $n$, $t$ or the members' verification keys.

2. **The cost is flat in $t$ and below the multisig's.** A transfer costs 26,794 gas whatever the
   threshold, against 35,622 for experiment 05's 2-of-3, and the multisig grows by at least 2,800
   gas and 85 bytes per extra signer. The price is VERIFY gas: 3,864 against 1,129, almost all of it
   the 3,000 for `ecrecover`. That stays well inside any VERIFY budget.

3. **Liveness is the trade, and an abort costs nothing on chain.** Multisig owners sign
   independently and asynchronously, and anyone can collect any $t$ of the signatures. FROST needs
   the chosen subset to finish round 2 together, because every round-1 commitment is already inside
   $R$. In C, carol commits and goes silent. Aggregation fails with `no response from member 3`; alice
   and bob throw away their nonces, draw fresh ones and sign again. The abort cost one round trip
   and no transaction. Round 1 can be done ahead of time (FROST allows pre-published nonce
   commitments), which leaves one online round. Reusing a nonce across two messages leaks the
   member's share, which is why the restart draws fresh nonces rather than replaying round 2.

4. **Not being a protocol scheme costs three things.**
   - **Code.** The address must hold code; the default code accepts SECP256K1 only, as experiment
     11 found for P256.
   - **Self-deployment.** At 395 bytes the account is past the roughly 206 bytes a first
     transaction can deploy for itself under `MAX_VERIFY_STATE_GAS`, so the funder deploys it in
     setup. Experiment 08's `CodeProxy` pattern (one shared verifier, a small per-account proxy
     holding $P_x \parallel \mathrm{parity}$) would bring it under the limit; that is not tested
     here.
   - **Sponsorship.** The canonical paymaster's signer must be a protocol scheme (experiment 09),
     so a FROST group cannot be that signer. A FROST-controlled paymaster is a non-canonical one,
     with the one-pending-transaction cap ethrex puts on those.

   A threshold-ECDSA group (GG18, CGGMP, DKLs) avoids all three. Its signature is an ordinary
   SECP256K1 entry, so a code-less address with the default code works, and the group can be a
   canonical paymaster signer. The price is a much heavier signing protocol (Paillier or oblivious
   transfer, more rounds) with a long record of implementation bugs. This repository does not
   implement it.

5. **The group key is in code, so the VERIFY reads no storage.** That keeps the account in the
   mempool's self-verify shape. It also keeps it eligible for concurrent transactions on disjoint
   nonce keys, which ethrex grants only to prefixes that read no sender storage (experiment 08).
   Changing who holds shares, or changing $t$, needs no transaction at all: FROST resharing
   produces new shares of the same $P$. Removing a member that way rests on the old shares being
   deleted. A removed member's share plus $t - 1$ undeleted old shares still sign. Changing $P$
   itself needs a new account, or a code-commitment proxy and an on-chain operation as in
   experiment 08.

6. **The encoding must be canonical, and the length check is what makes it so.** ARBITRARY bytes
   are outside the sig hash but inside the transaction hash. Any second encoding the account
   accepted would let a relayer mint a second transaction hash for the same authorisation, as the
   high-$s$ check prevents in experiment 11. With the exact-length check gone, a trailing byte
   would do it, because `SIGDATACOPY` reads only the first 52. The $z < n$ check closes the other
   variant, $z + n$, which fits in 32 bytes only when $z < 2^{256} - n$, a chance of about
   $2^{-128}$. The $\mathrm{addr}(R) \neq 0$ check is defence in depth: a failed `ecrecover` would
   leave zero in the output buffer, but with $r = P_x$ on the curve and $s = c P_x \neq 0$ it
   cannot fail here.

7. **The challenge commits to $\mathrm{addr}(R)$, a 160-bit hash of $R$, not to $R$.** That is
   what makes `ecrecover` usable, and it is the construction in Chainlink's contract. This
   experiment does not analyse what it costs in security against a forger.

8. **One transaction was admitted and then dropped once.** The first run's transfer
   (`0xcbb6534e…`) was sent just after the setup block. The node accepted it and simulation passed,
   but it never reached a block. Within 90 s, `txpool_status` showed it gone and there was no
   receipt. The same transaction re-signed mined at once, and so did the three that followed. This
   did not reproduce, and its cause is unknown. Experiment 10's silent drops had a cause (a
   deadline within one slot of the head); this one did not. A wallet should treat "accepted by
   `eth_sendRawTransaction`" as provisional and resend when the receipt does not come.
