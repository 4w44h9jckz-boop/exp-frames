# 54 - An outcome check at the end of an atomic batch

A wallet can state what a transaction is for as a short list `Q` of expected results, for example
"the recipient's balance of token T rises by 10, mine falls by 10, and spender S's allowance over
my T stays 0". The user confirms `Q` and signs it. The chain then checks the outcome against `Q`
after the transaction's body has run, and reverts the body if the check fails.

EIP-7906 proposes an `ASSERT` frame mode for this, with `TXTRACE` to read the transaction's state
diff. Today's test network has EIP-8141 without EIP-7906. What it has is the atomic batch: "All
frames in a batch must succeed, or all of them revert." So the body's frames carry the atomic-batch
flag, and the batch ends with a `SENDER` frame calling the account's own `assert(Q)`, with `Q` in
the frame's data. Without `TXTRACE` this check can read named state but cannot list writes. It
checks a footprint: the values `Q` names, and nothing else. This experiment tests that rule's
weakness directly.

The rule a check should meet is stricter: **it denies every write the signed `Q` does not list.**
A check that only reads named state cannot meet it, and the cases below are chosen to show where.

## Written before any run

**The claim.** On today's test network, an atomic batch ending in `assert(Q)` gives revert-all:
a body whose named results differ from `Q` is undone in full. Reads of named state still let two
kinds of harm through: a write to a resource `Q` does not name (case c), and a contract that lies
about the state `Q` reads (case e).

**It would be shown wrong if any of these is observed:**
- case (b) or case (d) leaves its approval or grant in place after the check fails;
- reads of named state catch case (c) or case (e), which would mean the stricter rule above is
  unnecessary.

**It is done when** each case is mined or reverted on chain, with receipts. The `ASSERT` mode is
tried on the same network, and its outcome is recorded either way.

**The plan, fixed before the run:**
- The account, `OutcomeAccount.yul`, is experiment 27's execution-scope account with two
  additions:
  - Its `VERIFY` frame also requires the check frame:
    - The last frame must be a `SENDER` frame whose resolved target is the account and whose data
      starts with `assert`'s selector.
    - Every frame after the validation frames and before the check frame must carry the
      atomic-batch flag, so the check frame ends the one batch that holds the whole body.
    - EIP-7906 notes that nothing at protocol level makes a transaction include a check, so the
      account has to require it.
  - When the account calls itself with `assert`, it runs each entry of `Q`:
    - each entry is a target, a call, and the 32-byte word the call must return;
    - the account makes the call as a `STATICCALL` and reverts at the first entry whose word
      differs.
  - `VERIFY` keeps experiment 27's two paths:
    - the owner pays, over the canonical signature hash;
    - a payer pays, over the execution digest `E`.
- The contracts it acts on, all deployed by the run:
  - `TestToken`, the repository's ERC-20;
  - `TestCollection.sol`, a collection with `setApprovalForAll` and `isApprovedForAll`;
  - `LyingToken.sol`, an ERC-20 whose `transfer` credits a third address and whose `balanceOf`
    adds what the recipient was told it got.
- The cases. Each sends one transaction from the account:
  - **(a) An honest transfer.** The body moves 10 tokens to a recipient. `Q` lists both balances,
    and the allowance of one named spender at 0.
  - **(b) A hidden approval to a listed spender.** As (a), with an extra body frame approving the
    named spender for the maximum.
  - **(c) An approval to an unlisted spender.** As (a), with an extra body frame approving a
    spender `Q` does not name.
  - **(d) An operator grant on a listed collection.** As (a), with an extra body frame calling
    `setApprovalForAll(operator, true)` on the collection. `Q` lists `isApprovedForAll` for that
    operator as false.
  - **(e) A lying token.** The body transfers 10 of `LyingToken` to a recipient. `Q` lists both
    balances as `balanceOf` reports them.
  - **(f) A payer cannot drop or move the check.**
    - The owner signs `E` over a body and its check frame.
    - A payer completes the transaction, then:
      - removes the check frame;
      - moves the check frame ahead of the body;
      - moves the check frame into a separate batch.
    - Each copy is simulated and sent.
    - The honest completion is sent last, and must be mined.
- After each case, the run reads back:
  - every balance, allowance and grant involved;
  - for (e), the third address's real balance.
