# Is EIP-8141 Done? Frame Transactions after 30 Experiments and Four Clients

## TLDR

[EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) adds *frame transactions* to Ethereum: a transaction type in which an account decides for itself how it is authorized and who pays for it. It is scheduled for Hegota, the network upgrade after Glamsterdam. The question we keep hearing is whether it is done, and we built 30 experiments to answer it. Most were mined on a public testnet that runs ethrex, an Ethereum execution client. Some ran inside ethrex's own code, one probed four execution clients on a shared development network, and one read 30 days of mainnet.

**The core is done.** Four clients compute the same blocks from frame transactions. An implementation we wrote separately reproduces the hashes, signatures and gas of 2,000 of their transactions. Everything we tried from ERC-4337, today's smart-account system, ports to frames, and a token transfer costs 2.41 times less gas.

**What a user relies on is not.** Whether a frame transaction spreads through the network, who may pay for it, whether the network can force it into a block when builders censor it, and whether a post-quantum account can use it are all decided outside block execution. Each of those has an open problem. Seven findings, numbered as the sections below:

1. **The EIP's advice for custom signature checks can be exploited.** It lets an account check only its `SENDER` frames instead of the whole transaction. We followed that advice literally. An attacker then sandwiched a swap *inside the victim's own transaction*, and it was mined. The same gap lets whoever relays a transaction choose its fee. The fix is to sign everything you approve. Done carefully, that also lets one signature work with any sponsor, and we drafted it as a standard that today's wallets can already sign.
2. **A sponsor's ether can leave by three routes, and the proposed safety check watches one.** An open proposal trusts a sponsoring contract whose code has no instruction that sends ether. We built one that passes the check and still emptied its balance in a single transaction, while a user's sponsored transaction was waiting on that balance. We give a check that covers all three routes, and that also cuts the old check's false positives from 28% to 0.9%.
3. **Deadlines and revocation are punished.** A policy published under EIP-8272 cannot be withdrawn for about 27 hours, and the only way to bound it is a deadline. But when a node's pool is full, the EIP evicts the transaction nearest its deadline first, whatever fee it pays.
4. **As scheduled, inclusion lists protect no frame transaction.** Inclusion lists are Ethereum's planned defence against censoring builders. Where the extension that would cover frames is built, its verdict depends on the order in which the lists arrive, and one committee member can deny honest privacy withdrawals for free. We propose a subset that needs no extension, and a budget per list, which is now an open pull request.
5. **Three rules disagree about where an account may keep the state its signature check reads.** So an EOA that delegates to smart-account code can be protected by inclusion lists, or be safe to re-delegate, but not both.
6. **A new account can be post-quantum. An existing EOA can leave its ECDSA key only if two proposals that are not yet scheduled ship together.**
7. **The public mempool is deliberately narrower than ERC-4337's.** So at launch frames replace the simple half of ERC-4337, not all of it. One limit could safely grow, and we timed it: compute.

Each finding comes with a suggestion, its cost, and the easier fix we are *not* proposing. One thread runs through all seven: **every rule that widened the mempool safely is a declaration that a node can check without running code. Every rule that failed infers something from running code, or from the order in which things arrived.**

**What a wallet gets.** Our last three experiments asked what frames change for the products people use:
- a dapp written against EIP-5792's `wallet_sendCalls` ran unchanged on a wallet that sends frame transactions, at about the gas of an EIP-7702 batch and 46% less than ERC-4337. The wallet had to sign twice to estimate gas, though;
- gas paid in tokens works with no server at all, but the sponsor then pays for every batch that fails, and the one read that would refuse an empty wallet is forbidden;
- over 30 days, notes in Tornado Cash's and Privacy Pools' ETH pools paid relayers 224.5 ETH for 3.35 ETH of gas. A pool that is its own sender, with a last frame that refunds what the gas did not use, would have charged the same withdrawals 4.65 ETH.

> The same findings, ranked by how hard each is to fix: [Frame Transaction Open Problems](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/posts/frame-transactions-open-problems.md)
> What 45 wallets and providers ship today, and what frames would change about it: [What Wallets Ship Today](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/posts/wallets-and-frames.md)
> Every experiment, with its scripts, contracts and transaction hashes: [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames)

This post is meant to be read on its own. The introduction explains frame transactions and the proposals around them from scratch, and a glossary follows. Links point to the evidence; the argument should not need them.

## Introduction

A transaction today is one signature over one call. The signature is ECDSA over secp256k1, and the account that signed pays the fee. A frame transaction lifts all three limits. It allows:
- an account to decide in its own code how it is authorized, with any signature scheme, or with none if a proof is the authorization;
- someone other than the sender to pay, by approving payment in the same transaction;
- several calls to run as the sender, and to succeed or revert together;
- anyone to relay it, and, if it is signed correctly, nobody to change it on the way.

### Why frames

Smart-contract wallets already work around the three limits with ERC-4337: users sign *user operations*, bundlers collect them from a separate mempool, and a contract called the EntryPoint runs them. That mempool has its own rulebook, ERC-7562. EIP-8141 moves the same flexibility into the protocol, so it needs no bundler, no EntryPoint and no second mempool.

### A transaction made of frames

A frame transaction (type `0x06`) has:
- a `sender`, a nonce and fees;
- a list of signature entries `[scheme, signer, msg, signature]`. The protocol checks `SECP256K1` and `P256` entries itself, before any contract code runs. It leaves `ARBITRARY` entries to the account's code. An empty `msg` means the entry signs the transaction's *canonical signature hash*; an explicit `msg` is a 32-byte digest of the account's choosing;
- a list of frames. Each frame has a mode, a target, two gas limits (`execution` and `state`), flags and data. There are three modes:
  - `VERIFY` frames run read-only. They decide whether to call `APPROVE`.
  - `SENDER` frames run as the sender, once the sender has approved execution. They may carry `value`.
  - `DEFAULT` frames run as the protocol's entry point, address `0xaa`. Anyone composing the transaction can use them, for example a sponsor's bookkeeping.

```
 FRAME TX (type 0x06)   sender = S   nonce   fees   signatures = [[scheme, signer, msg, sig], ...]
 ------------------------------------------------------------------------------------------
 [0] VERIFY  -> S          APPROVE(EXECUTION)          \  validation prefix:
 [1] VERIFY  -> sponsor    APPROVE(PAYMENT)             |  simulated by every mempool node,
                                                        /  bounded by MAX_VERIFY_GAS = 100k
 [2] SENDER  -> token      approve(dex, x)     caller = S     \ atomic batch:
 [3] SENDER  -> dex        swap(x)             caller = S     / [2] is undone if [3] fails
 [4] DEFAULT -> sponsor    post_op()           caller = 0xaa  reads [2..3] via FRAMEPARAM
 ------------------------------------------------------------------------------------------
 receipt: payer, and per frame [status in {FAILURE, SUCCESS, SKIPPED}, gas_used, logs]
```

Read from the top: the sender's account approves execution, a sponsor approves payment, two calls run as the sender and stand or fall together, and the sponsor's own code runs last.

### Who approves, and who pays

`APPROVE` takes a scope:
- **`EXECUTION`**: "`SENDER` frames may act as me". Only the sender's own frame may grant it.
- **`PAYMENT`**: "I pay the fee". The frame's target becomes the *payer*, and the protocol takes the transaction's maximum cost from it up front.
- **both at once**, which is what an account paying its own gas does.

An account with no code gets *default code*: it approves, in whatever scope its frame allows, when the transaction carries a `SECP256K1` entry by the account's own key over the canonical signature hash. That hash covers the whole transaction, including the fees, with the signature bytes of the entries that sign it left blank. A contract account brings its own `VERIFY` logic instead, and reads the transaction with introspection opcodes: `TXPARAM`, `FRAMEPARAM`, `FRAMEDATALOAD`, `FRAMEDATACOPY`, `SIGPARAM` and `SIGDATACOPY`.

The frames up to and including the one that sets the payer are the *validation prefix*. Everything after it is the *execution body*. A `VERIFY` frame whose only scope is `PAYMENT`, a sponsor's frame, is called a *pay frame* below.

### What the network will carry

A node that receives a transaction simulates its validation prefix before passing it on, and nobody pays for that work. So the EIP's public mempool admits a transaction only if its prefix is cheap and hard to invalidate:
- it fits `MAX_VERIFY_GAS` = 100,000 execution gas, signature checks included;
- it reads only the sender's storage;
- it uses no environment opcodes such as `TIMESTAMP`;
- one transaction is pending per sender.

Payers are rationed too, because one payer can back many senders:
- the *canonical paymaster*, a reference sponsoring contract that nodes recognize by its exact code, may back many pending transactions, each reserved against its balance. Its owner can withdraw only after a one-day timelock, so its balance cannot vanish under pending transactions;
- any other paymaster contract may back one pending transaction;
- a *code-less sponsor*, an ordinary key-held account paying for others, is bounded only by its balance.

### The proposals around it, and where they stand

Each network upgrade has a meta EIP that sorts candidates into Scheduled, Considered, Proposed and Declined. Hegota's is EIP-8081. As we read it on 2026-10-08:

