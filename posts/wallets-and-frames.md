# What Wallets Ship Today, and What Frame Transactions Would Give Them

## TLDR

We read the documentation of 45 wallets, wallet-infrastructure providers and wallet-facing standards on 2026-10-14. For each feature they ship, we asked how it is built today and what [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions would change about it, and tied it to what our 30 experiments measured:
1. **Nobody in the survey builds on frames yet.** No wallet mentions EIP-8141, and of the providers only one blog post by Biconomy does. Coinbase is building its own native account abstraction for Base instead (EIP-8130, and "Base Transactions" under EIP-8430). One standard targets frames directly: ERC-8286, a module interface for ERC-7579 accounts with a frame-validator type.
2. **Almost every advanced feature today is the same three parts:** an EIP-7702 delegate contract on the user's EOA, a relayer or bundler the wallet or its provider runs, and an off-chain policy service, more and more often inside a trusted execution environment (TEE). Frames move the first two into the protocol. The third can move on chain only where it fits the public mempool's rules.
3. **The biggest change is for EOA-first wallets.** Batching, sponsorship and gas paid in tokens all work for an EOA with no code under frames. MetaMask, Uniswap, Rainbow, OKX, Phantom and Trust each ship a 7702 delegate to get those three things.
4. **The hardest features to move rely on a server checking state the mempool may not read.** Gas paid in tokens, gas tanks, spending limits over a period and recovery delays all need a live signer, a clock, or storage outside the account.
5. **The dapp-facing APIs were written for ERC-4337.** EIP-5792's batch call is neutral, and needed no change. Its paymaster capability, ERC-7677, defines fields only for ERC-4337's EntryPoints, and ERC-7715 permissions require ERC-4337, so each needs a frames binding.

We then ran three of the eight experiments the survey suggests:
- **A dapp does not need to change** (experiment 28). A stock viem dapp calling `wallet_sendCalls` ran unchanged on a wallet that sends frame transactions: 90,321 gas for an approve and swap, against 92,143 through an EIP-7702 batch and 167,458 through ERC-4337. But the wallet had to sign twice to estimate gas, and ERC-7677's paymaster service needs two new fields.
- **Gas in tokens needs no server, at the sponsor's risk** (experiment 29). A sponsor repaid in ETH from a swap in the same atomic batch costs 91,276 gas and needs no signer. Every batch that fails is its loss, up to 4,147,393 gas in one transaction, because the read that would refuse an empty wallet is forbidden.
- **A privacy withdrawal needs no relayer** (experiment 30). Over 30 days of mainnet, notes paid relayers 224.5 ETH for 3.35 ETH of gas, and 15% of withdrawals were sent from an address that already held ETH, linking the user, to avoid the fee. A pool that pays its own gas and refunds the rest would have charged them 4.65 ETH.

> What frame transactions are, and seven findings about whether EIP-8141 is ready: [Is EIP-8141 Done?](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/posts/frame-transactions-in-practice.md)
> Twenty open problems, ranked by how hard each is to fix: [Frame Transaction Open Problems](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/posts/frame-transactions-open-problems.md)
> Every experiment, with its scripts, contracts and transaction hashes: [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames)

## Introduction

A transaction today is one secp256k1 signature over one call, paid by the account that signed. A frame transaction (EIP-8141, type `0x06`, scheduled for the Hegota upgrade) is a list of *frames*, each a call with its own mode. It allows:
- an account to authorize a transaction in its own code, in a read-only `VERIFY` frame that approves execution, payment or both;
- someone else to pay, by approving payment in a `VERIFY` frame of its own;
- several calls to run as the account, in `SENDER` frames, optionally as an atomic batch that succeeds or reverts together;
- anyone to broadcast it, since it carries its own authorization.

An account with no code gets *default code*: the protocol approves for it when the transaction carries a secp256k1 signature by its key over the whole transaction. So a plain EOA can batch and be sponsored without any contract. A *payer* is whoever approved payment, and a *sponsor* is a payer other than the sender.

That is why the three parts of today's wallet stack map onto frames so differently:

```
 TODAY                                         WITH FRAMES
 ------------------------------------------    -----------------------------------------------
 EOA --7702--> delegate contract               EOA with no code: default code approves
              (batch executor, keys, policy)     [0] VERIFY -> EOA      APPROVE(EXECUTION)
                    |                            [1] VERIFY -> sponsor  APPROVE(PAYMENT)
 user signs an intent                            [2] SENDER -> call 0   \ atomic batch
                    v                            [3] SENDER -> call 1   /
 relayer / bundler (wallet's server)           anyone broadcasts it: no relayer
   pays gas, submits, takes a fee              the sponsor's VERIFY is on chain
                    |
 policy service (often in a TEE)               a policy service only where VERIFY cannot
   prices tokens, checks balances,               read what it needs: another account's
   co-signs                                      storage, the clock, a price
```

The left column is three things a user has to trust or run. The right column keeps only the last, and the survey below is mostly about which features still need it.

Sources are the products' own documentation, help centres, repositories and blogs. A claim found only in third-party coverage is marked *second hand*. A page we could not reach is named in the appendix, and nothing was filled in from memory. "Not found" means not in the pages we read, which is not proof of absence. Where a feature cites "the post", it means [Is EIP-8141 Done?](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/posts/frame-transactions-in-practice.md), whose sections and smaller fixes are numbered.

## Feature by feature

Each row: which products ship the feature (examples, not a complete list), how they build it today, what frames give it, what our experiments measured, and what is still missing.

### Batching: several calls, one confirmation

- **Who:** MetaMask, Rainbow, Uniswap Wallet, OKX, Coinbase, Ambire, Safe, and every provider through EIP-5792's `wallet_sendCalls`.
- **Today:** an EIP-7702 delegate with a batch executor (MetaMask's Delegator; Uniswap's Calibur, which uses ERC-7821; Rainbow's own delegate), an ERC-4337 user operation (Coinbase), or Safe's MultiSend through `delegatecall`. Rabby has no batching; Brave has an open request for EIP-5792 since May 2025.
- **With frames:** consecutive `SENDER` frames, optionally flagged as an atomic batch that succeeds or reverts together. It works for an EOA with no code, through default code, with no delegation and no executor contract.
- **Measured:**
  - experiment 03 (approve and swap, mined); experiment 15 (a code-less EOA batches and is sponsored);
  - experiment 28: a stock viem dapp's `wallet_sendCalls` ran unchanged on a wallet that sends frame transactions. The steady-state approve and swap cost 90,321 gas, against 92,143 through a 7702 delegate's `executeBatch` and 167,458 through ERC-4337's EntryPoint v0.8, and the frames wallet needed no 58,052-gas delegation first. One frame transaction carries both of EIP-5792's modes: with `atomicRequired` the calls stand or fall together, and without it two of three calls persisted after the second failed, which a 7702 `executeBatch` cannot do.
- **Missing:**
  - a receipt status for frames rolled back with their batch. All four clients we probed report them `SUCCESS` while their logs and state are gone (post, smaller fixes row 10), so experiment 28's wallet had to remember which frames formed each batch to report its EIP-5792 status. ethrex's derived transaction `status` calls a partial success a failure;
  - an estimate without signing. The node simulates only a transaction whose validation approves, so the wallet signed twice per transaction, and it reports no state gas per frame, so every call got a fixed 379,440 of state budget (post, smaller fixes row 18);
  - a call without `to`, which EIP-5792 allows as a deployment, has no frame: a `SENDER` frame with no target calls the sender.

### Sponsored gas

- **Who:** MetaMask ("Paid by MetaMask" on Monad and SEI), Rainbow (free swaps, sends and unstakes through its relay), Phantom (gasless swaps), Coinbase (ERC-7677 paymaster service), Fluidkey (20 sponsored transactions a day on six L2s), and Privy, Dynamic, Turnkey, ZeroDev, Alchemy, Pimlico and thirdweb for apps.
- **Today:** a relayer the wallet runs submits the user's signed intent through a 7702 delegate (Privy, Dynamic, Turnkey, Phantom, Rainbow), or an ERC-4337 paymaster pays (Coinbase, Pimlico, ZeroDev, Alchemy). Alchemy also offers "bundler sponsored operations" with no on-chain paymaster.
- **With frames:** the sponsor adds its own `VERIFY` frame that approves payment. The sponsor can be an ordinary key-held account, the canonical paymaster contract, or any other paymaster. No relayer is needed: anyone can broadcast the transaction.
- **Measured:** experiments 04, 09, 24, 27 and 28. The canonical paymaster backed four users in one block (09). One owner signature was completed by two sponsors in turn, the second mined (23, 27). A paymaster service in ERC-7677's shape in front of the canonical paymaster sponsored a dapp's batch for 9,821 more gas than paying for itself, and the user's own wallet broadcast it (28).
- **Missing:**
  - payers are rationed in the public mempool. The canonical paymaster may back many pending transactions; any other paymaster one; a code-less sponsor is bounded only by its balance, which lets one transfer invalidate thousands of pending sponsorships (post, section 2). The canonical paymaster needs its signer online for each transaction;
  - ERC-7677 has no field for the pay frame's state budget or the payer's signature entries, and no error code for a policy refusal, so a dapp sees a generic `-32603`. Its stub signature is useless to a frames simulation, so the service is called three times instead of two (28).

### Gas paid in tokens

- **Who:** MetaMask ("gas included", in USDC, USDT, DAI and others on seven chains), Trust Wallet (FlexGas), Tangem (Smart Gas), Phantom, Coinbase, ZeroDev (USDC, 5% premium), Pimlico, Alchemy, Biconomy, thirdweb; Railgun broadcasters take their fee in the token being moved.
- **Today:** the user signs a 7702 authorization plus an EIP-712 fee quote, and the wallet's backend submits (Tangem, Trust, MetaMask; second hand for the mechanism in MetaMask's case). Or an ERC-4337 ERC-20 paymaster, with an off-chain service signing the price (Pimlico, ZeroDev, Alchemy).
- **With frames:** a sponsor pays the gas, and a `SENDER` frame in the same transaction pays the sponsor in tokens. Experiment 23's `PayThePayer` finds whichever sponsor's frame is present and pays it, so the user can sign before the sponsor is chosen.
- **With frames, and no server:** the sponsor is repaid in ETH, not tokens, out of a swap in the same atomic batch, and a last frame refunds the unused gas. Its `VERIFY` checks the layout with `FRAMEPARAM` (the swap and the repayment form one atomic batch, and the repayment covers the maximum cost), so it needs no signer, no oracle and no storage.
- **Measured:** experiments 04, 23, 27 and 29. The server-free sponsor paid for a user who held only tokens at 91,276 gas, or 274,876 on the user's first transaction, which creates the account (29).
- **Missing:** a sponsor's `VERIFY` may not read the user's token balance, because it is not the sender's storage. ERC-4337's mempool allows that read (ERC-7562's rule STO-021, storage associated with the sender), and the frame mempool refused it with `StorageReadNonSender` (29). So the sponsor either signs each transaction after an off-chain check, which is today's model under another name, or bears the risk. Experiment 29 priced the risk: every failed batch is the sponsor's loss and costs the user nothing.
  - a user who held no tokens: 57,595 gas; a swap that slipped: 53,999; a call built to burn its budget: 4,147,393, close to the sponsor's cap;
  - with no storage, the sponsor cannot remember who cost it money, and the cap of one pending transaction per non-canonical paymaster limits it to one user per block, honest or not.

  This is the clearest case where frames replace the relayer but not the server.

### Gas tanks and gas accounts

- **Who:** Rabby (GasAccount, a USD balance that pays gas on any supported chain), Ambire (Gas Tank, in USDC, with cashback), Avocado (a USDC gas tank), Fireblocks (Gas Station, Universal Gasless).
- **Today:** prepaid credit with the wallet's own relayer. Rabby's is not even a paymaster: it sends native gas to the user's EOA. None of these balances can be withdrawn.
- **With frames:** two designs. A key-held account the user controls can pay for the user's other accounts directly; the EIP names this "gas account" use case. Or a *sealed paymaster*, a contract from which ether can only leave as gas, holds the balance and sponsors by a published policy.
- **Measured:** experiment 24 built a sealed paymaster: three users with no ETH sponsored, seven malformed variants refused, 13,305 gas for the validation prefix.
- **Missing:** a code-less gas account has the fan-out problem above, and we propose capping it by count (post, suggestion 3). A sealed paymaster is a one-way tank, like Rabby's and Ambire's, and its policy cannot be withdrawn for about 27 hours (post, section 3).

### Passkeys

- **Who:** Coinbase (WebAuthn owners), Safe (one ERC-1271 proxy per passkey), Uniswap's Calibur and OKX's delegate (P256 and WebAuthn keys with expiry), MetaMask's Hybrid DeleGator, Sequence, Privy (P-256 authorization keys), Clave (raw P256 in the Secure Enclave, on zkSync), Daimo (shut down).
- **Today:** a P256 or WebAuthn verifier in the account's contract, using the P256 precompile where the chain has one.
- **With frames:** the protocol itself checks a raw P256 signature (a Secure Enclave or Android Keystore key) before any code runs. A browser passkey (WebAuthn) signs a wrapped message instead, so it is checked in the account's own `VERIFY`.
- **Measured:** experiment 11: WebAuthn `VERIFY` 15,542 gas; raw P256 checked by the protocol.
- **Missing:** default code accepts secp256k1 only, so a P256 key's own address cannot send until code is deployed there. A WebAuthn passkey cannot use the protocol's check at all.

### Session keys, permissions and AI agents

- **Who:** MetaMask (Advanced Permissions under ERC-7715 and ERC-7710; Agent Wallet with a rolling 24-hour outflow cap), Coinbase (sub-accounts, ERC-7895), ZeroDev, Rhinestone (Smart Sessions), Alchemy (Modular Account v2 spend limits), thirdweb, Sequence, Safe (the Allowance module, also for agents), OKX (Trader Mode), Trust and Zerion (agent kits), Privy, Dynamic and Turnkey (policy engines).
- **Today:** two camps. On-chain modules check a session key's calls and limits (ZeroDev, Rhinestone, Alchemy, thirdweb, MetaMask's caveat enforcers, Safe). Or an off-chain policy engine in a TEE decides what the key may sign (Privy, Turnkey, Dynamic, OKX Trader Mode, MetaMask's server agent wallet, Zerion's CLI).
- **With frames:** `VERIFY` reads every frame directly: target, value, data and position. A session policy checks the actual calls, with no `execute(...)` encoding to decode, and must refuse anything it did not ask for.
- **Measured:** experiment 12: a session key with a target, a selector, a deadline and an ETH budget, +21,600 gas per transaction over the owner's own.
- **Missing:**
  - `VERIFY` may not read the clock, so a session's deadline comes from an expiry frame, and deadline-bearing transactions are evicted first (post, section 3);
  - `VERIFY` cannot know what a transaction will cost, so the budget counts the maximum cost, and a session spent it about 3.5 times faster than its real fees;
  - the policy counts ETH, not token amounts or periods; a rolling 24-hour cap needs state the policy writes in a frame that cannot fail;
  - with one pending transaction per sender, the owner cannot revoke while a session transaction is pending, except by replacing it;
  - ERC-7715 requires ERC-4337, so it has no frames binding.

### Recurring payments and subscriptions

- **Who:** Coinbase (spend permissions: an app pulls up to an amount per period), MetaMask (periodic and stream permissions), Porto (planned; deprecated).
- **Today:** a permission-manager contract added as an owner of the account, with an EIP-712 grant (Coinbase), or an ERC-7710 delegation (MetaMask).
- **With frames:** the merchant sends the transaction and pays its gas; the subscriber's account approves execution only, for one pinned nonce key.
- **Measured:** experiment 16: the merchant pays to pull, accrual rather than reset, the nonce key as part of the authorization.
- **Missing:** keyed nonces are EIP-8250, which is only Considered for Hegota; ethrex has two nonce-key domains per sender.

### Recovery

- **Who:** Safe (Zodiac Delay Modifier, 28 days by default), Sequence (30-day timed recovery with email alerts), Argent (guardians, 5-day security period), Ambire (timelocked and email recovery in its contract, not yet shipped), Soul Wallet (guardians stored as a hash until used), Clave.
- **Today:** guardian logic in the account or a module, with a delay the owner can cancel.
- **With frames:** a guardian `VERIFY` path, guardians kept private until they act.
- **Measured:** experiment 13: +2,100 gas per transaction for a rotatable owner.
- **Missing:** `VERIFY` can bound time from above, never from below. A delay ("not before day 28") cannot be enforced in validation; the open PR-12252 would add a not-before time to the expiry frame. A lost key is recovered; a stolen one is not, because the current owner's cancel beats any recovery.

### Multisig and threshold keys

- **Who:** Safe (n-of-m, nested Safes), Avocado, MetaMask's Multisig DeleGator; Zengo, Dynamic and Fireblocks use MPC off chain, which looks like one key on chain.
- **With frames:** the protocol checks each signer's entry before execution; the account counts them. A FROST threshold key looks like one Schnorr key.
- **Measured:** experiments 05, 07 and 08: 26,794 gas per transfer at any threshold with FROST; a counterfactual proxy's `VERIFY` 4,262 gas.
- **Missing:** one pending transaction per sender, and a validation that reads the sender's storage gave up parallel nonces on ethrex.

### Upgrading an EOA in place

- **Who:** MetaMask (on by default for new users), Uniswap (Calibur, on by default), Rainbow, OKX, Phantom, Trust, Ambire; Safe says its existing contracts cannot be used with EIP-7702.
- **With frames:** most of what these delegates are for, batching and sponsorship and token gas, needs no delegation (experiment 15). Delegation is still how an EOA gets a second key, a session policy or recovery.
- **Missing:** a frame transaction cannot carry a 7702 authorization, so setting one costs a separate transaction (70,048 gas) and clearing it another (31,816); the open PR-12421 adds a frame for it. Storage outlives delegation: a key registered under one delegate came back when the EOA re-delegated (experiment 15). And the state a delegate reads conflicts with where inclusion lists can look (post, section 5).

### Simulation, clear signing and hardware wallets

- **Who:** Rabby, Zerion, Safe, Trust, Phantom (Blowfish), Brave (Blowfish), and Blockaid inside MetaMask, Coinbase Wallet, Zerion and others; Ledger (ERC-7730 clear signing, "Transaction Check"), Trezor (7702 experimental since 2.12.4), GridPlus, Keystone, Tangem (no screen; signs through the phone).
- **Today:** simulation services read type-2, EIP-712, ERC-4337 and now 7702 transactions. Hardware wallets sign EIP-1559, EIP-712 and, increasingly, 7702 authorizations. ERC-7730 descriptors cover ERC-4337 user operations.
- **With frames:** the execution digest $E$ of our draft ERC (experiment 27) is EIP-712 typed data, so a wallet or hardware device that can show typed data can authorize a sponsored frame transaction today. A per-frame receipt tells a wallet which call failed.
- **Missing:** no hardware wallet or simulation service mentions type `0x06`. A device asked to sign the canonical signature hash would be signing blind. ERC-7730 has no descriptor format for frames. The RPC is not settled: 21 of the 39 transaction fields four clients serve are not served by all four, and their error messages cannot tell "fund this account" from "sign entry 0" (experiment 22).

### MEV protection

- **Who:** MetaMask (Smart Transactions, on by default), Rainbow (Flashbots), Uniswap (private pools on mainnet).
- **With frames:** a transaction signed over the canonical hash, or over $E$, cannot be edited by whoever relays it.
- **Measured:** experiment 23: an account that signs only its `SENDER` frames, as the EIP's own wording allows, was sandwiched inside its own transaction, mined.
- **Missing:** the EIP's wording (post, section 1, and our proposed comment).

### Limit orders, deadlines and intents

- **Who:** UniswapX (limit orders up to a year; fillers pay gas), OKX Trader Mode (a TEE key signs only what matches the user's order), Trust's agent kit (limit orders with expiry), ZeroDev, Rhinestone, Sequence and Biconomy (cross-chain intents and orchestration).
- **With frames:** the expiry frame gives a deadline for 3,051 gas (experiment 10); a sponsor can be the filler.
- **Missing:** no not-before; deadlines evicted first; a deadline inside the current slot is dropped without an error (experiments 10 and 19).

### Cross-chain: one signature, many chains

- **Who:** Avocado (EIP-712 signed with a fixed chain id 634, the real chain carried in a salt), Porto (a nonce prefix that drops the chain id; deprecated), Coinbase (owner changes replayable on every chain), Ambire and the Ethereum Interop Layer (planned; no public specification found), ZeroDev and Rhinestone (intents over Across, Relay and LayerZero).
- **With frames:** nothing yet. Frames are one chain at a time, and $E$ includes the chain id.
- **Missing:** an experiment. We have two chains with frames (the Hegota testnet and the ethpandaops devnet), so a chain-agnostic digest for owner rotation can be tested, along with its replay risks.

### Privacy: withdrawals, stealth addresses, private relays

- **Who:** Railgun and Railway (broadcasters over Waku; fee about 10% of gas, in the token moved; a 7702 flow with a fresh EOA per operation), Privacy Pools (relayers paid from the withdrawn amount, a signed fee quote valid 20 seconds), Umbra (a relayer paid in the withdrawn tokens), Fluidkey (a 1-of-1 Safe per stealth address), Kohaku, the Ethereum Foundation's privacy wallet (an ERC-4337 privacy paymaster for Tornado Cash and Railgun on Sepolia; a reference extension forked from Ambire).
- **Today:** every one of them needs a third party to submit the withdrawal, because a fresh address has no ETH to pay gas, and that third party sees the user's network address and must be paid.
- **With frames:** the pool is its own sender and pays its own gas from the withdrawn funds. No relayer, no broadcaster, no fee quote.
- **Measured:**
  - experiment 06: Tornado Cash's circuit, `VERIFY` 244,808 to 248,991 gas, three withdrawals from one sender in one block in the design with keyed nonces;
  - experiment 30, on 30 days of mainnet: notes in Tornado Cash's four ETH pools and Privacy Pools' ETH pool paid 33 relayers 224.5 ETH for 3.35 ETH of gas. Tornado's relayers charge gas plus 41 to 175 bps of the note, so a 100 ETH note's median fee was 1,053 times its gas; Privacy Pools' relayer charged 1.4 times gas. 15% of withdrawals, 49% in the 10 ETH pool, were sent from an address that already held ETH, which is the link relayers exist to prevent;
  - experiment 30, on the testnet: a pool that pays its own gas has to take a fee that covers the maximum cost, 2.56 times the gas at ordinary headroom. A last frame that refunds the difference brought it to 1.023 times, for 11,820 gas. Priced that way, the same 30 days of withdrawals would have cost 4.65 ETH.
- **Missing:** without EIP-8250 a pool has one pending withdrawal network-wide, about 300 spends an hour; a Groth16 proof is above the public mempool's 100,000 gas; and inclusion lists, as scheduled, do not cover frame transactions, and where they are built, whether a withdrawal is admitted depends on the order its lists arrive in (post, sections 4 and 7). Frames remove the payment, not the network path: a withdrawal still reaches a node from some IP address, which Railgun's broadcasters over Waku hide today, and frames do not.

### Post-quantum accounts

- **Who:** Kohaku's hybrid account (ECDSA or P256 plus ML-DSA or Falcon, as ERC-4337, 1.69M to 8.39M gas by its own README).
- **With frames:** a hash-based (WOTS) account at 73,481 gas per transfer (experiment 17).
- **Missing:** the signature is checked in the EVM and cannot be aggregated; lattice schemes exceed the public mempool's 100,000 gas; an existing EOA can leave ECDSA only if EIP-8151 and EIP-8298 ship together (post, section 6).

### Login, MPC and TEE custody

- **Who:** MetaMask (social login), Phantom (Google or Apple login), Privy and Turnkey (keys in AWS Nitro enclaves), Dynamic and Zengo (two-party MPC), thirdweb, Sequence, Fireblocks.
- **With frames:** nothing changes. The key is still one secp256k1 key, so default code works as it is. These products can adopt frames without touching custody.

## What a wallet would need that does not exist yet

1. **A frames binding for the dapp APIs, except the one that needs none.** EIP-5792 needed no change: `atomic` maps to an atomic batch, and a non-atomic batch is independent frames of one transaction (experiment 28). ERC-7677 needs two fields, the pay frame's state budget and the payer's signature entries, an error code for a policy refusal, and an agreed JSON for an unsigned frame transaction. ERC-7715 permissions would need to map onto a session `VERIFY` policy. ERC-8286 does this for ERC-7579 modules only.
2. **A settled RPC.** One meaning for `gas`, one set of fields, and an error vocabulary a wallet can act on (experiment 22). And a simulation that accepts placeholder signatures and reports state gas per frame, so a wallet can price a transaction before the user signs it (experiment 28; the post's smaller fixes, row 18).
3. **A receipt that describes itself:** a status for frames rolled back with their batch, so an indexer can report a batch without knowing how it was built (experiment 28; row 10).
4. **Hardware support for type `0x06`**, or the convention that devices sign the EIP-712 digest $E$, which they can already display.
5. **A way to pay a sponsor in tokens without a live signer** that does not leave the sponsor paying for every failure. Experiment 29 shows the layout works; what it lacks is the one storage read that would refuse an empty wallet.
6. **A clock in validation**, bounded so that it cannot be abused, for session deadlines, recovery delays and not-before times.

## Experiments this suggests

Ranked by how many products ship the feature, and by whether our testnet can show the answer.

| # | Experiment | Why | Who ships the feature |
|---|---|---|---|
| W1, done: experiment 28 | **`wallet_sendCalls` over frames.** Turn an EIP-5792 request, with `atomic` and a paymaster capability, into one frame transaction through viem; compare gas and the number of signatures with the 7702 and ERC-4337 paths | the API every wallet and provider already serves; shows dapps need no change | MetaMask, Coinbase, Privy, Dynamic, thirdweb, Alchemy |
| W2 | **A gas account.** One user-controlled account pays for the user's other accounts, Rabby- and Ambire-style; measure how many pending sponsorships each client admits, and the fan-out of one transfer | the EIP's own use case, and the rule we propose to change | Rabby, Ambire, Avocado, Fireblocks |
| W3, done: experiment 29 | **Token gas without a server.** A sponsor reimbursed from a swap's output in the same atomic batch, and what it costs the sponsor when the swap fails | the most common feature, and the clearest gap | MetaMask, Trust, Tangem, Phantom, ZeroDev, Pimlico |
| W4 | **ERC-7715 permissions as a frames policy.** A periodic ERC-20 allowance and a Coinbase-style spend permission on experiment 12's and 16's accounts; where the mempool's rules on storage and time stop them | permissions are how dapps and agents ask wallets for standing access | MetaMask, Coinbase, ZeroDev, Rhinestone, Alchemy |
| W5 | **A passkey in a real browser.** Chromium's virtual authenticator against experiment 11's WebAuthn account, and Coinbase's WebAuthn signature format | experiment 11 used a software authenticator | Coinbase, Safe, Uniswap, OKX, Sequence |
| W6, done: experiment 30 | **A privacy withdrawal with no relayer, priced against today's relayers.** Experiment 06's pool paying its own gas from the withdrawal, against Privacy Pools' and Railgun's fee quotes | the feature frames change most | Privacy Pools, Railgun, Umbra, Kohaku |
| W7 | **What a device can show.** An ERC-7730 descriptor for $E$, and what each field looks like when signed as typed data | blind signing is the open question for hardware | Ledger, Trezor, GridPlus, Keystone |
| W8 | **One signature on two chains.** A chain-agnostic digest for owner rotation, on the testnet and the devnet, and its replay risks | the only feature frames do not touch | Avocado, Coinbase, Porto, Ambire |

We started with W1, W3 and W6: W1 because it decides whether dapps need to change at all, W3 because it is the feature most wallets ship and the one frames help least, and W6 because it is the one frames help most. They became experiments 28 to 30, and the features above carry their numbers. In one line each:
- **W1:** dapps need no change, and a frames batch costs about what a 7702 batch does and 46% less than ERC-4337. Estimation and ERC-7677 are what need work.
- **W3:** token gas needs no server, but the sponsor then carries every failure, and the frame mempool forbids the one read that would refuse most of them.
- **W6:** with the pool as its own sender and a refund frame, the note pays 1.023 times its gas. Against 30 days of mainnet relayers that is 4.65 ETH instead of 224.5 ETH. Privacy Pools' relayer already charges close to gas, so there the gain is removing the party, not the price.

W2, W4, W5, W7 and W8 remain.

## Conclusions

Wallets today rebuild the same three parts for every advanced feature: a delegate contract, a relayer, and a policy server. Frames take the first two into the protocol, and the survey sorts features by what is left of the third.

Batching-wise, and for most sponsorship, nothing is left. An EOA with no code batches and is sponsored through default code, a dapp written against EIP-5792 does not notice the difference, and anyone can broadcast the result. This is where frames are simply better, and where EOA-first wallets gain the most: a 7702 delegate becomes optional rather than the price of entry.

Token-wise, the server stays, or its risk moves to the sponsor. Gas paid in tokens, gas tanks, spending limits and recovery delays all need something `VERIFY` may not read: another contract's storage, the clock, or a price. That limit is deliberate, because it is what keeps validation cheap enough for every node to run and for inclusion lists to enforce, and experiment 29 shows exactly what it costs.

Privacy-wise, frames remove a party. A withdrawal no longer needs somebody else to pay its gas, and on today's numbers that saves users most of what they pay relayers, and removes the reason 15% of withdrawals came from an address that links the user. What it does not remove is the network path, and it needs EIP-8250's keyed nonces, which are only Considered for Hegota, before a pool can serve more than one user at a time.

So a wallet adopting frames needs less from the protocol than from its neighbours: an ERC-7677 with two more fields, an RPC that can price an unsigned transaction, a receipt that says when a frame was rolled back, and hardware that can show what it signs.

## Appendix: the inventory

Account model first, then the features we used above, with the source we read. "SH" marks second hand.

### Wallets that start from an EOA

| Wallet | Account model | Features (mechanism) | Sources |
|---|---|---|---|
| MetaMask | EOA; 7702 to the MetaMask Delegator `0x63c0c19a...` (v1.3.0), on by default for new users; ERC-4337 DeleGators in its kit | `wallet_sendCalls` atomic (7702); gas in tokens on seven chains; sponsorship on Monad and SEI; Smart Transactions (builder auction); security alerts (MetaMask server, Blockaid for non-EVM); social login (TOPRF); Advanced Permissions (ERC-7715 and 7710, v13.23.0+); Agent Wallet (TEE key, off-chain policy, 7702 relay) | docs.metamask.io; support.metamask.io; github.com/MetaMask/delegation-framework |
| Rabby | EOA plus Safe; no 7702 upgrade or `wallet_sendCalls` found | GasAccount (sends native gas to the EOA); simulation; batch revoke including 7702 delegations; local address whitelist; Ledger clear signing | support.rabby.io; github.com/RabbyHub/Rabby changelogs |
| Rainbow | EOA plus optional 7702 delegate (address not found) | atomic approve and swap; sponsored swaps, sends, unstakes (own relay with a quote signer); Flashbots toggle | github.com/rainbow-me changelogs and source; rainbow.me/support |
| Zerion | EOA; no 7702 found | simulation; Blockaid phishing checks; free gas on its ZERO chain until it wound down on 2026-07-31; agent CLI with client-side policies | help.zerion.io; github.com/zeriontech |
| Phantom (EVM) | EOA plus optional 7702 to Alchemy's Modular Account | gasless swaps (sponsored, or in USDC, USDT, USDG, WETH); Google or Apple login (2-of-2 with Juicebox); Blowfish previews | help.phantom.com; phantom.com/learn/blog |
| Trust Wallet | EOA plus FlexGas 7702 | FlexGas (gas in TWT, USDT, USDC); SWIFT passkey wallet on ERC-4337 Barz, being retired; scanner; agent kit | trustwallet.com/blog; support.trustwallet.com; Barz bundler SH |
| OKX Wallet | EOA plus optional 7702 | 7702 delegate (successor repository: P256 and WebAuthn signers, keyed nonce queues, "chainless" signing; which version ships is unsure); Trader Mode (TEE key signs only matching orders); Agentic Wallet | web3.okx.com/learn; github.com/okxlabs/okx-smart-wallet-evm; okx.com/help (some search summaries only) |
| Uniswap Wallet | EOA plus Calibur v1.1.0 `0x000000005c84...` (7702, ERC-7821, P256 and WebAuthn keys with expiry), on by default | one-tap approve and swap; UniswapX (fillers pay gas, limit orders); MEV protection; Blockaid warnings | blog.uniswap.org; github.com/Uniswap/calibur; support.uniswap.org returned 403 |
| Frame (frame.sh) | EOA only; last release February 2025 | local calldata decoding; hardware wallets | frame.sh; github.com/floating/frame |
| Brave Wallet | EOA | Blowfish simulation; shielded Zcash; NEAR Intents swaps; EIP-5792 requested since May 2025 | github.com/brave/brave-core; brave.com/blog |

### Smart-account wallets

| Wallet | Account model | Features (mechanism) | Sources |
|---|---|---|---|
| Coinbase Smart Wallet (now "Coinbase Wallet") | ERC-4337, EntryPoint v0.6 | `wallet_sendCalls`; ERC-7677 paymasters and ERC-20 paymaster; Magic Spend; WebAuthn and address owners; sub-accounts (ERC-7895); spend permissions (EIP-712 grant, permission manager as owner); same address on 248 chains with replayable owner changes. Native AA on Base: EIP-8130 and Base Transactions (type `0x79`, EIP-8430), "dates are TBD" | docs.cdp.coinbase.com; github.com/coinbase; docs.base.org |
| Safe | Safe contracts; ERC-4337 through Safe4337Module 0.3.0; "existing Safe contracts cannot be used with EIP-7702" | Transaction Builder (MultiSend); n-of-m and nested Safes; passkeys (ERC-1271 proxy); Allowance module (also for agents); recovery through a Delay Modifier (28 days); Tenderly and Blockaid; guards | help.safe.global; docs.safe.global |
| Ambire | own smart account (relayer and ERC-4337) and 7702 to AmbireAccount7702 | queued batches; Gas Tank (USDC, any network, not withdrawable); simulation; hardware with 7702; recovery and session keys promised; Kohaku and EIL on its 2026 roadmap | blog.ambire.com; help.ambire.com; github.com/AmbireTech |
| Argent (EVM) | pre-4337 modular wallet; Vault maintenance-only (SH, support pages returned 403) | guardians with a 5-day security period; trusted contacts; session keys; relayed meta-transactions | github.com/argentlabs/argent-contracts |
| Sequence | own v3 contracts (nonce spaces; ERC-4337 and 7702 modules, use unsure) | relayer with sponsorship, token fees and parallel transactions; identity signer in a TEE; Smart Sessions; 30-day timed recovery; Guard Firewall co-signer; Trails intents | docs.sequence.xyz; github.com/0xsequence |
| Avocado | own contract behind Instadapp's relayer; status unchecked | USDC gas tank tracked off chain; chain-agnostic EIP-712 signatures (chain id 634); multisig; 2FA as a backend co-signer | guides.avocado.instadapp.io |
| Daimo | ERC-4337 (v0.7); the app is shutting down | up to 20 P256 keys (Secure Enclave plus passkey backups) | github.com/daimo-eth/daimo |
| Porto | 7702 to a Porto proxy; deprecated on 2026-08-19 | keys with expiry; `wallet_grantPermissions` ("alternative to the draft ERC-7715"); merchant sponsorship; one signature across chains (nonce prefix) | github.com/ithacaxyz/porto |
| Clave | zkSync Era native AA; status unclear | raw P256 and WebAuthn validators; gasless and ERC-20 paymasters; social, cloud and email recovery | github.com/getclave/clave-contracts |
| Soul Wallet | modular ERC-4337 (v0.7); site gone | ECDSA and WebAuthn validators; guardians stored as a hash; ERC-20 paymaster | github.com/SoulWallet/soul-wallet-contract |
| Obvious | unreachable | ERC-4337 on Biconomy's stack, gas in a chosen token (SH, 2023) | aninews.in (SH) |

### Infrastructure providers

| Provider | Features (mechanism) | Sources |
|---|---|---|
| Privy | keys in AWS Nitro with a 2-share split; policy engine in the enclave; batching through 7702 to ZeroDev Kernel; sponsorship through Alchemy; ERC-20 gas through an ERC-4337 paymaster | docs.privy.io |
| Dynamic | 2-of-2 MPC with the server share in a TEE; sponsorship through a 7702 delegate and relayer; EIP-5792; ZeroDev for ERC-4337; layered policies | dynamic.xyz/docs |
| Turnkey | Nitro enclaves with attestation; JSON policy engine; sponsorship and batching through 7702 and EIP-712 intents (Gas Station) | docs.turnkey.com |
| ZeroDev | Kernel (ERC-7579; a 7702 variant); paymasters, ERC-20 gas (USDC, 5%); permissions as on-chain plugins; guardian recovery; intents over Relay and Across | docs.zerodev.app; github.com/zerodevapp/kernel |
| Alchemy | Account Kit deprecated, signer moved to Privy; Modular Account v2 (ERC-6900), 7702 delegate `0x77021100...`; Gas Manager; ERC-20 paymaster; session keys with spend limits; parallel transactions by nonce key | alchemy.com/docs/wallets |
| Biconomy | Nexus (ERC-7579); MEE, "built on ERC 4337", for multi-chain orchestration; any-token gas; Smart Sessions. Its blog (2026-05-04) calls EIP-8141 the "rails" and says it is building SDKs and integrations; no implementation claimed | docs.biconomy.io; blog.biconomy.io |
| Pimlico | Alto bundler; verifying and ERC-20 paymasters (off-chain signed price); permissionless.js | docs.pimlico.io |
| Rhinestone | ERC-7579 accounts; passkey plus a per-request co-signature; Smart Sessions; intents settled over Across, Relay and LayerZero, "not a single atomic transaction across those chains" | docs.rhinestone.dev |
| thirdweb | TEE keys; execution mode 7702 (default) or ERC-4337; token paymaster; on-chain session keys | portal.thirdweb.com |

### Privacy, hardware and custody

| Product | Features (mechanism) | Sources |
|---|---|---|
| Kohaku (EF) | JS SDK with Railgun, Tornado Cash and Privacy Pools plugins ("not ready for production"); reference extension forked from Ambire, Sepolia only; ERC-4337 privacy paymaster; post-quantum hybrid ERC-4337 account; private RPC with PIR. No mention of EIP-8141 in its repository | github.com/ethereum/kohaku, kohaku-extension, kohaku-contracts, kohaku-rs |
| Railgun / Railway | broadcasters over Waku, paid in the moved token (about 10% of gas); 0.25% protocol fee; 7702 flow with an ephemeral EOA per operation | docs.railgun.org; railway.xyz |
| Privacy Pools | direct or relayed withdrawal; the relayer is paid from the withdrawn amount; quotes valid 20 seconds; ragequit | docs.privacypools.com; github.com/0xbow-io/privacy-pools-core |
| Fluidkey | a 1-of-1 Safe per stealth address; sponsored transactions on six L2s; MFA spending limit | docs.fluidkey.com |
| Umbra | stealth payments; token withdrawals relayed for a fee in tokens | github.com/ScopeLift/umbra-protocol |
| Ledger | EIP-1559, EIP-712, 7702 (app 1.17.0+); ERC-7730 clear signing; blind signing off by default; Transaction Check | github.com/LedgerHQ/app-ethereum; developers.ledger.com |
| Trezor | 7702 experimental (firmware 2.12.4); EIP-712 clear on newer models | github.com/trezor/trezor-firmware |
| GridPlus, Keystone, Tangem | GridPlus: 7702 and ABI decoding; Keystone: legacy, 1559 and EIP-712 by QR, no 7702 found; Tangem: no screen, Smart Gas through 7702 and its backend | github.com/GridPlus/gridplus-sdk; github.com/KeystoneHQ/keystone3-firmware; tangem.com/en/blog |
| Zengo, Fireblocks | two-party and MPC-CMP custody; Fireblocks policies (TAP) enforced in SGX; Universal Gasless through 7702 | help.zengo.com; developers.fireblocks.com |
| Blockaid | simulation and scanning API (EIP-712, ERC-4337, 7702, `wallet_sendCalls`) embedded in MetaMask, Coinbase Wallet, Zerion and others | blockaid.io |

### Standards a wallet serves (status on eips.ethereum.org, 2026-10-14)

| Standard | What it asks of a wallet | Status | Frames binding |
|---|---|---|---|
| EIP-5792 | a batch of calls, its status, capabilities; defines `atomic` | Final | `atomic` maps to an atomic batch |
| ERC-7677 | paymaster web service (`pm_getPaymasterStubData`, `pm_getPaymasterData`) | Review | fields defined for EntryPoint v0.6 and v0.7 only |
| ERC-7715, ERC-7710 | standing permissions (`wallet_requestExecutionPermissions`), redeemed as delegations | Draft | requires ERC-4337 |
| ERC-7895 | app sub-accounts | Draft | none |
| ERC-7579, ERC-6900 | modular accounts | Draft | ERC-8286 (Draft, 2026-06-04) defines a frame-validator module type for ERC-7579 |
| ERC-7821 | a minimal batch executor for 7702 delegates | Draft | not needed for code-less EOAs |
| ERC-7730 | clear-signing descriptors | Draft | none for frames |
| ERC-7739, ERC-1271, ERC-6492 | contract signatures | Draft, Final, Final | unchanged |
| ERC-7683, ERC-7828, ERC-7930 | cross-chain intents and addresses | Draft, Review, Review | none |
| EIP-8130 | Coinbase's native AA (keystore accounts) | Draft | an alternative to EIP-8141 |

### Pages we could not read

support.uniswap.org (403); Trust Wallet's FlexGas article (404); OKX's smart-account guide (404); MetaMask's Agent Wallet architecture page (404; its text file was read instead); support.argent.xyz (403); zengo.com (403); Fireblocks' Universal Gasless article (403); docs.blockaid.io (login); app.umbra.cash/faq (rendered empty; the repository's FAQ text was read); getclave.io and obvious.technology (unreachable); eips.ethereum.org/EIPS/eip-8213 and eip-8211 (404).
