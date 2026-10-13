## Admission probes

Block 99450, 2026-10-08T02:36:00.000Z, base fee 7 wei. Priced probes offer `maxFeePerGas` 1000000014 and a tip of 1000000000; free probes offer zero. Every sender, and the sponsor `0x0AA8C07989d5B83Bab0f6FA7d7faF6b0B79B8151`, is unfunded.

`✓`: the refusal names the rule the probe breaks. Otherwise, what it named instead; the messages are below.

| Probe | Rule broken | geth (priced) | nethermind (priced) | reth (priced) | ethrex (priced) | geth (free) | nethermind (free) | reth (free) | ethrex (free) |
|---|---|---|---|---|---|---|---|---|---|
| `unfunded` | none but funds: APPROVE reverts, the payer cannot cover max_cost | ✓ | ✓ | prefix reverted | prefix reverted | fee | ✓ | prefix reverted | fee |
| `unfunded-sponsored` | as above, a default-code sponsor paying (only_verify, pay); pay budgets the sender's creation | ✓ | prefix reverted | prefix reverted | prefix reverted | fee | **accepted** | prefix reverted | fee |
| `new-account-no-state` | APPROVE halts: the new-account charge exceeds the frame's state budget | sender balance | prefix reverted | prefix reverted | prefix reverted | fee | prefix reverted | prefix reverted | fee |
| `cancel` | none but funds and existence: a one-frame nonce bump, max_gas about 19,400 | gas floor | ✓ | ✓ | ✓ | gas floor | ✓ | ✓ | fee |
| `keyed-envelope` | Payload Encoding: 7 fields (EIP-8250 adds nonce_keys) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `nonce-leading-zero` | RLP: integers are minimal | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `empty-list` | Payload Encoding | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `wrong-chain-id` | chain_id is this chain | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | fee |
| `nonce-2^64` | Constraints: nonce < 2**64 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `no-frames` | Constraints: 0 < len(frames) | gas floor | ✓ | ✓ | ✓ | gas floor | ✓ | ✓ | ✓ |
| `65-frames` | Constraints: len(frames) <= MAX_FRAMES | sender balance | decoder | ✓ | ✓ | fee | decoder | ✓ | ✓ |
| `mode-3` | Constraints: mode < 3 | sender balance | ✓ | decoder | ✓ | fee | ✓ | decoder | ✓ |
| `flags-8` | Constraints: flags < 8 | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `value-in-verify` | Constraints: only SENDER frames carry value | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `value-in-default` | Constraints: only SENDER frames carry value | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `approve-execution-elsewhere` | Constraints: APPROVE_EXECUTION only on tx.sender | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `atomic-last` | Constraints: an atomic flag needs a next frame | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `atomic-into-verify` | Constraints: batches contain no VERIFY frame | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `scope-in-batch` | Constraints: no approval scope in a batch | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `gas-over-cap` | Constraints: intrinsic + execution <= TX_MAX_GAS_LIMIT | sender balance | ✓ | ✓ | prefix reverted | ✓ | ✓ | ✓ | ✓ |
| `gas-over-2^64` | Constraints: total frame gas < 2**64 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `blob-fee-no-blobs` | Constraints: max_fee_per_blob_gas == 0 without blobs | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `blob-hash-version` | Constraints: versioned hash starts 0x01 | other | decoder | decoder | ✓ | other | decoder | decoder | ✓ |
| `scheme-3` | Constraints: scheme in {ARBITRARY, SECP256K1, P256} | sender balance | ✓ | decoder | ✓ | fee | ✓ | decoder | ✓ |
| `arbitrary-with-signer` | Constraints: ARBITRARY has no signer | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `msg-31-bytes` | Constraints: msg is empty or 32 bytes | sender balance | decoder | decoder | ✓ | fee | decoder | decoder | ✓ |
| `msg-zero` | Constraints: msg is not 32 zero bytes | sender balance | ✓ | decoder | ✓ | fee | ✓ | decoder | ✓ |
| `secp-high-s` | validate_signature: s <= n/2 | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `secp-v-27` | validate_signature: v is 0 or 1 | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `secp-r-zero` | validate_signature: 0 < r | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `secp-other-signer` | validate_signature: ecrecover == resolved signer (the entry the default code reads) | sender balance | ✓ | prefix reverted | ✓ | fee | ✓ | prefix reverted | ✓ |
| `unused-secp-wrong` | validate_signature on an entry no frame reads: ecrecover == signer | sender balance | ✓ | prefix reverted | ✓ | fee | ✓ | prefix reverted | ✓ |
| `unused-p256-wrong` | validate_signature on an entry no frame reads: P256VERIFY | sender balance | ✓ | prefix reverted | ✓ | fee | ✓ | prefix reverted | ✓ |
| `p256-signer-not-key` | validate_signature: P256 signer == keccak(qx || qy)[12:] | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `p256-high-s` | validate_signature: P256 s <= n/2 | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `expiry-flags` | Expiry Verifier Frame: flags == 0 | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `expiry-7-bytes` | Expiry Verifier Frame: len(data) == 8 | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `expiry-state-gas` | Expiry Verifier Frame: limits.state == 0 | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `two-expiry` | Expiry Verifier Frame: at most one | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `expiry-past` | Mempool: drop a passed deadline | sender balance | ✓ | prefix reverted | ✓ | fee | ✓ | prefix reverted | ✓ |
| `expiry-second` | Mempool: expiry_verify only as the first frame | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `no-verify` | Behavior: SENDER needs sender_approved; Mempool: no recognised prefix | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `no-signature` | Default code: needs a SECP256K1 entry at index 0 | sender balance | prefix reverted | prefix reverted | prefix reverted | fee | prefix reverted | prefix reverted | fee |
| `pay-before-verify` | Mempool: no recognised prefix (APPROVE_PAYMENT before execution) | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `verify-after-prefix` | Mempool rule 8: no VERIFY after the prefix | sender balance | ✓ | ✓ | prefix shape | fee | ✓ | ✓ | prefix shape |
| `two-default-first` | Mempool rule 2: at most one deploy, first | sender balance | prefix shape | ✓ | ✓ | fee | prefix shape | ✓ | ✓ |
| `verify-gas-150k` | Mempool rule 6: prefix execution <= MAX_VERIFY_GAS (100,000) | sender balance | sender balance | ✓ | ✓ | fee | sender balance | ✓ | ✓ |
| `verify-gas-600k` | Mempool rule 6, against a 500,000 cap | sender balance | ✓ | ✓ | ✓ | fee | ✓ | ✓ | ✓ |
| `verify-state-600k` | Mempool rule 6: prefix state <= MAX_VERIFY_STATE_GAS (500,000) | sender balance | ✓ | ✓ | prefix reverted | fee | ✓ | ✓ | fee |

