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
