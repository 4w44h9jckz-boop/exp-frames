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

### ethpandaops frames-devnet-0

| | |
|---|---|
| Chain ID | `7034189865` |
| RPC | `https://rpc.frames-devnet-0.ethpandaops.io`, an eRPC balancer over geth, Nethermind, reth and ethrex |
| Explorer | https://dora.frames-devnet-0.ethpandaops.io |
| Faucet | https://faucet.frames-devnet-0.ethpandaops.io (proof of work and a captcha, so a person claims) |

EIP-8141 at the same pin, without EIP-8250 or EIP-8272, so the envelope is EIP-8141's own:
`0x06 || rlp([chain_id, nonce, sender, frames, signatures, fees, blob_versioned_hashes])`. The library
picks it from the chain id (`envelopeFor`); a `FrameTx` with `envelope: 'plain'` carries the nonce in
`nonceSeq`, and its nonce is not priced as calldata.

```bash
RPC_URL=https://rpc.frames-devnet-0.ethpandaops.io RPC_UPSTREAM=nethermind npx tsx scripts/inspect.ts <txhash>
```

`RPC_UPSTREAM` pins every request to one client and skips the balancer's cache (eRPC's
`X-ERPC-Use-Upstream` and `X-ERPC-Skip-Cache-Read`). Without it, each request goes to whichever
client the balancer picks, possibly from its cache. The balancer also merges identical requests
that are in flight together, whatever client each asked for, so a pinned client checks the
`x-erpc-upstream` response header and refuses (and viem retries) an answer from another client. The clients do not yet agree on the JSON of a
frame transaction or a frame receipt (execution-apis#860 and #907 are open); `frameTxFromJson`,
`frameReceiptGas` and `frameReceiptStatus` read all four.

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
| 07 | `exp/07-threshold-wallet` | [Threshold wallet](experiments/07-threshold-wallet/): a 2-of-3 FROST group key behind one account; one 52-byte Schnorr signature in an ARBITRARY entry, whichever two signed | `ARBITRARY`, `SIGDATACOPY` |
| 08 | `exp/08-multisig-ops` | [Operating a multisig](experiments/08-multisig-ops/): a counterfactual proxy with the owner set in VERIFY data (plan item 05b), parallel proposals on keyed nonces, fee bumps, cancellation, owner rotation | Keyed nonces, replacement, deploy frames |
| 09 | `exp/09-paymasters` | [Paymasters in the public mempool](experiments/09-paymasters/): the canonical paymaster, a copy of it, a code-less sponsor, and a k-of-n treasury paying for its members | Paymaster tiers, pending caps |
| 10 | `exp/10-expiry` | [The expiry verifier frame](experiments/10-expiry/): a deadline the mempool understands, before and after it passes | Expiry verifier, `TIMESTAMP` |
| 11 | `exp/11-passkey` | [Passkey accounts](experiments/11-passkey/): a raw P256 key through the protocol scheme, and a WebAuthn passkey verified in VERIFY with `P256VERIFY` | P256 scheme `0x2`, `SIGDATACOPY` |
| 12 | `exp/12-session-keys` | [Session keys](experiments/12-session-keys/): a second key bound to a target, a selector, a deadline and a budget, checked frame by frame | `FRAMEPARAM`, `FRAMEDATALOAD` |
| 13 | `exp/13-social-recovery` | [Social recovery](experiments/13-social-recovery/): 2-of-3 salted guardians, a delay the owner can cancel, and no way to say "not before" in VERIFY | `SIGPARAM`, validation rules |
| 14 | `exp/14-modular-account` | [Modular account](experiments/14-modular-account/): ERC-7579-style validator modules run by DELEGATECALL or STATICCALL, against the public-mempool trace rules | Validation trace rules |
| 15 | `exp/15-eip7702-sender` | [An EIP-7702-delegated EOA as the sender](experiments/15-eip7702-sender/): an EOA that adds a device P256 key, and the seams between the two EIPs | Delegated senders |
| 16 | `exp/16-subscriptions` | [Subscriptions](experiments/16-subscriptions/): the merchant pulls from the account and pays for it from its own EOA: no paymaster, deposit or bundler | Keyed nonces, payer separation |
| 17 | `exp/17-pq-account` | [A post-quantum account](experiments/17-pq-account/): 1,024 one-time WOTS keys under a Merkle root, the key chosen by the nonce | `ARBITRARY`, `SIGDATACOPY`, `MAX_VERIFY_GAS` |
| 18 | `exp/18-introspection` | [The introspection opcodes](experiments/18-introspection/): every `TXPARAM`, `FRAMEPARAM` and `SIGPARAM` word, from every mode, against a model; every case that must halt | Introspection opcodes |
| 19 | `exp/19-mempool-rules` | [The public mempool's rules](experiments/19-mempool-rules/): each validation-prefix rule probed alone, replacement, and receipts from blocks that were not kept | Public mempool |
| 20 | `exp/20-signature-service` | [Signatures as a service](experiments/20-signature-service/): a token, an order book and a vote counter that read the protocol's signature verdicts with `SIGPARAM`, against `ecrecover` and `P256VERIFY` | `SIGPARAM`, explicit `msg` |
| 21 | `exp/21-erc4337-side-by-side` | [ERC-4337 side by side](experiments/21-erc4337-side-by-side/): one transfer through EntryPoint v0.8 and through frames on one chain; deployment, first-use and bundler costs | Gas, settlement |
| 22 | `exp/22-cross-client` | [Four clients, one chain](experiments/22-cross-client/): frames-devnet-0 read back from geth, Nethermind, reth and ethrex; 49 admission probes sent to each; each client's validation-prefix caps bisected | Cross-client, public mempool |