### Verbatim, priced

#### `unfunded` (priced)

none but funds: APPROVE reverts, the payer cannot cover max_cost. `keccak256(raw)` = `0x4f8120272435a90e82ed6d62d2ed7c92182fed6903899f8b22526d172c575d57`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220378003085292, overshot 220378003085292
- nethermind: insufficient funds for gas * price + value, Account balance: 0, pending cost: 0, transaction cost: 220378003085292
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Frame transaction validation-prefix simulation failed: validation prefix frame reverted

#### `unfunded-sponsored` (priced)

as above, a default-code sponsor paying (only_verify, pay); pay budgets the sender's creation. `keccak256(raw)` = `0xb379fa1ef6e840db6571bec4cc8b927f82918cda1f64f9a0ad3eba6932951d6e`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 235001003290014, overshot 235001003290014
- nethermind: frame transaction validation-prefix simulation failed, validation prefix frame reverted
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Frame transaction validation-prefix simulation failed: validation prefix frame reverted

#### `new-account-no-state` (priced)

APPROVE halts: the new-account charge exceeds the frame's state budget. `keccak256(raw)` = `0x453baa50e0f767964b924f4ff105d687e8999b147e7d1c3c292407e2cd7e6cc0`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 36766000514724, overshot 36766000514724
- nethermind: frame transaction validation-prefix simulation failed, validation prefix frame reverted
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Frame transaction validation-prefix simulation failed: validation prefix frame reverted

#### `cancel` (priced)

none but funds and existence: a one-frame nonce bump, max_gas about 19,400. `keccak256(raw)` = `0x523edbf55ffeb139efbd99f6e944508b2ad26d5f41f1264ad0a9e58b965bbb99`.

- geth: insufficient gas for floor data gas cost: gas 19435, minimum needed 24000
- nethermind: frame transaction validation-prefix simulation failed, validation prefix frame reverted
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Frame transaction validation-prefix simulation failed: validation prefix frame reverted

#### `keyed-envelope` (priced)

Payload Encoding: 7 fields (EIP-8250 adds nonce_keys). `keccak256(raw)` = `0x683f89c09ff6138cdeed47ac9fdfca8da2bc25ed71062d0624c9c2c01f2b97d9`.

- geth: invalid frame tx format: rlp: expected input string or byte for uint64, decoding into (types.FrameTx).Nonce
- nethermind: transaction invalid, keyed nonces are not enabled
- reth: failed to decode signed transaction
- ethrex: Invalid params: Error decoding field 'nonce' of type u64: UnexpectedList

#### `nonce-leading-zero` (priced)

RLP: integers are minimal. `keccak256(raw)` = `0x6e4f4c89ecefad6278d8317689c528861502ff14fa80dca9827676b459531752`.

- geth: invalid frame tx format: rlp: non-canonical integer (leading zero bytes) for uint64, decoding into (types.FrameTx).Nonce
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Error decoding field 'nonce' of type u64: MalformedData

#### `empty-list` (priced)

Payload Encoding. `keccak256(raw)` = `0x02830a8965a92dcb078ee3c6a5d5c0076078631d5af88e34863d15e7c577080c`.

- geth: invalid frame tx format: rlp: too few elements for types.FrameTx
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Error decoding field 'chain_id' of type u64: InvalidLength

#### `wrong-chain-id` (priced)

chain_id is this chain. `keccak256(raw)` = `0x688137698c9f023b32dfde00a0c15b4a6f58ca24de87ceaf3bfd6e96d9fb488d`.

- geth: invalid sender: invalid chain id for signer: have 8141 want 7034189865
- nethermind: transaction invalid, InvalidTxChainId: Expected 7034189865, got 8141.
- reth: invalid chain ID
- ethrex: Invalid params: Transaction chain id mismatch, expected chain id: 7034189865

#### `nonce-2^64` (priced)

Constraints: nonce < 2**64. `keccak256(raw)` = `0x1c69c8eca6612dff38ac5d0a6de4946819f27ae89085077eeda45258f0f9f539`.

- geth: invalid frame tx format: rlp: input string too long for uint64, decoding into (types.FrameTx).Nonce
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Nonce is max

#### `no-frames` (priced)

Constraints: 0 < len(frames). `keccak256(raw)` = `0xaac9e197b0e904fff43b1921e953478eb98f5f8034d229b1f6098822d956d04f`.

- geth: insufficient gas for floor data gas cost: gas 18960, minimum needed 24000
- nethermind: transaction invalid, frame transaction must contain between 1 and 64 frames
- reth: invalid EIP-8141 transaction: EIP-8141 transaction must contain between 1 and 64 frames
- ethrex: Invalid params: Invalid frame transaction: Frame count must be between 1 and 64

#### `65-frames` (priced)

Constraints: len(frames) <= MAX_FRAMES. `keccak256(raw)` = `0x1ddf445974be11e1ad89951c5737b02f3ae0a8d78797769a345da23268869b8b`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 246715003454010, overshot 246715003454010
- nethermind: Invalid RLP.
- reth: invalid EIP-8141 transaction: EIP-8141 transaction must contain between 1 and 64 frames
- ethrex: Invalid params: Invalid frame transaction: Frame count must be between 1 and 64

#### `mode-3` (priced)

Constraints: mode < 3. `keccak256(raw)` = `0x61941d29f1180fc60544d50c1363509ba7240b1d4f078a1bd02cd45a844eae05`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220366003085124, overshot 220366003085124
- nethermind: transaction invalid, POST_TX frames are not enabled
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Frame 1: reserved execution mode 3

#### `flags-8` (priced)

Constraints: flags < 8. `keccak256(raw)` = `0x2f70d1d177a2bd0a073a432cd07e7e5332bbeb0a02a0ba2cd916dcb665d02b87`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220390003085460, overshot 220390003085460
- nethermind: transaction invalid, frame flags must not use reserved bits
- reth: invalid EIP-8141 transaction: reserved EIP-8141 frame flag is set
- ethrex: Invalid params: Invalid frame transaction: Frame 1: reserved flag bits must be zero (flags=0x08)

#### `value-in-verify` (priced)

Constraints: only SENDER frames carry value. `keccak256(raw)` = `0xa2c7b72d10be4149c8a9db0da71e5f4f415c29e0e61e231fbfbeb5a8e933495d`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220390003085460, overshot 220390003085460
- nethermind: transaction invalid, frame value is only allowed in SENDER mode
- reth: invalid EIP-8141 transaction: frame value is only valid in sender mode
- ethrex: Invalid params: Invalid frame transaction: Frame 0: non-zero value only allowed in SENDER mode (mode=1, value=1)

