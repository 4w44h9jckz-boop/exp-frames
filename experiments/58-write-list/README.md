# 58 - An exact list of writes against an intent picked from templates

Experiment 54 showed where an outcome check that reads named values fails:
- a write to a resource the check does not name, as with an approval to an unlisted spender;
- a contract that lies about the value the check reads, as with the lying token.

A check that denies every write the signed intent $Q$ does not list caught both on the Hegota
devnet, where EIP-7906's `TXTRACE` lists the writes.

This experiment moves the same rule to the moment of signing, without a language model. The wallet:
1. simulates the transaction and gets the exact list of writes it makes;
2. takes $Q$ from a template the user picks and fills in, such as "send 10 of token T to R";
3. expands $Q$ into the writes it allows, using each contract's storage layout;
4. compares the two lists exactly and gives a verdict;
5. if the verdict is a pass, signs $Q$ in experiment 54's form, so the chain checks it again at
   inclusion.

The writes come from the local chain's ethrex. Its `ethrex_simulateFrameTransaction` returns a
`writes` field with one entry per changed account:
- its balance, nonce and code hash, each as `[before, after]` when it changed;
- every storage slot that changed, `{slot, before, after}`.

That field is the simulated-writes patch of exp-e2e-frames (`docs/simulated-writes.md` at
`f8c7361`). Neither public chain serves it.

The split of the work:
- **kohaku-rs**, branch `experiment/r-ai3-writes`: the compiler and a command-line tool.
- **This directory**: the cases, as raw transactions or builders, with a genesis allocation.
- **The end-to-end runs on the local chain** are the coordinator's, in exp-e2e-frames, because they
  build ethrex.
- **This session's unit tests** run on hand-written fixtures in the field's documented format,
  labelled as fixtures.

## Written before any code

**The claim.** An exact list of writes catches every harmful case without a model.

**It would be shown wrong by** an attack whose list of writes equals a harmless transaction's.

**It is done when:**
- the compiler gives a verdict on every case below, from a simulation or a saved simulation;
- the coordinator's runs on the local chain confirm the verdicts;
- the revert share below has been measured.

**Also measured:** the share of honest transactions that revert at inclusion because state moved
after simulation. The coordinator measures it, in runs designed as below.

### The plan

**Templates.** The user picks one and fills in its parameters. No model is involved.

| Template | Parameters | The writes it allows |
|---|---|---|
| `erc20-transfer` | token, recipient, amount | the token's balance slots of the sender (less the amount) and of the recipient (plus the amount) |
| `eth-transfer` | recipient, value | the recipient's balance plus the value; the sender's balance less the value, beside the fee |
| `approve-and-swap` | token in, amount in, DEX, token out, minimum out | the token in's balance slots of the sender and the DEX, moved by the amount; the token out's balance slots of the DEX and the sender, moved by one amount $\ge$ the minimum; the allowance slot only if it ends other than where it began |
| `pool-withdrawal` | pool, recipient, amount | the pool's nullifier slot set to 1, and the recipient's balance plus the amount |
| `calls-only` | none | nothing: the calls are meant to change no state. For test vectors that exercise frames, not assets |

For a swap's output, the template's bound comes from the user. The compiler takes the simulated
value if it meets the bound, and from then on that exact value is what is compared and signed.

**Layouts.**
- $Q$ is about resources, such as "the recipient's balance of T". The writes are slots. A
  registry of contract kinds maps one to the other:
  - an ERC-20 with its balance and allowance mapping slots;
  - a collection with its operator mapping slot;
  - an account with its owner and implementation slots;
  - a pool with its nullifier mapping slot.
- With `--rpc`, the compiler checks each layout it uses against the chain before comparing: the
  slot's stored value must equal the getter's answer.
- A contract the registry does not know makes the verdict fail. A write to it cannot be matched to
  any resource.

**The exact comparison.** Every changed field must be either allowed by $Q$, with exactly $Q$'s
value after, or exempt by kind. And every write $Q$ expects must be present. So a missing write
fails, as an unlisted write does.

**Exempt by kind, not named in $Q$.** Every frame transaction makes three kinds of write. The
compiler exempts them by kind, computes each one's bounds from the transaction, and never lets the
user's template touch them:
1. **The fee.**
   - The payer's balance falls by at most the transaction's maximum cost, plus any value $Q$ sends
     from the payer.
   - The fee recipient's balance rises by at most the maximum cost. The fee recipient is the
     coinbase of the block the simulation ran on; the local chain's is the zero address.
