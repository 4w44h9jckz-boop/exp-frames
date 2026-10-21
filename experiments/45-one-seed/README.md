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

**It is done when,** on the testnet, a device given only the seed rebuilds the wallets of
experiments 31 (an account and its privacy-pool notes), 36 (tickets) and 40 (notes in a vault)
from the chain, spends a privacy-pool note and a ticket, and every derivation path is listed
with its domain.

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

## Derivation paths

To be filled from the run.
