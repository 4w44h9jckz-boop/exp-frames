# 05 — k-of-n multisig, with passkey owners

A multisig smart account in which the owners' signatures are verified by the protocol, not by
the account. The account only counts them.

| Frame | Mode   | Caller      | Flags                         | Target        | Signatures                                      |
| ----- | ------ | ----------- | ----------------------------- | ------------- | ----------------------------------------------- |
| 0     | VERIFY | ENTRY_POINT | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | k owners: SECP256K1 or P256, explicit `signer`, empty `msg` |
| 1     | SENDER | Sender      | APPROVE_SCOPE_NONE            | Destination   |                                                 |

[`Multisig.yul`](Multisig.yul) has 223 bytes of runtime, followed by `owner_0 … owner_{n-1}, n, k` as
32-byte words. The protocol validates every SECP256K1 and P256 entry in `tx.signatures` before any
frame runs, and one bad entry invalidates the whole transaction. The VERIFY path then:

1. loops over the entries with `SIGPARAM`. It keeps those whose scheme is SECP256K1 or P256 and whose
   `msg` is empty, meaning they sign the canonical sig hash, which commits to every frame.
2. counts distinct owners among their resolved signers, using a bitmap.
3. calls `APPROVE` with the frame's scope if at least `k` owners signed.

The VERIFY path does no `ecrecover` and no `P256VERIFY`, and reads no storage. It ignores entries
of other kinds: ARBITRARY entries, explicit digests, a paymaster's signature. The account needs no
`execute` function either: SENDER frames call their targets as the account.

[`multisig.ts`](multisig.ts) derives the owner keys from `PRIVATE_KEY` (labels `alice`, `bob`,
`carol`, `passkey`, `scale-i`). The same accounts come back on every run, and no new secret is stored.

## Run

