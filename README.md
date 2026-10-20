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
| Client | ethrex, branch [`hegota-testnet-hotfix`](https://github.com/lambdaclass/ethrex/tree/hegota-testnet-hotfix): `4738681` until 2026-10-07 13:10 UTC (experiments 01 to 21), `64b8fc09` since (23 onwards) |

The chain runs pinned EIP drafts, not their latest text:
EIP-8141 at [`b75cbe6115`](https://github.com/ethereum/EIPs/blob/b75cbe6115/EIPS/eip-8141.md) and
EIP-8250 keyed nonces at [`f3079a09e8`](https://github.com/ethereum/EIPs/blob/f3079a09e8/EIPS/eip-8250.md)
(plus EIP-8272 and EIP-7805/8369). What that changes for us:

- The envelope has `nonce_keys, nonce_seq` where EIP-8141 has `nonce`:
  `0x06 || rlp([chain_id, nonce_keys, nonce_seq, sender, frames, signatures, fees, blob_versioned_hashes])`.
  `nonce_keys = [0]` is the ordinary account nonce.
- The expiry verifier lives at `0x…8141` (EIP master has since moved it to `0x81413f0c…FfFf`).
- The nodes run `--mempool.max-verify-gas=500000`, not the spec's 100,000.
- An approval made inside a call that then reverts survives on these nodes. EIP-8141 undoes it
  since [`af80fc1`](https://github.com/ethereum/EIPs/commit/af80fc1c4122c4990b8c84bfd10be60c6e343bb2)
  (2026-10-08). ethrex fixed it first, on 2026-09-22 (lambdaclass/ethrex#7298), on its
  `hegota-testnet` branch, but the nodes run `hegota-testnet-hotfix`, which forked before it.

### ethpandaops frames-devnet-0

| | |
|---|---|
| Chain ID | `7034189865` |
| RPC | `https://rpc.bogota-devnet-0.ethpandaops.io`, an eRPC balancer over geth, Nethermind, reth and ethrex |
| Explorer | https://dora.bogota-devnet-0.ethpandaops.io |
| Faucet | https://faucet.bogota-devnet-0.ethpandaops.io (proof of work and a captcha, so a person claims) |

ethpandaops renamed the devnet's hostnames from `frames-devnet-0` to `bogota-devnet-0` on 2026-10-12
([`7c889ab`](https://github.com/ethpandaops/frames-devnets/commit/7c889abdc35b2a9413d6ecb59587a44a4857b279)).
The chain, its id and its nodes are the same, and the old hostnames answer 404. The text below
keeps the name the experiments used.

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
| 23 | `exp/23-approval-scope` | [What an approval has to commit to](experiments/23-approval-scope/): the Security Considerations' "constrain every subsequent SENDER frame" taken literally and sandwiched; a digest of every frame but the payer's, completed by two sponsors from one signature | Approval scope, sig hash, replacement |
| 24 | `exp/24-sealed-paymaster` | [A sealed paymaster](experiments/24-sealed-paymaster/): EIPs#12328's egress-decidable paymaster with its policy under an EIP-8272 root, measured; a paymaster its scan calls sealed, emptied by its owner; an amended scan | Paymasters, recent roots |
| 25 | `exp/25-inclusion-lists` | [Inclusion lists for frame transactions](experiments/25-inclusion-lists/): all 183 mined transactions classified under EIP-8369, EIP-8272 and a Profile 1 for directly evaluable prefixes; ethrex's Profile 2 budget fill run over the orders the consensus layer delivers, and against a committee member who lists what can never be valid | FOCIL, inclusion lists |
| 26 | `exp/26-validation-cpu` | [What a gas cap on the validation prefix bounds, in time](experiments/26-validation-cpu/): 29 prefixes (Groth16, a 40-key multisig, a passkey, a WOTS shape, one fill per precompile and per state read) timed in ethrex's own admission path; about 16 ns per gas at worst | Validation, `MAX_VERIFY_GAS` |
| 27 | `exp/27-execution-digest` | [A shared layout for the execution digest](experiments/27-execution-digest/): a draft ERC for the EIP-712 digest an execution-only approval signs, checked by four implementations, 19 cases inside ethrex and a wallet-signed replacement mined on the testnet | Approval scope, EIP-712, sponsorship |
| 28 | `exp/wallet-features` | [`wallet_sendCalls` over frames](experiments/28-wallet-send-calls/): an EIP-5792 wallet and an ERC-7677 paymaster service bound to frames, under viem's stock dapp actions; the same approve-and-swap batch on four rails | Default code, paymasters, receipts |
| 29 | `exp/wallet-features` | [Gas paid in tokens, with no server](experiments/29-token-gas/): a stateless sponsor repaid in ETH from a swap in the same atomic batch; every failure in the batch is the sponsor's loss, and the balance read that would refuse an empty wallet is `StorageReadNonSender` | Atomic batches, sponsorship, mempool rules |
| 30 | `exp/wallet-features` | [A privacy withdrawal with no relayer, priced](experiments/30-relayer-free-withdrawal/): 30 days of mainnet relayer fees (224.5 ETH for 3.35 ETH of gas), and a pool whose last frame refunds the fee's surplus, so the note pays 1.023 times its gas | Privacy pools, `TXPARAM`, post-ops |
| 31 | `claude/nifty-einstein-llp9cd` | [Recovery from the owner's own devices](experiments/31-device-recovery/): two devices hand the account to a new key after a delay the owner can cancel, under the EIP's rule (an early finish reverts) and ethrex's (refused at admission); the notes' keychain key comes back from the same two devices | Recovery, `TIMESTAMP`, keychains |
| 32 | `claude/nifty-einstein-llp9cd` | [One registry for the private owned state of many applications](experiments/32-owned-state/): two applications share one tree and one sender; the same secrets give each its own nullifier, a kernel proof in `VERIFY` (229k gas) self-updates a note with no signature, and a rule that reads its own storage is refused at admission | Owned state, keyed nonces, EIP-8272, Groth16 |
| 33 | `claude/nifty-einstein-llp9cd` | [Two wallets swap owned state](experiments/33-owned-state-swap/): an offer and an answer sealed to each other's keys on a board, then one frame transaction spends both notes into each other's hands; aborting at every step leaves both notes spendable by their owners, a deadline in every proof ends the counterparty's option, and a cheating settlement is refused | Owned state, swaps, encrypted announcements, expiry frames |
| 34 | `claude/nifty-einstein-llp9cd` | [Two withdrawals from one wallet, at once, through a mempool node](experiments/34-concurrent-withdrawals/): kohaku-rs's batch builder sends a keyed pair through skandha under `disjoint-keys`, both are admitted and mined in one block, and a second spend of one note is refused as an underpriced replacement; the two spends are linked by their arrival, block and shape | Keyed nonces, public mempool, skandha |
| 35 | `claude/nifty-einstein-llp9cd` | [How many could make the statement](experiments/35-disclosure-counts/): from mainnet data alone, the crowd behind a deposit before a date, an unspent note worth at least T and association-set membership, each checked by hand; joined facts shrink it to 3, and a balance over all accounts cannot be counted through an RPC | Disclosure, privacy pools |
| 36 | `claude/nifty-einstein-llp9cd` | [Blind tickets](experiments/36-blind-tickets/): two buyers prepay, four issuers with a DKG key sign blinded points, and six fresh senders spend with the unblinded tickets checked in a paymaster's `VERIFY` (122,006 gas); the issuers' answers match no spend, but the issuers must share one count, and the mempool lets the paymaster sponsor one pending spend at a time | Blind signatures, BLS12-381, EIP-2537, paymasters |
| 37 | `claude/nifty-einstein-llp9cd` | [A private read paid with a blind ticket](experiments/37-ticket-paid-read/): three testnet account reads through kohaku-pir-rpc's router, each by single-server PIR and one ticket from a committee like experiment 36's; the server checks the ticket first and logs no address, and at the testnet's 8,640-byte table the ticket check (1 ms) outweighs the answer (10 us or less) | Private reads, PIR, blind tickets |
| 38 | `claude/nifty-einstein-llp9cd` | [Clear signing for frame transactions](experiments/38-clear-signing/): a display format beside ERC-7730, rendered by kohaku-rs over 83 inputs; all 19 mined shapes (batches, a deploy frame, a session grant and its redemptions) review with nothing blind and without the account's code; five of the six things ERC-7730 lacks follow from EIP-8141 alone, and an account descriptor bound by code template covers what a signature over $E$ allows and the account's calls to itself | Signatures, frame modes, approval scopes |