#### `value-in-default` (priced)

Constraints: only SENDER frames carry value. `keccak256(raw)` = `0x03bc0bf5484727bc3e9cedd2ca797a4c24ceeb7370c1b9c6583e6929c0293038`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 226390003169460, overshot 226390003169460
- nethermind: transaction invalid, frame value is only allowed in SENDER mode
- reth: invalid EIP-8141 transaction: frame value is only valid in sender mode
- ethrex: Invalid params: Invalid frame transaction: Frame 1: non-zero value only allowed in SENDER mode (mode=0, value=1)

#### `approve-execution-elsewhere` (priced)

Constraints: APPROVE_EXECUTION only on tx.sender. `keccak256(raw)` = `0xf2e2340e7b459f86f67810d245f3a0296d4df7f12882f4e359b6fe7e9db393e3`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 36766000514724, overshot 36766000514724
- nethermind: transaction invalid, frames allowed to approve execution must target the sender
- reth: invalid EIP-8141 transaction: execution approval target must resolve to the transaction sender
- ethrex: Invalid params: Invalid frame transaction: Frame 0: APPROVE_EXECUTION requires an empty target or tx.sender

#### `atomic-last` (priced)

Constraints: an atomic flag needs a next frame. `keccak256(raw)` = `0xad4284b63c10767ddc9bda164bc07d30c8803cd8bcb552bcc64a0665f17af068`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220378003085292, overshot 220378003085292
- nethermind: transaction invalid, the last frame must not have the atomic batch flag set
- reth: invalid EIP-8141 transaction: invalid atomic EIP-8141 frame
- ethrex: Invalid params: Invalid frame transaction: Frame 1: atomic batch flag on last frame

#### `atomic-into-verify` (priced)

Constraints: batches contain no VERIFY frame. `keccak256(raw)` = `0x005e257342f3af87c875973b3c9c31c241c95f3f39b771e66d599e7765e33781`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 414453005802342, overshot 414453005802342
- nethermind: transaction invalid, an atomic batch frame must not be followed by a VERIFY frame
- reth: invalid EIP-8141 transaction: invalid atomic EIP-8141 frame
- ethrex: Invalid params: Invalid frame transaction: Frame 1: atomic batch flag followed by a VERIFY frame

#### `scope-in-batch` (priced)

Constraints: no approval scope in a batch. `keccak256(raw)` = `0x69306ab4a1c8cb3308a5f53e0e1ddaf5a70bf08b3a20e954e89b056bee303e08`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 230841003231774, overshot 230841003231774
- nethermind: transaction invalid, frames belonging to an atomic batch must not carry approval scope
- reth: invalid EIP-8141 transaction: atomic batch frames must not approve payment or execution
- ethrex: Invalid params: Invalid frame transaction: Frame 2: approval scope on an atomic-batch frame (flags=0x01)

#### `gas-over-cap` (priced)

Constraints: intrinsic + execution <= TX_MAX_GAS_LIMIT. `keccak256(raw)` = `0x862c9f763daf051275da963604230ed7e925ab289ace25fbf48f65d4c5f1af2b`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 16987582237826148, overshot 16987582237826148
- nethermind: transaction invalid, frame intrinsic and execution gas (16803982) exceeds the transaction gas cap of 16777216
- reth: invalid EIP-8141 transaction: EIP-8141 transaction exceeds the EIP-7825 execution gas cap
- ethrex: Invalid params: Frame transaction validation-prefix simulation failed: validation prefix frame reverted

#### `gas-over-2^64` (priced)

Constraints: total frame gas < 2**64. `keccak256(raw)` = `0x2861ec897234514b86844b62455ff29cf4a862da38e2cabfa39c048752295e10`.

- geth: invalid frame tx format: rlp: input string too long for uint64, decoding into (types.FrameTx).Frames[1].GasLimits.State
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Error decoding field 'frames' of type alloc::vec::Vec<ethrex_common::types::transaction::Frame>: Error decoding field 'limits' of type (u64, u64): InvalidLength

#### `blob-fee-no-blobs` (priced)

Constraints: max_fee_per_blob_gas == 0 without blobs. `keccak256(raw)` = `0xf3036e6d739e7833be818b5e37ff7c23b8954096b7bef81d805e8a57d27d018e`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220378003085292, overshot 220378003085292
- nethermind: transaction invalid, max fee per blob gas must be 0 when there are no blob hashes
- reth: invalid EIP-8141 transaction: blob fee is non-zero without blob hashes
- ethrex: Invalid params: Invalid frame transaction: max_fee_per_blob_gas must be zero when the transaction carries no blobs

#### `blob-hash-version` (priced)

Constraints: versioned hash starts 0x01. `keccak256(raw)` = `0xc5fb7ccbf10e42c4661df2b65f6189216d6e632336834ba9d35776564125ce88`.

- geth: transaction type not supported: frame transaction with 1 blob hashes
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Blob versioned hash 0: wrong version byte

#### `scheme-3` (priced)

Constraints: scheme in {ARBITRARY, SECP256K1, P256}. `keccak256(raw)` = `0xbd6eecc43b5b734363d0a6301fc148ac9d657884e29521a602121b79f87bc563`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220494003086916, overshot 220494003086916
- nethermind: transaction invalid, unknown signature scheme
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Signature 1: unsupported scheme 3

#### `arbitrary-with-signer` (priced)

Constraints: ARBITRARY has no signer. `keccak256(raw)` = `0xcf3f7e77be0b551ab50b7804d3ffe6b5d7f7af1b6a4d46c976a653e9139ac7df`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220814003091396, overshot 220814003091396
- nethermind: transaction invalid, ARBITRARY signatures must not name a signer
- reth: invalid EIP-8141 transaction: arbitrary signatures must not contain signer metadata
- ethrex: Invalid params: Invalid frame transaction: Signature 1: ARBITRARY signatures must not name a signer

#### `msg-31-bytes` (priced)

Constraints: msg is empty or 32 bytes. `keccak256(raw)` = `0x7ca688091d0aa60b0343dcf9d357c09f316b6d0ebc4de09b768b634965707ebb`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 224662003145268, overshot 224662003145268
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Signature 1: msg must be empty or 32 bytes, got 31

#### `msg-zero` (priced)

