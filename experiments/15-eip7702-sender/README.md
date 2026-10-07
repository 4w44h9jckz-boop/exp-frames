# 15 — An EIP-7702-delegated EOA as the sender

A plain EOA already gets a lot from EIP-8141: the default code lets it batch, be sponsored and pay
gas in ERC-20 (experiments 01-04). What it cannot get from the default code is any validation
other than its own secp256k1 key. EIP-7702 lets an EOA point at contract code while keeping its
address. This experiment delegates an EOA to code that adds a device P256 key. It then checks
what frames make of a delegated sender, and what goes wrong at the seams between the two EIPs.

[`PasskeyDelegate.yul`](PasskeyDelegate.yul) is the delegate. Its VERIFY accepts entry 0
(`msg` ∅) signed either by the EOA itself, as SECP256K1 with signer `address()`, or by a P256 key
the EOA has registered in its own storage, at the namespaced slot
`keccak256("exp-frames.15.passkey")`. Registration is a SENDER frame the EOA sends to itself.
Frame transactions carry no authorization list, so delegating and clearing are ordinary type-4
transactions. Here the funder sends them and dana only signs the authorization.

| File | What |
|---|---|
| [`PasskeyDelegate.yul`](PasskeyDelegate.yul) | The delegate, deployed once and shared |
| [`delegated.ts`](delegated.ts) | Keys (dana, a stranger), `setDelegation` / `clearDelegation` (type-4 via viem), `eoaTx`, `registerPasskey` |
| [`example-7702.ts`](example-7702.ts) | Setup, then A-F, with refusals (E2) and a race (F0) |
| [`estimate.ts`](estimate.ts) | `eth_estimateGas` for a type-4 whose authorization is valid now, and one valid a transaction later |

## Run

