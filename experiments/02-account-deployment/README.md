# 02 — Account deployment (EIP-8141 Example 1b)

Deploy a smart account **at `tx.sender`** and use it in the same transaction. The sender is a
counterfactual CREATE2 address that nobody holds a key for. Its code is installed by frame 0,
and that code then validates frame 1.

| Frame | Mode    | Caller      | Flags                         | Target        | Value  | Data           |
| ----- | ------- | ----------- | ----------------------------- | ------------- | ------ | -------------- |
| 0     | DEFAULT | ENTRY_POINT | APPROVE_SCOPE_NONE            | Deployer      | 0      | Initcode, Salt |
| 1     | VERIFY  | ENTRY_POINT | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | 0      | Empty          |
| 2     | SENDER  | Sender      | APPROVE_SCOPE_NONE            | Destination   | Amount | Empty          |

- **Deployer:** the testnet has no EIP-7997 predeploy, so frame 0 calls Arachnid's CREATE2 deployer
  (`0x4e59…956c`) with `salt ‖ initcode`.
- **The account:** [`SimpleAccount.yul`](SimpleAccount.yul), 77 bytes of runtime plus its 32-byte
  owner appended to the code. Its VERIFY path does no `ecrecover`. The protocol has already validated
  every SECP256K1 entry in `tx.signatures` before frame 0 runs. So the account only checks, with
  `SIGPARAM`, that entry 0 is a secp256k1 signature whose resolved signer is the owner and whose
  `msg` is empty (it signs the canonical sig hash, which commits to every frame). Then it calls
  `APPROVE(FRAMEPARAM(0x06, current))`, the scope the frame's flags allow. It reads no storage.
- **The initcode is safe for anyone to submit:** the owner is fixed inside it, so a front-runner can
  only deploy the same account for us.

## Run

```bash
npx tsx experiments/02-account-deployment/example-1b-deploy.ts   # prefund → 1b → follow-up
npx tsx experiments/02-account-deployment/negative.ts            # 1 funding tx, then simulations only
```

## Results (2026-10-07)

Owner EOA `0xa93CEe06b1e4fFACdf920BD500cb301a39DdEB74`, account `0x998bB2F3B526e56D12415D02b36580E295fc2B78`.

| Tx | What | Frames (execution / state gas used) | `gasUsed` |
|---|---|---|---|
| [`0x44416f96…`](https://dora.privacy.ethrex.xyz/tx/0x44416f9636feacbb132d902a543ed216378954c0b155a2d5edfa1c78f78fb848) | owner prefunds the counterfactual address with 0.02 ETH | VERIFY 100/0 · SENDER 3,000/183,600 | 209,702 |
| [`0x9882637a…`](https://dora.privacy.ethrex.xyz/tx/0x9882637a3a4c99b101498620f9e69096a6ae45a36bb6a16f6dd31255d1fbb88c) | **Example 1b**: deploy at `tx.sender`, validate, send 0.001 ETH | DEFAULT 15,241/166,770 · VERIFY 288/0 · SENDER 3,000/183,600 | 394,908 |
| [`0x68fc041a…`](https://dora.privacy.ethrex.xyz/tx/0x68fc041abd4c9c039473e6412422997881b135b873b421f599df394afb0e97eb) | follow-up from the deployed account, no deploy frame | VERIFY 288/0 · SENDER 3,000/183,600 | 210,982 |

Account state: `nonce 0, no code` → after 1b `nonce 2, 109 B of code` → after the follow-up `nonce 3`.
The account paid its own gas both times (`payer` = the account).

## Observations

1. **The node recognised the shape.** The simulator reported `DeploySelfVerify`, the EIP's "Deploy New
   Account" self-relay prefix. The validation prefix (deploy 80,000 + verify 10,000 execution + 2,800
   signature) fits even the spec's `MAX_VERIFY_GAS` of 100,000. It actually used 15,241 + 288.
2. **The code deposit was the only state cost of deployment.** That was 109 B × 1,530 = 166,770.
   There was no 183,600 account-creation charge, because the prefund had already created the
   account (balance, no code). In experiment 01 the probe deployed onto an untouched address and
   paid 183,600 + its code deposit.
3. **The nonce jumped 0 → 2.** CREATE2 gives the new contract nonce 1, then `APPROVE` *increments*
   the nonce instead of setting it to `nonce_seq + 1`, which EIP-8250 spells out for exactly this case.
   A wallet must re-read the nonce after a deploy transaction rather than assume `+1`.
4. **The account costs 288 gas to validate.** Compare 100 for an EOA's default code. Both pay the same
   100-gas access charge. The account adds 188 gas of code: seven 2-gas introspection opcodes, a
   `CODECOPY` of the owner, and ordinary stack and jump opcodes. Using the protocol's signature list
   instead of an in-EVM `ecrecover` (3,000 + calldata) keeps it tiny, and the signature is checked once,
   by the protocol (2,800 intrinsic).
5. **The follow-up transfer is calldata-floor bound again.** It paid 27,382 = 21,750 + 88 B × 64 (with a
   20-byte `signer` this time) against 26,422 for intrinsic + execution.

### Rule violations (`negative.ts`, simulated)

| Case | `valid` | Node says |
|---|---|---|
| fresh funded account, Example 1b as designed | true (`DeploySelfVerify`) | — |
| no deploy frame | false | validation prefix frame reverted: no code, so default code runs and wants signer == sender |
| VERIFY before the deploy frame | false | validation prefix frame reverted (same reason) |
| signed by another key, `signer` = that key | false | validation prefix frame reverted: the protocol accepts the signature, but the account rejects the signer |
| owner signs an explicit 32-byte `msg` instead of the sig hash | false | validation prefix frame reverted: the account requires `msg` empty, so the approval is bound to these frames |
| deployed account, deploy frame replayed | false | validation prefix frame reverted: CREATE2 collides, so wallets must drop the deploy frame |
| signature claiming to be the account itself (`signer` empty) | false | frame signature list does not authenticate the sender: nobody has the account's key |