Constraints: msg is not 32 zero bytes. `keccak256(raw)` = `0x6a0ad14657cd26dfd186e21c313a9091c917d0a8c234b0b2e4ddec012b7151ed`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 224654003145156, overshot 224654003145156
- nethermind: transaction invalid, explicit signature msg must not be the zero digest
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Signature 1: explicit msg must not be zero digest

#### `secp-high-s` (priced)

validate_signature: s <= n/2. `keccak256(raw)` = `0xb71e3d2a00a0817f0afefabb938f214ae7c80400d2abdf34fc7afaacab6c8b9f`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220390003085460, overshot 220390003085460
- nethermind: transaction invalid, frame transaction signature must use a 0/1 recovery id and a canonical low s value
- reth: invalid EIP-8141 transaction: frame signature is not canonical
- ethrex: Invalid params: Invalid frame transaction signature

#### `secp-v-27` (priced)

validate_signature: v is 0 or 1. `keccak256(raw)` = `0x405ba51632562970717248f176d07609964ef7bb80ce375545c027545ba64ac4`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220390003085460, overshot 220390003085460
- nethermind: transaction invalid, frame transaction signature must use a 0/1 recovery id and a canonical low s value
- reth: invalid EIP-8141 transaction: frame signature is not canonical
- ethrex: Invalid params: Invalid frame transaction signature

#### `secp-r-zero` (priced)

validate_signature: 0 < r. `keccak256(raw)` = `0xcf1873f7bc7a19ae1b8c459c97da944e7716c0dbe5b955b1bb4541b23f6bfe46`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220006003080084, overshot 220006003080084
- nethermind: transaction invalid, frame transaction signature must use a 0/1 recovery id and a canonical low s value
- reth: invalid EIP-8141 transaction: frame signature is not canonical
- ethrex: Invalid params: Invalid frame transaction signature

#### `secp-other-signer` (priced)

validate_signature: ecrecover == resolved signer (the entry the default code reads). `keccak256(raw)` = `0x049aa71191c4e7102ad095d7d14f56a3ff554ae17b04e2092068b484772ae86f`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 220366003085124, overshot 220366003085124
- nethermind: transaction invalid, frame transaction SECP256K1 signer does not match the recovered address
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Invalid frame transaction signature

#### `unused-secp-wrong` (priced)

validate_signature on an entry no frame reads: ecrecover == signer. `keccak256(raw)` = `0x5c6ad8d42500dd6de7f336d10270be9ec30e410040e2c0499cc7cc0dbb9da314`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 224550003143700, overshot 224550003143700
- nethermind: transaction invalid, frame transaction SECP256K1 signer does not match the recovered address
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Invalid frame transaction signature

#### `unused-p256-wrong` (priced)

validate_signature on an entry no frame reads: P256VERIFY. `keccak256(raw)` = `0x0160889c4e42869fcf071c2bd984eb26a23906e07b8bf5cabf462e6bc48fda50`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 229446003212244, overshot 229446003212244
- nethermind: transaction invalid, frame transaction has an invalid signature
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Invalid frame transaction signature

#### `p256-signer-not-key` (priced)

validate_signature: P256 signer == keccak(qx || qy)[12:]. `keccak256(raw)` = `0xdb7a0bd347f65ee48b460534bd0d8b4537b8834610726f5d8b1bcb454157afdc`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 229434003212076, overshot 229434003212076
- nethermind: transaction invalid, frame transaction P256 signer does not match the public key
- reth: invalid EIP-8141 transaction: P-256 public key does not match the resolved signer
- ethrex: Invalid params: Invalid frame transaction signature

#### `p256-high-s` (priced)

validate_signature: P256 s <= n/2. `keccak256(raw)` = `0xd41b59374941284e2c9ba68b5054d2c124d845399bc4bfbd593d3e167df7577a`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 229422003211908, overshot 229422003211908
- nethermind: transaction invalid, frame transaction P256 signature must be canonical with a low s value
- reth: invalid EIP-8141 transaction: frame signature is not canonical
- ethrex: Invalid params: Invalid frame transaction signature

#### `expiry-flags` (priced)

Expiry Verifier Frame: flags == 0. `keccak256(raw)` = `0xedf290073ff1bee75befa5302e84dc59408556e7748f4a780fbe1c936f58f7b4`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 225945003163230, overshot 225945003163230
- nethermind: transaction invalid, expiry verifier frame must have zero flags, zero value, and 8-byte data
- reth: invalid EIP-8141 transaction: invalid expiry verifier frame
- ethrex: Invalid params: Invalid frame transaction: Frame 0: expiry verifier frame must have flags == 0

#### `expiry-7-bytes` (priced)

Expiry Verifier Frame: len(data) == 8. `keccak256(raw)` = `0x41f2c9061c4e22fd18792be33ff47855e7b5d2a4dec9d578b598a90efb0463a8`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 225917003162838, overshot 225917003162838
- nethermind: transaction invalid, expiry verifier frame must have zero flags, zero value, and 8-byte data
- reth: invalid EIP-8141 transaction: invalid expiry verifier frame
- ethrex: Invalid params: Invalid frame transaction: Frame 0: expiry verifier frame data must be 8 bytes

#### `expiry-state-gas` (priced)

Expiry Verifier Frame: limits.state == 0. `keccak256(raw)` = `0x29727d329ea8f3ecc4fd3a5eabc81a5d5cc51ed66014d372dc4980498b96ee40`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 225922003162908, overshot 225922003162908
- nethermind: transaction invalid, expiry verifier frame must have zero flags, zero value, and 8-byte data
- reth: invalid EIP-8141 transaction: invalid expiry verifier frame
- ethrex: Invalid params: Invalid frame transaction: Frame 0: expiry verifier frame must have state_gas_limit == 0 (got 1)

#### `two-expiry` (priced)

Expiry Verifier Frame: at most one. `keccak256(raw)` = `0xa0f81518638866dbfe2fe0da055bbe1ad3601ecea0ec76bfc80c112bfe9dfd75`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 231488003240832, overshot 231488003240832
- nethermind: transaction invalid, at most one expiry verifier frame is allowed
- reth: invalid EIP-8141 transaction: EIP-8141 transaction may contain at most one expiry verifier
- ethrex: Invalid params: Invalid frame transaction: Frame 1: more than one expiry verifier frame

#### `expiry-past` (priced)

Mempool: drop a passed deadline. `keccak256(raw)` = `0xe8f933265214ecbc6fc7f6f74ab8478ebbcf7cf4e67eb98e1dcfa44521e9c3ee`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 225921003162894, overshot 225921003162894
- nethermind: frame transaction expired
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Frame transaction expiry deadline has passed

#### `expiry-second` (priced)

