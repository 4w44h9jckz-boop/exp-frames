# 45 - One seed: every secret the wallet holds, derived and rebuilt

A wallet that keeps the user's state holds many secrets: the account's key, the openings of its
notes, the keys of its fresh senders, its tickets' blinding factors, the secrets of its notes in
each application's vault, a key that others seal messages to, and the key of its backup.
Experiments 31, 36 and 40 each made theirs in their own way: from a key in the environment, from
fresh randomness, from a label. Post 30 names recovery the wallet's hardest new duty: "lose the
device, and the state goes with it". Recovery is only as complete as the list of what has to come
back.

This experiment derives every one of those secrets from one seed, under a published path for
each, and then rebuilds the wallet on a device that has the seed and nothing else.

## Written before any run

**The claim.** Every secret the wallet holds comes from one seed by a published derivation, one
domain per purpose, so that the seed and what anyone can read from the chain rebuild the whole
wallet: its account, its notes in the privacy pool, its notes in each application's vault, the
notes others sealed to it, and its unspent tickets.

**It would be shown wrong if any of these is observed:**
- something the wallet needs in order to spend cannot be derived again from the seed and the
  chain: a note's opening, a ticket's signature or blinding factor, anything kept only on the
  device;
- two secrets derived from the seed can be tied to each other by what the chain shows, without
  the seed;
- deriving a ticket's blinding factor from the seed lets the committee that issued the ticket
  match it to its spend.

**It is done when** a process that starts with nothing but the 24 words finds again, by reading
the testnet, what experiments 31, 36 and 40 each kept: an account with its privacy-pool notes,
tickets, and notes in a vault. It must then pay out one of those pool notes and pay for a
transaction with one of those tickets. The README must publish each derivation label beside
the purpose it serves.

**The plan, fixed before the run:**
- The seed is BIP-39's: 24 English words, the 64-byte seed with an empty passphrase. The
  account's owner keys are on BIP-44's path `m/44'/60'/0'/0/i`, so that any Ethereum wallet given
  the words finds the same owner. Every other secret is `HKDF-SHA256(seed, salt =
  "kohaku-seed-v1", info = label)`, one label per purpose (the table below).
- The account is experiment 31's `DeviceRecoveryAccount`, deployed with CREATE2 under a salt
  from the seed, owner 0, an empty recovery commitment, the EIP's time rule and a delay of 120 s.
  Its address therefore follows from the seed alone. Experiment 46 sets its recovery commitment.
- The privacy-pool notes are experiment 06's keyed pool, through kohaku-rs's keychain, whose key
  is the label `pool/keychain`. Withdrawals pay to `pool/recipient/<n>`, so the money comes back
  with the seed too.
- The vault notes are experiment 40's registry and its fixed-amount vault, with secrets
  `custody/<vault>/<j>/...`.
- A note someone else makes for the wallet cannot be derived from the wallet's seed. Its opening
  is sealed to the wallet's viewing key, label `view`, with experiment 33's announcements, on
  experiment 33's board. The rebuild finds it by scanning the board.
- Tickets are experiment 36's: a new committee of four issuers with a quorum of three, from
  Commonware's DKG, and a new paymaster for its key. The fresh sender, the salt and the blinding
  factor of the k-th ticket all come from the seed. The ticket's signature does not: it is the
  committee's answer, unblinded. So the buyer posts the committee's blinded answer `x * B`
  beside its request `B` on the board, where the rebuild finds it again by recomputing `B`. A
  blind signature's request is uniformly random whatever the message is, so the post tells no
  one which ticket it is.
