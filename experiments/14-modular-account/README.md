# 14 — Modular account: ERC-7579-style validators under the frame mempool

ERC-7579 accounts keep their validation logic in modules, and a user operation names the module
that should judge it. This experiment ports the pattern. The VERIFY frame's data names the
module, and the account runs it. Then it tests the three ways a 7579 validator is commonly
written against EIP-8141's public-mempool rules.

[`ModularAccount.yul`](ModularAccount.yul) stores `kind` at `storage[module]`: 1 means run the
module by DELEGATECALL, 2 by STATICCALL. VERIFY then:

1. reads `module` from the first 20 bytes of its own frame data;
2. calls the module with `0x01 ‖ rest of the data`;
3. APPROVEs the frame's scope if the module returns the word 1.

The module reads the signature list itself, because `SIGPARAM` is transaction-scoped and works at
any call depth. Install and uninstall are SENDER frames the account sends to itself.

| Module | Run by | Keeps its config in | Under the frame mempool |
|---|---|---|---|
| [`OwnerValidator`](OwnerValidator.yul) | DELEGATECALL | the account's storage, at a namespaced slot | admitted and mined |
| [`ExternalOwnerValidator`](ExternalOwnerValidator.yul) | STATICCALL | its own storage, keyed by the account (the common 7579 layout) | **`StorageReadNonSender`** |
| [`CountingValidator`](CountingValidator.yul) | DELEGATECALL | the account's storage, and writes a use counter there while validating | **reverts**: VERIFY is static |

| File | What |
|---|---|
| [`ModularAccount.yul`](ModularAccount.yul) | The account: 308 B deployed. The constructor installs the first module |
| [`OwnerValidator.yul`](OwnerValidator.yul), [`ExternalOwnerValidator.yul`](ExternalOwnerValidator.yul), [`CountingValidator.yul`](CountingValidator.yul) | The modules, deployed once and shared by every account |
| [`modular.ts`](modular.ts) | `modularAccount`, `install`, `viaModule(account, module, signer, frames)` |
| [`example-modular.ts`](example-modular.ts) | Setup, then A-D on the testnet |
| [`negative.ts`](negative.ts) | 9 cases, simulated |

## Run

```bash
npx tsx experiments/14-modular-account/example-modular.ts   # setup (once), then A-D
npx tsx experiments/14-modular-account/negative.ts          # simulations
```

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

Account `0x8B2760F8463a2F73f3A156c42995d0bFf0ec1858`, owned by alice through OwnerValidator.

| Tx | What | Frames: execution / state gas | `gasUsed` |
|---|---|---|---|
| [`0xded7fd61…`](https://dora.privacy.ethrex.xyz/tx/0xded7fd61e96718ba42a2c4c1bc3d030c07f90426ef75fd78c5cebcfa13348132) | setup: the funder deploys the three modules and the account (installing OwnerValidator for alice), and funds it | VERIFY 100 · 3 modules · account 37,061/850,680 · fund 141 | 2,036,569 |
| [`0x5d5d1944…`](https://dora.privacy.ethrex.xyz/tx/0x5d5d194459e3cd6cdddc863f7db56e66bc64ca06033e5eb72afab1085d2df2e7) | **A.** alice pays; OwnerValidator judges by DELEGATECALL | VERIFY **7,750** · pay 3,000 | 34,228 |
| [`0xd2d2ae96…`](https://dora.privacy.ethrex.xyz/tx/0xd2d2ae9699bafea67735403ce0322a4cebeef3a414791dfd21304b6f967b7036) | **B.** alice installs ExternalOwnerValidator (which writes alice into its own storage) and CountingValidator | VERIFY 7,750 · install 27,633/195,840 · install 15,525/97,920 | 363,621 |
| refused | **C.** alice pays; ExternalOwnerValidator judges by STATICCALL | prefix succeeded and set the payer; refused `StorageReadNonSender` by both simulation and `eth_sendRawTransaction` | |
| refused | **D.** alice pays; CountingValidator judges | `validation prefix frame reverted` (the SSTORE in a static context) | |

The VERIFY cost of the same owner check in three places:

| Owner check | VERIFY gas | Source |
|---|---|---|
| owner in code | 340 | experiment 12 |
| owner in storage | 2,404 | experiment 13 |
| owner in storage, behind a delegated module | 7,750 | A |

### Refusals (`negative.ts`, simulated)

| Case | valid | Node says | payer |
|---|---|---|---|
| OwnerValidator, alice signs (baseline) | true | | set |
| OwnerValidator, a stranger signs | false | `validation prefix frame reverted` | |
| OwnerValidator, alice signs an explicit `msg` | false | prefix reverted | |
| a module that is not installed (the CREATE2 deployer) | false | prefix reverted | |
| VERIFY data of 19 bytes | false | prefix reverted | |
| ExternalOwnerValidator, alice signs | false | `StorageReadNonSender` | **set** |
| ExternalOwnerValidator, a stranger signs | false | `StorageReadNonSender` | |
| CountingValidator, alice signs | false | prefix reverted | |
| CountingValidator, a stranger signs | false | prefix reverted | |

## Observations

1. **A module may keep its configuration only in the account.** The EIP's trace rules allow
   helper contracts "including via `DELEGATECALL`", and say "`SLOAD` can be used only to access
   `tx.sender` storage, including when reached transitively via `CALL*` or `DELEGATECALL`".
   ERC-7562, the 4337 mempool's rulebook, also lets validation read storage *associated* with the
   sender in other contracts, such as `mapping(account => config)` in a module. Most 7579
   validators are written that way. EIP-8141 has no such category, and ethrex enforces that. C's
   prefix succeeded at the protocol level, and the payer was set, so a block builder could include
   it; the public mempool refuses it. A 7579 validator ports to frames as a DELEGATECALL module
   whose state lives in the account under a namespaced slot (OwnerValidator), not as an external
   one.

2. **A validator cannot keep counters.** VERIFY runs as a static call, so CountingValidator's
   `SSTORE` halts it, and with it the transaction. 7579 validators that count uses, rate-limit or
   record anything during `validateUserOp` must split as experiment 12 does: VERIFY reads, and a
   SENDER frame that cannot fail writes.

3. **Indirection costs about 5,300 gas per transaction.** A delegated owner check costs 7,750 in
   VERIFY against 2,404 for the same check inline. The difference is:
   - the module's cold account access (2,600);
   - the `installed` lookup (one more cold slot, 2,100);
   - copying the frame data into calldata.

   The 20-byte module address in the VERIFY data adds calldata cost too. Under 4337, a 7579
   account pays roughly the same indirection inside `validateUserOp`.

4. **The module is chosen in the frame, not in the nonce.** ERC-7579 accounts under 4337 often
   encode the validator in the user operation's nonce key. Here the VERIFY frame's data carries
   it, and the signature hash covers it, so the module choice is signed. The nonce keys stay free
   for parallelism (experiment 08). Because VERIFY here reads sender storage, ethrex would not let
   those keys run in parallel anyway.

5. **The trace violation is reported before the revert.** With a stranger's signature,
   ExternalOwnerValidator would have returned 0 and the account would have reverted. The node
   reports `StorageReadNonSender`, not the revert, so a wallet debugging a refusal sees the
   mempool rule first.
