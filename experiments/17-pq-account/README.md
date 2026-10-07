# 17 — A post-quantum account: one-time keys, chosen by the nonce

Every key in the experiments so far would fall to a large quantum computer: secp256k1, P256
and FROST alike. Hash-based signatures depend only on the hash function, and frames let an
account verify whatever it likes in VERIFY. The signature travels in an ARBITRARY entry with
`msg` ∅, which keeps its bytes out of the sig hash it signs. The account reads it with
`SIGDATACOPY`. No new opcode or precompile is involved.

[`WotsAccount.yul`](WotsAccount.yul) holds a Merkle tree of 1,024 one-time Winternitz (WOTS)
keys, in the manner of XMSS (RFC 8391). The root is in its code, and its VERIFY reads no
storage. A one-time key must never sign two messages. Stateful schemes like XMSS therefore keep
a counter, and lose everything if it is ever reused. Here the counter is the account's nonce:
the key for a transaction is leaf $K \cdot \text{nonce} + \text{attempt}$, with $K = 4$, and
VERIFY refuses any other leaf.

The signature is one ARBITRARY entry of $2 + n(1 + L + H)$ bytes:

| Field | Bytes | What |
|---|---|---|
| leaf | 2 | must satisfy $\lfloor \text{leaf} / K \rfloor = \text{nonce}$ on nonce key 0 |
| $R$ | $n$ | the signer's randomizer; digest $= \text{keccak256}(R \Vert \text{sig hash})[0{:}n]$ |
| chain values | $L \cdot n$ | the digest in base $w$, then the checksum $\sum (w - 1 - d_i)$ in base $w$ |
| path | $H \cdot n$ | the Merkle authentication path, $H = 10$ |

Each hash is tweaked, chain steps by (leaf, chain, step) and tree nodes by (level, index), and
cut to its first $n$ bytes. The parameters are five functions at the top of the Yul;
[`account.ts`](account.ts) rewrites them per variant. Three variants:

| Variant | $n$ | $w$ | Chains $L$ | Signature | Deployed code |
|---|---|---|---|---|---|
| n32-w16 | 32 B | 16 | 64 + 3 = 67 | 2,498 B | 588 B |
| n16-w16 | 16 B | 16 | 32 + 3 = 35 | 738 B | 608 B |
| n16-w256 | 16 B | 256 | 16 + 2 = 18 | 466 B | 606 B |

$n = 16$ is the hash size of FIPS 205's 128-bit parameter sets. With 128-bit digests the
randomizer matters. A party that composes part of the transaction, such as a sponsor, could
otherwise search for two transactions with the same 128-bit digest, which takes $2^{64}$ work.
$R$ is chosen after the transaction is fixed, so the search has nothing to aim at.

Each variant has two accounts. **main** sends real transactions, and no key of it is ever shown
to anyone twice. **burner** is where measurements and refusals are simulated. A simulation shows
the node a signature, so a burner's keys are spent by design.

| File | What |
|---|---|
| [`WotsAccount.yul`](WotsAccount.yul) | The account; written for n32-w16, the other variants are substitutions |
| [`wots.ts`](wots.ts) | Parameters, key generation (cached), signing with optional grinding of $R$, and a verifier that mirrors the contract |
| [`account.ts`](account.ts) | Compiles a variant, the CREATE2 address, `pqTx` (picks the leaf from the nonce and the attempt) |
| [`setup.ts`](setup.ts) | Deploys and funds the six accounts |
| [`example-pq.ts`](example-pq.ts) | A: one transfer per variant. B: a fee bump on a fresh key. C: the verification cap |
| [`measure.ts`](measure.ts) | VERIFY gas against verification work, on the burners |
| [`negative.ts`](negative.ts) | Refusals, on the n16-w16 burner, checked against `wots.ts` |
| [`reuse.ts`](reuse.ts) | Offline: what signing twice with one key gives a forger, counted exactly |

## Run

