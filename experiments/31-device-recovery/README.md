# 31 - Recovery from the owner's own devices

When the user's wallet holds the user's state, losing the device loses the state, so recovery
becomes the wallet's duty. The usual answers, guardians, a recovery service or a committee
holding shares, put a party back in charge of the account. That is the operator a frames wallet
removed. This experiment recovers an account, and the notes it deposited, with nobody but the
owner. Two of the owner's own devices, a laptop and a hardware key, both needed, hand the account
to a new key after a delay, and the owner can cancel during it.

The question is whether a user can get the account back with no party holding a share of it,
for years, on the user's behalf.

[`DeviceRecoveryAccount.yul`](DeviceRecoveryAccount.yul) is experiment 13's `RecoveryAccount`
(v2) with the guardians replaced by the owner's devices. It also has one more constructor word,
which picks the rule that says a finish is too early:

| Rule | Where the delay is checked | An early finish |
|---|---|---|
| **EIP** (`LOWER_BOUND = 0`) | in execution, by the finish frame | admitted, included, and its finish frame reverts |
| **ethrex** (`LOWER_BOUND = 1`) | also in the pending owner's `VERIFY`: it calls the expiry verifier at `0x8141` with `unlock - 1` and requires it to revert (experiment 19, probe 30) | refused at admission |

The EIP allows `TIMESTAMP` only "in an expiry verifier frame". ethrex allows it wherever the
verifier's code runs, at any call depth. So the ethrex rule works only on ethrex. On a client
that follows the EIP's wording, the pending owner's `VERIFY` halts, and the account could never
be recovered.

| Signed by | VERIFY frame data | Allowed frames after VERIFY | Effect |
|---|---|---|---|
| the owner (slot 0) | empty | anything | |
| $m$ devices, ascending, `msg` empty | `salt \|\| m \|\| devices` (the reveal) | exactly one SENDER to self: `0x01 \|\| newOwner` | pending = newOwner, unlock = now + `DELAY` |
| the pending owner | empty | exactly one SENDER to self: `0x02` | owner = pending, if now $\ge$ unlock |

The owner also has `0x03` (cancel) and `0x04` (replace the device commitment). The account
stores only $\mathrm{keccak256}(\mathrm{salt} \parallel m \parallel d_1 \parallel \dots \parallel d_n)$.

The account's key is not the only thing to recover. The notes the wallet deposited are opened by
secrets that kohaku-rs's `kohaku-tornadocash-keychain` derives from one keychain key. That key is
split between the same two devices: each holds a uniformly random 32-byte share, and the key is
their XOR. kohaku-rs's `crates/frame-wallet/examples/device_recovery.rs` does that part from Rust.

| File | What |
|---|---|
| [`DeviceRecoveryAccount.yul`](DeviceRecoveryAccount.yul) | The account, both rules, 830 B of creation code |
| [`device.ts`](device.ts) | Keys derived from `PRIVATE_KEY` (the phone, the new phone, the laptop, the hardware key, a thief), `reveal`, `commitment`, `deviceRecoveryAccount`, `start`, `accountTx`, `readState` |
| [`run.ts`](run.ts) | Setup, then A to F against both accounts |

## Run

```bash
npx tsx experiments/31-device-recovery/run.ts            # both rules; waits out each 60 s delay
npx tsx experiments/31-device-recovery/run.ts ethrex     # one rule
```

From kohaku-rs, the note openings:

```bash
PRIVATE_KEY=0x... cargo run --release -p kohaku-frame-wallet --example device_recovery
```

Each account can be recovered once, because A to F leave it owned by the new phone. `DELAY` is
60 s here and days in practice.

## Results (2026-10-20, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

