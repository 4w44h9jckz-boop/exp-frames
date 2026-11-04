# 49 - The wallet's keys after a quantum computer

Experiments 45 to 48 gave the wallet one seed, a recovery through guardians who never hold the seed,
a backup anyone can store, and a ticket bound to the transaction it pays for. Every key that
authorises something on those paths is an elliptic-curve key: secp256k1 for the owners, the
recovery key, the fresh senders, the pool's recipients and the one-time binder, and P-256 for the
passkey accounts of experiments 11 and 50. A quantum computer running Shor's algorithm recovers
any of them from its public key, and a public key is on chain from its first signature. The
target for moving off them is December 2028, as Justin Drake gave it in his Devcon 8 talk; the
September roadmap had December 2029.

*Amended 2026-11-04, wording only: the date sentence above replaces "December 2029 published,
December 2028 stated as a hope". No claim, falsifier or prediction changed.*

This experiment gives each of the wallet's paths a hash-based form, leanSPHINCS, and runs each
path with it beside the classical records. The classical runs stay as they are; this one is new,
and it is written down here before any of its code.

## Written before any code

### The tools, pinned

- **leanVM** at
  [`3cbac04`](https://github.com/leanEthereum/leanVM/tree/3cbac047160f4d1465bfe985521603b0a3418556),
  its `signatures` crate for leanSPHINCS: a 32-byte secret seed, a 32-byte public key laid out as
  root then public parameter, a 7,740-byte signature, $2^{30}$ signatures per key, stateless. Its
  own README says the parameters are not final. Built with `-C target-cpu=native`.
- **EIP-8288** as at `ethereum/EIPs` master `46976b2` (read 2026-11-04): a dependency frame (mode 4)
  declares `(scheme, data_hash, verification_key_hash)` triples that one recursive STARK per
  block proves. `LEANSPHINCS_SCHEME` is `0x10` at 3,000 gas, the key is its own 32-byte
  verification key, and a zero `data_hash` stands for the transaction's signature hash.
  `LEANSTARK_SCHEME` is reserved there, and nothing here needs it: every dependency in this
  experiment is a leanSPHINCS signature.
- **Two chains, as `exp-e2e-frames` experiment 19 runs them.**
  - *The local chain:* ethrex at the test network's commit `64b8fc09`, with that experiment's
    public EIP-8288 patch, set to the EIP **as written**. The block's leanSPHINCS dependencies are
    aggregated by leanVM and the node checks the aggregate. This is where a path counts as
    mined.
  - *The Hegota test network, modelled:* the same triple travels in the account's own `VERIFY`
    data, and the signature is checked off chain by leanVM's verifier. Nothing on chain checks it,
    and every such figure says so. It is run for one reason: to compare gas with experiments 45
    to 48 on the chain they ran on.
- **ML-KEM-768** (FIPS 203) for the two places the wallet seals a message to a key.

### The paths, and what each becomes

| # | Path | Where | Key today | Post-quantum form here |
|---|---|---|---|---|
| 1 | the account's owner | 45, 46 | owner $i$, BIP-44 secp256k1 | a leanSPHINCS key from the seed, label `sphincs/account/<i>/owner/<j>` |
| 2 | the recovery key $R$ and the guardians' quorum | 46 | a random secp256k1 key, split 2 of 3 | a random 32-byte leanSPHINCS seed, split 2 of 3 as before; the account commits to its public key |
| 3 | the shares' hand-off to a new device | 46, 47 | ECDH to a transport key | ML-KEM-768 to a transport key |
| 4 | the viewing key for notes others deposit | 45 | ECDH to `view` | ML-KEM-768 to a key from `sphincs/view` |
| 5 | a fresh sender paid by a ticket | 45 to 48 | a secp256k1 account at nonce 0 | a leanSPHINCS account, deployed by its first transaction, key `sphincs/ticket/<k>/sender` |
| 6 | the bound ticket's one-time key | 48 | a secp256k1 binder and a protocol signature entry | a leanSPHINCS binder key, `sphincs/ticket/<k>/binder`, named in the ticket and declared as a dependency |
| 7 | the pool's recipients | 45 | `pool/recipient/<n>`, secp256k1 | a leanSPHINCS account, as path 5 |
| 8 | the passkey | 11, 50 | P-256 in the authenticator | written below: WebAuthn has no post-quantum form today |

**Outside this experiment, said now:** the tickets' own BLS signatures (the issuers' side) and the
pool's Groth16 withdrawal proof are other entries' work. A run that uses them uses them as they
are, and says so. The seed's derivation (BIP-39, HKDF-SHA256), the envelope (AES-256-GCM under
HKDF and Argon2id) and the backup are symmetric, and stay. The pool's keychain derives note
secrets from a secp256k1 signature whose key never appears on chain; it is recorded, not changed.