Mempool: expiry_verify only as the first frame. `keccak256(raw)` = `0x009e593153c63b0e8bf7e0c7bff21fde254cc4dde07f752eef0afbd4b757df31`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 225933003163062, overshot 225933003163062
- nethermind: frame transaction has an expiry verifier frame that does not lead its frame list
- reth: EIP-8141 public mempool policy: verify frame after validation prefix
- ethrex: Invalid params: Frame transaction prefix structure is invalid: frame 1: expiry verifier frame must be the first frame

#### `no-verify` (priced)

Behavior: SENDER needs sender_approved; Mempool: no recognised prefix. `keccak256(raw)` = `0x3def6ff8200b3b6c116147da8c30d9e140903e443653648fd5123c239f41a5d6`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 26279000367906, overshot 26279000367906
- nethermind: frame transaction validation-prefix simulation failed, frame transaction validation prefix never set a payer
- reth: EIP-8141 public mempool policy: unrecognized validation prefix
- ethrex: Invalid params: Frame transaction validation prefix does not match any recognized shape

#### `no-signature` (priced)

Default code: needs a SECP256K1 entry at index 0. `keccak256(raw)` = `0x5a0716d5180da5117084eab736f3d3287870fefb160c9e0234d2de2aa4fc41b6`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 216550003031700, overshot 216550003031700
- nethermind: frame transaction validation-prefix simulation failed, validation prefix frame reverted
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Frame transaction validation-prefix simulation failed: validation prefix frame reverted

#### `pay-before-verify` (priced)

Mempool: no recognised prefix (APPROVE_PAYMENT before execution). `keccak256(raw)` = `0xd325ac59f9ba02393cb04af1008a01d9f3d74fe8c4292cd2944e216d0042dd83`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 51081000715134, overshot 51081000715134
- nethermind: frame transaction has a VERIFY frame after its validation prefix
- reth: EIP-8141 public mempool policy: unrecognized validation prefix
- ethrex: Invalid params: Frame transaction validation prefix does not match any recognized shape

#### `verify-after-prefix` (priced)

Mempool rule 8: no VERIFY after the prefix. `keccak256(raw)` = `0x9386f53a2ad31a157d6f2c46326e39034edd6b69e11e99aa761baee675a8a57b`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 225857003161998, overshot 225857003161998
- nethermind: frame transaction has a VERIFY frame after its validation prefix
- reth: EIP-8141 public mempool policy: verify frame after validation prefix
- ethrex: Invalid params: Frame transaction prefix structure is invalid: frame 2: VERIFY frame follows the validation prefix

#### `two-default-first` (priced)

Mempool rule 2: at most one deploy, first. `keccak256(raw)` = `0x6df6fa5b3743e5afbe3d13a1d3e0e445f541ef310271e6d170524bb104d59da9`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 241328003378592, overshot 241328003378592
- nethermind: frame transaction validation-prefix simulation failed, frame transaction validation prefix never set a payer
- reth: EIP-8141 public mempool policy: unrecognized validation prefix
- ethrex: Invalid params: Frame transaction validation prefix does not match any recognized shape

#### `verify-gas-150k` (priced)

Mempool rule 6: prefix execution <= MAX_VERIFY_GAS (100,000). `keccak256(raw)` = `0xcf9f8327eef442df476cccb012e50ce89320fed00e893b1578eceec0af1b6893`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 360390005045460, overshot 360390005045460
- nethermind: insufficient funds for gas * price + value, Account balance: 0, pending cost: 0, transaction cost: 360390005045460
- reth: EIP-8141 public mempool policy: verification gas budget exceeded
- ethrex: Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS

#### `verify-gas-600k` (priced)

Mempool rule 6, against a 500,000 cap. `keccak256(raw)` = `0x8c307ec79b5c832cebda3d7710eee07dff59da46c466cb7ba82e55bcb8b6a6eb`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 810378011345292, overshot 810378011345292
- nethermind: frame transaction validation prefix exceeds MAX_VERIFY_GAS
- reth: EIP-8141 public mempool policy: verification gas budget exceeded
- ethrex: Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS

#### `verify-state-600k` (priced)

Mempool rule 6: prefix state <= MAX_VERIFY_STATE_GAS (500,000). `keccak256(raw)` = `0xdd5b090ab10fd3523c60bd466a1ac78bacefe73983098bd1066b2eca79ebe2cf`.

- geth: insufficient funds for gas * price + value: balance 0, tx cost 636790008915060, overshot 636790008915060
- nethermind: frame transaction validation prefix exceeds MAX_VERIFY_STATE_GAS
- reth: EIP-8141 public mempool policy: state gas budget exceeded
- ethrex: Invalid params: Frame transaction validation-prefix simulation failed: validation prefix frame reverted


### Verbatim, free

#### `unfunded` (free)

none but funds: APPROVE reverts, the payer cannot cover max_cost. `keccak256(raw)` = `0xcf84d5d0dec8332b83879adf8bfdb9b8245ab2129ff67c1bfab575014d7fb69f`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: insufficient funds for gas * price + value, Account balance: 0, pending cost: 0, transaction cost: 0
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Tip cap 0 wei below the configured minimum of 1 wei

#### `unfunded-sponsored` (free)

as above, a default-code sponsor paying (only_verify, pay); pay budgets the sender's creation. `keccak256(raw)` = `0xb3ac5132d562e39da7ef56efe39c9511b4bbc506dbb576a02d7112e782141010`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: accepted 0xb3ac5132d562e39da7ef56efe39c9511b4bbc506dbb576a02d7112e782141010
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Tip cap 0 wei below the configured minimum of 1 wei

#### `new-account-no-state` (free)

APPROVE halts: the new-account charge exceeds the frame's state budget. `keccak256(raw)` = `0xd8d8f5b4ec225a4c2fef6c320216d822a61b5a0f2f238084d1dc1e5c699b501f`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction validation-prefix simulation failed, validation prefix frame reverted
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Tip cap 0 wei below the configured minimum of 1 wei

#### `cancel` (free)

none but funds and existence: a one-frame nonce bump, max_gas about 19,400. `keccak256(raw)` = `0x389b11794ecee6f6dcae961b7129545487f614f3d6e3da4be969b2be86c7f3a0`.

- geth: insufficient gas for floor data gas cost: gas 19435, minimum needed 24000
- nethermind: frame transaction validation-prefix simulation failed, validation prefix frame reverted
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Tip cap 0 wei below the configured minimum of 1 wei

#### `keyed-envelope` (free)

