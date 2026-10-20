# 40 - One registry, two applications, each holding its own value

Experiment 32 put the notes of several applications into one registry: one tree, one verifier in
the registry's `VERIFY`, one space of nonce keys. Post 30 reports what that measured, that "where
two applications shared one registry, each update's crowd stayed its own application's notes". It
left the applications' value in one place: every note's ether sat in the registry's own balance,
and every payout came from it.

This experiment gives each application a vault of its own, which holds the value its depositors
paid in and pays only that application's withdrawals. It binds the vault into what a withdrawal
proves, and it binds whom a withdrawal pays and on what fee terms, so that no one else can
settle it differently.

## Written before any run

**The claim.** Applications can share one registry's tree, its verifier and its nonce space,
while none of them can make the chain pay a withdrawal it should not, from its own value or from
another application's.

**It would be shown wrong if any of these is observed:**
- value deposited for one application leaves through another application's vault;
- tying a withdrawal to its vault needs the registry's `VERIFY` to read storage outside the
  sender, which the public mempool refuses;
- someone who sees a withdrawal before it is mined can send its payload in a transaction they
  build, and gain by it. Read here as: any wei the withdrawal's owner did not direct to
  them reaches an address of their choosing, a priority fee they set included.

**It is done when,** on the testnet, one registry holds two applications whose value sits in
separate vaults, and:
- a withdrawal that crosses from one application to the other is refused before inclusion;
- a copied payload is refused;
- each application's withdrawals are paid from its own vault and no other, as the vaults'
  balances show after every step.

**The plan, fixed before the run:**
- A vault is a contract per application. It holds the ether deposited for that application, it
  answers the application's rules from its code alone, and it pays out only when the registry
  calls it, from its own balance.
- The note is computed by the registry, at deposit, under the vault's scope: a hash of the
  vault's parameters, the chain's identifier and the vault's address. The registry computes the
  scope itself, so two vaults never share one. The deposit's ether goes to the vault in the same
  call.
- A withdrawal proves its note under that scope, with experiment 32's kernel and its verifying
  key unchanged: the scope takes the place of the application's address.
- The proof is bound to a context that the registry computes from what frame 2 will do: the
  recipient, the fee, and the transaction's priority fee and fee cap, read in `VERIFY` with
  `TXPARAM`. A frame transaction from the registry carries no signature, so its fee fields are
  otherwise anyone's to choose.
- The fee is paid from the vault to the registry, which pays the transaction's gas as its payer.
- `VERIFY` reads code, `TXPARAM`, `FRAMEPARAM` and precompiles, and no storage at all.
- Tests on the testnet:
  - deposits under the same secrets in both vaults, and an honest withdrawal from each, one with
    a change note;
  - a note of one application claimed against the other's vault;
  - a pending withdrawal copied with another recipient, and copied with a higher priority fee;
  - the vaults' and the registry's balances read after every step.
- The control: the same copy with a higher priority fee, against experiment 32's registry,
  simulated. It is expected to be admitted, which is the gap this experiment closes.

## Short answers

1. **No value crossed.** A note of application A, presented against B's vault and against C's (A's
   twin, the same parameters at another address), was refused before inclusion, and so was B's
   change note presented against A's vault while A still held a deposit. The prover cannot make a
   proof of A's note under B's scope at all. After every step, each vault's balance moved by
   exactly its own application's withdrawals, and each update's receipt logs both its payments,
   the recipient's and the fee, as made by the note's own vault.
2. **The binding needs no storage.** The registry's `VERIFY` computes the vault's scope from a
   call that reads the vault's code, `CHAINID` and SHA-256, and reads the fees with `TXPARAM`. It
   reads no storage, and the testnet admitted every honest update, at 230,365 to 230,370 gas of
   `VERIFY`.
3. **A copy cannot be settled differently.** The pending withdrawal copied with another recipient
   was refused, and so was the copy with a higher priority fee, while the same fees with a proof
   made for them were admitted. Against experiment 32's registry, which binds the recipient but not
   the fees, the copy with a higher priority fee was mined, and paid the block's producer
   4,423,936,000 wei of the update's 10^10 wei fee.

