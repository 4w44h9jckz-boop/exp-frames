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
| `sign.ts` | secp256k1 signing (`yParity ‖ r ‖ s`, v is 0/1) of signature entries |
| `frames.ts` | `verifyFrame` / `senderFrame` / `defaultFrame` / `expiryFrame` builders |
| `rpc.ts` | Nonce sequence, fees, `prepareFrameTx`, simulate, send, receipts, faucet |
| `format.ts` | Human-readable tx, simulation and receipt output |

The tests pin the encoder to ethrex's golden vector and to transactions mined on the testnet: each one
must re-encode to its on-chain hash, its signatures must recover over our signature hash, and the gas
model must reproduce its receipt's `gasUsed`.

## Experiments

Each experiment lives on its own `exp/NN-name` branch and is merged here when done. Planning
lives on the `plan` branch, which is never merged.

| # | Experiment | EIP section |
|---|---|---|
| 01 | [Simple transaction](experiments/01-simple-tx/) — ETH transfer, contract deploy + call, rule violations | Examples 1, 1a |