- The `ASSERT` mode. The run tries two things on the same network:
  - (a)'s transaction with the check moved into a final frame of mode 3;
  - a probe contract that runs `TXTRACE` (`0xb6`).
  If either is accepted, (a) to (e) run again under the stricter rule, with the check in an
  `ASSERT` frame that reads the diff through `TXTRACE`.

**Predictions:**

| Case | Prediction |
|---|---|
| (a) | mined; every body frame succeeds; the recipient has 10 more |
| (b) | mined, with the check frame and every body frame failed. The allowance stays 0 and the transfer is undone. The owner still pays for gas |
| (c) | mined, with every frame succeeded. The unlisted spender's allowance is the maximum afterwards |
| (d) | mined, with the batch failed. The grant stays false |
| (e) | mined, with every frame succeeded. The recipient's real balance is unchanged. The third address holds the 10 |
| (f) | all three altered copies refused before inclusion, because the account's `VERIFY` reverts. The honest completion is mined |
| `ASSERT` | refused: the test network's client accepts frame modes 0 to 2 only, and `0xb6` is not an opcode there |

The check's own cost: about 3,000 gas per entry for a warm `STATICCALL` to a token, plus the copy
of `Q`. The account's `VERIFY` cost, about 1,000 more than experiment 27's for the frame checks.

**Amendment, 2026-11-06, before any run.**
- Case (f) gains two transactions, to tell its two defences apart:
  - **a fourth copy**: the payer inserts a body frame into the batch, ahead of the check. The
    check frame still ends the batch, so the account's frame rule passes. Only `E` refuses this
    copy.
  - **a control**: the owner signs, over the canonical hash, a body with no check frame. `E` is
    not involved, so only the account's frame rule refuses it.
- The `ASSERT` try is also sent from the funder's EOA, with a final frame of mode 3. An EOA's
  default code does not look at the last frame, so only the network's own rules decide.
- Predictions: both new (f) transactions are refused before inclusion. The EOA's mode-3
  transaction is refused as the account's is.

**Amendment 2, 2026-11-06, before any run on that chain: the `TXTRACE` arm on the public Hegota
devnet.**