- The run is two processes. The first, "the lost device", builds the wallet and then exits. The
  second, "the fresh device", gets the 24 words and the public addresses of the contracts
  (the pool, the registry, the vault, the paymaster and its committee's public key, the board),
  and nothing else. It rebuilds, lists what it found and from where, then spends a pool note to a
  derived recipient, spends a ticket from a fresh sender, and sends a transaction from the
  account.
- Neither process prints or records the words or any derived secret. The run's seed is not
  published. The derivation itself is pinned by a vector from a public test mnemonic, computed
  in Rust and checked here in TypeScript, a second implementation.

## Short answers

1. **Done when: met.** A process given the 24 words and the contracts' public addresses, and
   nothing the first process kept, found account 0, one privacy-pool note, two vault notes (its
   own and one the funder sealed to it) and two unspent tickets. It withdrew the pool note to a
   derived recipient, spent a ticket from a fresh sender, and sent from the account.
2. **Would show it wrong: not observed, with one condition.** Two things a wallet spends with
   cannot be derived from its seed: a ticket's signature, which is the committee's answer, and
   the opening of a note someone else made. The rebuild found both on the chain only because the
   wallet had put them there: the committee's blinded answer posted beside its request, and the
   opening sealed to the viewing key. So "the seed and the chain rebuild the wallet" holds as a
   rule the wallet must keep, every secret it receives either posted blinded or sealed to its
   viewing key, not as a property of derivation alone.
3. **Deriving the blinding factor does not let the committee link the ticket.** To anyone
   without the seed, the blinding factor is a uniformly random scalar, and a blind request is a
   uniformly random point whatever the ticket says. What determinism adds is for the holder of the
   seed: the same ticket gives the same request, so asking again after a loss tells the issuers
   nothing new.

| File | What |
|---|---|
| [`derive.ts`](derive.ts) | The derivation, written again here from the standards: `@scure/bip39`, viem's BIP-44, `@noble/hashes`' HKDF, `@noble/curves`' `hash_to_field` |
| [`vector.json`](vector.json) | Every path from BIP-39's public 24-word mnemonic of zero entropy, as kohaku-rs computes it |
| [`rebuild.test.ts`](rebuild.test.ts) | The vector checked against `derive.ts`; the run's transactions, the posted answers and the spends checked from public data |
| [`record.json`](record.json) | Both processes' records: every transaction, what each issuer saw, what the rebuild found. No mnemonic, no derived secret |

The run is kohaku-rs's `kohaku-frame-secrets` (branch `experiment/secrets`): its `derive`
module and its `seed_wallet` example, over `kohaku-frame-accounts`, `kohaku-frame-pool`,
`kohaku-frame-registry`, `kohaku-frame-ticket` and `kohaku-tornadocash-keychain`.

## Run

```bash
# kohaku-rs, crates/; SEED_FILE outside any repository, where the words are kept:
SEED_FILE=... PRIVATE_KEY=0x... PUBLIC=public.json RECORD=build.json MODE=build \
  cargo run --release -p kohaku-frame-secrets --example seed_wallet
SEED_FILE=... PUBLIC=public.json RECORD=restore.json MODE=restore \
  cargo run --release -p kohaku-frame-secrets --example seed_wallet
# here, offline:
npx vitest run experiments/45-one-seed
```

## Derivation paths

`K(label) = HKDF-SHA256(IKM = seed, salt = "kohaku-seed-v1", info = label)`, with the seed BIP-39's
64-byte seed of 24 English words and an empty passphrase. Indices are decimal, an address is `0x`
and 40 lowercase hex digits.

| Path | Gives | For | After a loss, comes back from |
|---|---|---|---|
| `m/44'/60'/0'/0/<i>` (BIP-32, BIP-44) | secp256k1 key | owner `i`: the account's signer, and the EOA that deposits and buys tickets | the account's address, from the salt below, and its owner slot |
| `account/<i>/salt` | 32 bytes | the CREATE2 salt of account `i`, deployed with owner `i` and an empty recovery commitment | the address alone: code there means the account exists |
| `account/<i>/recovery-salt/<r>` | 32 bytes | the salt of account `i`'s `r`-th recovery commitment (experiment 46) | not needed to spend |
| `pool/keychain` | secp256k1 key | kohaku-rs's Tornado keychain: every pool note's secret and nullifier, by pool and nonce | the pool's `Deposit` and `Withdrawal` events |
| `pool/recipient/<n>` | secp256k1 key | where the `n`-th withdrawal pays | the address's balance |
| `custody/<vault>/<j>/nullifier` | BN254 field element | the nullifier secret of the `j`-th note in a vault: custody per application | the registry's `Inserted` and `Updated` events, and `scopeOf(vault)` |
| `custody/<vault>/<j>/secret` | BN254 field element | the same note's secret | as above |
| `view` | secp256k1 key | the viewing key: experiment 33's announcements sealed to it carry what others made for the wallet | the board's `Posted` events |
| `ticket/<k>/sender` | secp256k1 key | the fresh sender the `k`-th ticket pays for | its nonce: 0 means unspent |
| `ticket/<k>/salt` | 32 bytes | the salt in the `k`-th ticket's message | derived |
| `ticket/<k>/blinding` | BLS12-381 scalar | the blinding factor `r`: RFC 9380 `hash_to_field` of `K`, expand_message_xmd with SHA-256, tag `kohaku-seed-v1/ticket-blinding` | the committee's blinded answer, posted beside `r * H(m)` |
| `backup/<v>/key` | 32 bytes | the key of the `v`-th encrypted backup (experiment 47) | the backup, by its locator |
| `backup/<v>/locator` | 32 bytes | the tag the `v`-th backup is posted under | derived |

A secp256k1 key is `K(label)` itself, refused if it is zero or not below the curve's order
(probability about 2^-128). A field element is `K(label)` as a big-endian integer, reduced.
Distinct labels are distinct HKDF inputs, and BIP-32's tree starts from HMAC-SHA512 under
"Bitcoin seed", apart from HKDF's extract under its own salt, so no derived secret says anything
about another without the seed.

Standards, from their primary sources (bitcoin/bips `master` and RFC Editor, read 2026-10-21):
BIP-32, BIP-39 and BIP-44, each "Status: Deployed"; SLIP-44's coin type 60 for ether; RFC 5869
(HKDF, Informational); RFC 9380 (hashing to elliptic curves, Informational).

## Results (Hegota testnet, chain 8141, 2026-10-21)

Owner 0 `0x883ADC0Fe3792Df2c5361E45dAF4830cbaE51d5C`; account 0
`0xe067f84f0eaa1a62F5Ad82f9c5f18B88D335AC95`, a `DeviceRecoveryAccount` with the EIP's rule and a
delay of 120 s; the ticket paymaster for a new committee (four issuers, quorum three, Commonware's
DKG) `0xE033130Cb10b3921d94e1f317690C798d78C3694`. The pool, the registry and its vault, and
the board are experiments 06, 40 and 33's.

**The device that is then lost:**

| Step | Tx | Block | `gasUsed` | Frames: execution + state |
|---|---|---|---|---|
| the funder pays owner 0 | [`0x23e4fe36…`](https://dora.privacy.ethrex.xyz/tx/0x23e4fe3634e8871a38f3ee2e72af90bfb1dfbd7c3b063fef1e7ee54a81e7611b) | 490,517 | 209,702 | 100 · 3,000 + 183,600 |
| owner 0 deploys account 0 and the paymaster, funds the account, buys 2 tickets | [`0xdeeb2802…`](https://dora.privacy.ethrex.xyz/tx/0xdeeb280247b86ed0789ef52b564e53faf739c563b4c4a02174f93b7705dc95fe) | 490,519 | 4,179,927 | 100 · 42,222 + 1,675,350 · 141 · 13,387 + 2,314,890 · 1,623 |
| owner 0 deposits the keychain's pool note 0, leaf 16 | [`0xebf1b7ff…`](https://dora.privacy.ethrex.xyz/tx/0xebf1b7ff74a7ffd484efc4ac19428e018892704267f6fef8f22a6968ae3aee1b) | 490,521 | 1,223,164 | 100 · 1,003,810 + 195,840 |
| owner 0 deposits vault note 0, leaf 5 | [`0xff0c2581…`](https://dora.privacy.ethrex.xyz/tx/0xff0c2581455477edf731dd9d96c0bf74a0d63b57847305c7981673fbea3678f7) | 490,523 | 1,171,863 | 100 · 1,050,085 + 97,920 |
| the funder deposits a vault note for the wallet, leaf 6, and seals its opening to the viewing key | [`0x6e125aec…`](https://dora.privacy.ethrex.xyz/tx/0x6e125aec66a989eba3f8688359723784b8f3a1bc5879ca28da1ca2416246f10c) | 490,525 | 1,180,691 | 100 · 1,050,085 + 97,920 · 5,641 |
| owner 0 posts each ticket's request and the committee's blinded answer | [`0x8c9fe408…`](https://dora.privacy.ethrex.xyz/tx/0x8c9fe40806b2ddaa8bed420cdd339fbeddcecec486525ecf3547900bd4606099) | 490,527 | 45,665 | 100 · 5,379 · 2,479 |
| account 0, signed by owner 0 | [`0x9ed6c1f8…`](https://dora.privacy.ethrex.xyz/tx/0x9ed6c1f82930ea37933b558d335932375c05e4dabc3d296fdd7d0936f8323afc) | 490,529 | 27,782 | VERIFY 2,404 · 4,593 |

**The fresh device**, given the words and `PUBLIC` (the contracts' addresses and the committee's
public key). It read the chain and found:

| What | How | Found |
|---|---|---|
| account 0 | CREATE2 of the derived salt and owner 0; code there; slot 0 is owner 0 | `0xe067f84f…`, recovery commitment empty, balance 0.00497 ETH; accounts 1 and 2 have no code |
| pool notes | the keychain against the pool's 30 events | note 0, leaf 16, unspent |
| vault notes, its own | `custody/<vault>/<j>` for `j` until three misses; leaf `H(scope, inner, amount)` against `Inserted`, nullifier against `Updated` | note 0, leaf 5, unspent |
| vault notes, made by others | the board's messages opened with `view` | one, leaf 6, unspent, deposited in `0x6e125aec…` |
| tickets | `Bought` for owner 0: two; each request recomputed from the seed and found on the board; the answer unblinded and checked under the committee's key | both, verified, senders at nonce 0 |

| Spend | Tx | Block | `gasUsed` | Frames: execution + state |
|---|---|---|---|---|
| the pool note, withdrawn to `pool/recipient/0` with the pool as sender, no signature | [`0xed92e28a…`](https://dora.privacy.ethrex.xyz/tx/0xed92e28ade2682646c4b46eb3aa83435f1408763040634f8c2dfe5b23375bf9e) | 490,534 | 567,833 | root 5,579 · VERIFY 244,808 + 97,920 · payout 14,381 + 183,600 |
| ticket 0, from its fresh sender, the paymaster paying | [`0x50521ccf…`](https://dora.privacy.ethrex.xyz/tx/0x50521ccf6c9c27c5569bf3ad4855d0ba9e961bf805931aaf9de99e5aae19cac6) | 490,536 | 331,186 | 100 · ticket check 122,006 + 183,600 · 4,855 |
| account 0, signed by owner 0 | [`0x5482159e…`](https://dora.privacy.ethrex.xyz/tx/0x5482159e1178b46c594e994c94949d69ddd57da07775f9dbfc0ac2d2026fdcda) | 490,538 | 27,782 | VERIFY 2,404 · 4,593 |

The withdrawal's frames used exactly the gas of experiment 06's keyed withdrawal in block 304,501,
and the ticket check exactly experiment 36's. Every transaction above is a fixture in
`test/fixtures/chain/`.

## Observations

1. **What derivation cannot give, the chain has to hold.** Every secret the wallet chose came
   back from the seed. Two things it received did not, and could not: the committee's signature
   on a ticket, and a note's opening made by someone else. Each came back only because it had been
   put on the chain in a form that says nothing to others. A wallet that kept the unblinded ticket
   on the device, or took a note's opening over a private channel, would lose them with the
   device. Two alternatives were not taken. The issuers could answer the same request again: the
   request is deterministic, and experiment 36's shared list admits a request it already holds
   without counting it twice. That moves the record from the chain to the issuers. Or a backup
   could carry them (experiment 47).

2. **What the chain ties together, and what it does not.** In the run, owner 0's own acts tie
   to owner 0: the account it signs for, its deposits, its purchase of two tickets, and its post
   of the answers. Each is public by its nature: an account's signer, a deposit's depositor, a
   ticket's buyer. Nothing on the chain ties owner 0 to `pool/recipient/0`, which the pool paid,
   to the ticket's sender, which the paymaster paid, or to the viewing key, which never appears;
   the funder's announcement carries a fresh ephemeral key. What does narrow a spend is the
   crowd, as in experiment 36. The post publishes to everyone what only the issuers saw before,
   when owner 0 was issued tickets: two, in epoch 4,668,083, and a ticket of that epoch was spent
   nine blocks later. On a quiet testnet that crowd is one buyer. `record.json` holds the links,
   because it is the wallet's own record.

3. **One leaked seed opens everything, the past included.** The seed gives every note's
   secrets, every ticket's blinding factor, which ties each spent ticket to its purchase, and the
   viewing key, which opens every announcement ever sealed to it. Nothing here is forward-secure.
   Experiment 47 measures how much one leaked backup key opens, which is smaller.

4. **The account's address follows from the seed because nothing else is in it.** It was
   deployed with an empty recovery commitment, so its CREATE2 address depends only on derived
   values. A commitment to devices or guardians at deployment would put their addresses into the
   account's address, and a fresh device would need them to find the account. Experiment 46 sets
   the commitment afterwards, with the owner's `0x04`.

5. **Gap limits are part of the rebuild.** The keychain scans nonces until a gap, the vault
   notes until three misses, the recipients until an unused address, and the accounts up to
   index 2. A wallet that skips further than its gap limit loses what lies beyond, without any
   error. The limits belong in the published derivation, as BIP-44 states its own.

6. **Post-quantum status.**
   - *Holds:* the seed and everything derived by HKDF-SHA256 and HMAC-SHA512 (BIP-32), at about
     128 bits against Grover's search; the unlinkability of tickets, which is perfect, so a
     quantum adversary learns no more from a request than anyone else; the vault and pool notes'
     secrets, which never appear on chain, and the keychain key, which never signs anything
     public.
   - *Does not hold:* every secp256k1 key whose public key appears, on the first signature, to
     anyone: owner 0, the account's signer, the ticket senders; the viewing key, whose
     announcements (ECDH over secp256k1) a quantum adversary holding the public key can open,
     the past ones included; the committee's BLS key, from which tickets could be forged, the
     paymaster's loss. The account's own answer is experiment 17's hash-based one-time keys.
   - *BIP-44's last two levels are not hardened.* The path is kept for compatibility with other
     wallets. So the extended public key at `m/44'/60'/0'/0` must never leave the wallet: it links
     every owner key to every other, and with any one owner's private key it gives the parent
     key, and so every owner key, classically. Nothing in this wallet exports it.

7. **Two public pieces that would change the post-quantum rows above,** read 2026-10-21, not
   built here.
   - The viewing key. `4w44h9jckz-boop/pq-stealth-scheme3-public` implements ERC-8441 (a Draft,
     ethereum/ERCs#2059): ERC-5564 stealth announcements under an ML-KEM-768 encapsulation
     combined with a secp256k1 ECDH secret. Under it, announcements sealed to the wallet stay
     closed to a quantum adversary who keeps them. The cost is a 1,250-byte meta-address and a
     1,122-byte announcement, against experiment 33's 84 bytes. Spending stays secp256k1, as it
     says itself. Here that would be one more label, an ML-KEM-768 seed beside `view`.
   - The owner keys. `4w44h9jckz-boop/zkboo-bip32` proves in zero knowledge, with hash-based
     (MPC-in-the-head) proofs, knowledge of the seed behind a BIP-32 key. That is a post-quantum
     way for the holder of the seed to authenticate an account whose ECDSA key a quantum
     adversary could forge. Its cheap statements are the HMAC-SHA512 ones: BIP-39's seed,
     BIP-32's master key and hardened children. A non-hardened child, as BIP-44's last two
     levels are, needs a secp256k1 multiplication in the circuit, its expensive case. The
     HKDF-SHA256 labels here would need a SHA-256 HMAC circuit, which it does not list. A
     derivation chosen with such proofs in mind would keep every level hardened and stay on
     HMAC-SHA512.
