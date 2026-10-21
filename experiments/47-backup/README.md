# 47 - An encrypted backup that anyone can store

Experiment 45 rebuilt a wallet from its seed and the chain, but needed three things besides: the
contracts' addresses and the ticket committee's key; a ticket's signature, which the wallet had
to post blinded; and the opening of a note someone else made, which had to be sealed to it on
the board. Experiment 46 brought the seed back through guardians. What the wallet knows that is
neither derived nor public still has to live somewhere. Post 30 names the danger of the obvious
place: "a backup written to the chain is a vault for whoever later holds its key". Its table asks
of a recovery service "whether the recovered key opens the backup".

This experiment writes the wallet's state to a public board, encrypted under keys from the seed,
loses the device, brings the seed back through experiment 46's guardians, and reopens the
backup.

## Written before any run

**The claim.** A backup of the wallet's state can be encrypted under a key from the seed and
posted where anyone can keep it, here the chain. The seed, recovered through guardians, reopens
it, and nothing in what is posted ties it to the account or its notes.

**It would be shown wrong if any of these is observed:**
- the recovered seed does not open the backup;
- where the backup is, how big it is, or when it was posted ties it to the account or its notes.

**Recorded either way:** how much of the wallet's history one leaked key opens.

**It is done when** a backup is written and the device is lost, the seed is recovered through
experiment 46's guardians, the backup is reopened on a fresh device, and its metadata is listed
against what an observer sees.

**The plan, fixed before the run:**
- Versions. Backup `v` is encrypted under `K("backup/<v>/key")` and found by
  `K("backup/<v>/locator")`, experiment 45's labels, so no two versions share a key, and a fresh
  device finds them by counting `v` up from 0.
- What it carries: the contracts and committees the wallet uses, its cursors (the next keychain
  nonce, vault note, ticket, recipient and backup), its unspent tickets with their signatures,
  the openings of notes others made for it, its account and guardian set, and the hashes of its
  own past transactions.
- The format: `locator (32) || nonce (12) || AES-256-GCM(plaintext padded to a multiple of 2,048
  bytes) || tag (16)`, the locator as associated data. No tag byte, so the post is random bytes
  of a bucket's size.
- Posted to experiment 33's board from a fresh sender paid with a blind ticket, so that no
  address of the wallet sends it.
- Two versions are written while the device lives, the second after the state changes. Then the
  device is lost. A fresh device gets two of experiment 46's current guardians' shares, off the
  chain this time, and the phrase; opens the envelope; and reopens both versions from the seed.
  It checks what they say against the chain: the tickets verify, the notes are in the vault, the
  account is owned as stated.
- The leak, measured: what one version's key opens, what the seed opens, and what experiment
  46's old envelope, with its old guardians and the phrase, opens.

## Short answers

1. **Done when: met.** Two backup versions were posted to the board while the device held the
   seed. Then a process with the phrase and two guardians' shares, handed over off the chain, and
   nothing else of the wallet, opened experiment 46's newest envelope and had the seed. It found
   both versions by their locators and opened them, byte for byte what was written, by SHA-256.
   It checked what they said against the chain: the contracts exist, the account is the seed's
   and owned as stated, a ticket carried only in the backup verifies and is unspent, and a
   received note's opening carried only in the backup is a leaf of its vault.
2. **Would show it wrong: observed, as linkage, not as leakage.** The two are separate
   questions (see "Leakage and linkage" below).
   - *Leakage,* what one post gives away by itself: nothing of the state. It is a pseudorandom
     locator, a nonce and ciphertext from a fresh sender. Only its size class shows: version 0
     needed a third bucket.
   - *Linkage,* whether the posts join the wallet's identities over time: yes, in this run. Both
     versions were paid by a ticket paymaster whose only buyer is owner 0, so the payer names the
     wallet, and the same payer joins the two versions to each other. Version 0 also went out two
     blocks after owner 0 posted that paymaster's answers. A ticket hides its buyer only among
     its paymaster's buyers, and here there was one.
3. **How much one leaked key opens.** One version's key opens that version and no other. But a
   version is cumulative, so the newest version's key opens the wallet's whole history (28
   transactions here), its unspent tickets, and the opening of a note someone made for it, which
   anyone holding it can spend. The seed opens every version. And experiment 46's first guardian
   set with the phrase, through its envelope still on the board, opened the seed, so both
   versions too.

| File | What |
|---|---|
| [`rebuild.test.ts`](rebuild.test.ts) | The posts' layout, the reopened plaintexts' hashes against the written ones, the observer's view |
| [`record.json`](record.json) | Both processes' records: transactions, locators, sizes, each plaintext's SHA-256, the checks, the leak and the metadata. No key, share, phrase, word or plaintext |