```bash
npx tsx experiments/17-pq-account/setup.ts        # once; first run hashes six trees (about 4 minutes)
npx tsx experiments/17-pq-account/example-pq.ts   # A-C
npx tsx experiments/17-pq-account/measure.ts      # simulation only
npx tsx experiments/17-pq-account/negative.ts     # simulation only
npx tsx experiments/17-pq-account/reuse.ts        # no network
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

Setup ([`0xb28a9158…`](https://dora.privacy.ethrex.xyz/tx/0xb28a915867eb50617cc6d1c15245ec9ce36c9c6855e5009805465697e0407b2e),
6,928,823 gas) deployed and funded the six accounts. The main accounts are:

- n32-w16: `0x568C0916cf7c9F01003FEe6a42FC20f51E9C157C`;
- n16-w16: `0x9C07b374a1f01059e2aFd6d4ED366a258704De9E`;
- n16-w256: `0x534C444165377f2f21f07f5e0E5a3Cd242E7cf10`.

**A.** One transfer of 0.0001 ETH from each, against the 27,382 gas of the same transfer from
an EOA's default code (experiment 15, A):

| Tx | Variant | Steps | VERIFY | Intrinsic | Calldata floor | `gasUsed` | Against ECDSA |
|---|---|---|---|---|---|---|---|
| [`0xb214621d…`](https://dora.privacy.ethrex.xyz/tx/0xb214621d169068e6663b91a1939b115549f56ebbda1bdec3910722354e57c33f) | n32-w16 | 510 | 66,923 | 58,862 | **179,114** | 179,114 (floor) | 6.5× |
| [`0xb9017b81…`](https://dora.privacy.ethrex.xyz/tx/0xb9017b81c81918bb81903db04a0ac23528bfb1cc2b335c55549d99cf57bbef53) | n16-w16 | 300 | 39,659 | 30,822 | 66,474 | **73,481** | **2.7×** |
| [`0x738854c6…`](https://dora.privacy.ethrex.xyz/tx/0x738854c6d0850576e334738a026e2dc2a5a83b5f844f4b2a9c56389c31a2b2f1) | n16-w256, $R$ ground (try 135,864) | 1,020 | 97,315 | 26,494 | 49,066 | 126,809 | 4.6× |

"Steps" is the verifier's hashing work: $\sum (w - 1 - d_i)$ over all chains. The transfer frame
is 3,000 gas in each. `gasUsed` is the larger of intrinsic + frames and the floor.

**VERIFY gas against steps** ([`measure.ts`](measure.ts): 12 simulations per variant on the
burners, least squares):

| Variant | Steps seen | VERIFY seen | Fixed | Per step | Largest residual | Most steps under 99,900 |
|---|---|---|---|---|---|---|
| n32-w16 | 435-570 | 60,398-72,143 | 22,553 | 87 | 0 | 889 |
| n16-w16 | 225-345 | 33,134-43,574 | 13,559 | 87 | 0 | 992 |
| n16-w256 | 1,020-2,295 | 97,315-208,240 | 8,575 | 87 | 0 | 1,049 |

The line predicts A exactly. The fixed part depends a little on the leaf's bits, through the
branch taken at each level of the path: leaf 9 (B and C) came in 15 gas under it.

**B.** A fee bump on n16-w16. Attempt 0 (leaf 8) was sent, and at once attempt 1 (leaf 9) for
the same nonce with both fees 25% higher. The pool held one transaction, the replacement.
Attempt 0 (`0xc0ac1b00…`) was never mined. Attempt 1
([`0x22aa05cc…`](https://dora.privacy.ethrex.xyz/tx/0x22aa05cc9c72135fac7ae3c715f22a9a336baa7a433795cb8bd0b105ae46abfa))
was mined in 305977: 255 steps, VERIFY 35,729, 69,563 gas. Two messages were signed for one
nonce, each with its own key.

**C.** w = 256 without grinding, at the testnet's verification cap. The testnet's nodes run with
a cap of 500,000 rather than the EIP's 100,000.

| VERIFY limit | Leaf | Outcome |
|---|---|---|
| 499,901 | 8 | refused: `Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS` |
| 499,900 | 9 | [`0xc487bc7b…`](https://dora.privacy.ethrex.xyz/tx/0xc487bc7b4cd4d60b2ef17720f7801c7824844c24db015340e20085ebcf37cabf): 2,550 steps, VERIFY **230,410**, 259,880 gas |

**Refusals** ([`negative.ts`](negative.ts), simulated on the n16-w16 burner). The second column
is the TypeScript verifier's verdict on the same bytes.

| Case | `wots.ts` | valid | Violation |
|---|---|---|---|
| baseline | ok | true | |
| a key of the previous nonce | leaf belongs to another nonce | false | validation prefix frame reverted |
| a key of the next nonce | leaf belongs to another nonce | false | validation prefix frame reverted |
| leaf 65535 (outside the tree) | leaf out of range | false | validation prefix frame reverted |
| one byte more | length | false | validation prefix frame reverted |
| one byte less | length | false | validation prefix frame reverted |
| one bit of $R$ flipped | root | false | validation prefix frame reverted |
| one bit of a chain value flipped | root | false | validation prefix frame reverted |
| one bit of the path flipped | root | false | validation prefix frame reverted |
| the signature of another transaction | root | false | validation prefix frame reverted |
| nonce key 1 | nonce key | false | validation prefix frame reverted |
| `msg` set to the sig hash | msg not empty | false | validation prefix frame reverted |
| VERIFY limit 20,000 | ok | false | validation prefix frame reverted (out of gas) |

**Signing twice with one key** ([`reuse.ts`](reuse.ts)). A WOTS signature reveals each chain at
its signed digit, and anyone can hash forward from there. After $s$ signatures under one key, a
forger can sign any digest whose digits, the checksum's included, are all at or above the
smallest signed ones. The forger also chooses $R$, so each try costs one keccak. The table
gives $\log_2$ of the expected number of tries, over 2,000 random signed messages, counted
exactly in integers:

| Variant | Signatures under one key | 10% | median | 90% |
|---|---|---|---|---|
| n32-w16 | 1 | 256.0 | 256.0 | 256.0 |
| n32-w16 | 2 | 36.2 | 60.7 | 72.3 |
| n32-w16 | 3 | 22.8 | 31.1 | 40.5 |
| n16-w16 | 1 | 128.0 | 128.0 | 128.0 |
| n16-w16 | 2 | **17.4** | **28.5** | 37.9 |
| n16-w16 | 3 | 10.9 | 14.5 | 21.0 |
| n16-w256 | 2 | 13.3 | 18.6 | 24.3 |
| n16-w256 | 3 | 7.5 | 10.4 | 13.9 |
| n16-w256, $R$ ground to ≤ 1,020 steps | 2 | 37.8 | 41.6 | 46.1 |
| n16-w256, $R$ ground to ≤ 1,020 steps | 3 | 29.8 | 32.5 | 35.6 |

With one signature, only the signed digest itself is forgeable ($2^{8n}$). That row is a check
on the count, not a finding.

## Observations

1. **A post-quantum account works on the public mempool today.** The prefix is an ordinary
   self-verifying VERIFY frame, and the node needed nothing new. The whole job is done by the
   ARBITRARY entry, whose bytes stay outside the hash they sign, and `SIGDATACOPY`. The best of
   the three variants costs 2.7 times an ECDSA transfer: 73,481 gas against 27,382.

2. **The calldata floor prices the signature, and verification hides under it.** EIP-8141
   charges at least 64 gas for every byte of the transaction: EIP-7976's 16 gas per token, 4
   tokens per byte. For n32-w16 that floor (179,114) is above the cost of doing the work
   (128,785): the VERIFY frame could spend 50,000 more gas without changing what is paid. So
   bytes are the first target and gas the second.
   - Halving $n$ cuts the signature from 2,498 to 738 bytes and the total by 59%.
   - n16-w16 lands just above its own floor, 73,481 against 66,474, which is about where the
     two costs balance.

3. **`MAX_VERIFY_GAS` decides $w$.** VERIFY costs a fixed part plus exactly 87 gas per hash step,
   of which keccak is 42. With $w = 256$, the work is $510 + 255 \times$ the checksum's high digit
   steps, about 2,300 for a random digest. That is 200,000-plus gas, which only the testnet's
   500,000 cap admits (C).

   Grinding $R$ until the work is 1,020 steps needs $2^{18.7}$ tries on average; this run took
   135,864. It brings VERIFY to 97,315, under the EIP's 99,900 for the frame. Getting to 765
   steps would need $2^{28}$ tries.

   Even ground, w = 256 costs more than w = 16 (126,809 against 73,481). It saves bytes the floor
   had already stopped charging for, and pays in hashing that it does not hide. ethrex counts
   the signature's own 100 gas against the cap, as the EIP says: a limit of 499,901 is refused
   and 499,900 is admitted.

4. **The nonce is the state, and it closes the hole stateful schemes are known for, except
   within one nonce.** XMSS and LMS are dangerous in practice because a signer that loses its
   counter, for instance by restoring a backup, signs twice with one key. Here the chain keeps
   the counter: a key whose nonce has passed is refused (`negative.ts`), and a key of a future
   nonce is refused too.

   What remains is signing twice for the same nonce: a fee bump, a cancellation, or a re-signed
   transaction after a crash. Two signatures under one n16-w16 key let a forger sign a
   transaction for that nonce after a median of $2^{28.5}$ tries, about 380 million keccak calls.
   That is minutes of work, and the forged transaction can then race the honest one. Hence
   $K = 4$ keys per nonce. In B, a 25% fee bump replaced the pending transaction, and no key
   signed twice. A wallet that runs out of attempts for a nonce must stop and wait.

5. **Simulation is publication.** Any signature that has left the wallet counts as used:
   simulated, refused or replaced. C's refused transaction had shown leaf 8 to the node, so the
   admitted one used leaf 9. All measurement and every negative case ran on burner accounts for
   this reason. A wallet's bookkeeping is "which leaves have left this device", not "which
   transactions were mined". `eth_estimateGas`, simulation and `eth_sendRawTransaction` all
   count.

6. **An honest signer who grinds also reveals less.** Grinding $R$ for little verification work
   means signing digests with high digits, so the chain values revealed sit near the public
   ends. Two ground w = 256 signatures under one key leave a forger needing $2^{41.6}$ tries,
   against $2^{18.6}$ without grinding. That is a side effect, not a reason to drop $K$.

7. **The EVM's loop overhead is half the verification cost.** solc's own compilation of the
   chain loop cost about 130 gas a step. Keeping the value in memory, rewriting only the
   tweak's last byte with `MSTORE8`, and unrolling by two brought it to 87. A first deployment
   with the original loop measured this directly:
   - [`0xd175f2ae…`](https://dora.privacy.ethrex.xyz/tx/0xd175f2ae680209aed379d840b81f5550fe4cf51fa0c66038f8905a6285365d6e):
     VERIFY 79,934 gas at 510 steps, where the final code needs 66,923;
   - [`0x43da0344…`](https://dora.privacy.ethrex.xyz/tx/0x43da03441529a67f157d8a443c66cbf5dfdca2355e9699dc19ebb25e6f181cfb):
     48,184 gas at 270 steps, where it needs 37,049.

   Of the 87 gas, 42 is keccak itself. An opcode or precompile that iterates a hash would take
   the rest away. The floor would then be nearly the whole cost, and w = 256 would become the
   better choice.

8. **What this does not do.**
   - The tree is fixed in code. 1,024 keys at 4 per nonce is 256 transactions, after which the
     account must move its funds. A larger tree costs $n$ bytes per level, 64 gas each under the
     floor, and key generation: $2^{10}$ leaves took 10 to 80 s in this TypeScript, so $2^{20}$
     would take hours. A root kept in storage could be rotated by a SENDER frame. VERIFY may
     read its own storage, at 2,100 gas.
   - The account uses only nonce key 0. Keyed nonces would let several transactions wait
     together (experiment 16), but each fresh key costs 97,920 state gas.
   - A sponsor who pays with secp256k1 is not post-quantum, even though the account is. The
     chain's consensus is out of scope.
   - The hashing follows XMSS in outline, but has no public seed, and it has not been reviewed.
     It is an experiment, not a scheme.
