# exp-frames

Experiments with [EIP-8141 frame transactions](https://eips.ethereum.org/EIPS/eip-8141) on the
public ethrex **Hegotá testnet**.

## Network

| | |
|---|---|
| Chain ID | `8141` |
| RPC | `https://rpc1.privacy.ethrex.xyz` (also serves `ethrex_simulateFrameTransaction`) |
| Explorer | https://dora.privacy.ethrex.xyz (decodes type-`0x06` txs and per-frame receipts) |
| Faucet | https://faucet.privacy.ethrex.xyz (1 ETH per address per hour) |
| Client | ethrex, branch [`hegota-testnet`](https://github.com/lambdaclass/ethrex/tree/hegota-testnet) |

The chain runs pinned EIP drafts, not their latest text:
EIP-8141 at [`b75cbe6115`](https://github.com/ethereum/EIPs/blob/b75cbe6115/EIPS/eip-8141.md) and
EIP-8250 keyed nonces at [`f3079a09e8`](https://github.com/ethereum/EIPs/blob/f3079a09e8/EIPS/eip-8250.md)
(plus EIP-8272 and EIP-7805/8369). What that changes for us:

- The envelope has `nonce_keys, nonce_seq` where EIP-8141 has `nonce`:
  `0x06 || rlp([chain_id, nonce_keys, nonce_seq, sender, frames, signatures, fees, blob_versioned_hashes])`.
  `nonce_keys = [0]` is the ordinary account nonce.
- The expiry verifier lives at `0x…8141` (EIP master has since moved it to `0x81413f0c…FfFf`).
- The nodes run `--mempool.max-verify-gas=500000`, not the spec's 100,000.

## Setup

```bash
npm install
npm run account   # creates PRIVATE_KEY in .env (gitignored) and shows its balance
npm run faucet    # claims 1 ETH for it
npm test          # encoder/gas tests against ethrex's golden vector and mined txs
```

`npm run inspect -- <txhash>` decodes any mined frame transaction with its per-frame receipts.

## Library (`src/frametx`)

| Module | What it does |
|---|---|
| `constants.ts` | Modes, APPROVE scopes, flags, signature schemes, opcodes, gas constants, predeploy addresses |
| `types.ts` | `FrameTx`, `Frame`, `FrameSignature` |
| `encode.ts` | RLP encode/decode, tx hash, canonical signature hash (`TXPARAM(0x08)`) |
| `gas.ts` | Intrinsic gas, calldata floor, `max_gas`, `max_cost`, settled `gas_used` |
| `sign.ts` | Fills signature entries: secp256k1 (`yParity ‖ r ‖ s`, v is 0/1) and P256 (`r ‖ s ‖ qx ‖ qy`, signer = `keccak256(qx ‖ qy)[12:]`), both low-s |
| `frames.ts` | `verifyFrame` / `senderFrame` / `defaultFrame` / `expiryFrame` builders |
| `rpc.ts` | Nonce sequence, fees, `prepareFrameTx`, simulate, send, receipts, faucet |
| `format.ts` | Human-readable tx, simulation and receipt output |

Outside the library: `src/execute.ts` (sign → simulate → send → receipt, `--dry-run` aware),
`src/contracts.ts` (solc-js for Solidity, and Yul with `verbatim` for the new opcodes),
`src/deploy.ts` (CREATE2 deployment frames) and `contracts/TestToken.sol` (a mint-anyone ERC-20).

Solidity cannot emit `APPROVE`, `TXPARAM`, `FRAMEPARAM` and the rest, so contracts that use them are
written in Yul with `verbatim_<n>i_<m>o(hex"…", args…)`. The first argument ends up on top of the stack,
matching the EIP's stack tables. For example, `verbatim_3i_0o(hex"aa", offset, length, scope)` is `APPROVE`.

The tests pin the encoder to ethrex's golden vector and to transactions mined on the testnet: each one
must re-encode to its on-chain hash, its signatures must recover over our signature hash, and the gas
model must reproduce its receipt's `gasUsed`.

Thirteen of those transactions were built and signed in Rust, by
[kohaku-rs](https://github.com/4w44h9jckz-boop/kohaku-rs) (branch `experiment/frames`), whose
`kohaku-frame-kit` and `kohaku-frame-accounts` crates port this library and experiments 01 to 05.
Its tests do the same checks on the transactions mined from here, so each implementation checks the
other's output.

## Experiments

Each experiment lives on its own `exp/NN-name` branch and is merged here when done. Its folder has a
README with the frame layout, how to run it, mined tx hashes and observations. Planning lives on the
`plan` branch, which is never merged.

| # | Branch | Experiment | EIP-8141 section |
|---|---|---|---|
| 01 | `exp/01-simple-tx` | [Simple transaction](experiments/01-simple-tx/): ETH transfer, contract deploy and call, rule violations | Examples 1, 1a |
| 02 | `exp/02-account-deployment` | [Account deployment](experiments/02-account-deployment/): deploy a smart account at `tx.sender` and use it in the same tx | Example 1b |
| 03 | `exp/03-atomic-batch` | [Atomic approve + swap](experiments/03-atomic-batch/): all-or-nothing frame batches | Example 2 |
| 04 | `exp/04-sponsored-erc20` | [Sponsored transaction](experiments/04-sponsored-erc20/): a sponsor pays gas, the user pays it back in an ERC-20 | Example 3 |
| 05 | `exp/05-multisig` | [k-of-n multisig](experiments/05-multisig/): owners' secp256k1 and P256 (passkey) signatures validated by the protocol, counted by the account | Signatures, `SIGPARAM` |
| 06 | `exp/06-privacy-pool` | [Privacy pool as its own sender](experiments/06-privacy-pool/): Tornado withdrawals with `tx.sender` = the pool and no signature; storage vs keyed (EIP-8250 nullifier keys, EIP-8272 roots) | `FRAMEDATACOPY`, keyed nonces, recent roots |