### One account for paths 1, 2, 5 and 7

`SphincsAccount.yul`: experiment 46's `DeviceRecoveryAccount`, with every key a 32-byte leanSPHINCS
public key and every signature a dependency.
- Storage: the owner's key, the commitment $\mathrm{keccak256}(\mathit{salt} \,\Vert\, m \,\Vert\, k_1 \,\Vert\, \dots \,\Vert\, k_n)$
  over the recovery keys, the pending owner's key, and the unlock time.
- A key authorises the transaction when the transaction declares the triple
  `0x10 || 32 zero bytes || key`: a leanSPHINCS signature by that key over the transaction's
  signature hash. Where EIP-8288 runs, the triple is in a dependency frame and the account finds
  it there; on the test network it is in the account's own `VERIFY` data. One bytecode does
  both, as experiment 19's contracts do.
- The same three kinds of transaction as experiment 46: the owner's; $m$ recovery keys starting a
  recovery, with the commitment's preimage in the `VERIFY` data; the pending owner finishing it.
  A fresh sender is this account with no commitment.

### The bound ticket, for the mempool

The ticket's one-time key becomes a leanSPHINCS key. These are the bytes this experiment
proposes, for the mempool's next version of its claim-gated admission:
- **The message**, 164 bytes: experiment 36's 132, then the binder's 32-byte leanSPHINCS public
  key, where experiment 48 had a 20-byte address.