| EIP | What it does | Hegota |
|---|---|---|
| [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) | frame transactions | Scheduled |
| [EIP-7805](https://eips.ethereum.org/EIPS/eip-7805) (FOCIL) | inclusion lists: each slot, 16 validators each publish a list of transactions from the mempool they see. Attesters vote only for a block that includes them, unless a listed transaction is invalid or does not fit | Scheduled |
| [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250) | keyed nonces: a sender has several independent nonce sequences, so several of its transactions can be pending at once | Considered |
| [EIP-8272](https://eips.ethereum.org/EIPS/eip-8272) | recent roots: any address can post a Merkle root to a shared contract, and a transaction can name it in a `VERIFY` frame the protocol checks. A root stays usable for 8,191 slots | Considered |
| [EIP-8369](https://eips.ethereum.org/EIPS/eip-8369) | VOPS profiles: which transactions inclusion lists can enforce when nodes keep only a small part of the state. Profile 1 covers ordinary transactions; Profile 2 covers frame transactions, by replaying their validation prefix | Proposed |
| EIP-8151 and EIP-8298 | together, let an EOA retire its ECDSA key (section 6) | Considered |
| EIP-8355 | post-quantum (ML-DSA) signature precompiles | Declined |
| EIP-7851 | let a delegated EOA disable its key | Declined |

Glamsterdam, the upgrade before Hegota, schedules ePBS (EIP-7732, enshrined proposer-builder separation). It changes when attesters see a block's contents, which matters in section 4.

### Glossary

| Term | Meaning |
|---|---|
| default code | the validation the protocol runs for an account with no code: one secp256k1 signature by the account's key over the canonical signature hash |
| canonical signature hash | the hash of the whole transaction, fees included, with the signature bytes of the entries that sign it left blank |
| explicit digest | a digest the account signs instead of the canonical hash, passed as a signature entry's `msg` |
| validation prefix, execution body | the frames up to and including the one that sets the payer; the frames after it |
| payer, sponsor, paymaster | the account charged the fee; a payer other than the sender; a sponsoring contract |
| pay frame | a `VERIFY` frame whose only scope is `PAYMENT` |
| canonical paymaster | the reference paymaster nodes recognize by its exact code, with a one-day withdrawal timelock |
| code-less sponsor | a key-held account that pays for other senders |
| atomic batch | consecutive frames flagged to succeed or revert together |
| keyed nonce | one of a sender's independent nonce sequences (EIP-8250) |
| recent root | a Merkle root posted under EIP-8272 and referenceable for 8,191 slots, about 27 hours at 12-second slots |
| expiry frame | a `VERIFY` frame calling the expiry verifier contract, which refuses the transaction after a stated deadline |
| execution gas, state gas | the two gas dimensions of EIP-8037: computation and data, and durable state growth |
| calldata floor | the minimum a transaction pays per byte of data (EIP-7976) |
| fan-out | the number of pending transactions one on-chain action invalidates (section 2) |
| inclusion list, includer, attester | a list of transactions a block must include; the committee member who publishes it; a validator voting on the block |
| VOPS | validity-only partial statelessness: nodes that keep only each account's nonce, balance and code flag, plus a few storage slots |
| keyless deployment | deploying a contract with a pre-signed transaction from an address whose key nobody holds, so it has the same address on every chain |
| ethrex, geth, Nethermind, reth | Ethereum execution clients |

## How we tested

We used four environments:
- **The Hegota testnet** (chain id 8141), a public testnet whose nodes run ethrex's Hegota build. Experiments 01 to 21, 23, 24 and 27 to 30 mined their transactions there. That build is ethrex `v23.0.0-hegota-testnet`, with EIP-8141 pinned at `b75cbe61` plus EIP-8250 and EIP-8272, and with `MAX_VERIFY_GAS` raised to 500,000 by a node flag. So its numbers are ethrex's, on the Amsterdam gas schedule, and some prefixes above 100,000 were mined there that a node at the EIP's value would refuse.
- **frames-devnet-0**, a development network run by ethpandaops with geth, Nethermind, reth and ethrex behind one RPC endpoint. It was renamed bogota-devnet-0 on 2026-10-12. Experiment 22 ran there.
- **ethrex's own test tree**, at [`c94964843d`](https://github.com/lambdaclass/ethrex/tree/c94964843d39d04914dff178e55e60daf7707089) of its `hegota-testnet` branch. Experiments 25 to 27 ran there too, and 25 and 26 send no transaction at all.
- **Ethereum mainnet, read only.** Experiment 30 read every withdrawal from five privacy pools over 30 days, to price what relayers charge today.

| # | Experiment | Headline number |
|---|---|---|
| 01-05 | the EIP's own examples, account deployment, an atomic batch, a sponsor paid in ERC-20, a k-of-n multisig | 26,102 gas for an ETH transfer, bound by the calldata floor; a front-run costs an ERC-20 sponsor 218,760 gas |
| 06 | a privacy pool that is its own sender, with Tornado Cash's circuit | `VERIFY` 244,808 to 248,991 gas; three withdrawals from one sender in one block, keyed design only |
| 07-08 | a FROST threshold wallet; operating a multisig | 26,794 gas per transfer at any threshold; a counterfactual proxy's `VERIFY` 4,262 |
| 09 | paymasters, including the canonical one | four users in one block through one instance; a copy one unreachable byte longer refused |
| 10-11 | the expiry frame; passkeys, raw P256 and WebAuthn | 3,051 gas; WebAuthn `VERIFY` 15,542 |
| 12-16 | session keys, social recovery, a modular account, an EIP-7702-delegated EOA as sender, subscriptions | +21,600, +2,100 and +5,300 gas per transaction over the owner's own |
| 17 | a post-quantum account: one-time WOTS keys under a Merkle root | 73,481 gas against 27,382 for ECDSA |
| 18-20 | introspection opcodes; mempool rules one at a time; contracts that read the protocol's signature verdicts | 731 introspection words match a model; `TIMESTAMP` through a nested call admitted |
| 21 | ERC-4337 v0.8 side by side | 116,735 gas against 48,435, 2.41 times |
| 22 | four clients on frames-devnet-0 | 50 of 50 heights agree; admission diverges |
| 23 | what an approval has to commit to | a sandwich inside the victim's own transaction, mined |
| 24 | a sealed paymaster, and a scan that calls the wrong one sealed | a scan-sealed paymaster emptied; sealed pay frame 13,305 gas |
| 25 | inclusion lists for frame transactions, against ethrex's Profile 2 | 46 admitted sets from one set of lists; 2 privacy withdrawals per slot |
| 26 | what a gas cap on the validation prefix bounds, in time | about 16 ns per gas at worst; Groth16 13.1; a state read from memory 1.4 |
| 27 | a shared layout for the execution digest, as a draft ERC | one typed-data signature, two payers, the second mined |
| 28 | EIP-5792's `wallet_sendCalls` and ERC-7677's paymaster service, bound to frames | a stock viem dapp unchanged; 90,321 gas against 92,143 for a 7702 batch and 167,458 for ERC-4337 |
| 29 | gas paid in tokens with no server: a sponsor repaid from a swap in the same atomic batch | 91,276 gas; a failed batch costs the sponsor up to its cap, 4,147,393 gas in one transaction |
| 30 | a privacy withdrawal with no relayer, priced against 30 days of mainnet relayers | 224.5 ETH of relayer fees for 3.35 ETH of gas; the note pays 1.023 times its gas with a refund frame |

188 mined transactions are kept as test fixtures. Every experiment has a directory in [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames) with a README, the scripts, the contracts and the transaction hashes.

## Is it done? A readiness map

We read EIP-8141 and the proposals above at master on 2026-10-08, again on 2026-10-09, and again on 2026-10-13. Every claim below has a mined transaction, a refusal message or a quoted sentence behind it.

| Layer | What it decides | State | Section | What is missing |
|---|---|---|---|---|
| Block execution | encoding, signature hash, frames, `APPROVE`, receipts, gas | **converged**: 4 clients agree at 50 of 50 heights; 2,000 transactions re-encoded and re-settled; 41 rebuilt byte for byte in Rust | Four clients | a receipt status for frames rolled back with their batch; cross-client coverage beyond 5 transaction shapes |
| Approval | what a custom `VERIFY` must check | the canonical hash is sound; **the guidance is exploitable** | 1 | one paragraph of the EIP; an ERC for the digest, drafted |
| Payers | who may sponsor many pending transactions | the canonical paymaster works, for one secp256k1 signer; **two other rules are unsafe as written**; a sponsor with no signer serves one user per block and pays for every failure (experiment 29) | 2, 7 | a bound on how many pending transactions one action can invalidate |
| Public mempool | what propagates | specified and deliberately narrow; **clients diverge** | 7, Four clients | one set of caps, one check order and one error vocabulary; a cap for state apart from compute |
| Shared senders | privacy pools, multisig treasuries | **one pending transaction per sender** unless EIP-8250 ships, and it is only Considered. What is at stake: notes paid relayers 224.5 ETH in 30 days (experiment 30) | 4, Wallets | scheduling EIP-8250, and mempool rules for keyed nonces |
| Inclusion lists | censorship resistance | **undefined for frame transactions; order-dependent where built**; a fix per list proposed | 4 | Profile 1 for frames that need no replay; the per-list fix merged; consensus-specs carrying list membership |
| Partial statelessness | what a VOPS node can validate | Proposed; its storage surface conflicts with account practice | 5 | a namespaced surface |
| Time | deadlines, not-before, revocation | deadlines yes; not-before proposed; **deadlines evicted first** | 3 | a frame-level clock rule; a different eviction order |
| Post-quantum | moving off ECDSA | new contract accounts only, at 2.7 times ECDSA's gas; **EOAs exit only if EIP-8151 and EIP-8298 both ship** | 6 | both EIPs, together; room in the mempool for in-EVM verification |
| Wallet interface | what an RPC returns, and what a dapp asks for | EIP-5792 dapps **work unchanged** (experiment 28); **21 of 39 transaction fields differ** across clients; estimating gas needs real signatures | Four clients, Wallets | [execution-apis PR-860](https://github.com/ethereum/execution-apis/pull/860), [PR-907](https://github.com/ethereum/execution-apis/pull/907); a simulation that takes placeholder signatures and reports state gas per frame; two ERC-7677 fields |

The closer a layer sits to the block, the more done it is; the closer it sits to a user, the less. That is the expected order of work for a protocol change. But users never meet the block layer alone. A frame transaction that a wallet cannot price, a mempool will not carry, and an inclusion list does not protect is, to a user, not done.

The same findings, ranked by how hard each is to fix, are in a companion list, [Frame Transaction Open Problems](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/posts/frame-transactions-open-problems.md). What changed upstream while we wrote is in the appendix.

## 1. An approval must commit to exactly what it approves

**In short.** The EIP lets a custom signature check cover only the `SENDER` frames. That leaves the frames around them, and the fees, to whoever relays the transaction. We exploited both on the testnet. The rule that works is to sign everything you approve, and applied carefully it also lets one signature work with any sponsor.

**What the EIP says.** Its Security Considerations section, *Execution Approval Authorizes All Subsequent Sender Frames* (master, 2026-10-08), ends:

> Custom validation contracts that grant `APPROVE_EXECUTION` should verify against the canonical signature hash, or otherwise constrain every subsequent `SENDER` frame, before approving.

The first option is what default code does. The second is for accounts that want to sign something narrower, for example so that a sponsor can be chosen after the user has signed.

**What we did** ([experiment 23](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/23-approval-scope)). We built a "literal" account that takes the second option at its word. Its owner signs a digest $D$ of the chain id, the sender, the nonce, and every `SENDER` frame in order (target, flags, both gas limits, value and data), and nothing else. The owner signed a swap, `[self_verify, approve(pool, 10 A), swap(10 A, minOut)]`, with `minOut` 3% under the quote, the slippage a wallet would allow. Its wallet set a 1,000 wei tip, which $D$ does not cover.

An observer watching the mempool copied the transaction. It kept the signature entry byte for byte, added two frames of its own around the swap, and raised both fee fields by 20%, the minimum for a node to accept the copy as a replacement. It sent the copy within the same slot:

```
 honest (signed)                           attacked (same signature entry, same D)
 ------------------------------------      --------------------------------------------------
 [0] VERIFY  self   APPROVE(3)             [0] VERIFY  self   APPROVE(3)
 [1] SENDER  token  approve(pool, 10 A)    [1] SENDER  token  approve(pool, 10 A)
                                           [2] DEFAULT bot    front(15.42 A)     <- inserted
 [2] SENDER  pool   swap(10 A, minOut)     [3] SENDER  pool   swap(10 A, minOut)
                                           [4] DEFAULT bot    back()             <- appended
 fees: tip 1,000 wei                       fees: x 1.2  (a valid replacement)
```

`APPROVE(3)` is both scopes at once: the account approves execution and pays.

**What happened.** The attacked copy was mined, in block 315,369:
- the victim received 9.6040 B against a quote of 9.9010: 3.0% less, exactly the slippage it allowed;
- the attacker's bot ended 0.3029 A up;
- the victim, as payer, paid for the bot's 110,710 gas of execution.

Separately, we relayed the honest transaction with a 10 gwei tip instead of 1,000 wei. It was mined and cost the account 0.0011865 ETH; at the tip its wallet chose, it would have cost about $10^{-7}$ of that.

**Why the second option fails.** Constraining the `SENDER` frames leaves three things to whoever relays the transaction:
- the `DEFAULT` frames, which run between the sender's calls and can trade against them;
- the positions and the number of frames, so frames can be inserted or appended;
- the fees, which the account pays when it also approves payment.

**The rule that works: sign what you approve.** Let $\mathcal{C}(s)$ be what a validation granting scope $s$ must authenticate:

$$\mathcal{C}(\mathsf{EXECUTION}) = \{\, (i, \mathsf{frame}_i) : \mathsf{frame}_i \text{ is not a pay frame} \,\} \cup \{\, n_{\text{frames}} \,\}$$

$$\mathcal{C}(\mathsf{PAYMENT}) = \mathcal{C}(\mathsf{EXECUTION}) \cup \{\, \text{fees}, \text{every frame's limits} \,\}$$

In words: approving execution must cover every frame except a sponsor's pay frame, each with its position, and how many frames there are. Approving payment must also cover the fees and every frame's gas limits, because the payer pays for all of them. A frame that approves both may leave out nothing but signature bytes, and that is exactly the canonical hash. Default code is right for every case it handles.

**Sign once, any payer.** The rule has a useful asymmetry. An account that approves execution alone may leave out the pay frame and the fees, because someone else pays. Our `ScopedAccount` signs the canonical hash when it pays, and otherwise an explicit digest $E$ of every frame but the payer's, with positions and count. Against it:
- all three attacks were refused;
- one owner signature was completed by two sponsors in turn. The second replaced the first with another payer and higher fees, and was mined (block 315,376). A token fee went to whichever sponsor landed it;
- `VERIFY` cost 2,914 gas for six frames, against 351 for the canonical hash.

This settles half of a question a companion study of account abstraction put to the EIP's authors: whether fees could leave the canonical hash. They can, for accounts that do not pay, through $E$, with no change to the EIP. That matters most for privacy designs. If a spender's authorization is a blind voucher from an issuer, re-signing to change the price means contacting the issuer again, and that second contact links the spender.

**What a transaction is.** Across the two payers, $E$ stayed the same while the signature hash and the transaction hash both changed. A wallet that tracked its operation by transaction hash lost it at the replacement. Bitcoin met the same problem as transaction malleability, and fixed it with an identifier for what the signer authorized that leaves the witness out (BIP 141's txid against wtxid). Frames need the same distinction in wallets and RPCs: the *intent* the sender signed, against the *envelope* that carries it. A wallet should watch the nonce and recompute $E$ of whatever consumed it. A contract that wants an operation id should recompute $E$ rather than read the signature hash.

**Suggestion 1: replace the paragraph.**

> A validation that grants `APPROVE_EXECUTION` must authenticate every frame other than pay frames, with its index, and the number of frames. A validation that grants `APPROVE_PAYMENT` must also authenticate the fees and the limits of every frame. Constraining only `SENDER` frames is not sufficient: `DEFAULT` frames placed between them run while the sender's operations are in flight, and every frame is paid for by the payer. The canonical signature hash satisfies both requirements.

**Cost.** One paragraph in the EIP. Wallets that build explicit digests also need a published layout for $E$, so that two wallets, an account and a sponsor agree on it byte for byte. That belongs in an ERC, not the EIP.

**The ERC we drafted** ([experiment 27](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/27-execution-digest), [`erc-draft.md`](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/experiments/27-execution-digest/erc-draft.md)). It defines $E$ as EIP-712 typed data, the format wallets already display for signing:

```
domain  = EIP712Domain("FrameExecution", "1", chain_id, verifyingContract = sender)
message = FrameExecution(nonceKeysHash, nonceSeq, Frame[] frames, bytes32[] blobVersionedHashes)
Frame   = (mode, flags, resolved target, execution limit, state limit, value, data)
          with target, both limits and data zeroed in the pay frame
```

The pay frame's mode, flags and value stay pinned. None can differ in a valid pay frame today, and pinning them means a future flag, or value on `VERIFY`, cannot reach the sender through an open field. A plain EIP-8141 transaction digests as if it had one nonce key, `nonce_keys = [0]`, so both forms of one operation share one $E$.
- **Four implementations that share no code agree on it:** viem's typed-data encoder, a by-hand encoder, the EIP-712 derive macro of alloy (a Rust library) in our Rust port, and a 617-byte account written in Yul that recomputes $E$ by introspection.
- **Inside ethrex's own validation, every verdict matched:** 11 signed cases accepted and 8 refused. The refusals include an inserted or an appended `DEFAULT` frame, a lowered state limit, a retargeted transfer, a swapped blob, and the same signature on a second account.
- **On the testnet,** the owner's entry came out of viem's `signTypedData`, the call a wallet serves for `eth_signTypedData_v4`. A second sponsor replaced the first sponsor's copy with its own pay frame and 20% higher fees, reusing that entry byte for byte, and was mined (block 320,282). `VERIFY` cost 1,974 gas for three frames and 3,207 for six, about 411 per added transfer.

So a wallet that knows nothing about frames can authorize a sponsored frame transaction today. That is also why the draft requires wallets to display the typed data honestly: the same interface carries permit phishing.

Writing the layout down turned up three things experiment 23 had not tested:
- **The relay can name the sender as payer.** $E$ leaves the pay frame's target open, so a relay may point it at the account itself. An account that approves payment because a valid owner entry exists, without requiring that entry to cover the fees, then pays whatever fees the relay states. The draft's first rule for accounts is that nothing approves payment on $E$, from any frame. Our account refused the case inside ethrex and against the testnet's state.
- **Blobs.** The `BLOBHASH` opcode reads the transaction's blob hashes in every frame, and experiment 23's $E$ left them out. A relay could have swapped the blobs under a `SENDER` frame that posts them. $E$ pins them now.
- **The pay frame's limits must stay open.** EIP-8250 charges a keyed nonce's first use, 97,920 state gas per key, to the frame that approves payment. With two keys, the payer had to budget 195,840 state gas in its own frame. A layout that pinned the pay frame's limits would make the owner fix one budget, before any payer is known, for both the payer's own code and a charge the sender's keys cause.

**Not suggested: a protocol execution hash.** A reserved `msg` value meaning "the protocol's execution hash" would let plain EOAs sign execution-only, more cheaply, and visibly to RPCs. It would also be a second canonical hash, fixed forever, for a use not yet shown at scale. The explicit `msg` is the extension point EIP-8141 already has, and an ERC can be versioned.

**Not suggested: moving the fees out of the canonical hash.** Our fee-rewrite result is exactly what that would allow for every account that pays for itself: whoever relays the transaction sets the tip, and the account pays it. The accounts that need fee freedom are the ones that do not pay, and they can already have it through $E$.

## 2. Ether leaves through three doors

**In short.** One cheap action that invalidates many pending transactions is a free attack on the network. The EIP's rules for payers mostly prevent that, but two rules do not. The deeper reason is that ether can leave an account by three routes, and the rules watch one.

### The invariant

A mempool node validates each transaction before passing it on, up to `MAX_VERIFY_GAS`, and nobody pays for that work unless the transaction is mined. So a mempool is cheap to attack when one cheap on-chain action invalidates many admitted transactions at once. Call the number an action $a$ invalidates its *fan-out*:

$$F(a) = \bigl|\{\, t \in \text{pool} : t \text{ valid before } a,\ t \text{ invalid after } a \,\}\bigr|$$

The public mempool stays safe if every action that costs a constant fee has a constant fan-out, $F(a) = O(1)$. Most of EIP-8141's mempool is that invariant, applied one mechanism at a time:

| Mechanism | Action that could invalidate | Fan-out |
|---|---|---|
| one pending transaction per sender | the sender transacts | 1 |
| keyed nonces, disjoint keys ([PR-12039](https://github.com/ethereum/EIPs/pull/12039)) | a key is used | 1 |
| EIP-8272 recent roots | none: an entry cannot be overwritten inside its window | 0 (time only, declared) |
| expiry frame | none: the deadline is in the transaction | 0 (time only, declared) |
| canonical paymaster | a withdrawal, delayed 86,400 s and subtracted while pending | 0 within the horizon (ethrex does not subtract pending withdrawals, experiment 09) |
| any other paymaster | anything | $\le 1$ (the cap) |
| **code-less sponsor (master)** | **one transfer by its key** | $\le \lfloor B / c_{\min} \rfloor$ |
| **PR-12328's "egress-decidable" paymaster, as written** | **one transaction by the paymaster as sender** | **unbounded (measured below)** |

The code-less sponsor's row is the EIP's own text: such a payer "is not a paymaster and is governed by the per-payer exposure rule alone", which bounds the summed maximum cost of its pending transactions by its balance $B$. That bounds the *amount* at risk, not the *number* of transactions. Suppose the smallest maximum cost a sponsored transaction can declare is $c_{\min} \approx 50{,}000$ gas at 2 gwei, that is $10^{-4}$ ETH. Then one ether backs about 10,000 pending transactions, each from its own fresh sender, and one 21,000-gas transfer invalidates them all (derived, not measured). The companion account-abstraction study raised the same point with the authors. ethrex does not implement the exemption, and caps such a sponsor at one pending transaction (experiment 09).

Three open pull requests touch this row, and none bounds it:
- [PR-12321](https://github.com/ethereum/EIPs/pull/12321) specifies the cleanup. A payer that approved through default code and then acquires code is dropped with everything it backs, and a falling balance evicts transactions until the exposure fits again. That is the fan-out, written down.
- [PR-12421](https://github.com/ethereum/EIPs/pull/12421) adds a frame that installs an EIP-7702 delegation. That is one more single transaction that gives a code-less sponsor code, and so drops all its pending sponsorships.
- [PR-12328](https://github.com/ethereum/EIPs/pull/12328), below, has not changed since 2026-09-13.

The model that does satisfy the invariant is the canonical paymaster as revised in [PR-12041](https://github.com/ethereum/EIPs/pull/12041). Its withdrawals and its signer rotations both wait out the 86,400-second timelock, so within that horizon nothing invalidates what it backs.

EIP-8141 has also begun to admit the cost of unpaid work elsewhere. A validation prefix that never approves payment is charged nothing. Since commit `857622a`, a block producer may evict such a transaction after more than one failed attempt to build it into a block, because one failure can be transient. But a count of attempts either wastes work, or evicts a transaction that was about to become valid, and an attacker can arrange the second by delaying the transaction that funds a payer. Retrying only when something the transaction depended on at admission changes would bound the work by state changes somebody paid for (smaller fixes, row 17).

### Three doors

What the two bad rows share is a model of where ether can leave an account. There are three doors:
1. **An opcode in its code**: `CALL`, `CALLCODE`, `DELEGATECALL`, `CREATE`, `CREATE2` or `SELFDESTRUCT`.
2. **A key**: an EOA, a default-code account, or an EOA delegated through EIP-7702. EIP-7851, which would let a delegated EOA retire its key, is declined for Hegota, so every EOA keeps this door open for good.
3. **An approval of execution**: an account whose code can reach `APPROVE` with the execution scope can be the transaction's sender, and a `SENDER` frame's `value` then moves its ether with no opcode in its code at all. This door is new with EIP-8141.

PR-12328 proposes to let a paymaster back many pending transactions, not one, if its code shows that ether leaves it only as approved gas: an "egress-decidable" paymaster. Its decidable form is a scan of the whole code for door 1, and it waves door 3 through explicitly:

> `APPROVE` is not an egress instruction: its `offset`/`length` operands designate return data only, and the protocol collects at most the reserved `max_cost` through `APPROVE_PAYMENT` regardless of the approval scope, so no scan of the `APPROVE` operands is required.

The sentence is true of payment and false of execution. Door 2 passes without a check: an account with no code has no forbidden opcode.

**What we did** ([experiment 24](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/24-sealed-paymaster), scenario E). `SelfSendingPaymaster` is the canonical paymaster's admission rule with the timelocked withdrawal deleted, plus default code's rule for when the paymaster is itself the sender. Its 134-byte code has none of the scanned opcodes, so PR-12328's scan calls it sealed. We then sent two transactions in one slot:

```
 sponsorship (admitted, reserved against the paymaster's balance)
   sender = fresh user    [0] VERIFY user  APPROVE(EXECUTION)
                          [1] VERIFY PM    APPROVE(PAYMENT)        owner's entry 1
                          [2] SENDER token mint(user)
 drain (higher tip)
   sender = PM            [0] VERIFY PM    APPROVE(EXECUTION_AND_PAYMENT)   owner's entry 0
                          [1] SENDER owner value = balance - own max cost - a remainder
                                           below the sponsorship's max cost
```

**What happened.** The drain was the only transaction in block 316,423. The paymaster went from 0.009999861732475678 ETH to 580,965,481 wei, and its owner received 0.009999860728069323 ETH. The pending sponsorship left the pool. Sent again, it was refused: `validation prefix frame reverted`.

ethrex holds any non-canonical paymaster to one pending sponsorship, so one transaction was lost here. PR-12328 lifts that cap for the paymasters its scan admits. Under it, every sponsorship pending against this balance would go the same way, for the price of one transaction.

On the way, block 316,413 was reorganized. Our first drain's receipt said success; in the block that replaced it, the sponsorship came first and the drain's value transfer failed for want of balance. The same two transactions, in two orders, gave two outcomes. We saw this once on this testnet.

### A sealed paymaster that works

PR-12328's idea is good, and we built it ([experiment 24](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/24-sealed-paymaster), scenarios A to D). `SealedPaymaster`:
- has no `CALL`-family opcode;
- approves only through the four instructions `PUSH1 1, PUSH0, PUSH0, APPROVE`, so its scope is always `PAYMENT`. The canonical paymaster's code uses the same four;
- holds the sponsor's EIP-8272 source id as a constant inside a `PUSH32`, so nothing trails the code;
- reads no storage and no balance.

The sponsor's policy is a Merkle tree of leaves

$$\mathsf{leaf} = \mathsf{keccak256}(\mathsf{target} \Vert \mathsf{selector} \Vert \mathsf{cap} \Vert \mathsf{notAfter})$$

meaning "I pay for calls to this target and function, up to this maximum cost, until this time". The sponsor's ordinary key-held account posts the tree's root through EIP-8272. A sponsored transaction proves its leaf in the pay frame:

```
 SPONSORED MINT    sender = USER (no ETH, no code)    signatures = [USER over the sig hash]
 ----------------------------------------------------------------------------------------------
 [0] VERIFY -> 0x..8141   deadline                     protocol: block.timestamp <= deadline
 [1] VERIFY -> 0x..8272   (source_id, slot, root)      protocol: root committed, slot in window
 [2] VERIFY -> USER       APPROVE(EXECUTION)           default code
 [3] VERIFY -> SEALED     APPROVE(PAYMENT)             tuple names my source_id; the leaf for
                                                         frame 4's target and selector folds
                                                         to its root; max cost <= cap;
                                                         deadline <= notAfter; 5 frames
 [4] SENDER -> TOKEN      mint(USER, 1e18)
```

Three users with no ETH were sponsored. All seven malformed variants were refused at admission, among them a stranger publishing *the sponsor's own root* under the stranger's source id. The system contract proves only that someone wrote a root; binding it to a sponsor is the consumer's job.

This also measures what the PR left open, the cost of the recent-root frame and of the proof:

| | expiry | recent root | `only_verify` | pay frame | prefix execution | proof bytes (calldata gas) |
|---|---|---|---|---|---|---|
| depth 4 | 3,051 | 5,579 | 100 | 4,575 | **13,305** | 288 B (2,808) |
| depth 20 | 3,051 | 5,579 | 100 | 7,631 | **16,361** | 800 B (11,000) |

- The pay frame costs $3{,}811 + 191d$ gas at tree depth $d$.
- With the user's signature, the prefix is 16,105 gas at depth 4, far inside 100,000.
- Proof bytes do not count against `MAX_VERIFY_GAS`, which counts execution limits and signature checks. The payer pays for them as data, and at depth 20 they cost more than the hashing. So the bill for data, not the gas cap, is what limits the tree's depth.
- Compared with the canonical paymaster (a 5,210-gas pay frame plus its signer's entry, about 2,800 gas and 90 bytes), the sealed path costs about 5,000 more execution gas and needs no signer online.

### Suggestions 2 and 3

**Suggestion 2 (to PR-12328): scan all three doors, and only reachable code.** A contract's code is sealed if:
1. it is not empty and not an EIP-7702 delegation indicator (door 2);
2. every reachable `APPROVE` is immediately preceded by `PUSH1 0x01, PUSH0, PUSH0`, with no `JUMPDEST` among them, so no jump can arrive with another scope (door 3);
3. no reachable instruction is a door-1 opcode. Reachable means from position 0 or a `JUMPDEST`, falling through until `STOP`, `RETURN`, `REVERT`, `INVALID`, `JUMP`, `SELFDESTRUCT` or `APPROVE`.

It is still one linear pass, the same one clients already make to find jump destinations, and cacheable per code hash as the PR wants.

Reachability also fixes a false positive in the PR's scan. Solidity appends metadata after an `INVALID` instruction, including a 32-byte IPFS hash, and a linear scan reads those bytes as instructions. Our own call-free `TestToken` fails the PR's scan on a `CALLCODE` byte inside its hash. Over 100,000 random hashes:

| Code | PR scan says sealed | amended scan says sealed |
|---|---:|---:|
| SealedPaymaster + `INVALID` + Solidity metadata | 72.17% | 99.08% |
| TestToken + Solidity metadata | 71.66% | 99.05% |

The remaining 0.9% are hashes with a `0x5b` byte (`JUMPDEST`) at an instruction position. EOF, the proposed EVM Object Format that separates code from data, would have closed the question entirely.

**Suggestion 3 (to EIP-8141): cap the code-less sponsor by count, as ERC-7562 caps unstaked entities.** ERC-7562 lets an unstaked entity back `SAME_UNSTAKED_ENTITY_MEMPOOL_COUNT` = 10 user operations. A cap of $k$ keeps the fan-out at $k$ per transfer, and keeps the EIP's own use case: a user's "gas account" paying for their other accounts.

**Cost.**
- Suggestion 2 refuses some contracts a looser scan would admit: those whose `APPROVE` takes its scope from the stack even though they never approve execution. Their authors can emit the four-instruction form instead.
- Suggestion 3 limits a code-less market maker serving strangers to $k$ pending sponsorships. A canonical paymaster has no such limit.
- Neither changes consensus.

**What sealing costs a sponsor**, so that nobody is surprised:
- **The money only goes one way.** The PR's property also admits ether that leaves "after a delay". But a timelocked withdrawal needs a `CALL` or an execution approval, and a whole-code scan forbids both. Under any such scan, an egress-decidable paymaster is a gas tank: ether goes in and only leaves as gas.
- **It depends on the sponsor staying alive.** If the sponsor stops posting roots, then 8,191 slots after the last one no transaction can name a root, and the balance is stranded for good.
- **Policies cannot be withdrawn for 8,191 slots** (section 3).

**Not suggested: more exact code hashes.** Nodes recognize the canonical paymaster by an exact match of its code. One unreachable extra byte demoted a copy to "refused" (experiment 09). Every edit to the reference code orphans the deployed instances, a versioning problem the companion account-abstraction study also raised. Recognition by a decidable property is the right direction; it only has to decide the right property.

**Not suggested: lifting the cap of one for every paymaster.** ERC-7562 uses staking and reputation instead, and EIP-8141 removed both on purpose. The canonical paymaster's 86,400-second timelock is ERC-7562's `MIN_UNSTAKE_DELAY` of one day turned into code. A sealed paymaster is a stake that never unstakes.

## 3. Deadlines are declared, and then punished

**In short.** A sponsor's policy published as a recent root cannot be withdrawn for about 27 hours. The only way to bound its life is a deadline, an expiry frame. But a full mempool evicts the transactions with the nearest deadline first, whatever they pay, so the careful transactions go first.

**Revocation** ([experiment 24](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/24-sealed-paymaster), scenario D). The sponsor from section 2 published a policy, then a second root without one of its leaves, meaning to revoke it. A transaction proving the revoked leaf against the *first* root was mined after the second root was written. EIP-8272 keeps every root usable for 8,191 slots, about 27 hours at 12-second slots, so a later root adds a root and withdraws nothing.

That is the property that makes EIP-8272 safe for the mempool: no write can invalidate a pending transaction that references a root. For a privacy pool's tree of deposits it is also what the application wants, because the set only grows. For an *allow-list* it is not. Privacy Pools' association sets are allow-lists: a provider that removes a flagged deposit wants the removal to take effect. Under EIP-8272 the removed deposit stays provable against older roots for 8,191 slots, unless the contract that reads the root bounds its age itself.

It can, by composition, with no protocol change:
1. put $\mathsf{notAfter}$ in the leaf, or publish $\mathsf{keccak256}(\mathsf{root} \Vert \mathsf{notAfter})$ as the root;
2. require an expiry frame whose deadline is at most $\mathsf{notAfter}$.

The sealed paymaster does exactly this. Once the policy's `notAfter` had passed, a transaction with a later deadline was refused by the paymaster, and one with the old deadline by the protocol (`Frame transaction expiry deadline has passed`).

**Eviction.** That composition has a cost. When a node's pool is full, EIP-8141 evicts in this order:

> first transactions already invalid against the current head, then transactions with the nearest expiry deadline, then transactions with the lowest effective priority fee.

So a transaction that declares when it stops being valid is evicted before one that does not, *whatever it pays*. Who declares deadlines?
- privacy spends bounded as above;
- session keys (experiment 12);
- sponsored transactions whose sponsor wants a bounded exposure;
- every transaction whose wallet is careful.

A flood of deadline-free transactions at the minimum fee evicts all of them first. This follows from the text; we did not measure it, since filling a testnet's mempool proves little. Experiments 10 and 19 also found that a transaction whose deadline falls inside the current slot is dropped without any error.

**Suggestion 4: evict by fee, and use deadlines only near expiry.**
- Evict invalid transactions first, then the lowest effective priority fee.
- Treat a deadline as a reason to evict only once it falls within the margin a node uses for revalidation. EIP-8272 already asks nodes not to admit references that would expire "almost immediately".

**Cost.** A node holds transactions with deadlines a little longer, and they are exactly the ones it can index without running anything.

**Not suggested: ignoring deadlines in eviction altogether.** A transaction about to expire wastes gossip and builder attention, and dropping it first *near* its deadline is right. What is wrong is ranking a deadline a day away below a fee.

## 4. Inclusion lists: absent for frames as scheduled, order-dependent where built

**In short.** FOCIL, the inclusion-list design scheduled for Hegota, cannot check a frame transaction, so as scheduled it protects none. The proposal that would cover frames needs an extension and two EIPs that are not scheduled. Where it is built, which listed transactions must be included depends on the order the lists arrive in, and one committee member can deny honest transactions for free. We propose covering the simple frame transactions now, and filling the replay budget per list.

### How inclusion lists work, and why frames do not fit

Builders choose what goes in a block, and a few builders build most blocks. FOCIL (EIP-7805) is the defence against them censoring a transaction. Each slot, 16 validators form the inclusion-list committee. Each builds a list of transactions it sees in the public mempool and gossips it. Attesters store the lists, and vote for the next block only if it includes every listed transaction, unless that transaction is invalid at the end of the block or there is no room for it. An omission with no such excuse costs the block its votes.

To check that excuse, FOCIL's execution-layer rule asks, for each listed transaction $T$ that the block left out:

> 3. Validate `T` against `S` by checking the nonce and balance of `T.origin`.

A frame transaction has no `T.origin` in that sense. Its validity is whatever its validation prefix decides when run, and its payer may not be its sender. So an attester cannot tell an excused omission from censorship. The companion account-abstraction study's explainer on inclusion lists noted the gap.

EIP-8369 is the proposal that fills it. It defines two profiles of what a node with partial state (VOPS) can check. Profile 1 is ordinary transactions, checked by nonce and balance. *Every* frame transaction goes in Profile 2:

> [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions with an empty `blob_versioned_hashes` list are Profile 2 candidates.

Profile 2 replays the validation prefix of a listed frame transaction against the state at the end of the block. It needs:
- an extension EIP for the state that replay reads (AA-VOPS), not yet written;
- EIP-8250 and EIP-8272 live;
- "a single composed payload encoding and signature hash for EIP-8141, EIP-8250, and EIP-8272", a sentence older than EIP-8272's move to a canonical frame;
- under ePBS, attesters vote before they see the block's contents, so it must "move omission checks to a post-reveal duty or leave Profile 2 disabled".

**What is scheduled.** Hegota's meta EIP (read 2026-10-08) has exactly two EIPs Scheduled: FOCIL and EIP-8141. EIP-8250 and EIP-8272 are Considered, EIP-8369 Proposed. Glamsterdam's meta EIP, EIP-7773, schedules ePBS, so ePBS comes first.

**What it means.** As scheduled, no frame transaction is protected by inclusion lists in Hegota, and three groups lose.

EOA-wise, a user whose wallet moves from ordinary transactions to frame batches, the main benefit of the EIP for users, loses inclusion-list protection by doing so.

Sponsorship-wise, sponsored and private transactions are what the companion EIPs exist for, and the companion account-abstraction study asks whether a shared payer can be protected at all.

Privacy-pool-wise, the loss is double. Without EIP-8250, a pool that is its own sender has one pending withdrawal network-wide. Experiment 06 measured it: the pool that tracks spends in storage serializes every user, and a second withdrawal evicted the first. A companion study, not published, computes the ceiling at about 300 spends an hour. These are the transactions frames help most: a pool that pays its own gas needs no relayer, and relayers took 224.5 ETH from notes in the last 30 days (experiment 30, below).

**What we measured** ([experiment 25](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/25-inclusion-lists)). We classified the 183 frame transactions mined before experiment 25 under each rule:

| Rule | Eligible | Not |
|---|---:|---:|
| Profile 2 candidate, EIP-8369 as written | 173 | 10 |
| Profile 2 candidate, skipping both optional leading verifier frames (EIP-8272's rule, and ethrex's) | 183 | 0 |
| Profile 1 for frames that need no replay (suggestion 5a below) | 68 | 115 |

The 10 that EIP-8369 leaves out are every transaction with an EIP-8272 recent-root frame: experiment 06's privacy withdrawals and experiment 24's sealed sponsorships. EIP-8369 ignores "the optional EIP-8141 expiry verifier frame for shape matching", but not the recent-root frame, so a prefix that starts with one matches none of its four shapes. Yet those are the transactions its own motivation names: "a privacy spend that checks recent roots and consumes each nullifier as a single-use EIP-8250 keyed nonce". EIP-8272 (changed 2026-10-08) already says "clients MUST skip both optional leading protocol verifier frames", and ethrex does. The fix is editorial (smaller fixes, row 14).

**Suggestion 5a: put the frame transactions that need no replay in Profile 1.** EIP-8141 already names them. Its section *Direct Evaluation of Protocol-Defined Frames* lists three kinds of frame that run no deployed code of their own, so a node can evaluate them without running anything:
- default code;
- the expiry verifier;
- the canonical paymaster.

For the first two, everything the transaction's validity depends on is the sender's code hash, nonce and balance, the payer's code hash and balance, and the deadline. That is exactly what base VOPS keeps, an account's nonce, balance and code flag, plus the block's timestamp.

The amendment to EIP-8369's Profile 1:

> A frame transaction is Profile 1 if every frame of its validation prefix is an expiry verifier frame or resolves to an account with empty code, and every signature those frames use is a `SECP256K1` entry with empty `msg`. Omission is justified if it does not fit the remaining payload gas, or if at the end of the payload the sender's nonce, the payer's balance or code classification, or the deadline makes it invalid.

This covers, from the day frames ship:
- an EOA's batch;
- an EOA's deploy-and-use;
- a friend's code-less sponsorship;
- a deadline-bounded transaction.

It needs no AA-VOPS extension, no code corpus, no replay budget, and none of the unscheduled EIPs, and it survives ePBS exactly where Profile 1 does. Because nothing in it is replayed, no budget rations it, so nothing in the next subsection applies to it.

Where it should live has changed. PR-12394 moves Profile 2's rules into EIP-7805, which is Scheduled, while Profile 1 there still means legacy, EIP-2930, EIP-1559 and EIP-7702 transactions. The paragraph above belongs next to PR-12394's, in EIP-7805, so that it ships with FOCIL whatever happens to EIP-8369. It recognizes an expiry frame by its target, so it also needs the expiry verifier's code to exist at activation (smaller fixes, row 16).

**Cost.**
- Attesters decode frame transactions and verify their `SECP256K1` entries. That is stateless work they already do for ordinary transactions in another encoding. We timed it with ethrex's own functions (experiment 25): decoding a default-code frame transaction and checking its signature takes 50 to 53 $\mu$s on one core, and recovering an ordinary transaction's sender takes 48. A full slot of them costs less than a full slot of ordinary transactions, because they are larger.
- It covers only what an EOA could already do: 68 of our 183 transactions. Accounts with their own `VERIFY`, privacy pools included, still need Profile 2.

**Not suggested: custom `VERIFY` in Profile 1.** A custom validation can depend on state changed earlier in the block, which is why Profile 2 checks it at a claimed position. Checking it at the end of the block brings back the loop that EIP-8369 removed. **Nor the canonical paymaster in Profile 1.** Its admission reads its own signer and withdrawal slots, which is Profile 2's surface.

### Where Profile 2 is built, the order decides

Replaying validation costs attesters time, so Profile 2 bounds it with a budget, `MAX_VERIFY_GAS_PER_IL` $= 2^{20}$ gas per list. A listed transaction is *admitted* while its declared validation cost fits the budget, and only admitted transactions must be included; omitting one that was never admitted is excused. The one implementation is ethrex's `hegota-testnet` branch (`crates/blockchain/focil_profile2.rs` at `c94964843d`), the code the testnet above runs. We ran its own fill function over lists built from our mined transactions, plus transactions from a key that never held any ether ([experiment 25](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/25-inclusion-lists)).

**Capacity: the budget runs per block, not per list.** The Engine API, the interface between consensus and execution clients, hands the execution client one flat array of listed transactions, so ethrex has no list boundaries to fill against. Its own spec says so, and files it as feedback. A slot then protects:

| Kind (experiment) | Bytes | Declared budget | ethrex, $2^{20}$ per block | EIP-8369, $2^{20}$ per list |
|---|---:|---:|---:|---:|
| self-relayed EOA (01) | 188 | 7,800 | 134 | 688 |
| sealed-paymaster sponsorship (24) | 702 | 67,800 | 15 | 176 |
| privacy withdrawal, keyed pool (06) | 747 | 410,000 | **2** | 32 |

The most expensive transactions get the least protection, and the most expensive are the privacy spends. Declared tightly, at the 250,387 gas it uses, a withdrawal fits 4 times per slot.

**Order: the verdict is not a function of the lists.** The consensus specification's `get_inclusion_list_transactions` ends:

```python
    # Deduplicate inclusion list transactions. Order does not need to be preserved.
    return list(set(transactions))
```

ethrex's fill debits the budget in the order it receives. We ran the specification's function itself, under eight hash seeds, on two lists holding 4 withdrawals, 3 sealed sponsorships and 4 EOA transactions. It delivered eight orders, and ethrex admitted eight different sets. Over 5,040 sampled orders of those 11 transactions there are 46 different admitted sets, and each withdrawal is admitted in about 48% of them. Two attesters holding the same lists can therefore disagree about a block that omits one withdrawal. That is the disagreement EIP-8369's "single eligibility boundary" exists to prevent.

**Attack: denial is free.** A committee member lists transactions from a key that has never held ether, each declaring whatever validation cost the attacker likes. The fill checks shape and signature before it debits, and both pass. Replay then finds the transaction invalid, so its omission is excused, and it has used up the budget. A transaction that is never included pays no fee.
- One such transaction declaring $2^{20}$ denies every honest Profile 2 transaction of the slot, in the orders where it comes first.
- Thirty at $2^{20}/30$ each, 4,800 bytes in one list, need no luck with the order: honest withdrawals were admitted in 26% of orders.
- The attacker needs one seat on a committee of 16. If it controls a fraction $p$ of validators, it holds one in a given slot with probability $1 - (1 - p)^{16}$, which is 15% at $p = 0.01$.

**Sorting fixes determinism and nothing else.** A canonical order, by declared cost and then hash, makes the verdict the same everywhere. But junk priced just under a withdrawal's cost still crowds it out: in our thirty-junk scenario it denied every withdrawal and every sponsorship. And a shared budget is not monotone in the lists, which no order repairs. FOCIL tolerates attesters that received different lists because more lists can only mean more to include; the builder declares which lists it covered, in `inclusion_list_bits`. Under one shared budget an extra list can only add debits ahead of a transaction, so an attester that received the attacker's list excuses what one that did not would require.

**Suggestion 5b (to consensus-specs, the Engine API and EIP-8369): fill the budget per list, and carry the lists.** EIP-8369 already says the budget is per list, counted "per IL occurrence before deduplication". What is missing is the boundaries between lists:
- `get_inclusion_list_transactions` returns the timely lists from members that did not equivocate, in committee order, the order `InclusionListBits` already uses;
- the Engine API carries them as an array of arrays, or as the flat array plus, for each transaction, the lists that carry it;
- the execution client fills each list's budget on its own, then deduplicates. A transaction is admitted if any list that carries it admits it.

Admission per list is monotone, so a builder that satisfies the lists its bits declare satisfies every attester whose lists those bits include. An attacker's budget is its own. It can withhold its own list's protection, which it could always do by listing nothing, and it cannot spend anyone else's. In each multi-list scenario we ran, it admitted every honest transaction. That is FOCIL's guarantee that one honest includer suffices, restored for Profile 2.

**Cost.**
- **The Engine API changes shape.** It carries the same bytes, at most $16 \times 8$ KiB per call.
- **The replay bound is $16\,c_{\max}$ per slot.** One honest list must be able to protect a transaction of cost $c_{\max}$ whatever the other fifteen carry, and no fill does better without lowering the cap. That is $2^{24}$ gas at the candidate value, the bound EIP-8369 itself states. Keeping ethrex's $2^{20}$ per slot would mean a per-transaction cap of $2^{16} = 65{,}536$, below what a withdrawal uses. A cap that admits a tightly declared withdrawal needs $16 \times 250{,}387 \approx 4.0$M gas of replay per slot. At the worst compute rate we measured (section 7), about 16 ns per gas, that is 64 ms, and $2^{24}$ is 270 ms, before any state read from disk. EIP-8369 says the number "requires full pipeline benchmarks", and it should be benchmarked before either value is fixed.

**Not suggested:**
- **A canonical order on the flat array.** It is deterministic and protects cheap transactions, but it leaves the verdict non-monotone and expensive transactions denied by cheaper junk.
- **Rationing per sender or per payer.** The attacker's keys are free and never funded, so rationing by key counts keys, not adversaries.
- **Ordering by fee, or by arrival.** A transaction that is never included never pays the fee it declares, and an includer who publishes first would choose the order, which is the attack.
- **Dropping the budget.** Attester replay becomes unbounded.

**The proposal now exists.** [PR-12394](https://github.com/ethereum/EIPs/pull/12394) (to EIP-7805, opened 2026-10-08) has the consensus layer pass, with each deduplicated transaction, a bitvector of the committee positions whose lists carry it. The execution layer fills each position's budget on its own, with no shared budget. Its rationale names this attack: a shared budget "lets one includer exhaust it with maximum cost candidates, which are never executed and so cost nothing". [PR-12396](https://github.com/ethereum/EIPs/pull/12396) (to EIP-8369) fills each list in ascending hash order, rather than the order the includer chose. Bits are a better carrier than our array of arrays: they cost one bitvector per transaction, and the lists can be rebuilt from them. What the two still leave:
- **The recent-root transactions.** *Fixed in both on 2026-10-10.* As first written, PR-12394's shape rule skipped only "a first expiry verifier frame", so it excluded the same 10 transactions as EIP-8369, although its own list of state included "the EIP-8272 recent root entries that `T` references" (smaller fixes, row 14).
- **A per-transaction cap of $2^{18} = 262{,}144$.** Our withdrawal used 250,387 and declared 410,000, so a wallet must declare within 4.7% of what it uses.
- **A cap 2.6 times the public mempool's floor.** The transactions this cap admits and the public mempool's 100,000 does not are the ones includers are least likely to have seen (section 7).
- **The consensus side.** consensus-specs still ends `get_inclusion_list_transactions` with `list(set(transactions))` at `aa16bb4`, and ethrex's branch is unchanged.
- **The benchmark** of the $2^{24}$ replay bound.

What filling per list leaves is the paid grief ethrex's own security considerations record: a transaction that is valid when listed, and invalidated by a cheaper conflicting one in the block. That now costs the attacker an entry in every honest list it must deny, each placed there through the public mempool, instead of one seat anywhere on the committee.

## 5. Validation state has three homes, and they disagree

**In short.** Three rules say where an account may keep the state its `VERIFY` reads, and they name different places. The result is that an EOA delegated to smart-account code can be protected by inclusion lists, or safe to re-delegate, but not both. We propose one fixed, namespaced region instead of "the first four slots".

**Where each rule puts validation state:**
- EIP-8141's public mempool: any storage slot of the sender, and nothing else.
- EIP-8369's Profile 2: slots 0 to `AA_VOPS_SLOT_COUNT` $- 1$ (candidate values 2 to 4) of sender and payer. "Ordinary privacy contract storage, nullifier mappings, commitment trees, and arbitrary external storage" are out.
- Account practice: anywhere but there.
  - ERC-1967, the standard proxy layout, keeps the implementation address at a slot derived from a hash.
  - ERC-7201 places every storage struct at a hash-derived base, so that different code cannot collide.
  - ERC-7579 modular accounts keep a validator's configuration in the validator's own contract, keyed by account. EIP-8141 refuses that read outright (experiment 14: `StorageReadNonSender`), where ERC-7562 allows it as *associated storage*.

**Why delegation makes it sharp.** An EOA can delegate to smart-account code through EIP-7702, and later delegate to different code. Experiment 15 found that storage outlives delegation: a key registered under one delegation was valid again the moment the EOA re-delegated. Namespaced slots are what stop two *different* delegates reading each other's layout, and slots 0 to 3 are exactly where Solidity puts every contract's first variables by default. So:
- a delegated EOA that keeps its validation state where EIP-8369 can see it shares that region with whatever delegate comes next;
- one that namespaces its state, as EIP-7702 guidance recommends, is invisible to EIP-8369.

**What resolves it** was measured in experiment 08: keep *one* commitment, and carry the rest as data in the `VERIFY` frame.
- The commitment held in the code of a proxy costs `VERIFY` 4,262 gas.
- The same commitment in slot 0 costs 6,353, the difference being one cold storage read.

There is a price beyond gas. On ethrex, a prefix that reads any sender slot gave up keyed concurrency: the storage proxy was refused a second pending transaction, and the code proxy was not.

Two open pull requests pull the homes further apart. PR-12394 sets `AA_VOPS_SLOT_COUNT = 4`, which settles the surface on slots 0 to 3. Until 2026-10-10 its rationale named the uses (a passkey's two slots, a second key, a configuration word); it now says only that the value "fixes the ordinary validation storage surface to four words per account". [PR-12340](https://github.com/ethereum/EIPs/pull/12340) widens the mempool's side to "sender authority storage": the sender's storage, plus account-associated storage in a list of immutable contracts that each chain configures. Validation that reads such a contract would be carried by the mempool and outside every inclusion-list surface. Meanwhile PR-12421 and EIP-8298 give EOAs new ways to acquire code, so delegates that share an account's slots will be more common.

**Suggestion 6 (to EIP-8369 and PR-12394): define the surface as a namespaced base, not slots 0 to 3.**

$$\mathsf{base} = \mathsf{keccak256}(\texttt{"eip8369.aa-vops.validation"}) - 1, \qquad \text{surface} = \{\mathsf{base}, \ldots, \mathsf{base} + N - 1\}$$

The base is one constant for every account, so a VOPS node stores those $N$ slots exactly as cheaply as slots 0 to $N - 1$. No compiler uses the region by default, so ordinary state never lands there by accident, and state written there is validation state by convention. $N = 1$ suffices for an account that stores a commitment. A convention that the word commits to the validating code's identity lets a new delegate refuse an old delegate's state.

**Cost.**
- Account authors must write to a specific slot, which Solidity supports through ERC-7201-style layout annotations.
- The surface stops being "the first slots", which was easier to explain.

**Not suggested: admitting per-account hash-derived slots (mappings) to the surface.** That surface is unbounded, and keeping it bounded is why VOPS profiles exist. For the same reason, if PR-12340's authority contracts are admitted to the mempool, the same list belongs in the inclusion-list surface; otherwise validation that reads them is carried and never protected.

## 6. Post-quantum: the account can move, and the EOA only if two Considered EIPs ship together

**In short.** A new contract account can use a post-quantum signature today, at 2.7 times the gas, but the signature is checked in the EVM, cannot be aggregated, and exceeds what the public mempool carries. An existing EOA cannot leave its ECDSA key through anything scheduled. Two Considered EIPs together would give it an exit.

**What a post-quantum user gets in Hegota as scheduled:**
- **A new post-quantum contract account works.** Experiment 17's account holds 1,024 one-time WOTS keys (Winternitz, a hash-based signature) under a Merkle root, chosen by the nonce. It cost 73,481 gas per transfer, against 27,382 for ECDSA. At the Winternitz parameter that minimizes bytes ($w = 256$), the work fits 100,000 gas only after grinding a randomizer, $2^{18.7}$ tries on average.
- **Its signature is `ARBITRARY`, and stays unaggregatable.** The EIP keeps the bytes of protocol-checked signatures away from the EVM "to allow future aggregation schemes", and `ARBITRARY` bytes are exactly the ones the EVM reads. [EIP-8288](https://eips.ethereum.org/EIPS/eip-8288)'s aggregation moves signatures out of the transaction into mempool wrappers, a separate path.
- **It costs more than the public mempool carries.** Post-quantum verification in the EVM runs 150,000 to 200,000 gas (EIP-8288's figures), above the 100,000 every public-mempool node must carry (section 7).
- **It cannot sponsor others at scale.** The canonical paymaster in master "authorizes with a single secp256k1 signer via `ecrecover`". PR-12041 now accepts any scheme the protocol checks except `ARBITRARY`, with signer rotation behind the withdrawal timelock. But no post-quantum scheme is among the ones the protocol checks, and on 2026-10-08 Hegota declined EIP-8355's ML-DSA precompiles. A post-quantum sponsor stays non-canonical, capped at one pending transaction.
- **An EOA cannot leave ECDSA through anything scheduled.** Default code accepts `SECP256K1` only. EIP-7702 delegation adds keys and removes none: in experiment 15 the EOA key kept full power after delegation, signing legacy transactions and new authorizations. PR-12421's set-delegation frame installs the same delegation indicator, and says so: it "does not remove the authority of the account's ECDSA key". EIP-7851 is declined.

**What changed on 2026-10-08: an exit, if two EIPs ship together.** EIP-8298 (`SETCODEFROM`) and EIP-8151 moved to Considered. The path they open:
1. the EOA delegates through EIP-7702 to migration code, which stores its post-quantum wallet state;
2. the code calls `SETCODEFROM` and adopts ordinary wallet code, which is not a delegation indicator;
3. EIP-3607, which refuses transactions signed for an address that has code, then refuses the old key's transactions, and EIP-7702 can no longer re-delegate the account;
4. EIP-8151 makes the `ecRecover` precompile return zero for an account with such code. That closes ERC-2612 `permit`, signed token approvals, and every other contract that checks the old key through `ecRecover`.

Without step 4 the old key still moves tokens through `permit`. Without steps 2 and 3, EIP-8151 has nothing to restrict.

The honest summary: Hegota as scheduled makes post-quantum accounts possible and leaves every existing account on ECDSA. As Considered, it could give them an exit, chain by chain, and only before an attacker able to derive keys can race the migration. What it does not give either kind of account is an efficient post-quantum path in frames: verification stays `ARBITRARY`, in the EVM, unaggregatable, and over the mempool's floor.

**Suggestion 7: ship the exit as a pair, and new schemes only with rotation.**
- Schedule EIP-8151 and EIP-8298 together, or neither: each alone leaves the old key with power.
- Until a post-quantum scheme is one the protocol checks, give the mempool a compute floor that admits in-EVM post-quantum verification (section 7), rather than raising the single cap.
- Version the canonical paymaster to accept any scheme the protocol checks, as PR-12041 now does.
- Admit new schemes by what only the protocol can do with them: check them before execution, and aggregate them. On that test BIP-340 Schnorr comes first, and among post-quantum schemes the one with a credible aggregation path beats the one that verifies fastest. Under the calldata floor, bytes are the cost: a 738-byte WOTS signature pays 66,474 gas of floor before any verification.
- Pair any widening of default code with a way to install code that works for every scheme, so an address derived from a key can still rotate.

**Cost.** Each scheme is consensus code forever, and versioning the canonical paymaster is a migration problem the companion account-abstraction study raised. PR-12041 answers it by pinning a code hash per fork and demoting the instances of an unpinned version, which strands their sponsorship capacity, though not their funds, at each upgrade.

**Not suggested: post-quantum schemes in default code without rotation.** That would make a key the permanent sole owner of an address that can never acquire code: the same dead end, one scheme later.

## 7. The public mempool is a strict subset of ERC-7562

**In short.** Every limit of the frame mempool is narrower than the matching ERC-4337 limit. That is defensible, but it means frames replace only the simple half of ERC-4337 at launch. The one limit that could safely grow is compute, and a separate cap for state would let it.

| Rule | ERC-7562 (ERC-4337's mempool) | EIP-8141 public mempool |
|---|---|---|
| pending per sender | `SAME_SENDER_MEMPOOL_COUNT` = 4 | 1 (more only with EIP-8250 and PR-12039) |
| unstaked paymaster or factory | `SAME_UNSTAKED_ENTITY_MEMPOOL_COUNT` = 10 | 1 (non-canonical) |
| staked entities | unlimited, with reputation | none: recognition by code hash instead |
| storage outside the sender | associated storage allowed | none (PR-12340: a list of authority contracts per chain) |
| validation gas | `MAX_VERIFICATION_GAS` = 500,000 | `MAX_VERIFY_GAS` = 100,000 (PR-12301: a floor, with headroom above) |

Every row is narrower. That is a defensible design: a smaller surface is what makes frame validation cheap enough for inclusion lists and partial statelessness, and lightclient's [mempool strategies note](https://hackmd.io/@matt/frame-mempool) says plainly that "a restrictive policy is fine at launch".

But it means frames replace the *simple* half of ERC-4337 at launch, not all of it. The other half stays where it is.

Token-gas-wise, a sponsor cannot read the user's token balance during validation. So a sponsor paid in tokens either signs every transaction after an off-chain risk check, which makes it a live keyed service that sees each transaction before it propagates, or it bears the risk. Experiment 29 built the second kind with no server at all: the user repays the sponsor in ETH out of a swap in the same atomic batch, and a last frame refunds the unused gas. It works, at 91,276 gas. But every batch that fails is the sponsor's loss, and the user pays nothing:
- 57,595 gas for a user who held no tokens;
- 53,999 for a swap that slipped, which needs no attacker, only a price that moved;
- 4,147,393, close to the sponsor's own cap, for a call built to burn its budget and fail.

The sponsor cannot learn from it either, because it has no storage it may read in validation, and the cap of one pending transaction per non-canonical payer limits it to one user per block, honest or not. The one read that would refuse the empty wallet, the token's `balanceOf(sender)`, was refused with `StorageReadNonSender`. ERC-7562 allows exactly that read, as storage associated with the sender (its rule STO-021). Experiment 04's sponsor, paid in tokens, lost 218,760 gas in simulation to a sender who held none.

Module-wise, ERC-7579 external validators must be rewritten as `DELEGATECALL` modules with namespaced state in the account (experiment 14).

Compute-wise, validation over 100,000 gas does not reach every node: a Groth16 privacy proof is 245,000 to 249,000 (experiment 06).

For wallets, the migration path is not "frames instead of ERC-4337". It is to move what fits, keep an ERC-4337 path for what does not, and expect the gap to close by *declarations*: keyed nonces, recent roots, payers whose safety can be decided from their code. It will not close by reopening associated storage.

**Not suggested: associated storage for frames.** It is the one ERC-7562 rule that would bring ERC-20 sponsorship back, and it is the one that would break every VOPS surface above. Experiment 29 prices the choice: without it, a sponsor with no server pays for every failure, up to its own cap.

**What can safely grow is compute** ([experiment 26](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/26-validation-cpu)). We timed ethrex's own admission check, `Blockchain::validate_transaction`, on prefixes that spend their gas on the most expensive work a prefix may legally do. The slowest work per gas is elliptic-curve arithmetic: alt_bn128 multiplication at 16.0 ns per gas on one core, a BLS12-381 pairing at 15.9, ECDSA recovery at 14.3. So a cap of $C$ gas bounds compute at about $16\,C$ ns:

| Cap | Worst compute |
|---:|---:|
| 100,000 (`MAX_VERIFY_GAS`) | 1.6 ms |
| 250,000 (fits experiment 06's Groth16 prefix) | 4.0 ms |
| 500,000 (the Hegota testnet's node flag) | 8.0 ms |

- The prefixes that need more than 100,000 already run near that rate: Groth16 at 13.1 ns per gas, a 40-key multisig at 15.0. A cap set from the worst rate wastes little on them.
- Hash-based verification runs at about 5.7, so the same cap gives a hash-based post-quantum account three times the margin it needs.
- A cold state read served from memory runs at 1.4, about 2.9 $\mu$s a slot. State becomes the binding resource only once a read from disk costs more than about 34 $\mu$s, and its other cost is fan-out (section 2), which depends on the number of reads, not their time.
- Every admission also costs about 30 $\mu$s that no gas counts, about 1,900 gas at the worst rate.

So gas is a good enough unit for compute, and the reason not to simply raise the cap is state. At 250,000 the single cap allows 119 cold reads instead of 47. Two caps (smaller fixes, row 9) let compute grow to 4 ms while the state allowance stays where it is.

**Where PR-12301 leaves this.** [PR-12301](https://github.com/ethereum/EIPs/pull/12301) makes `MAX_VERIFY_GAS` a floor: a node must carry any transaction whose declared validation budget is at or below it, and may carry heavier ones as headroom, so "the heavier its validation work the fewer nodes carry it". That makes the three values we found on frames-devnet-0 legitimate, and for compute it is the right shape. Two things it leaves:
- **The floor is still one dimension.** A node that grants a 250,000-gas Groth16 prefix headroom grants 119 cold reads with it.
- **The transactions above the floor are the ones inclusion lists exist for.** PR-12394 admits Profile 2 candidates up to 262,144, which is 2.6 times the floor, so privacy spends and post-quantum accounts are exactly the transactions includers are least likely to have seen. EIP-8369's fallback is to submit directly to an includer, and for a privacy spend that links the spender's network address to the spend.

A compute floor of 250,000 beside a cap of today's 47 cold reads closes both.

## Wallets on frames: three experiments

**In short.** Our wallet survey ([What Wallets Ship Today](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/posts/wallets-and-frames.md)) read what 45 wallets and providers ship, and proposed eight experiments. We ran the three that decide the most. A dapp needs no change. Gas paid in tokens needs no server, at a price the sponsor pays. A privacy withdrawal needs no relayer, and that is where frames save users the most money.

### A dapp does not need to change (experiment 28)

Every wallet and provider in the survey serves dapps through EIP-5792: `wallet_sendCalls` sends a batch of calls, `wallet_getCallsStatus` reports what happened. Sponsorship rides on ERC-7677's paymaster web service, written for ERC-4337's EntryPoints. We wrote a wallet that answers those calls with frame transactions, and a paymaster service in ERC-7677's shape in front of a canonical paymaster. The dapp was viem's stock actions, unchanged:

```
 dapp (viem: getCapabilities, sendCalls, waitForCallsStatus)
   |  wallet_sendCalls { calls, atomicRequired, capabilities.paymasterService }
   v
 wallet (EIP-1193 provider, EOA with no code)          paymaster service (ERC-7677 shape)
   |  [0] VERIFY  -> sender   APPROVE(EXECUTION)          pm_getPaymasterStubData
   |  [1] VERIFY  -> PM       APPROVE(PAYMENT)  <-------  pm_getPaymasterData, twice:
   |  [2] SENDER  -> call 0   (atomic flag)               its signer signs the sig hash
   |  [3] SENDER  -> call 1
   |  sign a draft, simulate, tighten limits, sign the final, simulate, send
   v
 node --> receipt: payer, and per frame [status, gas, logs] --> wallet derives 200 / 500 / 600
```

Gas-wise, the steady-state approve-and-swap cost 90,321 as frames, 92,143 through an EIP-7702 delegate's `executeBatch`, and 167,458 through ERC-4337's EntryPoint v0.8. Sponsoring it cost 9,821 more, and the user's own wallet sent it: no relayer. Frames needed no delegation either, where a 7702 wallet must first send a 58,052-gas type-4 transaction before it may answer `atomic: supported`.

Semantics-wise, one frame transaction carries both of EIP-5792's modes. With `atomicRequired`, the calls commit or roll back together. Without it, they are independent frames of one transaction, and two of three calls persisted after the second failed. A delegate's `executeBatch` reverts everything on any failure.

Status-wise, the wallet has to derive what happened, because the receipt has no transaction status. ethrex's JSON derives `status: 0x0` whenever any frame failed, which reports the partial success above as a complete failure, and viem's fallback reads exactly that field. In the atomic case, the approve's frame reports SUCCESS although its batch rolled it back, as the EIP defines it. Our wallet knew which frames formed the batch because it built them. An indexer does not (smaller fixes, row 10).

Estimation-wise, the node simulates only a transaction whose validation prefix approves, so a placeholder signature cannot be simulated. ERC-4337 has the opposite rule: an account should fail softly on a wrong signature so that gas can be estimated. Our wallet signed twice, once over generous limits and once over the final ones, and called the paymaster three times instead of ERC-7677's two. The simulation also reports no state gas per frame, so the wallet gave every call a fixed 379,440 of state budget. The draft's limits reserved 1.75 times the final maximum cost (smaller fixes, row 18).

Binding-wise, ERC-7677 needs two fields it does not have, the pay frame's state budget and the payer's signature entries, and a policy refusal has no error code. A call without `to`, which EIP-5792 allows as a deployment, has no frame: a `SENDER` frame with no target calls the sender.

### Gas in tokens with no server (experiment 29)

Section 7 has the numbers. The layout is the point here, because the whole policy is in it:

```
 sender = USER (holds Token A, no ETH)        payer = GasForOutput (no storage, no signer)
 ------------------------------------------------------------------------------------------
 [0] VERIFY  -> USER     APPROVE(EXECUTION)     default code
 [1] VERIFY  -> GFO      APPROVE(PAYMENT)       max cost <= cap; [2..3] atomic SENDER frames;
                                                [4] repays >= max cost; [5] is its post-op
 [2] SENDER  -> token    approve(dex, x)        \
 [3] SENDER  -> dex      swapForEth(x, min)      |  one atomic batch: if anything fails,
 [4] SENDER  -> GFO      value = max cost       /   the repayment fails with it
 [5] DEFAULT -> GFO      post-op: refund the unused gas, if [4] succeeded
```

`FRAMEPARAM` lets the sponsor check every frame's mode, flags, target and value, so the repayment is enforced by the layout, not by a server. What the layout cannot do is see the token balance, and so a batch that fails costs the sponsor and nobody else.

### A privacy withdrawal with no relayer (experiment 30)

A withdrawal from a privacy pool goes to a fresh address, which has no ETH for gas. Today somebody else sends it and the note pays them out of the withdrawal: a Tornado Cash relayer, a Privacy Pools relayer, a Railgun broadcaster. We read every withdrawal from Tornado Cash's four ETH pools and Privacy Pools' ETH pool over 30 days of mainnet, blocks 25,972,879 to 26,188,878:

| Pool | Withdrawals | Paid their own gas | Median fee | Median relayer gas | Fee / gas | No relayer, same price |
|---|---:|---:|---:|---:|---:|---:|
| Tornado 0.1 ETH | 5,447 | 5% | 0.002080 | 0.000426 | 5.1x | 0.000612 |
| Tornado 1 ETH | 2,285 | 20% | 0.005850 | 0.000286 | 19.9x | 0.000395 |
| Tornado 10 ETH | 1,189 | **49%** | 0.041774 | 0.000242 | 172.8x | 0.000337 |
| Tornado 100 ETH | 553 | 24% | 0.431695 | 0.000434 | 1,053.4x | 0.000628 |
| Privacy Pools ETH | 611 | 4% | 0.000170 | 0.000099 | 1.4x | 0.000095 |

Amounts are in ETH. The last column prices the frames withdrawal below at each relayed withdrawal's own gas price. Over the window, notes paid relayers **224.5 ETH for 3.35 ETH of gas**, and the same withdrawals with no relayer would have cost **4.65 ETH**. 33 addresses relayed all 8,614, and one sent 77% of Privacy Pools'.

Two things in that table are the privacy story rather than the price story. First, 1,471 withdrawals, 15% of all and 49% of the 10 ETH pool's, were sent by an address that already held ETH, and 661 by the recipient itself. That is the link relayers exist to prevent, accepted to save the fee: in the 10 ETH pool a median of 0.042 ETH, 0.4% of the note, for 0.00024 ETH of gas. Second, a relayer sees every request it relays as it arrives, and can refuse it.

With frames, experiment 06's pool is its own sender and pays the gas from the note. But the note's fee is fixed in the proof, and the pool may approve payment only if the fee covers the maximum cost, so with ordinary headroom the note pays

$$\text{fee} \ge \Big(g_{\text{intrinsic}} + \sum_i \ell_i\Big) \cdot f_{\max} \qquad\text{for a charge of}\qquad \Big(g_{\text{intrinsic}} + \sum_i u_i\Big) \cdot p$$

where $\ell_i$ and $u_i$ are frame $i$'s limits and use, $f_{\max}$ the max fee and $p$ the price paid. Priced the way a wallet prices, with a max fee twice the price and limits 1.25 times use, the note paid **2.56 times** its gas, and experiment 06's pool kept the difference. A last frame can refund it, and it needs no oracle. The frames' use is in `FRAMEPARAM`, and with no blobs and no signatures the intrinsic gas the protocol does not expose falls out of the max cost:

$$g_{\text{intrinsic}} + \sum_i \ell_i = \frac{\texttt{TXPARAM(0x06)}}{\texttt{TXPARAM(0x04)}}$$

```
 WITHDRAWAL   sender = POOL   signatures = []   nonce key = the nullifier hash (EIP-8250)
 ----------------------------------------------------------------------------------------
 [0] VERIFY  -> 0x..8272  (source_id, slot, root)        protocol: the root is recent
 [1] VERIFY  -> POOL      APPROVE(EXECUTION_AND_PAYMENT)  proof; fee >= max cost; this layout
 [2] SENDER  -> POOL      withdraw(proof, ..., fee)       recipient gets amount - fee
 [3] DEFAULT -> POOL      refund                          recipient gets fee - bound on charge
```

The refund frame counts its own limit as used, so the pool never refunds more than the transaction leaves it. On the testnet the note then paid **1.023 times** its gas: the bound was off by exactly the 13,469 gas the refund frame left unused, and the frame cost 11,820 gas.

**What it means.** Frames help privacy the most where today's market charges a percentage of the note: 14 to 729 times cheaper on Tornado's 1, 10 and 100 ETH pools, by median. Where a relayer already charges about gas, as Privacy Pools' does, the saving is 1.4 times, and the gain is the removal of the party. The comparison is conservative: our 593,130 gas includes 281,520 of state gas on the testnet's EIP-8037 schedule, for the nullifier's nonce key and the recipient's new account, which today's mainnet prices at about 47,000. What frames do not remove is the network path. A withdrawal still reaches a node from some IP address, and only Tor, a mixnet or the user's own node hides it. Railgun's broadcasters, reached over Waku, do that part today.

## Four clients, one chain

**In short.** Four clients compute the same chain from frame transactions. They disagree about which transactions to admit, what to return over JSON-RPC, and what to say when they refuse. None of that is consensus, and all of it is what a wallet meets first.

frames-devnet-0 runs geth, Nethermind, reth and ethrex behind one RPC endpoint ([experiment 22](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/22-cross-client)). Our test account has no funds there, so we asked what four clients can be asked without spending anything.

Block-wise, they agree:
- At 50 of 50 heights they served the same block hash, state root and receipts root.
- All 2,000 frame transactions in 200 blocks re-encode to their hash under our implementation, every secp256k1 entry recovers over our signature hash, and every receipt's `gasUsed` equals our settlement of its frames.
- The coverage is narrow: 5 transaction shapes, all self-relayed and secp256k1, with no sponsor, no contract account and no state gas.

Admission-wise, they disagree. We sent 49 probes, each breaking one rule, to each client. The divergences:

| Probe | geth | Nethermind | reth | ethrex |
|---|---|---|---|---|
| any frame rule, unfunded sender | `insufficient funds` before any frame rule | the rule | the rule | the rule |
| validation prefix of 150,000 | funds | **funds: within its cap** | `MAX_VERIFY_GAS` | `MAX_VERIFY_GAS` |
| wrong signature on an entry no frame reads | funds | signature | "prefix execution failed" | signature |
| zero-fee sponsored transaction | min tip | **accepted, and held** | prefix failed | min tip |

Bisection gave three values of one constant: `MAX_VERIFY_GAS` is 100,000 on reth and ethrex, 300,000 on Nethermind, and 500,000 on ethrex's Hegota build.

*Rerun on 2026-10-13, on geth's 2026-10-09 build.* geth's column has changed. It now names the broken rule for 44 of the 49 probes: it checks frame rules, then the minimum tip, then signatures and the public mempool's caps, and only then the balance. It refuses the 150,000 prefix ("frame validation prefix exceeds gas limit") and bisects to 100,000 and 500,000, the EIP's values. Three values are still deployed. The other three clients, the chain and their JSON are unchanged.

RPC-wise, they disagree on what they return. Of the 39 transaction fields the four serve over JSON-RPC, 21 are not served by all four. `gas` alone has three meanings: `max_gas`, the sum of frame limits, or absent.

Error-wise, they say too little. "The validation prefix reverted" covered an unfunded payer, an unbudgeted account-creation charge and a missing signature entry, from three clients. A wallet cannot tell "fund this account" from "budget account creation" from "sign entry 0".

Time-wise, a gas price is a bound on work only for clients built like the one that set it (experiment 26). Two things we found inside ethrex:
- It verifies each protocol signature twice on admission, once over the signature list and again inside the prefix simulation. One `SECP256K1` entry adds 89 $\mu$s over an empty prefix, two recoveries' worth, for the 2,800 gas the protocol charges.
- Built without its assembly backend, the portable path its zero-knowledge virtual machine builds take, `P256VERIFY` runs at 36.0 ns per gas. That is 3.9 times its rate with the backend, and more than twice the slowest operation of a normal build.

## Smaller fixes

Suggestions 1 to 7 are in the numbered sections. The rest are smaller: a sentence of the EIP, a local rule or an RPC, each with its evidence. They are numbered on from 8, and the numbers are stable across versions of this post. Rows 14 to 17 came out of experiments 25 and 26, and row 18 out of experiment 28. Where an open pull request touches a row, the row says so.

| # | Suggestion | Evidence | Not suggested |
|---|---|---|---|
| 8 | Allow `TIMESTAMP` only while executing a frame whose target is the expiry verifier. Optionally, add a not-before time to the expiry frame's data | ethrex admits a nested call to the verifier: a hidden deadline, the EIP's own example attack (experiment 19). PR-12252 adds `valid_after` and keeps the wording that admits the nested call | `TIMESTAMP` in `VERIFY` generally |
| 9 | Meter the validation prefix in two dimensions: cold state access, capped where today's floor is, and total, capped by a CPU benchmark | the workloads over 100,000 (Groth16, unground WOTS, 40-key multisigs) are compute, not state access (experiments 06, 17). The worst work runs at about 16 ns per gas, Groth16 at 13.1, state from memory at 1.4, so a total cap is a time budget of 16 ns per gas, 4 ms at 250,000 (section 7). PR-12301 makes the cap a floor; it should be a floor in both dimensions | raising the single cap, which raises the worst case for state access with it: from 47 cold reads to 119 at 250,000 |
| 10 | A receipt status 3, ROLLED_BACK, for frames undone by their atomic batch | all four clients report them `SUCCESS` while their logs and state changes are gone (experiments 03, 22). A wallet serving EIP-5792 had to remember which frames formed the batch to report it, and ethrex's derived `status` calls a partly successful non-atomic batch a failure (experiment 28) | marking them FAILURE |
| 11 | State `MAX_VERIFY_STATE_GAS` in state bytes, and size it for EIP-8250's keys | a re-derivation of the gas cost per state byte silently shrinks what the rule admits. At 97,920 state gas per fresh key, 500,000 admits 5 fresh keys of the 16 EIP-8250 allows, fewer beside a deploy frame | |
| 12 | One stated order of admission checks; a small enum of rejection reasons; `gas` defined or dropped for type `0x06` | three orders and four error vocabularies (experiment 22). PR-12321 defines the order; the enum and `gas` remain | |
| 13 | Reconcile the paymaster text: one sentence makes a transaction "eligible ... only if the `pay` frame targets a canonical paymaster instance", and the next section admits non-canonical ones | EIP-8141 master; PR-12041's rewrite of the section is the place to fix it | |
| 14 | EIP-8369's shape rule, and PR-12394's copy of it, skip both optional leading verifier frames, as EIP-8272 already says; EIP-8369 drops the two sentences that predate EIP-8272's canonical frame | as written it leaves out 10 of 183 transactions, exactly the recent-root ones its motivation names (experiment 25, section 4). PR-12394 and PR-12396 make both changes since 2026-10-10 | |
| 15 | The omission check's gas fit uses EIP-8141's two-dimensional test, not one comparison against `T.gas` | 104 of 183 transactions declare state gas, median 97,920; the largest declares 30,070,620 for five contract creations. With one dimension, a transaction that creates an account needs room in the dimension it does not use (experiment 25). PR-12394 makes exactly this change | |
| 16 | Require each keyless-deployed contract to exist at activation, as EIP-8250 does, in EIP-8141 (the expiry verifier) and EIP-8272 (recent roots); evaluate the expiry frame directly only when its canonical code is present | EIP-8141 and EIP-8272 moved to keyless deployment on 2026-10-06 and 2026-10-08, and only EIP-8250 states the requirement. Where the contract is missing, a client that evaluates the expiry frame directly accepts what a client that executes it refuses: the empty address runs default code, which finds no signature | installing them at the fork, which the EIPs moved away from so that activation changes no state |
| 17 | Retry a prefix that failed to approve payment only when something it depended on at admission changes | `857622a` bounds unpaid producer work by a count of attempts, and asks for more than one because failures can be transient (section 2) | a count of attempts, which either wastes work or evicts what was about to become valid |
| 18 | A simulation RPC for type `0x06` that runs a transaction whose signature entries are placeholders, reports what each frame would approve, and reports execution and state gas per frame | the node simulates only a prefix that approves, so our EIP-5792 wallet signed twice per transaction and called the paymaster service three times. No per-frame state gas came back, so it gave every call a fixed 379,440 of state budget, and the draft reserved 1.75 times the final maximum cost (experiment 28) | estimating by hand from the gas constants, which every wallet would then get wrong in its own way |

## What we would not change

- **Fees inside the canonical hash.** Section 1: outside it, whoever relays a self-paying account's transaction sets its tip. Accounts that do not pay can already leave the fees out, through an explicit digest.
- **No third-party storage in `VERIFY`.** Section 7: it is the price of a validation surface small enough for inclusion lists.
- **No staking or reputation.** Recognition by code hash got the canonical paymaster to four users per block without either, and decidable properties extend it, once they decide the right property.
- **Protocol signature bytes hidden from the EVM.** It is what keeps aggregation possible.
- **Signature bytes priced as data.** A discount would reopen the bound on data per block, and post-quantum signatures are where the bytes will be.
- **EIP-8272's in-window immutability.** Section 3: revocation belongs to the contract that reads the root, by composition, not to a write that could invalidate pending transactions.
- **The explicit `msg` as the extension point.** Section 1: an execution-only digest needs no second protocol hash. An ERC can be versioned, and a canonical hash is fixed forever.
- **A replay budget on Profile 2.** Section 4: without one, attester replay is unbounded. What has to change is how it is filled, not whether it exists.

## Conclusions

Is EIP-8141 done? As a state transition, yes. Four clients compute the same blocks, an implementation that shares no code with them reproduces 2,000 of their transactions, and everything we ported from ERC-4337 works at less gas. We found nothing in block execution that needs more than the receipt status of row 10.

As something a user can rely on, no, and the reason is the same in every section. What a user relies on is decided before the block: by mempool nodes that simulate a prefix nobody pays for, by includers that must decide which transactions a builder owed them, and by wallets that must price a transaction before it is signed. The rules that already work there share one shape: they are *declarations* a node can check without running anything. A nonce key, a recent root, a deadline, a paymaster recognized by its code, a frame layout a sponsor reads with `FRAMEPARAM`. The rules that fail all *infer* something, from running code (section 2's opcode scan, section 4's replay) or from the order things arrived in (section 4's lists, section 3's eviction). So our suggestions are mostly of one kind: replace an inference with a declaration, or bound what the inference can cost.

For wallets the picture is better than the mempool's. A dapp needs no change at all, because EIP-5792 already describes what a frame transaction is. Sponsorship and token gas work, but each brings back a server or a risk the sponsor carries, because the one read that would decide it is the storage read the mempool forbids. And the biggest gain is where frames remove a party outright: a privacy pool that pays its own gas makes a withdrawal 14 to 729 times cheaper than a relayer on most of Tornado Cash's pools, and stops 15% of users linking themselves to avoid that fee. That gain depends on EIP-8250, which is only Considered, and on a way to reach a node that does not reveal the user, which frames do not provide.

## Open questions, and what we run next

Experiments 25 to 27 answered the three questions an earlier version of this post left open: an attester cost model for suggestion 5, a CPU benchmark for suggestion 9, and an ERC for $E$. Experiments 28 to 30 answered three of the eight the wallet survey proposed. What is left:
- **The Profile 2 replay bound.** Suggestion 5b makes an attester's worst case $16\,c_{\max}$ per slot, $2^{24}$ gas at the candidate value: about 270 ms of compute at the worst rate we measured, before disk. That needs a benchmark of the whole pipeline, and a decision on $c_{\max}$, before either is fixed.
- **Disk.** Experiment 26 read state from memory. The state half of suggestion 9 needs a cold read from disk, which is where state becomes the binding resource, above about 34 $\mu$s per slot.
- **A rerun on code that implements the 2026-10-08 changes:** the approval rollback, the keyless addresses, and EIP-8250's 12,100 gas per key. The rollback is a consensus change none of our four-client checks exercised.
- **A funded run on the four-client devnet, and on its successor with EIP-8250 and EIP-8272:** every shape the devnet's load generator does not send, including both paymasters of experiment 24 and the execution digest of experiment 27, read back from four clients.
- **Review of the ERC draft**, and whether a protocol execution hash is ever warranted: for RPCs that must show an operation's identity, or for EOAs that want execution-only signatures without a contract.
- **Comments on PR-12394**: whether its per-transaction cap and the public mempool's floor should be the same number. (The shape rule, our other comment, was fixed on 2026-10-10.)
- **Estimation (row 18).** What a simulation RPC that takes placeholder signatures should return, and whether it belongs in execution-apis beside PR-860 and PR-907 or in a wallet ERC.
- **The refund pattern.** Experiment 30's refund frame, and the $\texttt{TXPARAM(0x06)} / \texttt{TXPARAM(0x04)}$ identity it rests on, serve any post-op that refunds. The identity fails once a transaction carries blobs or signature entries, or once the calldata floor binds, and a wallet-facing standard would need a parameter that exposes the intrinsic gas directly.
- **The rest of the wallet survey:**
  - W2, a gas account paying for its owner's other accounts: how many pending sponsorships each client admits, and the fan-out of one transfer (suggestion 3);
  - W4, ERC-7715 permissions as a frames policy, and where the mempool's rules on storage and time stop them;
  - W5, a passkey in a real browser, against experiment 11's WebAuthn account;
  - W7, an ERC-7730 descriptor for $E$, so a hardware wallet can show what it signs;
  - W8, one signature for owner rotation on two chains, and its replay risks.

Every number above has a directory, a README, a command and a transaction hash behind it in [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames). Corrections are very welcome, especially from the EIP authors where we have read intent into text that does not state it.

## Appendix A: what changed upstream while we wrote

**Before 2026-10-09.** On 2026-10-09 we re-read every EIP above, the open pull requests against them, consensus-specs (at `aa16bb4`) and ethrex's testnet branch (still `c94964843d`). In the two weeks before:
- **Merged into EIP-8141:**
  - a block producer may evict a transaction whose validation prefix keeps failing to approve payment, after more than one attempt ([`857622a`](https://github.com/ethereum/EIPs/commit/857622acc95d59c0b52bc92cf862a15d823bf5db));
  - the expiry verifier became an ordinary contract deployed by a keyless transaction, at `0x81413f0c...`, instead of a predeploy at `0x8141` ([`88fa3e4`](https://github.com/ethereum/EIPs/commit/88fa3e4d24efb0dffdbe1fda2765060b870de784));
  - an approval made inside a call that later reverts is now undone with it ([`af80fc1`](https://github.com/ethereum/EIPs/commit/af80fc1c4122c4990b8c84bfd10be60c6e343bb2), 2026-10-08).
- **EIP-8250** ([`e328506`](https://github.com/ethereum/EIPs/commit/e32850647e72d6287b7778c6899007abd1a78b1d), 2026-10-08): the nonce manager is keyless-deployed, each non-zero key costs 12,100 execution gas besides its first-use state gas, and keyed nonces enter the block access list. It is still Considered.
- **EIP-8272** ([`5e32ce9`](https://github.com/ethereum/EIPs/commit/5e32ce9abb16d8a8d1a55b65fc2aa55b606b882c), 2026-10-08): the recent-root contract is keyless-deployed, and shape matching skips both leading verifier frames.
- **Hegota, EIP-8081** ([`f154af8`](https://github.com/ethereum/EIPs/commit/f154af816c4e3467ea3a86e064e4d3493ab2a8e0), 2026-10-08): EIP-8355's ML-DSA precompiles are Declined; EIP-8151 and EIP-8298 moved to Considered. FOCIL and EIP-8141 are still the only EIPs Scheduled.
- **Open pull requests:**
  - [PR-12394](https://github.com/ethereum/EIPs/pull/12394): budgets per inclusion-list member, and a two-dimensional gas fit (section 4);
  - [PR-12396](https://github.com/ethereum/EIPs/pull/12396): each list filled in hash order (section 4);
  - [PR-12421](https://github.com/ethereum/EIPs/pull/12421): a frame that installs an EIP-7702 delegation (sections 2 and 6);
  - [PR-12041](https://github.com/ethereum/EIPs/pull/12041): the canonical paymaster accepts any scheme the protocol checks, with signer rotation (section 6);
  - [PR-12301](https://github.com/ethereum/EIPs/pull/12301): `MAX_VERIFY_GAS` as a floor, with headroom above it (section 7);
  - [PR-12321](https://github.com/ethereum/EIPs/pull/12321): one order of admission checks (smaller fixes);
  - [PR-12340](https://github.com/ethereum/EIPs/pull/12340): sender authority storage (section 5);
  - [PR-12252](https://github.com/ethereum/EIPs/pull/12252): a not-before time in the expiry frame (smaller fixes).

Two findings moved. Section 4's budget per list is now a pull request, and section 6's "no exit for an EOA" holds only until EIP-8151 and EIP-8298 ship together. The rest stand, and each section says where a pull request touches it. Our testnet's code predates all of the above: its expiry verifier is at `0x8141`, and it does not charge EIP-8250's 12,100 gas per key, so experiment 06's withdrawal would now cost 12,100 more per key.

**Since 2026-10-09.** On 2026-10-13 we read everything again, reran experiment 22 and read ethrex's branches.
- **EIP-8141** (2026-10-09): the `TXPARAM`, `FRAMEPARAM` and `SIGPARAM` parameters have names ([`7752622`](https://github.com/ethereum/EIPs/commit/7752622050d9d77c46b578351eba9cfb5125f087)), and the validation prefix is defined under Behavior, as "the frames up to and including the first frame after whose execution `payer` is set" ([`af3a780`](https://github.com/ethereum/EIPs/commit/af3a7802c8ea516f717c6013e27d0f529046f007)).
- **PR-12394 and PR-12396** (2026-10-10 and 2026-10-12): the declared prefix takes an optional recent-root verifier frame, which fixes smaller fixes row 14 in both; a replay may load at most 16 code bodies and 131,072 bytes of code; Profile 2 activates only once EIP-8250 and EIP-8272 are live, and until then "omission of an EIP-8141 frame transaction is excused".
- **PR-12301** (2026-10-12): a transaction above the floor "is included only if it reaches a block producer whose headroom accepts it".
- **The ethpandaops devnet** is now reached at `bogota-devnet-0`, the same chain. Its geth, rebuilt on 2026-10-09, now checks frame rules and signatures before the balance and enforces both caps at the EIP's values (section "Four clients, one chain").
- **ethrex's Hegota nodes** have returned a reorganized-out block's transactions to the pool since 2026-10-07 13:10 UTC, the likely cause of the dropped dependent transactions in experiments 07, 15 and 16. They still keep an approval made in a call that reverted: ethrex fixed that on 2026-09-22, on a branch the nodes do not run.

## Appendix B: sources

- **Experiments**, one directory each with a README, scripts, contracts and mined fixtures: [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames) (start at its [README](https://github.com/4w44h9jckz-boop/exp-frames#readme)). This round: [23, approval scope](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/23-approval-scope), [24, sealed paymaster](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/24-sealed-paymaster), [25, inclusion lists](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/25-inclusion-lists), [26, validation CPU](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/26-validation-cpu) and [27, execution digest](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/27-execution-digest); for wallets, [28, `wallet_sendCalls`](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/28-wallet-send-calls), [29, token gas](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/29-token-gas) and [30, relayer-free withdrawal](https://github.com/4w44h9jckz-boop/exp-frames/tree/main/experiments/30-relayer-free-withdrawal).
- **The wallet survey** these three came from: [What Wallets Ship Today](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/posts/wallets-and-frames.md).
- **Mainnet sources for experiment 30:** the pool addresses from [tornado-cli's `config.js`](https://github.com/tornadocash/tornado-cli) and [Privacy Pools' deployments page](https://docs.privacypools.com/deployments), and Railgun's broadcaster fee model from [its documentation](https://docs.railgun.org).
- **Rust wallet ports:** [kohaku-rs, branch `experiment/frames`](https://github.com/4w44h9jckz-boop/kohaku-rs/tree/experiment/frames).
- **Companion studies we draw on rather than repeat:** an earlier study of account abstraction and the gas market for private transactions, including its questions for the specification authors; and a composition framework for privacy protocols on frames. Neither is published.
- **Related reading:** Nero_eth, [Frame transactions and the three gates to privacy](https://ethresear.ch/t/frame-transactions-and-the-three-gates-to-privacy/24666); lightclient, [Mempool Strategies for EIP-8141](https://hackmd.io/@matt/frame-mempool).
- **The same findings ranked by difficulty:** [Frame Transaction Open Problems](https://github.com/4w44h9jckz-boop/exp-frames/blob/main/posts/frame-transactions-open-problems.md).
