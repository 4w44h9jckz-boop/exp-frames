# 49 - The wallet's keys after a quantum computer

Experiments 45 to 48 gave the wallet one seed, a recovery through guardians who never hold the seed,
a backup anyone can store, and a ticket bound to the transaction it pays for. Every key that
authorises something on those paths is an elliptic-curve key: secp256k1 for the owners, the
recovery key, the fresh senders, the pool's recipients and the one-time binder, and P-256 for the
passkey accounts of experiments 11 and 50. A quantum computer running Shor's algorithm recovers
any of them from its public key, and a public key is on chain from its first signature. EF
Protocol's deadline for moving off them reads: December 2029 published, December 2028 stated as a
hope.

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