The run is kohaku-rs's `kohaku-frame-secrets` (branch `experiment/secrets`): its `backup`
module and its `backup` example.

## Run

```bash
# kohaku-rs, crates/; after experiments 45 and 46, with their files:
SEED_FILE=... STATE_DIR=... PUBLIC45=public45.json PUBLIC46=public46.json \
  HISTORY=build45.json,restore45.json,setup46.json,recover46.json RECORD=write.json MODE=write \
  cargo run --release -p kohaku-frame-secrets --example backup
STATE_DIR=... RECORD=reopen.json MODE=reopen \
  cargo run --release -p kohaku-frame-secrets --example backup
# here, offline:
npx vitest run experiments/47-backup
```

## The construction

```text
key v      K("backup/<v>/key")          locator v   K("backup/<v>/locator")      (experiment 45)
posted     locator (32) || nonce (12) || AES-256-GCM(padded, aad = locator) || tag (16)
padded     uint32be(length) || plaintext (JSON) || zeros, to a multiple of 2,048 bytes
```

What a version carries, which neither the seed nor the chain gives on its own:

| Field | Why the seed and the chain are not enough |
|---|---|
| contracts: the pool, the registry, the vault, the board | experiment 45's rebuild needed them given |
| paymasters: address, committee key, first ticket, count | the same, for every committee the wallet bought from |
| account: index, the owner now (owner 1 after experiment 46), the delay | saves trying owners |
| guardians: set, threshold, contacts | whom to ask; nothing they hold |
| cursors: the next keychain nonce, vault note, ticket, recipient, backup | saves the gap scans |
| tickets: unspent ones, with epoch and signature | without the board's blinded answers |
| received: the opening of a note someone made for the wallet | without the viewing key's scan, and the only copy if it came off the chain |
| history: the wallet's own transaction hashes | nothing on the chain says which are the wallet's |

## Results (Hegota testnet, chain 8141, 2026-10-21)

**While the device holds the seed:**