| File | What |
|---|---|
| [`VaultedRegistry.yul`](VaultedRegistry.yul) | The registry: experiment 32's, with the scope, the context and payment from the vault |
| [`Vault.yul`](Vault.yul) | An application's custody: its rule, its parameters, and payment on the registry's call |
| [`custody.ts`](custody.ts) | Addresses, scopes, notes, the context, proofs, `updateTx` |
| [`run.ts`](run.ts) | Setup, then X, Y, A, B and the control Z |
| [`rebuild.test.ts`](rebuild.test.ts) | The mined updates rebuilt byte for byte, their proofs verified under their own scopes and refused under the others', each payment traced to its vault, the balances step by step |
| [`record.json`](record.json) | The run: addresses, scopes, nullifiers, every step's outcome, and the balances after each mined step |

The kernel, its proving and verifying keys, the verifier and the hasher are experiment 32's and
experiment 06's, unchanged and already on the testnet.

kohaku-rs's `kohaku-frame-registry` (branch `experiment/custody`, commit `ab2fcd9`, module
`custody`) does the same from Rust: its `tests/custody.rs` rebuilds the three mined updates byte
for byte, computes the same scopes and leaves, verifies each proof under its own vault and fees
and under no other, and traces every payment to the note's vault.

## Run

```bash
npx tsx experiments/40-custody/run.ts --dry-run   # simulate only
npx tsx experiments/40-custody/run.ts             # setup, then every step; each is skipped once done
npx vitest run experiments/40-custody             # offline
```

## Results (Hegota testnet, chain 8141, 2026-10-20)