Payload Encoding: 7 fields (EIP-8250 adds nonce_keys). `keccak256(raw)` = `0x454efa8499564eb85499fe899f8b49d6a4a1d202c0e21d89df2dcb5f3cc6b414`.

- geth: invalid frame tx format: rlp: expected input string or byte for uint64, decoding into (types.FrameTx).Nonce
- nethermind: transaction invalid, keyed nonces are not enabled
- reth: failed to decode signed transaction
- ethrex: Invalid params: Error decoding field 'nonce' of type u64: UnexpectedList

#### `nonce-leading-zero` (free)

RLP: integers are minimal. `keccak256(raw)` = `0x9c18272cc4222ec687489261f1c142aa3157eae22765fe8c7ab66af2410e0ef4`.

- geth: invalid frame tx format: rlp: non-canonical integer (leading zero bytes) for uint64, decoding into (types.FrameTx).Nonce
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Error decoding field 'nonce' of type u64: MalformedData

#### `empty-list` (free)

Payload Encoding. `keccak256(raw)` = `0x02830a8965a92dcb078ee3c6a5d5c0076078631d5af88e34863d15e7c577080c`.

- geth: invalid frame tx format: rlp: too few elements for types.FrameTx
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Error decoding field 'chain_id' of type u64: InvalidLength

#### `wrong-chain-id` (free)

chain_id is this chain. `keccak256(raw)` = `0x7321b6cfd77068c5a8a9291782341f1e3835025de1034daad156dc5f05061e5b`.

- geth: invalid sender: invalid chain id for signer: have 8141 want 7034189865
- nethermind: transaction invalid, InvalidTxChainId: Expected 7034189865, got 8141.
- reth: invalid chain ID
- ethrex: Invalid params: Tip cap 0 wei below the configured minimum of 1 wei

#### `nonce-2^64` (free)

Constraints: nonce < 2**64. `keccak256(raw)` = `0xcf63b030cd26fb83e12d50d49ef4c1420bc671c358731635046f5d0c554b742e`.

- geth: invalid frame tx format: rlp: input string too long for uint64, decoding into (types.FrameTx).Nonce
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Nonce is max

#### `no-frames` (free)

Constraints: 0 < len(frames). `keccak256(raw)` = `0x31a74d55f4ccdc8e395451932120eb022ec0f8c3fb81ead68d35434c9a35dcd3`.

- geth: insufficient gas for floor data gas cost: gas 18960, minimum needed 24000
- nethermind: transaction invalid, frame transaction must contain between 1 and 64 frames
- reth: invalid EIP-8141 transaction: EIP-8141 transaction must contain between 1 and 64 frames
- ethrex: Invalid params: Invalid frame transaction: Frame count must be between 1 and 64

#### `65-frames` (free)

Constraints: len(frames) <= MAX_FRAMES. `keccak256(raw)` = `0x2c17855ba2d29a6e20d3cc51f864e6aa8cf26a46c89c8088a0a5507c11ecdbb1`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: Invalid RLP.
- reth: invalid EIP-8141 transaction: EIP-8141 transaction must contain between 1 and 64 frames
- ethrex: Invalid params: Invalid frame transaction: Frame count must be between 1 and 64

#### `mode-3` (free)

Constraints: mode < 3. `keccak256(raw)` = `0xc11129d295fc14eb466c0662639c4f2a949a648011344c202d98b5fee9eb2118`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, POST_TX frames are not enabled
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Frame 1: reserved execution mode 3

#### `flags-8` (free)

Constraints: flags < 8. `keccak256(raw)` = `0xa572eddfb2fc2d3cd19019dd019dc32828f0b5702c12237873343cc42106bbc3`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame flags must not use reserved bits
- reth: invalid EIP-8141 transaction: reserved EIP-8141 frame flag is set
- ethrex: Invalid params: Invalid frame transaction: Frame 1: reserved flag bits must be zero (flags=0x08)

#### `value-in-verify` (free)

Constraints: only SENDER frames carry value. `keccak256(raw)` = `0xb7661372e9155a609f8cd4164007d92e41ed2ab243aefa1107527098d7b35d4a`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame value is only allowed in SENDER mode
- reth: invalid EIP-8141 transaction: frame value is only valid in sender mode
- ethrex: Invalid params: Invalid frame transaction: Frame 0: non-zero value only allowed in SENDER mode (mode=1, value=1)

#### `value-in-default` (free)

Constraints: only SENDER frames carry value. `keccak256(raw)` = `0xbc14f5b75c885064c289eeafd099a1ba39cb9875ac747b69479e78f3cd355b26`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame value is only allowed in SENDER mode
- reth: invalid EIP-8141 transaction: frame value is only valid in sender mode
- ethrex: Invalid params: Invalid frame transaction: Frame 1: non-zero value only allowed in SENDER mode (mode=0, value=1)

#### `approve-execution-elsewhere` (free)

Constraints: APPROVE_EXECUTION only on tx.sender. `keccak256(raw)` = `0xe49fc1a6af934cced48dc6258c2debe2b4553e4ada2898082c60e034ad8a1370`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frames allowed to approve execution must target the sender
- reth: invalid EIP-8141 transaction: execution approval target must resolve to the transaction sender
- ethrex: Invalid params: Invalid frame transaction: Frame 0: APPROVE_EXECUTION requires an empty target or tx.sender

#### `atomic-last` (free)

Constraints: an atomic flag needs a next frame. `keccak256(raw)` = `0x3c97c36a43c2ea31676e616fae4112b16de077724e5abf39c2d434facbc9cdda`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, the last frame must not have the atomic batch flag set
- reth: invalid EIP-8141 transaction: invalid atomic EIP-8141 frame
- ethrex: Invalid params: Invalid frame transaction: Frame 1: atomic batch flag on last frame

#### `atomic-into-verify` (free)

Constraints: batches contain no VERIFY frame. `keccak256(raw)` = `0x9958c20634b93d28f57049bd31f6aa985ed25eb1ecda308e1fffd6e31f295470`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, an atomic batch frame must not be followed by a VERIFY frame
- reth: invalid EIP-8141 transaction: invalid atomic EIP-8141 frame
- ethrex: Invalid params: Invalid frame transaction: Frame 1: atomic batch flag followed by a VERIFY frame

#### `scope-in-batch` (free)

Constraints: no approval scope in a batch. `keccak256(raw)` = `0x60df14cd4ef4d2a6e73809b6bf36254f627fdb10e4cd3e6a9b9633acf1063f56`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frames belonging to an atomic batch must not carry approval scope
- reth: invalid EIP-8141 transaction: atomic batch frames must not approve payment or execution
- ethrex: Invalid params: Invalid frame transaction: Frame 2: approval scope on an atomic-batch frame (flags=0x01)