The EIP-rule account is `0x57257496FEDA550aC7DBfe2618a2FbCA68B3b05B` and the ethrex-rule account
`0xDBc37572df127a8AD4ADE0c72B93a046a9a53451`. The owner (the phone) is
`0x2b8328a7D59C8f36e98E3cD6Ef62c181C3AB3eA9`, the devices `0xc1E245612c277De15c5c3fc065DC2cde61FE41eD`
and `0x2c8EF2d7E315996469A1DaE3543d24538963da20`, both needed, and the new phone
`0x809F29c69c037B6d55229B9C26597f82b4B183A0`. The funder deployed them in
[`0x46755802...`](https://dora.privacy.ethrex.xyz/tx/0x46755802341b56aeb0de262368948cec4de4b658c5883f6fec667ffb968711ac)
and [`0xa6c06b21...`](https://dora.privacy.ethrex.xyz/tx/0xa6c06b21099b31861be1e61b2642beab261f09bfe524c5175c4e8e407f4cd437).

| Step | EIP rule | `gasUsed` | Frames | ethrex rule | `gasUsed` | Frames |
|---|---|---|---|---|---|---|
| **A.** the owner pays | [`0x80b41e05...`](https://dora.privacy.ethrex.xyz/tx/0x80b41e05bfd797992de565f33e8a2bb64984564ee1a7976e0d44f2e4c149adb3) | 28,550 | VERIFY 2,404 · pay 3,000 | [`0x11300859...`](https://dora.privacy.ethrex.xyz/tx/0x1130085989dad3653cd27d479acaad6b94b4a558fc3424239a05baede60fe8c9) | 28,550 | VERIFY 2,404 · pay 3,000 |
| **B.** the two devices start a recovery to the new phone | [`0x7a5051c0...`](https://dora.privacy.ethrex.xyz/tx/0x7a5051c05ffea791b3a5307d5a3d80e668057b78c7f1a8730cb9003dca47e6fc) | 38,839 | VERIFY 3,589 · start 12,452 | [`0x8ff25bf0...`](https://dora.privacy.ethrex.xyz/tx/0x8ff25bf0457d63b30151c510fee5ce5876fb64398d8087ae0dd5adbd60ea6d70) | 38,863 | VERIFY 3,589 · start 12,452 |
| **C.** the new phone finishes before the delay | [`0xe8c0a407...`](https://dora.privacy.ethrex.xyz/tx/0xe8c0a407a6fd81675916bae2debce5453f7424da2661c3368c329b2605c625df): included, finish **FAILURE** | 22,381 | VERIFY 4,807 · finish 412 | **refused at admission**: "validation prefix frame reverted", in simulation and by `eth_sendRawTransaction` | | |
| **D.** the new phone finishes after the delay | [`0x3b328520...`](https://dora.privacy.ethrex.xyz/tx/0x3b3285202ab15ec1ea0ecbe340790b8e66219038a873c33b7be6200d56d37756) | 42,604 | VERIFY 4,807 · finish 20,623 | [`0xa3fb8a65...`](https://dora.privacy.ethrex.xyz/tx/0xa3fb8a650c28736e47eaa482cbc906989a7f9184342cf86501ad370adc8251ef) | 45,856 | VERIFY **8,071** · finish 20,623 |
| **E.** the new owner pays | [`0x9821c3d5...`](https://dora.privacy.ethrex.xyz/tx/0x9821c3d58d2ef35ea975aaba4665965dfb220967d8ceb7a75873d703321fe534) | 28,550 | VERIFY 2,404 · pay 3,000 | [`0xaa47ddf5...`](https://dora.privacy.ethrex.xyz/tx/0xaa47ddf56f68d7fc07b704e99acd56a36a4b46ced25876473eef716374064aa4) | 28,538 | VERIFY 2,404 · pay 3,000 |
| **E.** the lost phone's key tries to pay | refused at admission | | | refused at admission | | |
| **F.** the devices, stolen together, start a recovery to a thief's key | [`0xf79497e6...`](https://dora.privacy.ethrex.xyz/tx/0xf79497e61d39fb3415f47a68bc0cb6b404863f8434f09bba47c025fe8a336eed) | 38,815 | VERIFY 3,589 · start 12,452 | [`0xc6967c03...`](https://dora.privacy.ethrex.xyz/tx/0xc6967c03193bdcc1c0c5a63c5798390531e54e477d56d4942c4612682d9ffa92) | 38,839 | VERIFY 3,589 · start 12,452 |
| **F.** the owner cancels during the delay | [`0x62ba747c...`](https://dora.privacy.ethrex.xyz/tx/0x62ba747c2c7c75c8f35d7b9e40948e86ecc6a6382a835c38755943cdbaca15c3) | 31,939 | VERIFY 2,404 · cancel 12,373 | [`0x3d24fad5...`](https://dora.privacy.ethrex.xyz/tx/0x3d24fad5ba8e13bb2edccc8078f794388ba41fa788af7e87d082ea562d1fb4f3) | 31,951 | VERIFY 2,404 · cancel 12,373 |
| **F.** the thief tries to finish | refused at admission | | | refused at admission | | |

The small differences in `gasUsed` between the two columns are calldata: other signatures, with
other zero bytes.

### The notes, from Rust

kohaku-rs's `device_recovery` example (branch `claude/nifty-einstein-llp9cd`) ran the note half
against experiment 06's keyed pool, with a fresh keychain key split between the two devices:

| Step | Tx | Block |
|---|---|---|
| before the loss: the keychain's note 0 deposited, leaf 13 | [`0x2e627aa8...`](https://dora.privacy.ethrex.xyz/tx/0x2e627aa8894fa9d48a1ddb35a698ce398bd3de3e4d818901e8b2b7a6e19fa840) | 479,022 |
| after it: the two shares give the key back, and the keychain finds 1 note of its own among the pool's 24 `Deposit` and `Withdrawal` events, unspent | | |
| the recovered note withdrawn with the pool as sender, no signature, 567,869 gas | [`0x4ab21d88...`](https://dora.privacy.ethrex.xyz/tx/0x4ab21d88d863b0f597da77a84c2c011c04189641afd5da8057957367819ab8b5) | 479,025 |

Every transaction above is a fixture here and in kohaku-rs. kohaku-rs's
`crates/frame-accounts/tests/device_recovery.rs` rebuilds the 13 account transactions with its
`DeviceRecoveryAccount`, byte for byte, and checks that both accounts land at the addresses
above. Its frame-pool test rebuilds the withdrawal.

## Observations

1. **Nobody but the owner holds anything.** The account recovered in D and the note recovered in
   Rust needed the two devices and nothing else: no guardian, no service, no committee, and no
   backup written to the chain. The devices do keep their keys and shares for as long as the
   account lives. They are the owner's own, though, not a party, so the answer is yes. What it
   costs:
   - **Losing both devices with the phone loses everything.** Two-of-three devices would trade
     that for one more device to keep.
   - **A thief with both devices can start a recovery** (F). Only the owner's cancel inside the
     delay stops it, so the delay must outlast the time it takes to notice. 60 s is a test value.

2. **The EIP's rule costs a reverted transaction; ethrex's costs portability.** Under the EIP's
   rule, the early finish in C was admitted, included and reverted, and the account paid 22,381
   gas for it. Only the pending owner the devices chose can do this. Under ethrex's rule the same
   transaction was refused at admission and cost nothing. That `VERIFY` costs 3,264 more gas on
   every finish (8,071 against 4,807), the expiry verifier call. The ethrex account depends on
   that one client's reading: on a client that follows the EIP's wording, no finish could ever be
   admitted. A recovery that works on one client only is the wrong thing to build an account on.
   An account meant to last should take the EIP's rule. The portable fix is still experiment 13's
   suggestion: a lower bound in the expiry frame.

3. **The note openings come back from public data.** The keychain needs only its key and the
   pool's events, which anyone can read. Recovering the notes reveals nothing to anyone,
   because the scan runs locally.

4. **The devices are revealed when they act.** As with experiment 13's guardians, the start
   publishes the device list in its `VERIFY` data and names both signers. After a recovery, the
   new owner should replace the commitment (`0x04`) with a fresh salt, or new devices.

5. **One more silent drop, on the first transaction after a deployment.** The first run's A was
   given a hash and never included. The node no longer knew it 15 blocks later. The second
   run sent the identical transaction, same hash, and it was mined. Experiments 07 and 15 each
   saw one such drop on the first transaction after the sender's code changed. Here the account's
   code had just been deployed.