The registry is `0x246FBf1ca115E6f9993658e0e46F24E4C9054Df6`. The vaults: A
`0x7Bc7902c7DEABFbD7Abd783C49BA7Bf946D13314` (FixedPool's rule, 0.001 ETH), B
`0xFF52Ebefff973bc75eef6BD6D52887B6fDFB9757` (Balance's rule, at most 0.002 ETH out), and C
`0xbD80555C4E78Ad93D2227555299dc720415774C3`, A's twin. A and C have the same parameters and the
scopes `0x2fa7d06a…` and `0x2a850b16…`.

| Step | Tx | Block | `gasUsed` | Frames: execution + state gas |
|---|---|---|---|---|
| deploy the registry and the vaults; the registry's float of 0.001 ETH | [`0x34181a82…`](https://dora.privacy.ethrex.xyz/tx/0x34181a825e9cf8b3180ba45642aa7cc6d0887248047f710dd2fa813278605b3f) | 488,421 | 7,538,230 | |
| deposit four notes: the same secrets in A (0.001 ETH) and B (0.003 ETH), a2 in A and c1 in C | [`0x78a32be2…`](https://dora.privacy.ethrex.xyz/tx/0x78a32be20e034d2a0b6d6bf9da11da6ab2cb8ed031a5c053fd16edd7556e88aa) | 488,422 | 5,721,949 | |
| **A.** A: the shared secrets' note spent whole | [`0xdc4debd1…`](https://dora.privacy.ethrex.xyz/tx/0xdc4debd1c5050b21921893c84220dd88665155071e412000e292d15a1596084b) | 488,426 | **567,032** | 8272 5,579 · VERIFY **230,365** + 97,920 · update 27,683 + 183,600 |
| **B1.** B: the same secrets, 0.001 ETH out, 0.002 ETH in a change note | [`0x4e1ceffa…`](https://dora.privacy.ethrex.xyz/tx/0x4e1ceffa630e9479d5839bef550b78521e5ad4637a05bf804018f00ac3a9d485) | 488,428 | **1,652,468** | 8272 5,579 · VERIFY **230,370** + 97,920 · update 1,014,810 + 281,520 |
| **B2.** B: the change note spent | [`0xb8c10651…`](https://dora.privacy.ethrex.xyz/tx/0xb8c106513ddacdc937ec57c2b635f8feb1cb5d9d2ed5130b3524240da141971a) | 488,429 | **567,049** | 8272 5,579 · VERIFY **230,370** + 97,920 · update 27,683 + 183,600 |

The balances, in units of 0.001 ETH:

| After | Vault A | Vault B | Vault C | Registry |
|---|---:|---:|---:|---:|
| setup | 2 | 3 | 1 | 1 (the float) |
| A | 1 | 3 | 1 | 1 + 9,995,463,744 wei |
| B1 | 1 | 2 | 1 | 1 + 19,982,244,000 wei |
| B2 | 1 | 0 | 1 | 1 + 29,977,707,608 wei |

The registry paid each update's gas from its float and was paid its 10^10 wei fee back by the
note's vault; it keeps the difference, as experiment 32's did.

| Refused | How | Reason |
|---|---|---|
| **X1.** A's withdrawal naming B's vault | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": the proof is under A's scope |
| **X2.** A's withdrawal naming C's vault, A's twin | the same | the same: the scope has the vault's address in it |
| **X3.** A's note proved under B's scope | the prover | the witness fails: no leaf under B's scope opens to these secrets |
| **X4.** B's change note naming A's vault, which still held a2 | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted" |
| **Y1.** the pending A withdrawal copied with another recipient | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": the context binds the recipient |
| **Y2.** the same copied with a priority fee of 8,000 wei and a cap of 10,000 | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": the context binds the fees |

`eth_sendRawTransaction` gave every refusal as "Missing or invalid parameters.", and the
simulation names no more than the validation prefix, so each refusal is read beside a control
that is admitted: the honest update for X and Y1, and for Y2 a withdrawal of the same note proved
for the raised fees, which simulation admitted (567,008 gas) and which was not sent.

**The control, Z.** A note deposited in experiment 32's FixedPool, in
[`0x42d45536…`](https://dora.privacy.ethrex.xyz/tx/0x42d455368b931545665e6c48cba80d4b6c1cea01571f6db1ca93d367f7859f80)
(block 488,430). Its update as made, with a 1 wei priority fee, was admitted in simulation and not
sent. The same payload copied with the raised fees of Y2 was mined in
[`0x59272e37…`](https://dora.privacy.ethrex.xyz/tx/0x59272e374c551bae00b271f03b7313a28ab16b2d4d6253e95ba1d698f074b305)
(block 488,431), at an effective gas price of 8,007 wei for 552,992 gas: 4,423,936,000 wei to the
block's producer where the update as made would have paid 552,992. The recipient was paid as the
owner asked.

Every mined transaction above is a fixture in `test/fixtures/chain/`.

## Gas

| | Gas | Against |
|---|---|---|
| The vaulted registry's `VERIFY` | 230,365 to 230,370 | experiment 32's 229,302 to 229,326; EIP-8141's 100,000; the testnet's 500,000 |
| Frame 2, a payout to a fresh address, from the vault | 27,683 + 183,600 state | experiment 32's 14,670 + 183,600 |
| Frame 2, with a change note | 1,014,810 + 281,520 state | experiment 32's 991,736 + 281,520 |

The scope and the context cost about 1,050 gas of `VERIFY`: a call to the vault and two SHA-256
calls. Paying from the vault costs 13,013 more in frame 2, two calls with value where experiment
32 made one.

## Observations

1. **A shared tree does not share value once the scope is in the note.** The registry computes
   every note from the vault's scope and every scope from the vault's address, so a note opens
   against one vault only. A vault with the same parameters at another address (C) is another
   scope. Nothing an application deploys can make the registry pay one application's note from
   another's vault: the registry pays from the vault the proof's scope was computed for.

2. **A frame transaction with no signer leaves its fees to whoever sends it.** Experiment 32's
   registry bound the recipient and the fee to the proof, and required only that the fee cover
   the transaction's worst case. So anyone holding a pending update could send it again with a
   higher priority fee, up to what the fee covers, and the block's producer is paid the
   difference: the control mined such a copy. Binding the priority fee and the cap into the
   context closes it: a copy can then only be the update its owner made.

3. **Custody can be bound without storage.** The scope is computed from code, the chain's
   identifier and the vault's address, and the fees from the transaction, so `VERIFY` reads no
   storage, the sender's included, and nothing a pending update depends on can change under it.
   The vault's balance is read only in frame 2, where the payment either is made or the frame
   reverts.

4. **The registry still holds one thing of everyone's: its gas float.** The registry pays gas
   before frame 2 runs, from its own balance, and is paid back from the note's vault in frame 2.
   If frame 2 failed after approval, the float would pay that update's gas, for whichever
   application. Frame 2 is floored so it cannot be starved, and a vault pays while it holds the
   note's value, so it did not fail here; the float is the registry's, not any vault's.

5. **The crowd is still the application's.** The vault is a public input and in frame 2's calldata,
   as experiment 32's tag was, so an update's anonymity set is its own vault's notes.

## Divergences from the plan and the specification

- The context binds the recipient, the fee and the transaction's two fees. There is no separate
  recipient of the fee: on frames the registry is the payer, so the fee goes to it.
- One update per transaction: experiment 32's pairs are not carried over.
- The parameters are a vault's kind and amount, hashed; the asset is always ether.

## Not done here

- The fee's surplus stays in the registry, as in experiment 32. Experiment 30's refund frame would
  return it.
- No vault was deployed by anyone hostile. A vault's own code decides whether it pays its own
  depositors, as an application's rule did in experiment 32.