- **The pay frame's data**, 200 bytes: epoch (8), salt (32), the binder's key (32), the issuers'
  signature (128, EIP-2537's G1).
- **The binding:** the transaction declares the triple `0x10 || 32 zero bytes || binder key`, in a
  dependency frame where EIP-8288 runs, or after the 200 bytes in the paymaster's own `VERIFY`
  data where it is modelled. The paymaster requires that triple. It checks no signature itself:
  the block's proof does, over the signature hash. That hash covers the fees, the payer and every
  frame's data, the zero bytes of the triple included; only the signatures' own bytes are left
  out of it.
- The issuers still sign blind, so they never see the binder's key. The issuers' signature is
  still BLS: that half is another entry's.

### Arms

1. **The signer.** leanSPHINCS keys from experiment 45's seed under the labels above, fixed
   vectors, and on this machine: key generation, signing and verification times, and sizes.
2. **The account (path 1).** Build account 0 with a leanSPHINCS owner, fund it, and send a
   transaction it authorises; then one that declares a key that is not its owner's, which must be
   refused.
3. **Recovery (paths 2 and 3).** Set the account's commitment to a leanSPHINCS recovery key $R$
   split 2 of 3; lose the device; two guardians post their shares sealed with ML-KEM-768 to the
   new device; it joins $R$, opens the envelope with the phrase, has the seed, and $R$ starts a
   recovery to `sphincs/account/0/owner/1`; the old owner cancels one attempt; the new owner
   finishes after the delay. A start by a key outside the commitment must be refused.
4. **A fresh sender and a recipient (paths 5 and 7).** A ticket-paid first transaction from a
   leanSPHINCS account that does not exist yet, and a withdrawal to a leanSPHINCS recipient that
   then spends what it received.
5. **The bound ticket (path 6).** A bound ticket bought, issued blind and spent, from a fresh
   sender of arm 4 and on experiment 48's keyless pool withdrawal. Then the withdrawal's copies,
   as experiment 48 sent them: fees raised keeping the declared triple; the triple removed; another
   key named and signing.
6. **Sealing (path 4).** A note deposited by someone else and sealed with ML-KEM-768 to the
   viewing key, found by a fresh device from the seed.
7. **The passkey (path 8),** written, not built: what can stand in for it, and what the user
   loses, below.

Arms 2 to 6 run on the local chain, and arms 2, 4 and 5 again on the test network, modelled.

### The passkey's place

A passkey's key is P-256, made and kept by the authenticator, and WebAuthn defines no hash-based or
lattice-based algorithm for it today. What this experiment proposes in its place, and will not
build: the leanSPHINCS key lives in the wallet, encrypted under a key from the passkey's `prf`
extension (an HMAC inside the authenticator, symmetric, so not broken by Shor's algorithm). The
passkey then gates each use, but no longer signs. What the user loses, each to be stated in the
results:
- the key stays inside the authenticator: here it is decrypted into the wallet's memory to sign,
  so malware on the device at that moment can copy it;
- each signature names the site it was made for: here the wallet must check where a request comes
  from;
- the authenticator's attestation is still P-256 or RSA, so after a quantum computer it proves
  nothing about the device.

### It would be shown wrong if any of these is observed

- a path in the table, other than the passkey, that still needs an elliptic-curve key to authorise
  a transaction after this run;
- a recovery that cannot restore the owner's leanSPHINCS key from the seed, or cannot use a
  leanSPHINCS recovery key to replace the owner;
- the bound paymaster's validation, with the binder declared as a dependency, no longer fitting
  the validation budget a ticket paymaster has, the 500,000 gas of experiment 48's prefix;
- the binder's key reaching the issuers, so that they could tie a bound ticket to its spend.

### It is done when

every path in the table has its post-quantum form mined on the local chain, or stopped with a
measured reason; arms 2, 4 and 5 have their modelled gas on the test network beside experiments 45
and 48; and the passkey's section is answered.

### Predictions, fixed now

1. **The owner's transaction costs less than twice the classical one**, the declared 3,000
   included, against experiment 45's 27,782 on the test network.
2. **A fresh sender costs more than experiment 48's,** by the account's deployment, and less than
   500,000 gas in all.
3. **The bound paymaster's check costs less than experiment 48's 122,350**, since it reads a triple
   instead of looping over signatures; the binding's total cost moves from calldata (65 bytes
   for the entry) to 96 bytes of triple and 3,000 declared gas.
4. **Each of the withdrawal's copies is refused** on the local chain: at admission if the node
   checks the dependency's witness there, or by never entering a block whose proof the node
   accepts. Which of the two happens is recorded; the second leaves the refusal to the mempool.
5. **Signing takes under one second on this machine**, and key generation under one second.

### Conditions, in every result

- **leanVM has no zero knowledge yet.** The block's proof does not hide its witness, here the
  signatures. Nothing in this experiment relies on hiding a signature, but every statement about
  what someone cannot learn holds only once leanVM hides its witness.
- **EIP-8288 is a draft.** On the test network it is modelled; on the local chain it is the patched
  client's reading of the draft.

### Post-quantum status

This is the post-quantum run of experiments 45 to 48. What stays classical, said above: the
issuers' BLS signatures, the pool's Groth16 proof, the passkey's attestation.

## Amendment 1, 2026-11-04, after the contracts were written and before any run

**What changes.**
1. **The carrier is fixed at deployment, not read from the transaction.** The plan said one bytecode
   would take the triple from a dependency frame when there is one, and otherwise from its own
   `VERIFY` data, as experiment 19's contracts do. On a chain with EIP-8288 that account would
   accept a triple in its `VERIFY` data, which nothing proves: anyone could spend from it. So each
   account takes a flag at deployment: a dependency frame only, or its own `VERIFY` data only (the
   test network, modelled). The source is one; the two deployments differ by the flag, and so by
   address.
2. **Fresh senders and recipients get a smaller account.** A fresh sender deploys itself in its own
   first transaction, ahead of its `VERIFY`, and that frame's state gas is capped at 500,000, which
   leaves room for 206 bytes of code. `SphincsAccount` is 1,168 bytes. So paths 5 and 7 use
   `SphincsSender`: one key, kept in its code, no storage, no recovery, 190 bytes with its key.
   Path 1 and 2's account is deployed by another transaction, as experiment 45's was.
3. **The local chain is not built yet.** Building the patched ethrex in this session's environment
   was refused by the environment's permissions. Arms 2 to 6 stay planned on the local chain, and
   the experiment is not done until they run there or are stopped with a measured reason. In the
   meantime every arm also runs on the test network, modelled, arms 3 and 6 included.

**What it does not change.** No claim, falsifier, prediction or "done when" is edited. A modelled
run shows the wallet can build and send each path; only the local chain shows a chain checking it.

**Contracts:** kohaku-rs `crates/frame-pq/contracts/`, `SphincsAccount.yul` and `SphincsSender.yul`,
compiled by solc 0.8.37 (EVM version osaka, optimizer on, 200 runs): runtimes of 1,168 and 157
bytes before their appended arguments.

## Results, the test network modelled (2026-11-04)

Every figure below is from the ethrex Hegota test network, chain 8141, blocks 688,182 to 688,354,
with EIP-8288 **modelled**: each account and the paymaster were deployed with the triple in their
own `VERIFY` data, and every leanSPHINCS signature was made over the transaction's signature hash
and checked here with leanVM's verifier, never on chain. A "declared" figure is what EIP-8288
would add: 3,000 gas per dependency. The local chain, where a block's proof would check them, has
not run (amendment 1), so **experiment 49 is not done**.

Code: kohaku-rs branch `experiment/pq-keys`, crate `frame-pq`, example `pq_wallet`; the runs used
`ae68097` (arms 1, 2, 4, 5) and `e2ac92b` (arms 3, 6), built with `-C target-cpu=native`.
Commands: the example's header. Records: `results/`; the mined transactions are fixtures in
`test/fixtures/chain/`. No mnemonic, secret key or signature is recorded; each signature's
keccak256 and whether it verified are.

### Arm 1, the signer (`results/1-signer.json`)

On this machine (4 threads, Intel Xeon at 2.10 GHz), medians of nine: key generation 18.7 ms,
signing 46.0 ms, verifying 0.14 ms. A public key is 32 bytes, a signature 7,740.

### Arm 2, the account (`results/2-account-testnet.json`)

| Step | Tx | Block | `gasUsed` | Frames | Declared |
|---|---|---|---|---|---|
| the funder deploys account 0 and funds it | `0x73d80d75...` | 688,182 | 2,429,985 | | |
| account 0, owner 0's triple | `0xe77a4e92...` | 688,184 | 25,750 | `VERIFY` 2,666 · post 4,593 | 3,000 |
| a triple naming owner 1's key | refused before inclusion: "validation prefix frame reverted" | | | | |

Experiment 45's owner transaction, the same post, used 27,782 (`VERIFY` 2,404). With the declared
3,000, the leanSPHINCS one is 28,750.

### Arm 3, recovery (`results/4-recover-testnet.json`)

| Step | Tx | Block | `gasUsed` | Frames: execution + state |
|---|---|---|---|---|
| the funder pays three guardians' accounts | `0x80ac08b5...` | 688,320 | 595,676 | |
| owner 0 commits account 0 to `R` and posts the envelope (277 bytes) | `0x1d4d4671...` | 688,322 | 142,641 | 2,666 · 12,393 + 97,920 · 6,689 |
| guardians 2 and 3, with `R`, start a recovery to their own key | `0x922f7a72...` | 688,324 | 141,270 | 3,444 · 24,528 + 97,920 |
| owner 0 cancels it | `0xc9aade71...` | 688,326 | 28,837 | 2,666 · 12,373 |
| guardian 1's own key starts a recovery | refused before inclusion | | | |
| guardian 1 deploys its account and posts its share, sealed with ML-KEM-768 (1,138 bytes) | `0xf7cbcc0b...` | 688,328 | 404,093 | 15,296 + 290,700 · 446 · 13,765 |
| guardian 3 does the same | `0xc612166e...` | 688,330 | 404,093 | the same |
| the new device joins `R`, finds the envelope, opens it with the phrase (189 ms) and has the seed | off chain | | | |
| `R` starts a recovery to owner 1 | `0x7040602b...` | 688,332 | 43,350 | 3,444 · 24,528 |
| owner 1 finishes it, past the unlock time | `0x16a7ca5d...` | 688,352 | 41,529 | 3,020 · 24,699 |
| account 0, owner 1's triple | `0xb4154ce2...` | 688,354 | 27,798 | 2,666 · 4,855 |

Each authorised step declares one dependency, 3,000 more. Experiment 46's start and finish used
33,924 and 42,604.

### Arms 4 and 5, a fresh sender, a recipient, the bound ticket (`results/3-tickets-testnet.json`)

| Step | Tx | Block | `gasUsed` | Frames: execution + state | Declared |
|---|---|---|---|---|---|
| account 0 deploys the bound paymaster, buys 2 tickets, deposits a note | `0x0791c2f3...` | 688,273 | 3,897,709 | | 3,000 |
| a fresh sender deploys itself and posts, paid by a bound ticket | `0x7b526ab7...` | 688,275 | 640,298 | deploy 15,296 + 474,300 · `VERIFY` 446 · pay **122,277** · post 4,855 | 6,000 |
| the withdrawal to a leanSPHINCS recipient, the pool its own sender, paid by a bound ticket | `0xfc601b1c...` | 688,278 | 694,111 | root 5,579 · pool 244,817 · pay **122,277** + 97,920 · payout 14,410 + 183,600 | 3,000 |
| the recipient deploys itself and sends a tenth back, paying its own gas | `0x2a9fcab2...` | 688,280 | 333,547 | deploy 15,296 + 290,700 · `VERIFY` 446 · 3,000 | 3,000 |

The ticket requests were signed by account 0's owner key with leanSPHINCS, and the issuers saw
the blinded points and the requests only. The withdrawal's copies:
- **(a) fees raised, the triple kept:** the node's simulation accepted it, and the binder's
  signature does not verify over the copy's hash. It was not sent. On a chain where nothing checks
  the dependency, the binding binds nothing; that is what modelling means here.
- **(b) the triple removed:** refused before inclusion.
- **(c) another key named, declared and signing:** refused before inclusion, by the pairing.

### Arm 6, sealing (`results/5-seal-testnet.json`)

The funder deposited a pool note and posted its opening sealed with ML-KEM-768 to the viewing key
(`0xc294d595...`, block 688,339, 1,231,044 gas, 1,355 sealed bytes). A device with only the seed
read the board's 191 messages, opened one, and found the note at leaf 30, unspent (3.6 s).

### Arm 7, the passkey

Not built, as planned. What can stand in for it is a leanSPHINCS key kept encrypted under the
passkey's `prf` output, so the passkey still gates each use. What the user loses, each a property
the authenticator's P-256 key has and this does not: the key never leaving the authenticator; a
signature naming the site it was made for; and an attestation that still means something after a
quantum computer. None of the three was measured.

### Predictions, as far as the modelled runs reach

1. **Held:** 25,750, or 28,750 with the declared 3,000, is under twice experiment 45's 27,782.
2. **Wrong:** a fresh sender cost 640,298, 646,298 declared, not under 500,000. The account's
   self-deployment alone is 474,300 state gas: a new account and 190 bytes of code.
3. **Held, modelled:** the bound check used 122,277 against experiment 48's 122,350. With a
   dependency frame the check would loop over frames instead; that is the local chain's to
   measure.
4. **Not tested:** it is about the local chain. Modelled, copy (a) is accepted.
5. **Held:** signing 46.0 ms and key generation 18.7 ms.

### Against "would show it wrong", modelled

- No path in the table needed an elliptic-curve key in these runs. The funder's secp256k1 key
  only funded. The issuers' BLS signatures and the pool's Groth16 proof are outside, as said.
- The recovery restored owner 1's leanSPHINCS key from the seed through a leanSPHINCS recovery key.
- The bound check fits: 122,277 of 500,000.
- The binder's key did not reach the issuers.

None of this is shown on a chain that checks the signatures. That is the local chain's.

### Passes that stopped

Three earlier passes of arms 4 and 5 stopped before their record: at the fresh sender's
self-deployment, whose state gas was reserved for the initcode and passed 500,000 (fixed in
`fd2a2c8`); at the recipient's spend, whose tip and amount exceeded what it held (`efd085f`); and
at a fresh sender whose label a stopped pass had used (`ae68097`). Their mined steps: blocks
688,232 to 688,234, 688,244 to 688,251, and 688,261 to 688,263.

### Conditions

- leanVM has no zero knowledge yet: no result here depends on hiding a signature, but anything
  said about what a party cannot learn holds only once it does.
- EIP-8288 is a draft, and here it is modelled.

## Running arms 2 to 6 on a chain with EIP-8288

For the local chain: ethrex `64b8fc09` with `exp-e2e-frames` experiment 19's EIP-8288 patch, set
as written (`X14_EIP8288=written`). Every leanSPHINCS dependency is valid as written, so nothing
needs the extension. The example talks to ethrex directly; no skandha in front. It reads the
chain id from the node. No secp256k1 key is used: with `PRIVATE_KEY` unset, the funder is a
leanSPHINCS account that the genesis funds.

From kohaku-rs `f80adbe`, in `crates/`, built once with
`RUSTFLAGS="-C target-cpu=native" cargo build --release -p kohaku-frame-pq --example pq_wallet`.
The binary is then `target/release/examples/pq_wallet`.

**Common environment:**

| Variable | Value |
|---|---|
| `RPC_URL` | the node's HTTP RPC |
| `CARRIER` | `dependency`: accounts and the paymaster read their triples from a dependency frame only |
| `WITNESS_DIR` | the node's `X14_WITNESS_DIR`; each signature is written there, as `w-<keccak256(0x10 \vert\vert sig hash \vert\vert key)>.json` (`publicKey`, `signature`, `message`), before its transaction is sent |
| `SEED_FILE` | a file outside any repository, mode 0600; `MODE=new` writes a fresh mnemonic there |
| `PRIVATE_KEY` | unset |
| `BOARD`, `POOL` | the addresses of experiment 33's board and experiment 06's keyed pool on that chain, if not the test network's |

**Before the first arm:**
1. `MODE=new` writes the mnemonic.
2. `MODE=addresses` prints, with `CARRIER=dependency`, the funder's address (`funder`) and account
   0's.
3. The genesis gives `funder` 1 ETH. That is all it must fund: every other account is funded by
   it.

**What the chain must already hold:**
- the CREATE2 deployer at `0x4e59b44847b379578588920ca78fbf26c0b4956c`, which deploys every
  account and the paymaster;
- the board, for arms 2, 3, 4 and 6;
- for arms 4, 5 and 6, experiment 06's keyed pool with its verifier, filing its roots with EIP-8272
  (`0x8272`) under the salt `keccak256("exp-frames/06/pool-keyed")`. If the pool there was
  deployed with another salt, those arms stop at the withdrawal's root.

**One command per arm, in this order:**

| Arm | Command | Reads | Writes | Expects |
|---|---|---|---|---|
| 2 | `MODE=account RECORD=2-account-local.json pq_wallet` | the seed | the record | account 0 deployed and funded, a transaction by owner 0 mined, one naming owner 1's key refused |
| 4, 5 | `MODE=tickets RUN=0 RECORD=3-tickets-local.json pq_wallet` | the seed; account 0 from arm 2 | the record | the paymaster and a note; two tickets issued; a fresh sender's first transaction and the withdrawal mined; copies (b) and (c) refused; the recipient's spend mined |
| 3 | `MODE=recover STATE_DIR=<a 0700 directory> RECORD=4-recover-local.json pq_wallet` | the seed; account 0, still held by owner 0 | the record; `STATE_DIR/phrase.txt` | as on the test network; it waits out the account's 120 s delay |
| 6 | `MODE=seal RECORD=5-seal-local.json pq_wallet` | the seed | the record | a note deposited and its opening sealed; a device with only the seed finds it |
| 4, 5, prediction 4 | the same with `SEND_COPY_A=1 RUN=1`, last | as above | the record | copy (a) sent before the original, with no witness for its hash. What the node does with it is prediction 4: refused at admission, or never in a block whose proof the node accepts. **It may stall block production** if the builder keeps proposing it; run it last |

Arm 3 leaves account 0 held by owner 1, and `MODE=tickets` needs owner 0, so the copy (a) run uses a second seed: `MODE=new`, `MODE=account`, then the tickets row. Each record names its
transactions; capture them as fixtures if the chain is to be kept.

**Not run here.** The dependency carrier is built but untested on any chain. The test network
refuses mode 4, and the local chain is not built in this session.