#### `gas-over-cap` (free)

Constraints: intrinsic + execution <= TX_MAX_GAS_LIMIT. `keccak256(raw)` = `0xcdb55d5d230d316c2ab73801b5e75985641ed55482818878f761c2d5b2194455`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame intrinsic and execution gas (16803994) exceeds the transaction gas cap of 16777216
- reth: invalid EIP-8141 transaction: EIP-8141 transaction exceeds the EIP-7825 execution gas cap
- ethrex: Invalid params: Tip cap 0 wei below the configured minimum of 1 wei

#### `gas-over-2^64` (free)

Constraints: total frame gas < 2**64. `keccak256(raw)` = `0xff0bcb35e788ceb8b5c89fd5a16f2402afcdb7abae6bbc2832e2197a13ae8a21`.

- geth: invalid frame tx format: rlp: input string too long for uint64, decoding into (types.FrameTx).Frames[1].GasLimits.State
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Error decoding field 'frames' of type alloc::vec::Vec<ethrex_common::types::transaction::Frame>: Error decoding field 'limits' of type (u64, u64): InvalidLength

#### `blob-fee-no-blobs` (free)

Constraints: max_fee_per_blob_gas == 0 without blobs. `keccak256(raw)` = `0x59f41f772fb5f1634415032c1174b19ec24c1d5af395fa9f828f320ebb5355d9`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, max fee per blob gas must be 0 when there are no blob hashes
- reth: invalid EIP-8141 transaction: blob fee is non-zero without blob hashes
- ethrex: Invalid params: Invalid frame transaction: max_fee_per_blob_gas must be zero when the transaction carries no blobs

#### `blob-hash-version` (free)

Constraints: versioned hash starts 0x01. `keccak256(raw)` = `0x57c51109fe2dbaf40aa817304dba75f6b3c0cefbae6cb950713cf14996d7a65c`.

- geth: transaction type not supported: frame transaction with 1 blob hashes
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Blob versioned hash 0: wrong version byte

#### `scheme-3` (free)

Constraints: scheme in {ARBITRARY, SECP256K1, P256}. `keccak256(raw)` = `0xe64869804c6757313a1f3a0d8eade47ee4e58f22099d45927893a818717cbce4`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, unknown signature scheme
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Signature 1: unsupported scheme 3

#### `arbitrary-with-signer` (free)

Constraints: ARBITRARY has no signer. `keccak256(raw)` = `0x27d2c446458a82eb303cf6ffbc2255109506423e542a1f2a630a21caad131359`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, ARBITRARY signatures must not name a signer
- reth: invalid EIP-8141 transaction: arbitrary signatures must not contain signer metadata
- ethrex: Invalid params: Invalid frame transaction: Signature 1: ARBITRARY signatures must not name a signer

#### `msg-31-bytes` (free)

Constraints: msg is empty or 32 bytes. `keccak256(raw)` = `0x9d24b5b4c208b238261af97d8bf6ef2b3505a1ec50f5bae954b3af001cbdd08a`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: Invalid RLP.
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Signature 1: msg must be empty or 32 bytes, got 31

#### `msg-zero` (free)

Constraints: msg is not 32 zero bytes. `keccak256(raw)` = `0x2ef3f3bf9a5ac1e7e69287e6264184aeb79f00ee22c3473984bf594eb1291348`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, explicit signature msg must not be the zero digest
- reth: failed to decode signed transaction
- ethrex: Invalid params: Invalid frame transaction: Signature 1: explicit msg must not be zero digest

#### `secp-high-s` (free)

validate_signature: s <= n/2. `keccak256(raw)` = `0x8e54731f2531df90c99f5a332b1f3d39f993b6523acb14a781d85c1d260e04df`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame transaction signature must use a 0/1 recovery id and a canonical low s value
- reth: invalid EIP-8141 transaction: frame signature is not canonical
- ethrex: Invalid params: Invalid frame transaction signature

#### `secp-v-27` (free)

validate_signature: v is 0 or 1. `keccak256(raw)` = `0xb59fd540f459ffe647365d7df7a3abd86f920dd159fe4d23e9900562f4d6c4a1`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame transaction signature must use a 0/1 recovery id and a canonical low s value
- reth: invalid EIP-8141 transaction: frame signature is not canonical
- ethrex: Invalid params: Invalid frame transaction signature

#### `secp-r-zero` (free)

validate_signature: 0 < r. `keccak256(raw)` = `0xf7176c00dc5d171a2cd1a67a6707b644b77ed872776cf565f956ac44e898da4c`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame transaction signature must use a 0/1 recovery id and a canonical low s value
- reth: invalid EIP-8141 transaction: frame signature is not canonical
- ethrex: Invalid params: Invalid frame transaction signature

#### `secp-other-signer` (free)

validate_signature: ecrecover == resolved signer (the entry the default code reads). `keccak256(raw)` = `0x6402d88b999ac23ba578410f3e5fe2aa8a43f337995352f8ac8efef692531fac`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame transaction SECP256K1 signer does not match the recovered address
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Invalid frame transaction signature

#### `unused-secp-wrong` (free)

validate_signature on an entry no frame reads: ecrecover == signer. `keccak256(raw)` = `0x34058d0a38b02ab52bb79fe9d4b7de7d232faeb3a0f61b0fccd1c408b4bffc7e`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame transaction SECP256K1 signer does not match the recovered address
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Invalid frame transaction signature

#### `unused-p256-wrong` (free)

validate_signature on an entry no frame reads: P256VERIFY. `keccak256(raw)` = `0xd3fdab7e7a9bdf8ad4aafc3961818aedca8b8ea7e6a0da53ad83796e0e5feb18`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame transaction has an invalid signature
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Invalid frame transaction signature

#### `p256-signer-not-key` (free)

validate_signature: P256 signer == keccak(qx || qy)[12:]. `keccak256(raw)` = `0xf3bc87c291b9944fb504cc34edb19d0998d54c5cb5c2d8631efda52f26df8b39`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame transaction P256 signer does not match the public key
- reth: invalid EIP-8141 transaction: P-256 public key does not match the resolved signer
- ethrex: Invalid params: Invalid frame transaction signature

#### `p256-high-s` (free)

validate_signature: P256 s <= n/2. `keccak256(raw)` = `0xec90779ba625e2a4037db36d01adde07240c57ea37a8560f7948d2887d323dda`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, frame transaction P256 signature must be canonical with a low s value
- reth: invalid EIP-8141 transaction: frame signature is not canonical
- ethrex: Invalid params: Invalid frame transaction signature