2. **The nonce.**
   - For each nonce key, the EIP-8250 nonce manager's slot for the sender rises by exactly one.
   - For the legacy nonce, the sender's account nonce rises by exactly one.
3. **Nothing else.** Any other write by the nonce manager or to the fee recipient is not exempt. A
   code change is never exempt.

**The verdict.**
- `pass`: no write is unlisted, none is missing, none is mismatched.
- `fail`: with the unlisted, missing and mismatched writes listed.
- `not simulated`: the transaction is invalid, or its execution did not run, so the field is
  `null`. A wallet signs nothing it cannot simulate.

**Signing $Q$ in experiment 54's form.** On a pass, the compiler gives $Q$ in two encodings:
- **for a chain with EIP-7906:** experiment 54's `assertWrites` data for a final mode-3 frame:
  - every allowed storage write, exactly;
  - the nonce manager's slot, exactly;
  - the payer as the account whose balance may move by the fee.

  The fee recipient is paid after a mode-3 frame, so it is not in that diff (amendment 2's results).
- **for the local chain, which has no mode 3:** experiment 54's batch-ending `assert(Q)`, a named
  read of every allowed write that has a getter: `balanceOf`, `allowance`, `isApprovedForAll`,
  `owner()`, `implementation()`. The body's frames get the atomic flag.

  At signing, the comparison against the full list of writes is the compiler's. At inclusion, the
  chain checks the named values again.

The account signs the whole transaction, check frame included, over the canonical hash.

**The tool.**

```text
write-check --rpc <url> --raw <0x06...> --template <name> [--param k=v ...]
write-check --sim <simulation.json> --raw <0x06...> --template <name> [--param k=v ...]
```

It prints the verdict as JSON. `--sign` adds both encodings of $Q$, and, with the owner's key from
the environment, the signed transaction carrying the batch form.

### The cases

**A. R-AI1's 35 cases, from experiment 57.**
- **Experiment 27's nineteen at EIP-8250 `f3079a0`.**
  - Each case file holds the genesis allocation (`account` lines) and the signed raw
    transactions. The chain ID is 8141, the local chain's. The keys are derived from public labels.
  - That allocation gives no code to the vectors' call targets, so their "transfers" call empty
    addresses and write nothing. This experiment's allocation adds the repository's `TestToken` at
    `0x27...10` and `0x27...11`. Its genesis storage gives each vector account a balance there.
  - Every other target stays empty, as in experiment 27.
  - Each case's template follows from its note:
    - `erc20-transfer` on `0x27...10` for the four transfer vectors;
    - `eth-transfer` for the value vectors;
    - `approve-and-swap` for `atomic-approve-swap`;
    - `calls-only` for `blobs` and `many-frames`, whose calls go to empty addresses or to selectors
      the token lacks.
- **Experiment 28's twelve batches.**
  - The users' keys are not in this repository, so the cases are builders. They rebuild each
    batch's calls from its mined frames, with the same targets, data and atomic flags, on
    experiment 03's Token A, Token B and DEX in the local chain's genesis.
  - They are signed by a key derived from a public label.
  - All are self-paid. The sponsored batches' pay frames need experiment 09's paymaster, which is
    out of scope, and the calls' writes do not depend on who pays.
  - The template is `approve-and-swap`.
- **W3's pair (experiment 34).**
  - Two withdrawals of one pool, each to its own recipient.
  - Running them needs experiment 06's pool, a deposit and a proof on the local chain. Here they
    are hand-written fixtures in the documented format, labelled as such, and not a local-chain
    case.
- **The EIP-8250 replay pair.**
  - The same bytes under two revisions. A replay needs a chain that changes revision in place,
    which the local chain cannot do.
  - Here: a fixture pair, the original's writes and the replay's writes. They are identical by
    construction, since the replay reads an empty nonce record and writes the same value.

**B. The control-state family, new, as builders for the local chain.**
- Each case is an honest `erc20-transfer`, plus one frame the user was not told about.
- The account is `ControlAccount.yul`. Its owner is kept in storage slot 0, and its
  implementation in the EIP-1967 slot. It can change either only through a call from itself, so
  through a `SENDER` frame of its own transaction.
- Its `VERIFY` is experiment 54's: the owner's signature over the canonical hash, and a final
  `assert(Q)` frame ending one atomic batch.

| Case | The added frame | The write it makes |
|---|---|---|
| B0 | none: the honest transfer | none |
| B1 approval | `approve(spender, max)` on the token | the allowance slot |
| B2 operator grant | `setApprovalForAll(operator, true)` on a collection | the operator slot |
| B3 delegation | the account sets its own implementation slot (EIP-1967) | the implementation slot |
| B4 owner slot | the account sets its own owner slot | storage slot 0 of the account |
| B5 lying token | a transfer of experiment 54's lying token, in place of the honest one | the sink's and the "told" slots, not the recipient's |
| B6 unlisted spender | experiment 54's (c) | the unlisted spender's allowance slot |

**EIP-7702 is not exercised.** A frame transaction carries no authorization list. A delegation
through a type `0x04` transaction is a different transaction, and the local chain's EIP-7702 has
not been checked. So "a delegation" here is the account delegating through its own implementation
slot. That is the frames analogue, and a write.

**C. Probes for what would show the claim wrong**, chosen now:
- **C1, the replay** (A's EIP-8250 pair). Its writes equal the original's by construction.
- **C2, an event-only frame.** It is added to the honest transfer and emits an event that links
  the sender to another address. An event is not a write.
- **C3, an approval set to its current value.** No slot changes, so there is nothing to see. This
  is harmless too, so it should pass.
- **C4, a spender's pre-existing allowance spent inside the user's transaction.** A `DEFAULT`
  frame calls `transferFrom` from the user to the attacker, using an allowance the user had
  already given. It writes the allowance and both balances.

### Predictions

| Case | Prediction |
|---|---|
| A, experiment 27's valid cases (11) | `pass` under their template, ten of them. `payer-replaced` passes too: the fee exemption follows the payer. `atomic-approve-swap` fails with its writes missing: its "swap" calls a selector the token lacks, so the atomic batch reverts and nothing the template expects happens. The checker is right to refuse it |
| A, experiment 27's refused cases (8) | `not simulated`: each is invalid, its `VERIFY` reverts. A pre-signing checker never sees six of them, which are relay copies (experiment 57) |
| A, experiment 28's twelve | `pass` under `approve-and-swap` |
| A, W3's pair | `pass`, both. The linkability experiment 34 found is in the pair's shape and timing, not in any write. Recorded as a limit: a harm with no write |
| A, the EIP-8250 pair | `pass` for both, with identical writes. **This is an attack whose writes equal a harmless transaction's.** The claim is predicted to fail here, and the defence is the expiry frame experiment 27's draft recommends |
| B0 | `pass` |
| B1 to B4, B6 | `fail`, each naming exactly the one unlisted slot |
| B5 | `fail`: the sink's and the "told" slots unlisted, and the recipient's balance slot missing |
| C2 | `pass`. A harm with no write, recorded as a limit |
| C3 | `pass` (harmless) |
| C4 | `fail`: the allowance and the attacker's balance unlisted, and the sender's balance mismatched |

So the claim is predicted to hold for every harm that is a write, and to fail for the replay. The
harms with no write, linkability and an event, lie outside what any list of writes can see. The
results will report those separately, not count them as catches.

### The revert share: how state can move

- **Honest cases built for it.** They are B0 and an `eth-transfer`, each to a recipient that a
  second account, the "noise" sender, also pays.
- **How the state moves.** The coordinator's run simulates, signs and sends the honest
  transaction. Between simulation and inclusion it sends, with probability $p$, a noise transfer
  to the same recipient.
- **Why that reverts.** In the batch form, the final `assert(Q)` reads the recipient's balance
  and compares it with the simulated after-value. A moved balance reverts the honest transaction
  at inclusion.
- **The measure.** The revert share is the fraction of honest transactions mined with status 0,
  as a function of $p$.
- **Why exact values revert.** A rule written as a change rather than an absolute after-value
  would not revert. That needs both values in the check: EIP-7906's diff has them, and a named
  read does not. The results will say how much of the share that one choice decides.

**Post-quantum status.** None. Every case is signed with secp256k1. The compiler is
scheme-agnostic: it reads writes, not signatures, and $Q$ is pinned by whatever signature covers
the check frame.