- **Why there.** The test network (chain 8141) refuses mode 3 as reserved, and `0xb6` is an
  invalid opcode there (the results below). The public Hegota devnet implements EIP-7906 beside
  EIP-8141:
  - chain ID 3151908;
  - `https://rpc1.hegota.ethrex.xyz`, which reports `ethrex/v23.0.0`;
  - EIP-7906's mode is named `POST_TX` there, mode 3;
  - `TXTRACE` is `0xb6`, and `EVENTDATACOPY` is `0xb7`.

  Its parameters and the opcode's operand order are read from the demo by EIP-7906's first
  author, [`forshtat/hegota-demo`](https://github.com/forshtat/hegota-demo) at `8095b894`,
  `contracts/shared/TxTraceLib.sol`. Nothing from that repository is copied here. The demo's
  numbering:

  | Table | Parameters |
  |---|---|
  | balances | count `0x00`; address, before and after `0x03` to `0x05` |
  | storage | count `0x01`; address, slot, before and after `0x06` to `0x09` |
  | code | count `0x02`; address and hash `0x0a` and `0x0b` |
  | events | from `0x0c` |

  The demo has no nonce table, and the index is on top of the stack. EIP-7906's master text
  numbers the parameters differently, so the probe below checks the devnet's numbering before the
  cases run.
- **The envelope.** The devnet's type `0x06` transaction lays out its fee fields flat, not as a
  list, and ends with EIP-8272's `recent_root_references`. Frames and signatures are as on chain
  8141. [`devnet.ts`](devnet.ts) encodes it. Nonce key `[0]` is the legacy nonce there: its nonce
  manager is at `0x...8250`, as in EIP-8250 at `f3079a0`.
- **The account, `PostTxAccount.yul`.**
  - `VERIFY` checks the owner's signature over the canonical hash, as `SimpleAccount` does. It
    then requires the last frame to be a mode-3 frame whose target is the account, with one of
    the two checks' selectors.
  - The body's frames are ordinary `SENDER` frames, with no atomic flag. A failed mode-3 frame
    reverts the whole execution body.
  - In the mode-3 frame the caller is the entry point and the call is static. The account runs
    one of two checks over $Q$ in the frame's data:
    - **The strong rule.** Every storage write in the diff must be listed in $Q$, with its
      address, its slot and its value after. Every balance change must be listed with its value
      after, or as the payer's, whose balance moves by the gas charged. There must be no code
      change. Anything else reverts. $Q$ is computed by the runner from each contract's storage
      layout, as a wallet would from its simulation.
    - **The baseline**, in the shape of the demo's `ApprovalCapAssertion` and written here:
      - the named reads of the test-network arm, each call's word against its expected value;
      - every `Approval` event from the token naming the account as owner and the listed spender
        as spender must carry a value no larger than the cap, 0.

      An approval to any other spender, or a lie in `balanceOf`, passes it.
- **The cases.** (a) to (e) as above, each run once under each check, ten transactions in all.
  - The same token, collection and lying token are deployed on the devnet.
  - The funder is a key derived for this chain, funded from the devnet's faucet only.
  - Every contract is far below the devnet's deploy limit of about 10 to 11 KB.
  - Every record carries the chain ID.
- **The probe first.** A single transaction whose mode-3 frame requires the storage count to be
  exactly the number expected for (a). It is simulated before the cases run. If the devnet's
  numbering or operand order differs from the demo's, the probe says so, and this amendment gets a
  dated note before any case runs.
- **Predictions:**

  | Case | Strong rule | Baseline |
  |---|---|---|
  | (a) honest transfer | mined, status 1 | mined, status 1 |
  | (b) approval to the listed spender | reverted | reverted |
  | (c) approval to an unlisted spender | reverted: the unlisted allowance slot | mined, status 1 |
  | (d) operator grant | reverted | reverted |
  | (e) lying token | reverted: the sink's and the "told" slots | mined, status 1 |

  "Reverted" means mined, with the mode-3 frame failed and the body undone. The demo's notes say
  a failed `POST_TX` still mines and uses the nonce.
- **What would show the rule wrong on this chain:**
  - the strong rule passes (c) or (e);
  - it reverts (a);
  - the baseline catches (c) or (e).

**Post-quantum status.** None. The owner and the payers sign with secp256k1. Nothing here depends
on the signature scheme: the check frame is pinned by whatever signature covers the frames, so the
same layout works under EIP-8288's leanSPHINCS dependencies (experiment 49).

## Results, 2026-11-06

- Network: the Hegota testnet, `ethrex/v23.0.0-hegota-testnet-hotfix-64b8fc09`.
- Runner at commit `489aebe`, `npx tsx experiments/54-outcome-assertion/run.ts setup`, then
  `a`, `b,c,d,e`, and `f,assert`.
- Every record is in [`results/2026-11-06.jsonl`](results/2026-11-06.jsonl): the transaction,
  the simulation, the frames' receipts, `Q`, and every value read before and after.
- The account is 893 bytes of runtime, then the owner: 925 bytes on chain. Setup ran in blocks
  713,213 and 713,214.

| Case | Transaction | Outcome | Frames: status, execution gas | After |
|---|---|---|---|---|
| (a) honest transfer | [`0x63ac6170…`](https://dora.privacy.ethrex.xyz/tx/0x63ac61701302ea8d98e93cb1e7416dc76608eb526858274d4d3a0b846007c2ff) | **mined**, block 713,215, status 1 | VERIFY 714 · transfer 30,357 · check 11,179 | the recipient has 10 more |
| (b) hidden approval, listed spender | [`0xab2e9b88…`](https://dora.privacy.ethrex.xyz/tx/0xab2e9b8803bd51d32a4bc5ee2e84a2521d5a837c882d8c95484a9c5ef89d7f21) | **mined, reverted**, block 713,217, status 0 | VERIFY 811 · transfer 30,357 · approve 14,619 · check FAILED 3,103 | allowance still 0, both balances unchanged |
| (c) approval, unlisted spender | [`0x2350b4cd…`](https://dora.privacy.ethrex.xyz/tx/0x2350b4cdc60e355110fee39b609a21b2da3e76a17101de998f97030b106ac92b) | **mined**, block 713,218, status 1 | VERIFY 811 · transfer 30,357 · approve 14,619 · check 11,179 | the unlisted spender's allowance is $2^{256}-1$ |
| (d) operator grant, listed collection | [`0xafcb3fcf…`](https://dora.privacy.ethrex.xyz/tx/0xafcb3fcf5830b3e2c5a163f151511ddfa2869b97c6664fa147f30c00296b79ca) | **mined, reverted**, block 713,219, status 0 | VERIFY 811 · transfer 30,357 · grant 17,625 · check FAILED 6,230 | grant still false, both balances unchanged |
| (e) lying token | [`0x019ec079…`](https://dora.privacy.ethrex.xyz/tx/0x019ec079280aa1015a49e60fb80adc0088aae54d61bda5c6d0a76e7db57972ee) | **mined**, block 713,220, status 1 | VERIFY 714 · transfer 42,613 · check 6,508 | `balanceOf(recipient)` reads 10. The recipient holds 0, and the sink holds the 10 |
| (f) payer drops the check | `0x39feabfc…` | **refused** before inclusion | VERIFY reverted | - |
| (f) payer moves the check ahead of the body | `0x18d55d88…` | **refused** | VERIFY reverted | - |
| (f) payer moves the check into a separate batch | `0x51cace80…` | **refused** | VERIFY reverted | - |
| (f) payer inserts a body frame ahead of the check (amendment) | `0xbbae3bd2…` | **refused** | VERIFY reverted | - |
| (f) honest completion | [`0xa3cd3131…`](https://dora.privacy.ethrex.xyz/tx/0xa3cd31315b373289023041f62cd316a5b7070743dd407dde1b99a9c6f3bfe7f2) | **mined**, block 713,223, payer the sponsor | VERIFY over $E$ 3,059 · pay 3,000 · transfer 30,357 · check 11,179 | the recipient has 10 more |
| (f, control) owner signs a body with no check (amendment) | `0x8b9ef267…` | **refused** | VERIFY reverted | - |
| `ASSERT`: final frame of mode 3, from the account | `0x759eeadb…` | **refused**: "Invalid frame transaction: Frame 2: reserved execution mode 3" | - | - |
| `ASSERT`: final frame of mode 3, from an EOA (amendment) | `0x8f60821a…` | **refused**, the same words | - | - |
| `TXTRACE` (`0xb6`), `eth_call` to the probe | - | "execution halted: reason=Invalid Opcode" | - | - |
| `TXTRACE` (`0xb6`) in a body frame | [`0x452ce7a2…`](https://dora.privacy.ethrex.xyz/tx/0x452ce7a26117553785054e0d54b4343cabbe436980591c7b0b5c95c5eeddb093) | **mined, reverted**, block 713,224 | probe FAILED, all of its 30,000 · check SKIPPED | - |

The refused transactions have no receipts. Their hashes are the ones they would have had, and
the node's refusal is in the record.

**Setup fix, 2026-11-06, after the coordinator's rerun under another key.**
- Under a new key, setup's funding frame to the new sponsor failed while the other frames
  succeeded. The sponsor had no ETH, so (f)'s honest completion was refused with the altered
  copies, and (f) proved nothing. A value frame the funder cannot cover fails on its own, and
  frame [1] had already sent 0.1 ETH. The same layout funds a new sponsor when the funder holds
  enough: block 713,346.
- Setup now:
  - checks the funder's balance first;
  - deploys only missing contracts;
  - funds a new EOA with `NEW_ACCOUNT_STATE_GAS`;
  - stops on any failed frame.
- (f) stops if its honest completion would be refused.
- `EXP54_RUN=<name>` derives a fresh set of keys, account and sponsor. The key comes from
  `PRIVATE_KEY`.
- Rerun `EXP54_RUN=fresh-2 run.ts setup,f`, blocks 713,351 to 713,353:
  - the four altered copies and the control were refused;
  - the honest completion was mined in block 713,353, VERIFY over $E$ 3,059.
  The same outcome as the first run.

## Short answers

1. **Done when: met.**
   - Cases (a) to (e) and (f)'s honest completion were mined, with receipts.
   - (f)'s four altered copies and its control were refused before inclusion.
   - `ASSERT` was tried and is not implemented on this network: mode 3 is refused as reserved, and
     `0xb6` is an invalid opcode. So the run under `TXTRACE` with the stricter rule could not run.
     It waits for a client with EIP-7906.
2. **The claim holds, and nothing that would show it wrong was observed.**
   - (b) and (d) left nothing behind: the approval stayed 0, the grant stayed false, and the
     transfer in the same batch was undone.
   - (c) and (e) passed the check. The unlisted spender holds an unlimited allowance. The lying
     token's sink holds the 10 that `balanceOf` says the recipient got.
   - Reads of named state caught neither, so the stricter rule is needed: deny every write the
     signed `Q` does not list.
3. **Why (c) and (e) pass is the same reason.**
   - The check reads only the values `Q` names. Each read goes through code the transaction
     touched.
   - In (c) the harmful write is to a slot no entry names.
   - In (e) the entries are named, but the contract answering them is the one that lies.
   - A check that lists writes, as `TXTRACE` would, sees both: a write to the allowance slot of an
     address `Q` does not list, and a write to `held[sink]`. EIP-7906 reports a changed slot by its
     key, a hash. So a checker under the stricter rule needs no mapping from slot to resource: any
     changed slot that `Q` does not list fails.
4. **A failed check is visible only in the transaction's status and in the gas.**
   - In (b) and (d) the body frames' receipts say SUCCESS, with 0 state gas, although they were
     undone. This is experiment 03's observation 2, again.
   - A wallet that reads frame receipts sees a successful approve. It must read the transaction's
     status and the check frame's.
5. **`E` pins the check frame, and the account's frame rule pins it too. Each refused a copy the
   other let through.**
   - The inserted body frame keeps a valid layout, and only `E` refused it.
   - The owner's own transaction with no check frame is signed over the canonical hash, and only
     the frame rule refused it.
   - The first three copies break both. The node's refusal names no cause, so the record cannot
     tell which defence fired first.
6. **Cost against the predictions.**
   - The check costs about 2,800 execution gas per entry: 11,179 for four entries, 6,508 for two.
     The prediction was about 3,000.
   - The frame rule adds 363 to 460 gas to `VERIFY` over the canonical hash: 714 and 811, against
     experiment 27's 351. The prediction was about 1,000, so it was high.
   - Over $E$ with four frames, `VERIFY` is 3,059, against experiment 27's 1,974 for three frames.
     The fourth frame and $Q$'s 708 bytes of data account for the difference.
7. **What the batch cannot do, that `ASSERT` would.**
   - The check here is a frame of the batch, so it can only undo the batch. A validation-prefix
     write survives it, as EIP-7906 notes.
   - Everything before the batch is outside it. In these runs nothing ran there but `VERIFY`.
   - The account has to require the check itself. Here it does so in `VERIFY`: the frame rule.

**Post-quantum status.** None. The owner and the sponsor sign with secp256k1. The layout does not
depend on the scheme: the check frame is pinned by whatever signature covers the frames.

## Results of amendment 2: the `TXTRACE` arm on the Hegota devnet, 2026-11-06

- Chain 3151908, `https://rpc1.hegota.ethrex.xyz`, `ethrex/v23.0.0`.
- `npx tsx experiments/54-outcome-assertion/run-devnet.ts setup`, then `probe`, then `cases`.
- Records, each with its chain ID: [`results/devnet-2026-11-06.jsonl`](results/devnet-2026-11-06.jsonl).
- **Funding.** The funder, a key derived for this chain, was funded from the devnet's faucet
  only: one claim of 1 ETH.
- **Setup.** The first try put all four deploys in one transaction. It passed simulation and was
  accepted by `eth_sendRawTransaction`, then left the pool without a receipt. Its frame limits
  summed past the devnet's cap of $2^{24}$. One deploy per transaction mined, the last in block
  1,321,752; the minting in 1,321,753.
- **Layouts.** Setup checked both storage layouts against the chain before any case.
- **The probe** (simulation only) required the diff's storage count to be exactly 2 after (a)'s
  body. It passed at 2 and failed at 3, so the devnet numbers `TXTRACE` as the demo does, with
  the index on top.

| Case | Rule | Transaction | Outcome | The check's execution gas | After |
|---|---|---|---|---:|---|
| (a) honest transfer | strong | [`0x09aa7e52…`](https://dora.hegota.ethrex.xyz/tx/0x09aa7e523b22d7d97f585050689dec138b76dadcb25fc292c5a816f03a48b044) | **mined**, block 1,321,757, status 1 | 2,069 | the recipient has 10 more |
| (a) | baseline | [`0xfb48d242…`](https://dora.hegota.ethrex.xyz/tx/0xfb48d24278075a2169ccaa6c3ba275bdcc519fe4bb0d50d12fcaaf1cbaeb6919) | **mined**, 1,321,758, status 1 | 16,375 | the recipient has 10 more |
| (b) approval, listed spender | strong | [`0xc9d6d5cd…`](https://dora.hegota.ethrex.xyz/tx/0xc9d6d5cd0895fce120b98aedf0b75e888996ffeee5fdff55dfa08ee0659c790b) | **mined, reverted**, 1,321,759, status 0 | 938, FAILED | nothing changed |
| (b) | baseline | [`0x31de9460…`](https://dora.hegota.ethrex.xyz/tx/0x31de9460303def1a9aba718ae8cfa308585fe7521356409d4edc65111b73e17a) | **mined, reverted**, 1,321,760, status 0 | 5,963, FAILED | nothing changed |
| (c) approval, unlisted spender | strong | [`0xffd8540a…`](https://dora.hegota.ethrex.xyz/tx/0xffd8540a0bc1ba8e6f9ff6cc381677c11a36f26be328df9aa475babdc598a848) | **mined, reverted**, 1,321,761, status 0 | 938, FAILED | nothing changed |
| (c) | baseline | [`0xfa46a5d5…`](https://dora.hegota.ethrex.xyz/tx/0xfa46a5d597f081f6be3b8284f5eed88013e3e8198edb3f6eb62ceb32cdb0feb4) | **mined**, 1,321,762, status 1 | 17,048 | the unlisted spender's allowance is $2^{256}-1$ |
| (d) operator grant | strong | [`0x2bb799de…`](https://dora.hegota.ethrex.xyz/tx/0x2bb799de070e6662fc24ff7a33437b49b3214d47a70938054787817adf02c33c) | **mined, reverted**, 1,321,763, status 0 | 938, FAILED | nothing changed |
| (d) | baseline | [`0xff6dff6e…`](https://dora.hegota.ethrex.xyz/tx/0xff6dff6e33de690b06714f8a3e56f2d298eb59f9129dd991aa289ed4c9366b45) | **mined, reverted**, 1,321,764, status 0 | 12,882, FAILED | nothing changed |
| (e) lying token | strong | [`0x84e157e2…`](https://dora.hegota.ethrex.xyz/tx/0x84e157e2db579a555cc6e30e6cbe7b312942d6b9f442a2e68607c0f518700e55) | **mined, reverted**, 1,321,765, status 0 | 1,603, FAILED | nothing changed |
| (e) | baseline | [`0xbfcbb81a…`](https://dora.hegota.ethrex.xyz/tx/0xbfcbb81a4de78eb68e1666ea114cfb27aad4cc2f04d5b7ef0998eeab706f0e3c) | **mined**, 1,321,766, status 1 | 11,468 | `balanceOf(recipient)` reads 10, and the sink holds the 10 |

**Short answers for amendment 2:**

1. **Every prediction held.**
   - The strong rule passed (a) and reverted (b) to (e).
   - The baseline passed (a), (c) and (e), and reverted (b) and (d).
   - So the rule that denies every write the signed $Q$ does not list catches the two cases that
     reads of named state let through, on a chain that runs EIP-7906.
   - Nothing that would show the rule wrong was observed.
2. **A failed mode-3 check undoes the whole body.**
   - Every reverted case left balances, allowances and grants unchanged.
   - The transaction was still mined with status 0, and the account paid for its gas.
   - The body frames' receipts say `ok`, as in the batch arm. Only the check frame's receipt and
     the transaction's status show the failure.
3. **The strong rule is the cheaper check here.**
   - It reads the diff, which is small: two storage writes for a transfer.
   - It costs 2,069 gas when it passes, and 938 to 1,603 when it fails at the first unlisted
     write.
   - The baseline costs 11,468 to 17,048 when it passes. It pays for a `STATICCALL` per named
     value and a scan of every event.
   - The cost of the strong rule grows with the number of writes, and the baseline's with the
     number of events, which a dapp can pad.
4. **What the strong rule needed from the wallet.**
   - $Q$ names exact storage slots and their values after: the two balance slots of the token
     transferred. The runner computed them from the contracts' declared layouts and checked those
     against the chain first. A wallet would take them from its own simulation, as
     experiment 58 does.
   - The payer's balance change is allowed whatever its value, since the gas charged is not known
     at signing.
   - No other balance changed in these cases: the coinbase is paid after the check.
5. **The devnet's EIP-7906 differs from the master text** in its mode's name (`POST_TX`), its
   parameter numbering and its operand order, and it has no nonce table. A check written for one
   does not run on the other unchanged.