| Step | Tx | Block | `gasUsed` | Frames: execution + state |
|---|---|---|---|---|
| owner 0 deploys a ticket paymaster for a new committee and buys 2 | [`0x7dff9f46…`](https://dora.privacy.ethrex.xyz/tx/0x7dff9f46ee63ee058a0dc5ad57fcbc8b638537b2bb09114f782a5906a3caa6f1) | 490,828 | 2,434,267 | 100 · 16,287 + 2,314,890 · 1,623 |
| owner 0 posts the two requests and blinded answers | [`0xb2787036…`](https://dora.privacy.ethrex.xyz/tx/0xb2787036b0bec634d0935dc91f65184ea8b2b004afbd44a05e24d8c5ef419f45) | 490,830 | 45,665 | 100 · 5,379 · 2,479 |
| backup version 0, 4,105 bytes of state, posted as 6,204 bytes, from ticket 5's fresh sender `0x3ffEf0EB…` | [`0x8b421e42…`](https://dora.privacy.ethrex.xyz/tx/0x8b421e428c7899536b4a16a225cef78ddebf768228529198164d8b544f889b2d) | 490,832 | 616,593 | 100 · ticket 122,006 + 183,600 · post 55,234 |
| backup version 1, 3,980 bytes, posted as 4,156 bytes, from ticket 6's fresh sender `0x6b3adE4A…` | [`0x9a7d8710…`](https://dora.privacy.ethrex.xyz/tx/0x9a7d8710319d2cfb383137f408978d8b831f2033896a633af9840a0cc9519757) | 490,834 | 485,521 | 100 · ticket 122,006 + 183,600 · post 38,425 |

The ticket paymaster is `0x6Ab8026c7C3dAD7d0F6eaA000b791Aa5c76C1612`. A post's cost is mostly
calldata: version 0's 6,204 bytes took the transaction to 616,593 gas, inside one ticket's
0.001 ETH at the testnet's fees.

**After the loss**, given the phrase, and guardians 7 and 9's shares off the chain:

| Step | Result |
|---|---|
| join the two shares into `R2`; find its envelope by locator (experiment 46's `0xb82aa08b…`); open it with the phrase | the seed |
| `K("backup/0/locator")`, `K("backup/1/locator")`, then `K("backup/2/locator")` against the board | versions 0 and 1 found; version 2 not, so the count stops |
| open each with its key | both opened; their SHA-256 match the ones written |
| check the newest against the chain | 7 of 7: the four contracts have code; the account is the seed's account 0 and owner 1 holds it; experiment 45's unspent ticket 1, carried only here, verifies under its committee's key and its sender is at nonce 0; the received note's opening is a leaf of its vault |

## What an observer sees, against what the backup is

| Metadata | What is posted | What an observer can tie it to, here |
|---|---|---|
| where | experiment 33's board, which experiments 33, 36, 45 and 46 also post to | nothing by itself |
| what | a pseudorandom locator, a nonce, ciphertext; no tag; the two versions' locators unrelated | nothing; versions cannot be told to be one wallet's from their bytes |
| size | whole 2,048-byte buckets: 6,204 and 4,156 bytes | the size class of the wallet's state, and that version 0 was larger than 1; no other kind of board message is a multiple of 2,048 plus 60 bytes, so a backup is recognisable as a backup |
| sender | a fresh key at nonce 0, never funded, used once | nothing |
| payer | ticket paymaster `0x6Ab8026c…`, whose `Bought` logs name one buyer, owner 0 | **owner 0**: the crowd of buyers is one |
| when | version 0 two blocks after owner 0's answer post for the same paymaster; version 1 two blocks after version 0 | **owner 0**, by timing |

## Leakage and linkage

| Question | What it asks | Here |
|---|---|---|
| leakage | what one backup, read alone, tells an observer about the wallet's state | its size class, two or three buckets; nothing else |
| linkage | whether backups, over time, join the wallet's accounts and each other | both versions joined to owner 0 through the paymaster's single buyer and the timing, and so to each other; their bytes and senders alone would not join them |

A backup that leaks nothing can still link. Each version a wallet posts through the same
paymaster, at times its other acts predict, adds one more post joined to the same buyer, so the
backups over time draw the line between the wallet's accounts that the fresh senders were meant
to break. The fixes differ too: padding and encryption answer leakage; a paymaster with many
buyers, unpredictable timing, and no reuse of anything across versions answer linkage.

## How much one leaked key opens

| Leaked | Opens |
|---|---|
| one version's key, `K("backup/<v>/key")` | that version only (version 0's key, tried on version 1, failed) |
| the newest version's key | the newest version, which is cumulative: the whole history (28 transactions), the unspent tickets, and the received note's opening, a bearer secret anyone holding it can spend |
| the seed | every version, and everything in experiment 45's observation 3 |
| the current guardian set and the phrase | the seed, as this reopening did |
| an old guardian set and the phrase | the seed, through experiment 46's first envelope, which is still on the board, so both versions |

## Observations

1. **The recovered key opens the backup, with one hop.** Post 30's table asks "whether the
   recovered key opens the backup". Here the guardians' key does not open it; it opens the
   envelope, which gives the seed, which gives each version's key. The guardians never held
   anything that opens the backup by itself. The phrase is the factor between them.
2. **The ticket hid the sender, and the paymaster gave it back.** The posts came from fresh keys
   with no funding, which is what tickets are for. But a ticket hides its buyer only among the
   paymaster's buyers. A paymaster that one wallet set up and alone bought from names that wallet
   on every post it pays for. The backup needs a paymaster with many buyers, and a post sent at a
   time that no act of the wallet's predicts.
3. **A bucket hides the size, not the kind.** Padding to 2,048 bytes hid the exact size, but the
   two versions fell into different buckets, and no other message on the board has a backup's
   length. A wallet that wants backups not to stand out would pad every version to one fixed size,
   or post where messages of that size are common.
4. **Cumulative backups make the newest key the vault.** Each version's key is separate, so a
   leaked old key opens an old state. But each version carries the whole history, so the newest
   key opens all of it, and a received note's opening in it can be spent by whoever reads it. A
   backup that keeps only what spending needs, and keeps bearer secrets only until they are
   moved under the seed's own derivation, would shrink that vault. Post 30's sentence held:
   whoever later holds the key holds the vault.
5. **Nothing posted can be taken back.** Versions 0 and 1, and experiment 46's three envelopes,
   stay on the board for good. A rotation of guardians or of the seed protects what is written
   afterwards, not what is there. The board is the "public store" the claim allows; a store that
   can drop a ciphertext would be needed for anything else, and its operator would be trusted to.
6. **Post-quantum status.**
   - *Holds:* the backup's confidentiality, AES-256-GCM under a key from HKDF-SHA256 of the seed,
     at about 128 bits against Grover's search; the locators, which are pseudorandom; the
     tickets' unlinkability, which is perfect.
   - *Does not hold:* the path to the seed through experiment 46, whose shares travelled as
     secp256k1 ECDH announcements in that run, and whose account checks secp256k1 signatures.
     Here the shares were handed over off the chain. And the ticket committee's BLS key, from
     which a quantum adversary could forge tickets: the paymaster's loss, not the backup's.