#### `expiry-flags` (free)

Expiry Verifier Frame: flags == 0. `keccak256(raw)` = `0x874209d42b75528596340f154bcd62e1de8f7639b57ea71fa9c8bdd074699029`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, expiry verifier frame must have zero flags, zero value, and 8-byte data
- reth: invalid EIP-8141 transaction: invalid expiry verifier frame
- ethrex: Invalid params: Invalid frame transaction: Frame 0: expiry verifier frame must have flags == 0

#### `expiry-7-bytes` (free)

Expiry Verifier Frame: len(data) == 8. `keccak256(raw)` = `0xb0edf69b1e9c52fcc3a82ec23967a97668b0c39c6a0457a333870160dffb282b`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, expiry verifier frame must have zero flags, zero value, and 8-byte data
- reth: invalid EIP-8141 transaction: invalid expiry verifier frame
- ethrex: Invalid params: Invalid frame transaction: Frame 0: expiry verifier frame data must be 8 bytes

#### `expiry-state-gas` (free)

Expiry Verifier Frame: limits.state == 0. `keccak256(raw)` = `0xae439359274aa74278700bafd46646cc2cb6ef2ebbe82a1d69a06927203e89f8`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, expiry verifier frame must have zero flags, zero value, and 8-byte data
- reth: invalid EIP-8141 transaction: invalid expiry verifier frame
- ethrex: Invalid params: Invalid frame transaction: Frame 0: expiry verifier frame must have state_gas_limit == 0 (got 1)

#### `two-expiry` (free)

Expiry Verifier Frame: at most one. `keccak256(raw)` = `0x2e5c991a963d8bec89b2729f33f4a15b72dec858f7ba977fe5ec2d73372b81f1`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: transaction invalid, at most one expiry verifier frame is allowed
- reth: invalid EIP-8141 transaction: EIP-8141 transaction may contain at most one expiry verifier
- ethrex: Invalid params: Invalid frame transaction: Frame 1: more than one expiry verifier frame

#### `expiry-past` (free)

Mempool: drop a passed deadline. `keccak256(raw)` = `0x2980af7305f3a841f3cab6ee470624a2e91d470a7a63f5e34c968f690f530f2e`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction expired
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Frame transaction expiry deadline has passed

#### `expiry-second` (free)

Mempool: expiry_verify only as the first frame. `keccak256(raw)` = `0x84213018ea74d3d7c02248413e29d5b7fa5f7f91d45317dcd3e27101e0dabb0a`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction has an expiry verifier frame that does not lead its frame list
- reth: EIP-8141 public mempool policy: verify frame after validation prefix
- ethrex: Invalid params: Frame transaction prefix structure is invalid: frame 1: expiry verifier frame must be the first frame

#### `no-verify` (free)

Behavior: SENDER needs sender_approved; Mempool: no recognised prefix. `keccak256(raw)` = `0x5d890e1bd7f2ac6da4e85542aaa0e5afc7798630edc34b8cfe48b89a86c5a4f1`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction validation-prefix simulation failed, frame transaction validation prefix never set a payer
- reth: EIP-8141 public mempool policy: unrecognized validation prefix
- ethrex: Invalid params: Frame transaction validation prefix does not match any recognized shape

#### `no-signature` (free)

Default code: needs a SECP256K1 entry at index 0. `keccak256(raw)` = `0xbdbfc62606ee6fd9dbbe1c13e48801741f38f3d06cdb43ee1c07151123eabaf6`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction validation-prefix simulation failed, validation prefix frame reverted
- reth: EIP-8141 public mempool policy: validation prefix execution failed
- ethrex: Invalid params: Tip cap 0 wei below the configured minimum of 1 wei

#### `pay-before-verify` (free)

Mempool: no recognised prefix (APPROVE_PAYMENT before execution). `keccak256(raw)` = `0xb6c8ab01fbdc9bcc3674b91b43cf6e2bf52a4cc1939795463c07a36ecb19d85c`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction has a VERIFY frame after its validation prefix
- reth: EIP-8141 public mempool policy: unrecognized validation prefix
- ethrex: Invalid params: Frame transaction validation prefix does not match any recognized shape

#### `verify-after-prefix` (free)

Mempool rule 8: no VERIFY after the prefix. `keccak256(raw)` = `0x417d490ddbe7ca39cac440a4c0a8512b354e20d389e1ef039647a9e79c604f7d`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction has a VERIFY frame after its validation prefix
- reth: EIP-8141 public mempool policy: verify frame after validation prefix
- ethrex: Invalid params: Frame transaction prefix structure is invalid: frame 2: VERIFY frame follows the validation prefix

#### `two-default-first` (free)

Mempool rule 2: at most one deploy, first. `keccak256(raw)` = `0x3f38e1647235550989bbbae6b11a91bd3acdd1027818d7757de3c18522fe7877`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction validation-prefix simulation failed, frame transaction validation prefix never set a payer
- reth: EIP-8141 public mempool policy: unrecognized validation prefix
- ethrex: Invalid params: Frame transaction validation prefix does not match any recognized shape

#### `verify-gas-150k` (free)

Mempool rule 6: prefix execution <= MAX_VERIFY_GAS (100,000). `keccak256(raw)` = `0xd48b9b9e6101ee3f6c256ca39571cbd16f8a1567a57f33336360469845435387`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: insufficient funds for gas * price + value, Account balance: 0, pending cost: 0, transaction cost: 0
- reth: EIP-8141 public mempool policy: verification gas budget exceeded
- ethrex: Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS

#### `verify-gas-600k` (free)

Mempool rule 6, against a 500,000 cap. `keccak256(raw)` = `0xa18f8c4821ea1e3061c54ebc1f82d6216ee24f02cae054325822c9cd9d90dc35`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction validation prefix exceeds MAX_VERIFY_GAS
- reth: EIP-8141 public mempool policy: verification gas budget exceeded
- ethrex: Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS

#### `verify-state-600k` (free)

Mempool rule 6: prefix state <= MAX_VERIFY_STATE_GAS (500,000). `keccak256(raw)` = `0xfc19d047b9c73ffccc1b739aa165194a029339579d1c77947ec9b60389dc94b9`.

- geth: transaction gas price below minimum: gas tip cap 0, minimum needed 1
- nethermind: frame transaction validation prefix exceeds MAX_VERIFY_STATE_GAS
- reth: EIP-8141 public mempool policy: state gas budget exceeded
- ethrex: Invalid params: Tip cap 0 wei below the configured minimum of 1 wei

