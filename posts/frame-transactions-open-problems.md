# Frame Transaction Open Problems

Nineteen problems that stand between [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions and something a user can rely on, ranked from the hardest to fix to the easiest. Damage is rated separately, because the two orderings disagree: the most dangerous problem that is cheap to fix (problem 11) sits near the bottom.

Each problem says what it is, how it happens, what it can cost, what recent changes did to it, and the fix we propose. Experiments are cited by number from [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames), where each is a branch with its scripts, contracts and mined transactions; problems in this list are cited as "problem N". The argument behind most of them is in the companion post, [Is EIP-8141 Done?](https://github.com/4w44h9jckz-boop/exp-frames/blob/post/ethresearch/posts/frame-transactions-in-practice.md).

We read every EIP named here at master on 2026-10-09, with the open pull requests against them, consensus-specs at `aa16bb4`, and ethrex's `hegota-testnet` branch at `c94964843d`.

## What changed in the last two weeks

- **Merged into EIP-8141:**
  - an approval made inside a call that later reverts is undone with it (`af80fc1`, 2026-10-08);
  - the expiry verifier is a keyless-deployed contract at `0x81413f0c...`, no longer a predeploy at `0x8141` (`88fa3e4`);
  - a block producer may evict a transaction whose validation prefix keeps failing to approve payment (`857622a`).
- **EIP-8250** (2026-10-08): the nonce manager is keyless-deployed; each non-zero key costs 12,100 execution gas besides its 97,920 state gas on first use; keyed nonces enter the block access list.
- **EIP-8272** (2026-10-08): the recent-root contract is keyless-deployed.
- **Hegota, EIP-8081** (2026-10-08): EIP-8355's ML-DSA precompiles are **Declined**. EIP-8151 (ecRecover returns nothing for accounts with code) and EIP-8298 (`SETCODEFROM`) are now **Considered**. FOCIL and EIP-8141 are still the only EIPs Scheduled.
- **Open pull requests that change the analysis:**
  - [PR-12394](https://github.com/ethereum/EIPs/pull/12394): per-member inclusion-list budgets and a two-dimensional gas fit;
  - [PR-12396](https://github.com/ethereum/EIPs/pull/12396): each list filled in hash order;
  - [PR-12421](https://github.com/ethereum/EIPs/pull/12421): a frame that installs an EIP-7702 delegation;
  - [PR-12041](https://github.com/ethereum/EIPs/pull/12041): the canonical paymaster accepts any protocol-verified scheme, with signer rotation;
  - [PR-12301](https://github.com/ethereum/EIPs/pull/12301): `MAX_VERIFY_GAS` as a floor, with headroom above it;
  - [PR-12321](https://github.com/ethereum/EIPs/pull/12321): one order of admission checks;
  - [PR-12340](https://github.com/ethereum/EIPs/pull/12340): sender authority storage;
  - [PR-12252](https://github.com/ethereum/EIPs/pull/12252): a not-before time in the expiry frame.
- **Unchanged:** consensus-specs still ends `get_inclusion_list_transactions` with `list(set(transactions))`, and ethrex's testnet branch has not moved.

## Summary

| # | Problem | Fix difficulty | Damage | After recent changes |
|---|---|---|---|---|
| 1 | No efficient post-quantum path; EOAs leave ECDSA only if two Considered EIPs ship | Hard | Critical, long-term | ML-DSA declined; EIP-8151 and EIP-8298 now Considered |
| 2 | Inclusion-list verdicts depend on arrival order; one includer can deny them for free | Hard | High | Fix proposed in PR-12394 and PR-12396, merged nowhere |
| 3 | Gas paid in tokens has no safe home in the frame mempool | Hard | Medium | PR-12340 reopens a curated form of third-party storage |
| 4 | Validation state has three homes that disagree | Hard | High for delegated EOAs | PR-12394 settles slots 0 to 3; PR-12340 widens the mempool side |
| 5 | Inclusion lists protect no frame transaction as scheduled | Medium-hard | High | PR-12394 covers only the replayed profile |
| 6 | A shared sender gets one pending transaction without EIP-8250 | Medium | High for privacy pools | EIP-8250 rewritten, still Considered |
| 7 | One validation gas cap mixes compute with state reads | Medium | High for privacy and post-quantum | PR-12301 makes it a floor with headroom |
| 8 | One cheap action invalidates thousands of pending sponsorships | Medium | High | PR-12328 stalled; PR-12421 adds a trigger |
| 9 | Validation is unpaid until payment is approved | Medium-easy | Medium | `857622a` adds a retry-count bound |
| 10 | The mempool admits only 5 of EIP-8250's 16 keys when fresh | Easy-medium | Low-medium | EIP-8250's rewrite leaves it |
| 11 | The EIP's custom-validation guidance is exploitable | Easy | High | Unchanged |
| 12 | Transactions with deadlines are evicted first | Easy | Medium | Unchanged |
| 13 | A hidden deadline through a nested `TIMESTAMP` | Easy | Medium | PR-12252 keeps the loophole |
| 14 | Rolled-back frames report SUCCESS | Easy | Medium | Unchanged |
| 15 | Activation requirements differ after the keyless deployments | Easy | Medium | New since 2026-10-06 |
| 16 | The inclusion-list shape rule excludes recent-root transactions | Easy | High | Repeated in PR-12394 |
| 17 | Admission order, rejection reasons and the `gas` field differ between clients | Easy | Low-medium | PR-12321 fixes the order |
| 18 | The paymaster text contradicts itself | Easy | Low | Unchanged |
| 19 | EIP-8272 roots cannot be revoked for about 27 hours | Easy | Low-medium | Unchanged |

Difficulty is the coordination a fix needs. **Hard** means a new mechanism, or agreement across the consensus and execution layers and several EIPs. **Medium** means one EIP's normative text, mempool policy, or a scheduling decision. **Easy** means a few sentences.

## Hard

### 1. No efficient post-quantum path, and an EOA leaves ECDSA only if two Considered EIPs ship

**What it is.** Frames make a post-quantum contract account possible. They give it no efficient path, and give an existing EOA an exit only if two Considered EIPs ship together.

**How it happens.**
- Default code accepts only `SECP256K1`, and the protocol's signature registry holds only `SECP256K1` and `P256`. A post-quantum signature is therefore `ARBITRARY`: checked in the EVM, and not aggregatable, because the EIP keeps protocol-checked signature bytes out of the EVM precisely so that they can be aggregated later.
- EIP-8355's ML-DSA precompiles were declined for Hegota on 2026-10-08.
- EIP-7702 delegation adds code and removes no key. In experiment 15 the key still signed legacy transactions and new authorizations after delegating. PR-12421's set-delegation frame installs the same indicator, and says it "does not remove the authority of the account's ECDSA key".
- EIP-8298 and EIP-8151, now Considered, are an exit together:
  1. the EOA delegates to migration code, which stores its post-quantum wallet state;
  2. the code calls `SETCODEFROM` and adopts ordinary code, which is not a delegation indicator;
  3. EIP-3607 then refuses ECDSA-signed transactions from the account, and EIP-7702 can no longer re-delegate it;
  4. EIP-8151 makes `ecRecover` return zero for it, which closes ERC-2612 `permit`.

**Damage.**
- **Without the exit:** every EOA and every default-code account can be drained once a quantum computer can derive keys.
- **With EIP-8298 alone:** transactions are closed, but `permit` still lets the old key move tokens.
- **The migration itself:** it has to happen on every chain, and before an attacker who can derive the key can race it.
- **After migrating:** a WOTS account paid 73,481 gas per transfer against 27,382 for ECDSA (experiment 17). In-EVM post-quantum verification runs 150,000 to 200,000 gas (EIP-8288's figures, as PR-12394 quotes them), above the 100,000 every mempool node must carry, so these transactions propagate poorly (problem 7).
- **Sponsors:** PR-12041's canonical paymaster excludes `ARBITRARY`, so a post-quantum sponsor stays non-canonical, limited to one pending transaction.

**Fix.**
- Ship EIP-8151 and EIP-8298 together or neither. Each alone leaves the old key with power.
- Until a post-quantum scheme is in the registry, give the mempool a compute floor that admits in-EVM verification (problem 7).
- In a later fork, admit a registry scheme for what only the protocol can do with it, pre-execution validation and aggregation (EIP-8288's direction), not for raw speed.
- **Not this:** post-quantum schemes in default code without a rotation path. That makes one key the permanent owner of an address that can never acquire code.

### 2. Inclusion-list verdicts depend on arrival order, and one includer can deny them for free

**What it is.** In the one implementation of EIP-8369's Profile 2, the inclusion-list profile that replays a transaction's validation, which transactions a set of lists protects depends on the order the lists arrive in. One committee member can empty that protection at no cost.

**How it happens.**
- consensus-specs deduplicates with `list(set(transactions))`: "Order does not need to be preserved".
- The Engine API carries one flat array, so ethrex fills a single $2^{20}$ replay budget per payload, in delivery order.
- Junk from a key that was never funded passes the shape and signature checks and spends budget. Replay then finds it invalid, so its own omission is excused, and since it is never included it pays nothing.

**Damage (experiment 25).**
- **Verdicts:** one set of lists gave 46 admitted sets over 5,040 orders. Eight runs of the specification's own function gave eight sets, and each withdrawal was admitted in about 48% of orders. Attesters holding identical lists disagree on whether a payload satisfies them.
- **Capacity:** 2 privacy withdrawals per slot, against 32 with a per-list budget.
- **The attacker's odds:** a 1% stake holds a committee seat in 15% of slots, a 5% stake in 56%.
- **Junk without a position:** thirty junk transactions in 4,800 bytes left honest withdrawals admitted in 26% of orders.

**Recent changes.** PR-12394 has the consensus layer pass, with each transaction, a bitvector of the committee members whose lists carry it. The execution layer fills each member's budget separately, with no shared budget. PR-12396 fills each list in hash order. Neither is merged, and neither consensus-specs nor ethrex has changed.

**What PR-12394 still leaves.**
- Its shape rule excludes recent-root transactions (problem 16).
- Its per-transaction cap is $2^{18} = 262{,}144$. Our withdrawal used 250,387 and declared 410,000, so a wallet must declare within 4.7% of measured use.
- The replay bound of $2^{24}$ gas is unbenchmarked: about 270 ms of compute per slot at the 16 ns per gas we measured (experiment 26), before disk.
- Anyone other than the user who can invalidate the transaction inside the block, such as a payer that is not the user, can still remove its protection at an index the builder claims.

**Fix.**
- Merge PR-12394 and PR-12396.
- Change consensus-specs to emit the membership bits instead of `list(set(...))`, and add the Engine API field.
- Fix the shape rule (problem 16), and benchmark $2^{24}$.

### 3. Gas paid in tokens has no safe home in the frame mempool

**What it is.** ERC-4337's main paymaster, gas paid for in tokens, does not fit the frame mempool.

**How it happens.** Validation cannot read the user's token balance. A token sponsor therefore co-signs every transaction after an off-chain risk check, or extends credit.

**Damage.**
- A sender who emptied their wallet first cost our sponsor 218,760 gas (experiment 04).
- The co-signer is a live service that sees every transaction before it propagates, and can censor or link it.

**Recent changes.** PR-12340 lets validation read account-associated storage in a chain-configured list of immutable "authority" contracts. That serves sender-side validators, not a payer reading token balances. It also lies outside the inclusion-list state surface, so what it admits is propagated and never protected.

**Fix.** There is no clean one.
- Keep an ERC-4337 path for token sponsorship at launch.
- If PR-12340 proceeds, put the same contracts in the inclusion-list surface, or keep them out of the public mempool.
- **Not this:** reopening third-party storage reads generally. It would break every inclusion-list surface.

### 4. Validation state has three homes that disagree

**What it is.** Three rules say where an account's validation state may live, and no account satisfies all three:
- the mempool allows any slot of the sender, plus, under PR-12340, sender authority storage;
- EIP-8369 and PR-12394 allow slots 0 to 3 of sender and payer;
- account practice (ERC-1967, ERC-7201, ERC-7579) keeps state at namespaced slots or in module contracts.

**How it happens.** Solidity's default layout puts every contract's first variables in slots 0 to 3, so successive delegates of one EOA share them.

**Damage.**
- **Storage outlives delegation** (experiment 15): a key registered under one delegation was valid again the moment the EOA re-delegated. A revoked session key regains its power.
- **Namespaced state**, as EIP-7702 guidance recommends, makes the account invisible to inclusion lists.
- **Modules:** an ERC-7579 validator module was refused outright (experiment 14).
- **Concurrency:** a commitment held in code cost 4,262 gas in `VERIFY`, against 6,353 in slot 0, and the storage version lost keyed concurrency (experiment 08).

**Recent changes.** PR-12394 fixes `AA_VOPS_SLOT_COUNT = 4` with a rationale, which settles the surface on slots 0 to 3. PR-12340 widens the mempool side. PR-12421 and EIP-8298 give EOAs new ways to acquire code, so delegates that share slots will be more common.

**Fix.**
- Use a namespaced base for the surface, $\mathsf{keccak256}(\texttt{"eip8369.aa-vops.validation"}) - 1$, with 4 words. It costs inclusion-list nodes exactly what slots 0 to 3 cost.
- Adopt a convention that word 0 commits to the validating code's identity, so a new delegate refuses an old delegate's state.
- Keep the mempool's authority surface inside the inclusion-list surface.
- This must be agreed across EIP-7805, EIP-8369 and the account standards before launch. After launch it is a migration.

## Medium

### 5. Inclusion lists protect no frame transaction as scheduled

**What it is.** In Hegota as scheduled, no frame transaction can be protected by an inclusion list.

**How it happens.**
- FOCIL's execution-layer check reads the nonce and balance of `T.origin`.
- EIP-8369 puts every frame transaction in Profile 2, which needs EIP-8250 and EIP-8272 (Considered), EIP-8369 itself (Proposed), and a post-reveal duty under ePBS.

**Damage.**
- An EOA that moves from type-2 transactions to frame batching, the EIP's main UX benefit, loses inclusion-list protection by doing so.
- Sponsored and private transactions are unprotected.

**Recent changes.** PR-12394 moves Profile 2 into EIP-7805, which is Scheduled. Profile 1 there still means legacy, 2930, 1559 and 7702 transactions.

**Fix.**
- Add to EIP-7805 itself a Profile 1 for directly evaluable frame transactions:
  - every validation frame is an expiry verifier frame or resolves to an account with empty code;
  - every signature is `SECP256K1` over the canonical hash;
  - omission is excused if the transaction does not fit, or if at the end of the payload the sender's nonce, the payer's balance or code, or the deadline makes it invalid.
- **Coverage:** 68 of the 183 transactions we had mined when experiment 25 counted them.
- **Attester cost:** one takes 50 to 53 $\mu$s to decode and check, against 48 $\mu$s for a type-2 transaction (experiment 25).
- It has no budget, so problem 2 does not apply to it, but it needs the activation fix in problem 15.

### 6. A shared sender gets one pending transaction without EIP-8250

**What it is.** Without keyed nonces, a sender has one pending transaction network-wide. Privacy pools and multisig treasuries are shared senders.

**How it happens.** The mempool allows one pending transaction per sender. The fix is EIP-8250 with the keyed mempool rules of [PR-12039](https://github.com/ethereum/EIPs/pull/12039), open since 2026-07-30.

**Damage.**
- In experiment 06 the storage-based pool serialized every user, and a second withdrawal evicted the first.
- crops-frame's [P0005](https://github.com/4w44h9jckz-boop/crops-frame/blob/main/problems/records/P0005-a-shared-sender-has-a-one-transaction-mempool-ceiling.md) puts the ceiling at about 300 spends an hour.
- Users can keep replacing each other's withdrawals.

**Recent changes.** EIP-8250 was rewritten on 2026-10-08. It is still Considered. Each withdrawal that uses its nullifier as a key now pays 12,100 execution gas besides the 97,920 state gas.

**Fix.**
- Schedule EIP-8250 together with PR-12039; the text is mature.
- Otherwise, say in EIP-8141 that a shared sender has a ceiling of one transaction, so pools don't build on it.

### 7. One validation gas cap mixes compute with state reads

**What it is.** `MAX_VERIFY_GAS` bounds compute and cold state reads with one number, and clients disagree on it: 100,000 on reth and ethrex, 300,000 on Nethermind, 500,000 on ethrex's Hegota build (experiment 22).

**How it happens.** The workloads that need more than 100,000 are compute: Groth16 at 245,000, a 40-key multisig at 129,000, post-quantum signatures at 150,000 to 200,000. Raising the single cap also raises the cold reads it allows, from 47 to 119 at 250,000.

**Damage.**
- **Propagation:** privacy, post-quantum and large-multisig transactions propagate unreliably. Under PR-12301, "the heavier its validation work the fewer nodes carry it".
- **Inclusion lists:** PR-12394's inclusion-list cap of 262,144 is 2.6 times the propagation floor, so the transactions that most need inclusion lists are the ones includers are least likely to see.
- **Privacy:** EIP-8369's fallback is direct submission to an includer, which for a privacy spend links its network origin to the spend.

**Measured (experiment 26).**
- The slowest work runs at about 16 ns per gas: alt_bn128 MUL 16.0, a BLS12-381 pairing 15.9, ECDSA recovery 14.3.
- Groth16 runs at 13.1, the 40-key multisig at 15.0.
- A cold read from memory runs at 1.4 ns per gas, about 2.9 $\mu$s a slot.

**Fix.**
- Make PR-12301's floor two-dimensional:
  - a cold-access cap at today's level of about 47 reads;
  - a compute floor from a time budget. At 4 ms that is 250,000 gas, which covers Groth16 and in-EVM post-quantum verification.
- Benchmark disk reads. State becomes the binding resource above about 34 $\mu$s per slot.

### 8. One cheap action invalidates thousands of pending sponsorships

**What it is.** Two payer rules let one cheap on-chain action invalidate an unbounded number of pending sponsored transactions, each of them validated and gossiped and never paid for.

**How it happens.**
- **The code-less sponsor** is "governed by the per-payer exposure rule alone", which bounds the amount at risk by its balance, not the count.
  - At a minimum of about $10^{-4}$ ETH per transaction, one ether backs about 10,000 pending sponsorships.
  - One transfer drops them all, and so does acquiring code: PR-12321 makes that an explicit drop rule, and PR-12421's set-delegation frame is one more way to acquire it.
- **PR-12328's egress scan** ignores ether that leaves through an execution approval.
  - A scan-approved paymaster sent its whole balance out through a `SENDER` frame's `value` while a sponsorship it backed was pending. It was mined in block 316,423 (experiment 24).
  - The scan also wrongly fails 28% of call-free Solidity contracts, on bytes in their metadata.

**Damage.** One 21,000-gas transaction wastes the admission work of about 10,000 transactions per ether. At 100,000 gas each and 16 ns per gas, that is up to 16 CPU-seconds on every mempool node, plus the gossip (derived, not measured), repeatable with the same capital.

**Recent changes.** PR-12321 specifies the cleanup, not a bound. PR-12328 has not changed since 2026-09-13. PR-12041's canonical paymaster is the safe model: its withdrawals and signer rotations both wait 86,400 seconds, so within that horizon nothing invalidates what it backs.

**Fix.**
- Cap the code-less sponsor by count, as ERC-7562 caps unstaked entities at 10.
- If PR-12328 revives, scan all three ways ether leaves: no empty or delegated code, every reachable `APPROVE` with a constant payment scope, and an opcode scan of reachable code only. That cuts false positives to 0.9%.

### 9. Validation is unpaid until payment is approved

**What it is.** A frame transaction is charged nothing until one of its frames approves payment.

**How it happens.** A validation prefix that never approves costs block producers work on every build attempt. Inclusion-list junk (problem 2) and payer fan-out (problem 8) are the same mechanism.

**Recent changes.** `857622a` lets a producer evict such a transaction after a bounded number of failed attempts, and asks for more than one, because a failure can be transient.

**Damage.** A count either wastes work or evicts a transaction that was about to become valid. An adversary can arrange the second by delaying the transaction that funds a payer.

**Fix.** Retry only when a dependency recorded at admission changes. PR-12321's revalidation already records those dependencies. Unpaid work is then bounded by state changes somebody paid for, and no transient failure causes an eviction.

### 10. The mempool admits only 5 of EIP-8250's 16 keys when fresh

**What it is.** EIP-8250 allows 16 nonce keys per transaction. The public mempool admits at most 5 fresh ones.

**How it happens.** Each fresh key costs 97,920 state gas in the frame that approves payment. `MAX_VERIFY_STATE_GAS` is 500,000, so 5 keys use 489,600, and fewer fit beside a deploy frame. EIP-8250 says the cap "is unchanged".

**Damage.** A transaction that consumes 6 to 16 fresh keys, such as a batch of privacy spends with several nullifiers, is valid on chain and cannot use the public mempool. A change to the state-gas price would move the limit silently.

**Fix.** Denominate the cap in state bytes, sized as 16 keys of 64 bytes plus a deploy allowance, or state the public-mempool key limit explicitly.

## Easy

### 11. The EIP's custom-validation guidance is exploitable

**What it is.** Security Considerations still tells custom validation to verify the canonical hash "or otherwise constrain every subsequent `SENDER` frame".

**How it happens.** Constraining only `SENDER` frames leaves three things to whoever relays the transaction: the `DEFAULT` frames, the positions and count of frames, and the fees.

**Damage.**
- **Sandwich** (experiment 23): a relay inserted a sandwich inside the victim's own transaction, mined in block 315,369. The victim got 3.0% less, the full slippage it allowed, and paid for the bot's 110,710 gas.
- **Fee rewrite** (experiment 23): a relay set a 10 gwei tip where the owner signed for 1,000 wei. It cost the account 0.0011865 ETH.
- **Payer swap** (experiment 27): with an execution-only digest, a relay can name the account as its own payer, and the account then pays relay-chosen fees unless it refuses payment on that digest.

**Fix.**
- Replace the paragraph. An approval of execution must authenticate every frame except pay frames, with its index, and the number of frames. An approval of payment must also authenticate the fees and every frame's limits.
- Publish the execution digest as an ERC. Experiment 27 drafted it as EIP-712 typed data: blobs pinned, the pay frame left open, and no account approves payment on it.

### 12. Transactions with deadlines are evicted first

**What it is.** Under resource pressure a node evicts invalid transactions first, then the nearest deadline, then the lowest fee.

**How it happens.** A transaction that declares when it stops being valid ranks below every transaction that doesn't, whatever it pays.

**Damage.**
- A flood of minimum-fee transactions without deadlines evicts privacy spends, session-key transactions and bounded sponsorships first.
- It costs the attacker capital held in sender balances, not fees.
- PR-12252's validity windows will put deadlines on more transactions.

**Fix.** Evict invalid transactions first, then the lowest fee. Count a deadline only once it falls within the node's revalidation margin.

### 13. A hidden deadline through a nested `TIMESTAMP`

**What it is.** Validation may not read `TIMESTAMP` except "when executing the canonical expiry verifier runtime code at `EXPIRY_VERIFIER`". A nested call from custom validation code qualifies, and ethrex admits it (experiment 19).

**Damage.** Validity becomes time-dependent without being declared. That is the EIP's own example attack: many transactions can be made to expire at one moment that no node can index.

**Recent changes.** PR-12252 adds `valid_after` and keeps the same wording.

**Fix.** Allow `TIMESTAMP` only in a top-level frame whose target is `EXPIRY_VERIFIER`. PR-12252's `valid_after` can merge alongside.

### 14. Rolled-back frames report SUCCESS

**What it is.** A frame undone by a later failure in its atomic batch still reports `SUCCESS`.

**How it happens.** A frame's status is its top-level call's return code. The SKIPPED status covers only frames that never ran.

**Damage.** All four clients report `SUCCESS` for frames whose state and logs are gone (frames-devnet-0, block 99,563). A merchant or an indexer sees a payment that never happened.

**Fix.** Add a `ROLLED_BACK` status, value 3. It changes receipts, so it must land before activation.

### 15. Activation requirements differ after the keyless deployments

**What it is.** The expiry verifier (2026-10-06) and the recent-root contract (2026-10-08) are now deployed by keyless transactions. Only EIP-8250 requires its contract to exist when it activates.

**How it happens.** EIP-8141 lets clients evaluate the expiry frame directly instead of executing it. With no contract at the address, execution runs default code at an empty account and fails for want of a signature, while direct evaluation passes.

**Damage.**
- **Chain split:** clients split on any chain where the deployment has not landed: devnets, L2s, or a chain whose gas rules reject the 250,000-gas, 1,000-gwei unprotected deployment (EIP-8250 names this case).
- **Our testnet:** it still uses `0x8141`.

**Fix.**
- Copy EIP-8250's activation requirement into EIP-8141 and EIP-8272.
- Allow direct evaluation only when the canonical code hash is present.

### 16. The inclusion-list shape rule excludes recent-root transactions

**What it is.** EIP-8369's shape rule, and PR-12394's copy of it, skip only the expiry verifier frame.

**How it happens.** A recent-root frame matches none of the four recognized validation shapes.

**Damage.**
- **The motivating case is excluded:** "a privacy spend that checks recent roots and consumes each nullifier as a single-use EIP-8250 keyed nonce". That is 10 of the same 183 transactions, all of them experiment 06's withdrawals and experiment 24's sealed sponsorships.
- **PR-12394 contradicts itself:** its own state surface lists "the EIP-8272 recent root entries that `T` references".

**Fix.**
- Skip both optional leading verifier frames, as EIP-8272 already requires.
- Drop EIP-8369's two stale sentences about envelope references and a composed payload encoding.

### 17. Admission order, rejection reasons and the `gas` field differ between clients

**What it is.** Experiment 22 found three admission orders and four error vocabularies across four clients. 21 of 39 transaction JSON fields are not served by all four, and `gas` has three meanings.

**Damage.**
- A wallet cannot tell "fund this account" from "budget account creation" from "sign entry 0".
- Fee estimation breaks.

**Recent changes.** PR-12321 defines one 12-step admission order.

**Fix.**
- Merge PR-12321.
- Add a small enum of rejection reasons.
- Define or drop `gas` for type `0x06` (execution-apis [PR-860](https://github.com/ethereum/execution-apis/pull/860) and [PR-907](https://github.com/ethereum/execution-apis/pull/907)).

### 18. The paymaster text contradicts itself

**What it is.** One sentence makes a transaction eligible "only if the `pay` frame targets a canonical paymaster instance". The next section admits non-canonical paymasters, up to one pending transaction each.

**Damage.** Clients will pick different readings.

**Fix.** An editorial fix. PR-12041's rewrite of the paymaster section is the natural place for it.

### 19. EIP-8272 roots cannot be revoked for about 27 hours

**What it is.** A root stays referenceable for 8,191 slots, and a later root revokes nothing (experiment 24).

**Damage.** An allow-list cannot revoke an entry. A deposit removed from a Privacy Pools association set stays provable for about 27 hours.

**Fix.** No protocol change is needed. The consumer puts a `notAfter` time in the leaf and requires an expiry frame no later than it, as experiment 24 did. EIP-8272's Security Considerations should document the pattern.

## Recently fixed, and what in our own results is stale

- **The approval rollback (`af80fc1`)** is a consensus change. ethrex's testnet code predates it, and none of our four-client checks exercised it, so it needs a cross-client test.
- **Experiment 06's withdrawal** now costs 12,100 more execution gas per key.
- **Experiments that used the expiry verifier** targeted `0x8141`. Master puts it at `0x81413f0c...`.