```bash
npx tsx experiments/05-multisig/example-multisig.ts   # deploy + fund (once), one transfer from each account
npx tsx experiments/05-multisig/scaling.ts            # deploy n-of-n accounts (once), then simulations
npx tsx experiments/05-multisig/negative.ts           # simulations only
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

| Tx | What | Frames: execution / state gas | `gasUsed` |
|---|---|---|---|
| [`0xebbf8e6f…`](https://dora.privacy.ethrex.xyz/tx/0xebbf8e6f879b057f20bd8df36b89cea0daf5612b37b69ae3cf223b5de2e5e4d0) | funder deploys and funds both 2-of-3 accounts | deploy 15,551/769,590 · fund 121/0 · deploy 12,651/769,590 · fund 121/0 | 1,633,251 |
| [`0x8d3b555a…`](https://dora.privacy.ethrex.xyz/tx/0x8d3b555a015486bea91874143eebe4a192740740fcdc068a34705fbcb3afc78e) | **2-of-3 secp256k1** `0x861F…E821`: alice + carol send 0.001 ETH | VERIFY **1,129**/0 · SENDER 3,000/0 | 35,622 |
| [`0xa317ca5b…`](https://dora.privacy.ethrex.xyz/tx/0xa317ca5b4252861e11cb13a653be24764e8f10d338a87d493411a82eb1897ed8) | **2-of-3 mixed** `0x9Fc3…E6e7`: bob (secp256k1) + **passkey (P256)** send 0.001 ETH | VERIFY **1,207**/0 · SENDER 3,000/0 | 43,554 |
| [`0x2c7be319…`](https://dora.privacy.ethrex.xyz/tx/0x2c7be31990ca69af907d4572ed5934efa72e582db78410202553f84b7be2c4fe) | deploy 12 n-of-n accounts for `scaling.ts` | 13 frames | 13,347,255 |

Both transfers settled at the calldata floor:

| Tx | intrinsic + execution | floor (`gasUsed`) |
|---|---|---|
| 2-of-3 secp256k1 | 31,435 | 35,622 |
| 2-of-3 mixed | 36,409 | 43,554 |

The 7,932 gas between the two transfers is exactly 6,700 − 2,800 = 3,900 for P256 verification plus
63 more signature bytes × 64 at the floor.

### Scaling (`scaling.ts`, simulated)

Each account is n-of-n, all n owners sign, and an EOA pays through its default code
(`OnlyVerifyPay`). *Validation work* is the multisig VERIFY plus the payer's VERIFY (3,000) plus
signature verification. That is what `MAX_VERIFY_GAS` bounds, although the rule counts declared
limits rather than gas used.

| scheme | n = k | multisig VERIFY | signature verification | signature calldata | validation work | fits 100k (spec) | fits 500k (testnet) |
|---|---|---|---|---|---|---|---|
| secp256k1 | 1 | 913 | 5,600 | 2,708 | 9,513 | ✓ | ✓ |
| secp256k1 | 2 | 1,351 | 8,400 | 4,056 | 12,751 | ✓ | ✓ |
| secp256k1 | 3 | 1,867 | 11,200 | 5,380 | 16,067 | ✓ | ✓ |
| secp256k1 | 5 | 3,133 | 16,800 | 8,076 | 22,933 | ✓ | ✓ |
| secp256k1 | 10 | 7,663 | 30,800 | 14,864 | 41,463 | ✓ | ✓ |
| secp256k1 | 20 | 22,574 | 58,800 | 28,344 | 84,374 | ✓ (tight) | ✓ |
| secp256k1 | 30 | 45,285 | 86,800 | 41,860 | 135,085 | ✗ | ✓ |
| P256 | 1 | 913 | 9,500 | 3,704 | 13,413 | ✓ | ✓ |
| P256 | 2 | 1,351 | 16,200 | 6,072 | 20,551 | ✓ | ✓ |
| P256 | 5 | 3,133 | 36,300 | 13,164 | 42,433 | ✓ | ✓ |
| P256 | 10 | 7,663 | 69,800 | 24,920 | 80,463 | ✓ (tight) | ✓ |
| P256 | 20 | 22,574 | 136,800 | 48,540 | 162,374 | ✗ | ✓ |

Signature verification includes the payer's own secp256k1 entry (2,800).

### Rule violations (`negative.ts`, simulated)

| Case | `valid` | Node says |
|---|---|---|
| secp: alice + bob | true | VERIFY 1,051 gas |
| secp: bob + alice | true | order does not matter |
| secp: all three owners | true | VERIFY 1,483 |
| secp: an ARBITRARY entry first, then alice + bob | true | VERIFY 1,152: the ARBITRARY entry is skipped |
| secp: alice only | false | validation prefix frame reverted |
| secp: alice twice | false | validation prefix frame reverted: counted once |
| secp: alice + a stranger | false | validation prefix frame reverted |
| secp: alice + bob, bob signing an explicit digest | false | validation prefix frame reverted: bob's entry is valid but not counted |
| secp: alice's entry with an empty `signer` | false | `frame signature list does not authenticate the sender`: it resolves to the multisig, which has no key |
| mixed: bob + passkey | true | VERIFY 1,207 |
| mixed: passkey only | false | validation prefix frame reverted |
| mixed: another P256 key claiming the passkey's address | false | `frame signature list does not authenticate the sender`: signer ≠ `keccak256(qx ‖ qy)[12:]` |

## Observations

1. **The protocol does the cryptography, and the account just counts.** Two owners cost 1,129 gas
   of VERIFY: introspection and a loop. An in-EVM version pays 3,000+ per `ecrecover`, plus
   `P256VERIFY` for passkeys. Signature verification moves into intrinsic gas: 2,800 per secp256k1
   entry, 6,700 per P256 entry.
2. **Passkeys come at no extra code cost.** A P256 owner goes through exactly the same code path,
   since `SIGPARAM(0x00)` returns `keccak256(qx ‖ qy)[12:]`. The mixed transfer is the first mined P256 entry
   among our fixtures (the `aa` repo had not measured one either). The tooling's tests verify it.
3. **Per-signer cost is mostly the signature, not the account.** Simple multisig transactions sit at
   the calldata floor, so each secp256k1 signer costs 2,800 + 85 bytes × 64 ≈ 8,240 gas, and each P256
   signer 6,700 + 148 × 64 ≈ 16,170. Above the floor it is 2,800 + ~1,350 of calldata (`aa` measured
   4,148), or 6,700 + ~2,400.
4. **VERIFY grows quadratically, which is this contract's choice.** Each signer is matched against the
   owner list: 30 owners cost 45,285 gas. Requiring signers in ascending address order (as Safe
   does) would make it linear. Under the spec's `MAX_VERIFY_GAS` of 100,000, about 20 secp256k1
   signers or about 10 P256 signers fit, counting an EOA payer's 2,800 + 3,000.
5. **Counterfactual deployment is capped by `MAX_VERIFY_STATE_GAS` (500,000, the spec value).** A
   deploy frame in the validation prefix (Example 1b) can install at most (500,000 − 183,600) / 1,530
   = **206 bytes** of code at a fresh address, or 326 bytes if the address was prefunded. This
   multisig keeps its owners in its code, so even 1-of-1 is 319 bytes (671,670 state gas). The
   simulated self-deploy is refused: `prefix state gas budget exceeded: 760410 > 500000`.
   - Experiment 02's 109-byte account fit.
   - Wallet designs that deploy at first use through the public mempool need a small proxy
     (EIP-1167 is 45 bytes) plus a commitment to the owner set, or owners in storage (97,920 per slot).
   - Here the funder's transaction deployed the accounts instead.
6. **Explicit-digest signatures are inside the sig hash.** `compute_sig_hash` elides only empty-`msg`
   signatures, so a co-signer who signs some other 32-byte digest changes the hash everyone else
   signs. Signing alice (sig hash) and then bob (explicit digest) left alice's signature stale. The node
   then refused the whole list as `frame signature list does not authenticate the sender`. The
   tooling's `signAll` now fills explicit-digest entries first.
7. **Owners must name themselves.** An entry with an empty `signer` resolves to `tx.sender`, here the
   multisig, which has no key. Explicit `signer` fields cost 20 bytes per owner.
8. **Which owners signed is public.** Every owner's address sits in the transaction, and the subset
   that signed is visible. This is the linkability the `aa` repo set out to avoid by choosing one
   threshold key. A threshold signature (Track B, experiment 06) looks like a single owner.
