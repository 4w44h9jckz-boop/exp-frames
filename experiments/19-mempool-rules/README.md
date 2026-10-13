# 19 — The public mempool's rules, probed one at a time

EIP-8141 lets anyone write validation code. The public mempool can carry that code only if
validation cannot be invalidated cheaply by someone else, so the EIP limits what a validation
prefix may depend on:
- transaction fields;
- the block timestamp as read by an expiry verifier frame;
- the sender's nonce, code and storage;
- a deploy frame's factory code;
- a canonical paymaster, or a non-canonical payer used by one pending transaction;
- the code of other existing, non-delegated contracts.

The trace rules enforce that list:
- a set of banned opcodes;
- `SLOAD` only of `tx.sender`;
- `CALL*` and `EXTCODE*` only to an existing contract or a precompile, never to an
  EIP-7702-delegated address.

Earlier experiments ran into these rules one at a time, as refusals on the way to something else.
This experiment probes them on purpose. It does three things:
1. **Trace rules.** One transaction per rule, each with a VERIFY frame that does exactly one
   thing, offered to both `ethrex_simulateFrameTransaction` and `eth_sendRawTransaction`.
2. **Replacement.** Which fee a replacement must raise.
3. **Receipt finality.** Experiment 16's hypothesis has two parts. First, ethrex can return a
   receipt from a block that never becomes canonical. Second, a transaction sent on the strength
   of that receipt is then dropped. This experiment tests both.