```bash
npx tsx experiments/15-eip7702-sender/example-7702.ts   # setup (once), then A-F; repeatable
npx tsx experiments/15-eip7702-sender/estimate.ts       # estimates only
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

Dana is `0xbc263E783572AaD9C0ADAcE6bD65365727076b45`; the delegate is
`0xa6D0e0127fAa0291102AeB59a8fc0D146F92907B`. The script ran three times. The first run's D
had no state gas and failed, and its C was dropped (observation 6). The second run is the clean
one, and the third added C2, E2 and F0.

| Tx | What | VERIFY | `gasUsed` |
|---|---|---|---|
| [`0x3626bfff…`](https://dora.privacy.ethrex.xyz/tx/0x3626bfffa2fc1638c5b70f4b8e23fa5b3c4ae80c6cd3025112402ff7485e5f78) | setup: deploy the delegate, fund dana | | 789,876 |
| [`0x344bde97…`](https://dora.privacy.ethrex.xyz/tx/0x344bde97d1380e089ae7636a6582b9edbefdbb5ca219ff778f90e22e65d6c94d) | **A.** dana pays, no code: the default code | 100 | 27,382 |
| type 4, `0x1476e840…` | **B.** dana delegates to PasskeyDelegate (the funder sends and pays) | | 70,048 |
| [`0x5b31310f…`](https://dora.privacy.ethrex.xyz/tx/0x5b31310f62aad1b87c13b1bb15f2d1f48fe732878e9cd4832b5ef8c28aeff0eb) | **C.** dana pays, delegated: the delegate checks the EOA key | **3,321** | 29,467 |
| [`0xbeeeb9f0…`](https://dora.privacy.ethrex.xyz/tx/0xbeeeb9f0167eb5c3827b056e77e80d275d1d9b41d845ad66cf8aa8fdbb77d020) | **D.** dana registers the device key (one fresh slot) | 3,321 | 131,157 |
| [`0xd56b23e8…`](https://dora.privacy.ethrex.xyz/tx/0xd56b23e8c079dc46db0c9488cea00af45c08eb7f9fb9b24357f2f70313e06d07) | **E.** the device key pays from dana's address (P256 entry) | **5,475** | 36,517 |
| type 4, `0x3f55c39d…` | **F.** dana clears the delegation | | 31,816 |
| (same as A) | **F.** dana pays with the default code again; the device key is refused | 100 | 27,382 |
| [`0x9de7b8b0…`](https://dora.privacy.ethrex.xyz/tx/0x9de7b8b0218e1d085eb9d0afa7bd5b5505af3fa70f2139471c89a8f63dffddbd) | first run's D: the registration frame had no state gas for the fresh slot and ran out of gas | 3,321 | 60,791 |

Third run, simulated while delegated:

| Case | valid |
|---|---|
| **C2.** the device key, right after re-delegation and before D | **true** (the slot survived the clear) |
| **E2.** a stranger's secp256k1 key | false, `validation prefix frame reverted` |
| **E2.** an unregistered P256 key | false, prefix reverted |
| **E2.** dana signs an explicit `msg` | false, prefix reverted |
| **F.** after clearing: the device key | false, prefix reverted (the default code wants SECP256K1) |

Third run, **F0**, a race. The device key's frame transaction is sent, and at once the funder
sends a type-4 clearing the delegation. Both landed in block 305463:

| Index | Tx | Outcome |
|---|---|---|
| 0 | [`0x35ee10cd…`](https://dora.privacy.ethrex.xyz/tx/0x35ee10cd621576642f0ea37e3d15c4297f8d62e763df634774c07bcbea8f5478), the device key's payment | mined, success; dana's nonce 17 → 18 |
| 1 | `0x79ac4a29…`, type 4 clearing, authorization nonce 18, gas limit **26,200** | **status 0**, authorization not applied; dana still delegated |

Gas estimates for the same type-4 against the head state, from [`estimate.ts`](estimate.ts) run after the third run:

| Authorization | valid at the head | valid one transaction later |
|---|---|---|
| delegate to PasskeyDelegate | 70,909 | 23,152 |
| clear (address 0) | 32,170 | 23,152 |

## Observations

1. **A delegated EOA is a working frame sender in the public mempool.** The VERIFY frame targets
   the sender, and runs the delegate's code at the EOA's address. ethrex admitted and mined it
   (C, D, E). The EIP's trace rules forbid `CALL*` to an EIP-7702-delegated address during
   validation, "except for `tx.sender` default-code behavior". A delegated sender as the VERIFY
   target did not trip that rule here. VERIFY costs 3,321 gas for the EOA key through the
   delegate, against 100 for the default code, and 5,475 for the P256 key plus its 6,700 signature
   gas.

2. **Delegation switches the default code off.** Once the EOA has a delegation indicator, it has
   code, and the protocol's default code no longer runs. A delegate that does not check the EOA's
   own key locks that key out of frame transactions. PasskeyDelegate checks it again. The key
   never loses its power, though: it can still sign legacy transactions and a new type-4. Adding a
   passkey this way adds a key; it does not protect the account against the EOA key.

3. **What delegation buys over the default code is validation, and only that.** Batching,
   sponsorship and ERC-20 gas already work for a code-less EOA. Delegation is worth it for a
   second key, a session policy (experiment 12) or a recovery path (experiment 13) at an address
   the user already has. It costs a type-4 transaction to set (70,048 gas) and another to clear
   (31,816), because frame transactions cannot carry authorizations.

4. **Storage outlives delegation.** Clearing the delegation leaves dana's storage alone. In the
   third run, the device key registered in the second run was valid again the moment dana
   re-delegated (C2), before she registered anything. Namespaced slots stop two different
   delegates from reading each other's layout. They do not stop the same delegate from finding
   old state. A wallet revoking a key should remove it (`0x02`) before clearing the delegation.

5. **Clearing a delegation cannot overtake a pending transaction, and here it failed outright.**
   In F0 the builder ordered the pending frame transaction first. The clearing type-4, sent by
   another account (the funder), could not replace it. Its gas limit came from an estimate
   made while dana's nonce was still 17, so the authorization (signed with her pending nonce, 18)
   was invalid at estimation and was not priced: 26,200 instead of about 32,000. At inclusion the
   frame transaction had moved dana's nonce to 18, the authorization became valid, the gas did not
   cover it, and the type-4 failed and changed nothing. `estimate.ts` reproduces the gap: 23,152 for an
   authorization valid one transaction later, against 32,170 or 70,909 for one valid now. Two
   lessons for a wallet:
   - Estimate a type-4 with the authorization valid, and pad the estimate.
   - To cancel a pending frame transaction, replace it at the same nonce from the same sender
     (experiment 12, E). A delegation change from someone else cannot do it.

   A self-sent type-4 from dana at the pending nonce, with higher fees, might replace the frame
   transaction. That is not tested.

6. **One more silent drop.** In the first run, C (`0x798afbb4…`, the first frame transaction after
   the delegation) was accepted, simulated valid, and then left the pool without a receipt. In the
   second and third runs the same step mined in the next block. Experiment 07 saw the same thing
   once, also on the first transaction after the sender's code changed, and it did not reproduce
   there either. The pattern is suggestive, not established.

   *Amended after experiment 16.* Block 305424, which held B, is 12 s after its parent instead
   of 6, so the slot before it was missed. Experiment 07's drop follows a block with the same
   gap. Experiment 16 then caught a receipt for a block that was rebuilt a slot later, with
   transactions sent after the receipt (its observation 6). The working hypothesis is this:
   - B's receipt came from a payload built for the missed slot;
   - the pool revalidated C against the parent state, where dana was not yet delegated, and
     evicted it;
   - nothing readmitted it when the block was rebuilt.

   The sender's code changing is then incidental: what matters is that C's validity depended on
   the vanished block. Experiment 19 tests this deliberately.

7. **Each authorization costs the authority a nonce.** Dana's nonce went from 6 to 7 at B without
   her sending anything, and frame transactions on nonce key 0 continued from there. A wallet that
   pre-signs frame transactions for an EOA must re-sign them after any delegation change.