The [last table](#every-mempool-rule-measured-so-far) gathers every mempool rule this repository
has measured, from experiment 06 on.

[`ProbeAccount.yul`](ProbeAccount.yul) is an account with an owner key in code. Its VERIFY frame
checks the owner's SECP256K1 signature, which is entry 0 with `msg` ∅. It then runs the probe
that its frame data names, `id (1) ‖ argument`, and approves. The argument is an address or an
8-byte deadline. Banned opcodes are emitted with `verbatim`, so the optimizer cannot drop them.
[`Helper.yul`](Helper.yul) is the contract the probes call. With empty calldata it returns
`SLOAD(0)`: its own slot 0 when called, and the caller's slot 0 when DELEGATECALLed. With any
calldata it returns 1 and touches no storage.

| File | What |
|---|---|
| [`ProbeAccount.yul`](ProbeAccount.yul) | The account: owner check, then probe 1-30, then `APPROVE` |
| [`Helper.yul`](Helper.yul) | A contract to call: reads storage or not, depending on the calldata |
| [`probes.ts`](probes.ts) | Setup (the two contracts, an EIP-7702-delegated EOA), the probe table, and the "not before" resend |
| [`replace.ts`](replace.ts) | Seven replacement attempts against a pending transaction |
| [`receipts.ts`](receipts.ts) | The gap between consecutive block timestamps over 20,000 blocks, then rounds of a transaction and a dependent one |

## Run

```bash
npx tsx experiments/19-mempool-rules/probes.ts          # setup (once), then every probe; or: probes.ts 22 19
npx tsx experiments/19-mempool-rules/replace.ts
npx tsx experiments/19-mempool-rules/receipts.ts 80     # 80 rounds, about 40 minutes
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

The accounts and contracts:

| Name | Address |
|---|---|
| ProbeAccount (owner `0x932E…EEb1`) | `0x79b5bA93775ED3fE670d1C40396F62D28A87f2Fe` |
| Helper | `0xb4B2eCf546C330c1FBA8266CCCD420b2F295E732` |
| delegated EOA, delegated to the Helper | `0xe9CdC6C5f34D82d124CE540a89B2f56D990cB2E3` |
| dana, experiment 15's EOA: nonce 20, a balance, no code | `0xbc263E783572AaD9C0ADAcE6bD65365727076b45` |
| an address nothing has touched | `0xb09ED8167C656A60232D84a3aAc3FCf776E17f27` |

Setup was [`0xdd3285b2…`](https://dora.privacy.ethrex.xyz/tx/0xdd3285b2ef871fbd605a0070c22c31346d6e55f254d68a161775407fe82e7819).
It deployed both contracts and funded the account, for 1,390,069 gas. The delegation is a type-4
transaction that the funder sends:
- The first try, `0x5f4dcaf8…`, had a fixed 100,000 gas limit. It failed with status 0 and used
  all 100,000 gas. The authorization was not applied, and the EOA kept nonce 0 and no code.
- The second, `0x96fb93f0…`, used an estimate padded by 20% and succeeded with 255,740 gas.

Observation 4 explains the difference.

### The trace rules

Each row is one transaction with frames `[VERIFY(probe), SENDER(no-op)]`. The two RPCs gave the
same verdict, with the same message, in every row, so the table shows one verdict.
`eth_sendRawTransaction` prefixes its refusals with `Frame transaction validation-prefix
simulation failed:`. Every admitted probe was mined in the next block.

| # | VERIFY does | EIP | ethrex | Mined |
|---|---|---|---|---|
| 0 | nothing (baseline) | allowed | **admitted** | [`0xeb293eb7…`](https://dora.privacy.ethrex.xyz/tx/0xeb293eb7ea7ac27f1ce04b0e17f4184a792525d9e30daba461f5aa9c597b55f3), VERIFY 1,045 |
| 1 | `GASPRICE` | banned | refused, `BannedOpcode(58)` | |
| 2 | `BLOCKHASH` | banned | refused, `BannedOpcode(64)` | |
| 3 | `COINBASE` | banned | refused, `BannedOpcode(65)` | |
| 4 | `TIMESTAMP` | banned | refused, `BannedOpcode(66)` | |
| 5 | `NUMBER` | banned | refused, `BannedOpcode(67)` | |
| 6 | `PREVRANDAO` | banned | refused, `BannedOpcode(68)` | |
| 7 | `GASLIMIT` | banned | refused, `BannedOpcode(69)` | |
| 8 | `BASEFEE` | banned | refused, `BannedOpcode(72)` | |
| 9 | `BLOBBASEFEE` | banned | refused, `BannedOpcode(74)` | |
| 10 | `SLOTNUM` (0x4B) | banned | refused, `BannedOpcode(75)` | |
| 11 | `GAS`, then `POP` | banned | refused, `BannedOpcode(90)` | |
| 12 | `GAS`, then `STATICCALL` to a precompile | allowed | **admitted** | [`0x8e4b903e…`](https://dora.privacy.ethrex.xyz/tx/0x8e4b903e2f978d82f4e7b456695763022cb2a2a34990f6a8e72844fe15b58310) |
| 13 | `BALANCE` of the sender | banned | refused, `BannedOpcode(49)` | |
| 14 | `SELFBALANCE` | banned | refused, `BannedOpcode(71)` | |
| 15 | `SLOAD` of the sender | allowed | **admitted** | [`0x73696b5b…`](https://dora.privacy.ethrex.xyz/tx/0x73696b5ba4b5e7e27b4adeca3c9c25e5fbfe0ccf2d7f9fe391abe1a81b9bcfd8) |
| 16 | `STATICCALL` to the Helper, which reads its own storage | banned | refused, `StorageReadNonSender` | |
| 17 | `STATICCALL` to the Helper, no storage read | allowed | **admitted** | [`0x6415da0f…`](https://dora.privacy.ethrex.xyz/tx/0x6415da0f0b62e38689abc746657edf340db0d51f31865e6a054217fac6fd1bc4) |
| 18 | `DELEGATECALL` to the Helper, which reads the sender's storage | allowed | **admitted** | [`0x98737aba…`](https://dora.privacy.ethrex.xyz/tx/0x98737abab220e41144368210ae489abb03bca845b6f1e39b8ac512eefec710b0) |
| 19 | `STATICCALL` to an address nothing has touched | banned | refused, `CallToNonexistentOrDelegated(0xb09e…)` | |
| 19 | `STATICCALL` to dana: nonce and balance, no code | banned | **admitted** | [`0x1b02b102…`](https://dora.privacy.ethrex.xyz/tx/0x1b02b102684dd499bf408db9fd90817e2f5d7fd12f481345ac0f70ba3dbc95c1); again later, [`0x4d384224…`](https://dora.privacy.ethrex.xyz/tx/0x4d3842247df1a09104f4a484d0d88310dd316953dfe1b47dd6d0dc00e11711bb) |
| 20 | `EXTCODESIZE` of an address nothing has touched | banned | refused, `CallToNonexistentOrDelegated(0xb09e…)` | |
| 21 | `EXTCODEHASH` of a contract | allowed | **admitted** | [`0xd5566074…`](https://dora.privacy.ethrex.xyz/tx/0xd55660742924f0eee2890fcf21d867c0cde18942e5c0ed84e65544f31f9b19c0) |
| 22 | `STATICCALL` to the EIP-7702-delegated EOA | banned | refused, `CallToNonexistentOrDelegated(0xe9cd…)` | |
| 23 | `INVALID` | banned | refused, `BannedOpcode(254)` | |
| 24 | `TLOAD` (not in the list) | allowed | **admitted** | [`0x75cf7f36…`](https://dora.privacy.ethrex.xyz/tx/0x75cf7f36712749f2dd600e037cca642e92ca193db72b0f48694983c85e7c521c) |
| 25 | `ORIGIN` (not in the list) | allowed | **admitted** | [`0xa9112995…`](https://dora.privacy.ethrex.xyz/tx/0xa91129956fead7b8c29fdfcde83d82e5c4a27c51000e7eb683404933bf4ce606) |
| 26 | `TXPARAM(0x0D)`, the legacy nonce | allowed | **admitted** | [`0x41fbe466…`](https://dora.privacy.ethrex.xyz/tx/0x41fbe466e7df1c6c818fdde1cd3fc43545df9319adc59cb702e2fa103637fc8b) |
| 27 | `CREATE` | VERIFY is static: reverts | refused, `validation prefix frame reverted` | |
| 28 | `EXTCODESIZE` of a precompile | allowed | **admitted** | [`0x8c555cd8…`](https://dora.privacy.ethrex.xyz/tx/0x8c555cd8c0a0f71ab3dd1b579953c590925593e95ebcdcde443e71a18ae2785a) |
| 29 | `STATICCALL` to the expiry verifier `0x8141`, deadline $2^{64}-1$ | banned (see observation 2) | **admitted** | [`0x0a1e154d…`](https://dora.privacy.ethrex.xyz/tx/0x0a1e154df3b0cb41dcc22bdcb393bdc2e9462cb41c44b472c45da0fe2331bb84), VERIFY 4,123 |
| 30 | "not before head − 60 s": `STATICCALL` the verifier, require it to **refuse** | banned | **admitted** | [`0xad6f9bb2…`](https://dora.privacy.ethrex.xyz/tx/0xad6f9bb2f4e3de7ddefd17119d22dcb3ab33e62c59521bc165e670ec7e72aadd), VERIFY 4,141 |
| 30 | "not before head + 120 s" | banned | refused, `validation prefix frame reverted` | |

In the first run, row 22 named an EOA whose delegation had not been applied, the failed
`0x5f4dcaf8…`. It was refused, but as an untouched address. The row above is the re-run after
`0x96fb93f0…`, with the EOA's code reading `0xef0100 ‖ Helper`.

**"Not before", end to end.** The account's VERIFY passes only if the expiry verifier refuses the
deadline it is given, that is, only if $\texttt{block.timestamp} > \texttt{deadline}$. The script
signed one transaction with deadline 1791373159, two minutes past the head:
1. Before that time, both RPCs refused it (the last row).
2. The script waited until the head's timestamp passed 1791373159, and rebuilt the same
   transaction at the new nonce.
3. Simulation said valid, and it was mined in block 306152, timestamp 1791373171:
   [`0x473d6320…`](https://dora.privacy.ethrex.xyz/tx/0x473d6320383fa11f4e7cad9ecb78c59cab1211dbe5692bf77e3b72b5cd9f7571).

### Replacement

Each case waits for a new head, then sends an original (max fee 2 gwei, tip 1 gwei) and at once a
replacement at the same nonce, from `0x14C1…3485`:

| Replacement | Max fee | Tip | Offered | Mined |
|---|---|---|---|---|
| both fees +10% | 2.2 gwei | 1.1 gwei | **accepted** | the replacement, [`0x960ab67b…`](https://dora.privacy.ethrex.xyz/tx/0x960ab67b9d5840cf079759e8b0e760d220afb47889ae7a95e069f64ccdaf30b9) (block 306229) |
| both fees +9% | 2.18 | 1.09 | refused: `Attempted to replace a pooled transaction with an underpriced transaction` | the original |
| tip +10%, max fee unchanged | 2 | 1.1 | refused, the same | the original |
| max fee +10%, tip unchanged | 2.2 | 1 | refused, the same | the original |
| tip +100%, max fee unchanged | 2 | 2 | refused, the same | the original |
| max fee +100%, tip unchanged | 4 | 1 | refused, the same | the original |
| both fees unchanged (other frames) | 2 | 1 | refused, the same | the original |

### Receipts: is a receipt final when it arrives?

**History.** The gaps between consecutive block timestamps over blocks 286200-306200 (20,000
gaps, 128,520 s):

| Gap (s) | Blocks | Share |
|---|---|---|
| 6 | 18,842 | 94.21% |
| 12 | 971 | 4.86% |
| 18 | 133 | 0.67% |
| 24 | 38 | 0.19% |
| 30 | 13 | 0.07% |
| 36 | 1 | 0.01% |
| 42 | 2 | 0.01% |

That is 21,420 slots for 20,000 blocks: 1,420 slots without a block, 6.63%.

**Rounds.** One round runs as follows, from an EOA of its own (`0xC2B1…567b`):
1. Send A.
2. Poll for A's receipt every 250 ms.
3. The moment a receipt arrives, send B at the next nonce. B is valid only if A is in the parent
   state.
4. Two blocks later, compare A's receipt with the canonical chain.

80 rounds, blocks 306224-306459:

| | Rounds |
|---|---|
| A's canonical block came 12 s after its parent (a slot was missed just before it) | 5 (rounds 13, 21, 24, 43, 68) |
| A's receipt named a block that is **not** the canonical block at that height | **1** (round 24) |
| B refused at admission | 0 |
| B dropped | **0** |

B went out 216-318 ms after A's receipt arrived, every time.

Round 24:
- A's receipt said block 306292, hash `0xe444fffe…`.
- The canonical block 306292 is `0x72d06b41…`, timestamp 1791374035. Its parent, 306291, is 12 s
  older.
- A, [`0x7ad80e97…`](https://dora.privacy.ethrex.xyz/tx/0x7ad80e97b77c814cf95b4acf08ad94107e73e94cd136c35f5e7b44cf16c74c4e),
  is in the canonical block too, and a later receipt names it.
- B, [`0x57ab2d98…`](https://dora.privacy.ethrex.xyz/tx/0x57ab2d9821255bcea9caff67597c816728755940217cc8c6ce27bd1bd5ead7ad),
  was mined in 306293.

So the node served a receipt from a block it built for the missed slot, then built 306292 again
one slot later with the same transaction. B was sent on the stale receipt and survived.

**One drop, in passing.** Experiment 20's quorum script had a drop while these rounds ran:
- Bob's [`0xa4033d80…`](https://dora.privacy.ethrex.xyz/tx/0xa4033d80ea01c551852543f5f1647a6a5ab743661928ed65191c6a5e1125793a)
  is in canonical block 306358, 12 s after its parent.
- Bob's next transaction, `0xf9e24f27…`, was sent the moment the receipt arrived. It was accepted
  and never mined, and block 306359 was empty.
- That script did not record the receipt's block hash, so it is not known whether the receipt was
  stale.

Experiment 20 now waits for a child block before it sends again, and has had no drop since.

### Every mempool rule measured so far

What this repository has seen ethrex's public mempool do, rule by rule, with the experiment that
measured it. "EIP" is EIP-8141 as pinned (Draft) together with EIP-8250 for nonce keys.

| Rule | EIP | ethrex | Where |
|---|---|---|---|
| Banned opcodes in the prefix | 15 opcodes, `GAS` allowed before a call, `TIMESTAMP` in the expiry frame | as listed, each refused with `BannedOpcode(n)`; `INVALID` too | 19 |
| `TIMESTAMP` through a nested call into `0x8141` | banned: excepted only "in an expiry verifier frame" | **admitted**, so VERIFY can say "not before" | 19 (observation 2) |
| Storage reads | only `tx.sender`, also through calls | refused `StorageReadNonSender`, including a copied paymaster's own slot | 09, 14, 19 |
| `CALL*`/`EXTCODE*` targets | an existing contract or a precompile; not 7702-delegated | untouched address and delegated EOA refused; **a code-less EOA with a nonce or balance admitted** | 19 (observation 3) |
| A delegated sender as its own VERIFY target | allowed (default-code exception, and the target is the sender) | admitted | 15 |
| `MAX_VERIFY_GAS` | 100,000, signature gas included | **500,000** on this testnet (a node flag); 500,001 refused; signature gas included (499,901 + 100 refused) | 06, 17 |
| `MAX_VERIFY_STATE_GAS` | 500,000 across the prefix | enforced; it stops a self-deploy at 206 B of code | 08 |
| Pending transactions per sender | one; a future policy MAY admit several on disjoint non-zero keys | one on key 0; **several on disjoint non-zero keys** if the prefix reads no sender storage; key 0 and a keyed one never together | 08, 12, 16 |
| Nonce gaps | not queued | refused at admission, `Nonce mismatch` | 06, 10 |
| Max fee below the base fee | not includable | refused at admission | 10 |
| Replacement | both fees up by a node minimum, 10% conventional; the payer may change | both fees +10% required; +9%, +9.98% and one fee alone refused; a different payer accepted | 09, 12, 19 |
| Canonical paymaster | many pending, against `balance − reserved − pending_withdrawal` | many pending, reservation enforced; **the pending withdrawal ignored** | 09 |
| Non-canonical payer | at most 1 pending; a code-less payer exempt | 1 pending, **a code-less payer capped too** | 06, 09 |
| Canonical pay frame over 15,000 gas | MAY be rejected | 50,000 accepted | 09 |
| Expiry frame | first frame only, one per transaction, dropped once the deadline is behind the node's head | as specified; a deadline inside the next slot is admitted and then dropped without a receipt | 10 |
| Expiry frame, structure | flags, value, state budget, 8-byte data | each refused with its own message | 10 |
| Simulation and admission | (not specified) | the same verdict in every case tried; admission runs the expiry frame's structural checks first, with their own messages | 10, 14, 19 |
| Receipts | (not specified) | a receipt can come from a block built for a slot that is then missed (1 round in 80); a transaction sent on it sometimes survives and sometimes is dropped | 07, 15, 16, 19, 20 |

## Observations

1. **The trace rules are enforced as written, almost everywhere, and the errors name the rule.**
   Every opcode on the EIP's list was refused with `BannedOpcode(n)`. So was `INVALID`, which is on
   the list, rather than reported as a halt. `GAS` was allowed only when a call came next.
   `TLOAD`, `ORIGIN` and `TXPARAM(0x0D)` are not on the list and were admitted. The EIP has no
   reason to ban them: transient storage is empty at the start of a frame and `ORIGIN` is the entry
   point. A helper contract may be called, or DELEGATECALLed to read the sender's own storage. It
   may not read its own. The two exceptions follow.

2. **ethrex lets VERIFY call the expiry verifier, and that gives VERIFY a lower bound on time.**
   Probe 30 calls `0x8141` from inside the account's own VERIFY frame and requires it to revert.
   The transaction is valid only after the deadline, and the run shows the whole sequence: refused
   before its time, then mined after it. The EIP excepts `TIMESTAMP` only "in an expiry verifier
   frame executing the canonical runtime code", and an expiry verifier frame is one whose
   `frame.target` is `0x8141`. A nested call is not one, so under the EIP as written probes 29 and
   30 are banned. ethrex decides by the executing code's address at any call depth, and its source
   says so on purpose (`crates/vm/levm/src/vm.rs`, the `TIMESTAMP` arm of the validation observer).
   - **Is it safe for the pool?** A lower bound only ever turns invalid into valid. A
     transaction refused before its time costs the node nothing, and the sender sends it again
     later, so the lower bound adds no invalidation risk. An upper bound through the same call
     does: probe 29 with a near deadline is a nested expiry the node cannot see. The EIP's
     dependency set has "the block timestamp as read by an expiry verifier frame" only, and its
     eviction rule looks at the expiry frame's deadline. Not tested: whether ethrex re-simulates
     such a transaction at each head or keeps it until a builder fails it.
   - **What it changes.** Experiment 10 (observation 6) says there is no `validAfter`.
     Experiment 13 (observation 1) says VERIFY "can bound time from above and never from below".
     Both hold for the EIP and not for this client. Both READMEs now say so. Experiment 13's
     recovery delay could be checked in VERIFY here: read the unlock time from the sender's
     storage, then call `0x8141` with it. That is portable to no other client that follows the
     EIP's wording. The portable fix is the one experiment 13 suggested: let the expiry frame
     carry a lower bound too.

3. **ethrex lets VERIFY call a code-less EOA that has a nonce or a balance.** Probe 19 against dana
   was admitted twice and mined. The EIP allows `CALL*` and `EXTCODE*` only to "an existing
   contract or a precompile". Its dependency set has "the code of any other existing non-delegated
   contracts". ethrex refuses only an empty account (nonce 0, balance 0, no code); its check is
   `get_account(target).is_empty()`. The difference matters because an EOA's code is mutable. One
   type-4 transaction from dana delegates her, which changes what the call does, and probe 22 shows
   the call is then banned. So a transaction whose VERIFY calls dana depends on state outside the
   EIP's dependency set. Many pending transactions could depend on one EOA, and one delegation
   would invalidate them all for the price of a type-4. Not tested: whether ethrex evicts them when
   that happens. The fix belongs in the client: test for code, not for emptiness.

4. **Creating an account costs 183,600 state gas, and two setups here failed on it.**
   - The funding transfer to `receipts.ts`'s fresh EOA ran out of gas.
     [`0x95b41897…`](https://dora.privacy.ethrex.xyz/tx/0x95b41897f3a3b34dc6bd53c56b3866d2bd7d2bf2daecb74500c899848e27cd04)
     was mined with its SENDER frame `FAILURE`, 30,000 of 30,000 execution gas and no state gas. A
     value transfer that creates its recipient needs `NEW_ACCOUNT_STATE_GAS` in the frame's state
     limit.
   - The type-4 delegating a fresh EOA needed 255,740 gas, against 70,048 for dana in experiment 15.
     dana already existed. The fixed 100,000 gas limit failed, used everything, and applied
     nothing.

   Both are experiment 15's estimate lesson again. Estimate with the state the transaction will
   create, and pad.

5. **Replacement follows the EIP exactly: both fees, at least 10%.** Raising only the tip, or only
   the max fee, was refused even at +100%. A wallet's fee bump raises both. With experiment 09's
   0.02 percentage points (9.98% refused), the threshold is 10% inclusive.

6. **A receipt is provisional until a block is built on it.** Experiment 16's hypothesis held
   in part:
   - **Confirmed:** ethrex can return a receipt naming a block that never becomes canonical, and
     then include the transaction in a rebuilt block at the same height one slot later (round 24).
   - **Not confirmed as a rule:** that a transaction sent on such a receipt is evicted. B survived
     in round 24, and 0 of 80 Bs were dropped.

   The drops in experiments 07, 15, 16 and 20 all followed a block that came 12 s after its parent.
   What decides whether the dependent transaction survives is still unknown. The receipt's age
   when the dependent transaction arrives is a candidate, against when the node discards the
   missed slot's payload. Missed slots are 6.6% of all slots here, and a stale receipt came in 1
   of 80 rounds.

   The wallet rule costs one slot. After a receipt, wait until the head is past its block before
   sending anything that depends on it, and re-read the receipt then. Experiment 20's `confirmed()`
   does exactly this.

7. **Simulation is a faithful dry run of admission.** In this experiment's 31 probes,
   `ethrex_simulateFrameTransaction` and `eth_sendRawTransaction` gave the same verdict, with the
   same message. The refusals in experiments 10 and 14 gave the same verdict too. Admission runs
   the expiry frame's structural checks before it simulates, so those refusals carry their own
   messages (experiment 10, shapes). A wallet can simulate first and expect the pool to agree, for
   the same head. The exceptions are the paymaster and per-sender caps, which depend on what else
   is pending, and simulation does not see the pool.
