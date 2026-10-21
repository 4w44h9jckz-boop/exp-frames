# 46 - Guardians who hold a recovery key, not the seed

Experiment 31 recovered an account from two of the owner's own devices, with nobody else holding
anything. It left the case it could not cover: the user who loses every device. That case needs
someone else. Post 30 states the risk: "A recovery committee that holds shares for years is a
persistent operator again", and it orders the remedies: "the user's own devices before any
guardian, a protocol-enforced delay before any committee, and a committee, if at all, with
rotation and a way out". Its guideline 11: "recovery must not quietly rebuild the operator the
design removed".

This experiment gives the guardians shares of a recovery key, never of the seed, puts the
recovery behind the account's delay, which the owner can cancel, and rotates the guardians.

## Written before any run

**The claim.** Guardians can hold shares of a recovery key, and never of the seed, behind a
delay the owner can cancel, so that `t` of `n` of them recover the account and no fewer can. The
set can be replaced without the old set taking part, and none of them learns the account, its
balance or its notes from what it holds.

**It would be shown wrong if any of these is observed:**
- guardians recover without waiting out the delay, or the owner cannot cancel their attempt;
- a guardian learns the account, its balance or its notes from what it holds;
- replacing the set needs the old set to take part, or leaves the old set able to recover;
- recovery needs a party to hold a share for longer than the recovery itself (experiment 31's
  own test).

**It is done when,** on the testnet, `t` of `n` guardians recover an account after its delay, the
owner cancels a hostile attempt, the set is replaced and the old set's attempt is refused, and
what each guardian holds and learns is listed.

**The plan, fixed before the run:**
- The account is experiment 45's account 0, an unchanged `DeviceRecoveryAccount` (experiment 31)
  with the EIP's time rule and a delay of 120 s. Its one "device" is a recovery key `R`: the
  owner sets the commitment `keccak256(salt || 1 || address(R))` with `0x04`, the salt from the
  seed (`account/0/recovery-salt/<r>`).
- `R` is a fresh key for each guardian set, not derived from the seed. It is split 2-of-3 with
  Shamir's scheme over secp256k1's scalar field, and erased: it exists whole only when it is made
  and when a recovery uses it. A guardian holds an index and 32 bytes.
- The account's delay binds what the chain enforces. The seed is not on the chain: whoever opens
  it has every note at once, whatever the account says. So the seed's words are sealed in an
  envelope, posted to experiment 33's board from a fresh sender paid with a blind ticket, under a
  key that needs `R` and a phrase the user keeps (stretched with Argon2id), which no guardian
  holds. The run also seals one under `R` alone, the construction the claim would fail under,
  to show what a quorum gets from it.
- Recovery: the user's new device makes a transport key; two guardians post their shares sealed
  to it on the board; the device joins them into `R`, finds the envelope by a locator from
  `address(R)`, opens it with the phrase, and so has the seed, the account and the salt. `R`
  signs the start, naming owner 1 of the same seed; owner 1 finishes after the delay.
- A hostile attempt: two guardians who also know the account and the salt start a recovery to
  their own key. The owner cancels inside the delay.
- Rotation: the owner sets a commitment for a new `R`, split to a new set of three, and posts a
  new envelope. The old set's attempt is sent, and must be refused before inclusion.
- Recorded for each guardian: what it holds, what it receives, and what it can compute.

## Short answers

1. **Done when: met.** Two of three guardians recovered experiment 45's account 0 after its
   delay: owner 1 of the same seed finished at block 490,739, after the recovery key the guardians'
   shares gave started it at 490,721. Two guardians' hostile start was cancelled by the owner,
   and their finish was refused at admission. The set was rotated, by the owner alone, and the old
   set's start was refused at admission. What each guardian holds and learns is the table below.
2. **Would show it wrong: observed for one construction, and in part for two clauses.**
   - *Without the delay:* the account's delay held. The seed is not under it. An envelope that
     the recovery key alone opens gave two guardians the seed at once, and with it every note:
     they listed the wallet's pool note with no delay at all. This is why the envelope here
     needs a phrase the user keeps. With it, the same two got nothing.
   - *Rotation:* the old set can no longer touch the account. But the old envelope is still on the
     board, and the old set with the user's phrase opened it after the recovery: a rotation
     cannot take back a ciphertext already published.
   - *Holding a share for longer than the recovery:* every guardian holds its share from the day
     the set is made until it is replaced. That is what guardians are. Rotation bounds it;
     nothing removes it. Experiment 31 avoided it only by keeping the shares on the owner's own
     devices.
3. **No guardian learns the account from what it holds,** which is 33 bytes independent of the
   recovery key. Its posts can teach an observer, and itself, more than its share does:
   observation 3.

4. **Which loss this covers: a lost device, not a stolen one.** The account lets its current
   owner cancel any recovery, and that is what stopped the hostile guardians here. A thief who
   holds the owner's key holds the same power: it can cancel every recovery the guardians start,
   for as long as it likes, and move the account's ether itself. The seed on the device gives
   it every note too, whatever the account does. So this recovery answers a device that is gone
   or destroyed, whose key nobody else holds. A device that may be in someone else's hands needs
   something else first: a device that does not give up the seed (a secure element), and an
   account whose cancel the guardians can outvote, which this one, experiment 31's, does not
   have. Neither was built or run here.

| File | What |
|---|---|
| [`rebuild.test.ts`](rebuild.test.ts) | The run read back from public data: commitments, reveals, signers, the refusals, the envelopes and the guardians' posts |
| [`record.json`](record.json) | Both processes' records, and the three transactions of a first attempt. No key, share, phrase or word |

The run is kohaku-rs's `kohaku-frame-secrets` (branch `experiment/secrets`): its `guardians`
module, Shamir's scheme over secp256k1's scalar field and the envelope, and its `guardians`
example.

## Run

```bash
# kohaku-rs, crates/; after experiment 45, with its SEED_FILE; STATE_DIR outside any repository:
SEED_FILE=... STATE_DIR=... PRIVATE_KEY=0x... PUBLIC=public46.json RECORD=setup.json MODE=setup \
  cargo run --release -p kohaku-frame-secrets --example guardians
STATE_DIR=... PUBLIC=public46.json RECORD=recover.json MODE=recover \
  cargo run --release -p kohaku-frame-secrets --example guardians
# here, offline:
npx vitest run experiments/46-guardians
```

`STATE_DIR` holds each party's own storage: the phrase, which stands for the user's memory, and
each guardian's file. The recovery process is given no `SEED_FILE` and no `PRIVATE_KEY`.

## The construction

```text
R           a fresh secp256k1 key per guardian set, not derived from the seed
shares      Shamir 2-of-3 of R over secp256k1's scalar field: index (1) || y (32), one per guardian
commitment  keccak256(salt || 1 || address(R)),  salt = K("account/0/recovery-salt/<set>")
P           Argon2id(phrase, salt = "kohaku-seed-envelope-v1" || address(R)), 64 MiB, 3 passes, 1 lane
key         HKDF-SHA256(IKM = R || P, salt = "kohaku-seed-envelope-v1", info = address(R))
envelope    0x20 || locator || nonce (12) || AES-256-GCM(the 24 words, padded to 216 bytes) || tag
locator     keccak256("kohaku-seed-envelope-v1" || address(R))
```

`R` is made, used for the commitment and the envelope, split, and dropped. The account is
experiment 31's `DeviceRecoveryAccount` unchanged, with `R` as its one device.

## Results (Hegota testnet, chain 8141, 2026-10-21)

Account 0 `0xe067f84f0eaa1a62F5Ad82f9c5f18B88D335AC95` (experiment 45), EIP rule, delay 120 s;
owner 0 `0x883ADC0Fe3792Df2c5361E45dAF4830cbaE51d5C`. Recovery keys: `R0`
`0xdCA464076e68E1cf1738B12E317672bBD25245aE` (guardians 1 to 3), `R1`
`0x50c68C29bB15a036F05aC6D79aA903624AE0ad04` (4 to 6), `R2`
`0x00682a3d87776bD250E053710fC7A07A9d1844a0` (7 to 9). Ticket paymaster for the envelopes' posts
`0xB6e3D784782AaE36f6a58CF354667511e569dFE4`, a new committee of four, quorum three.

**While the owner's device holds the seed:**

| Step | Tx | Block | `gasUsed` | Frames: execution + state |
|---|---|---|---|---|
| the funder pays nine guardians gas | [`0xcaea6713…`](https://dora.privacy.ethrex.xyz/tx/0xcaea6713541c7465531f6d10a36b657a8f3ad7c58da29d60a224ed709af14bb0) | 490,681 | 101,714 | 100 · 3,000 each |
| owner 0 deploys a ticket paymaster, buys 3 | [`0x39fe989f…`](https://dora.privacy.ethrex.xyz/tx/0x39fe989fc768e2fe209ef2b0a747baa0b89abb76efc4f15ff7007a2e46ca7440) | 490,683 | 2,434,267 | 100 · 16,287 + 2,314,890 · 1,623 |
| owner 0 posts the three requests and blinded answers | [`0xdd9435ea…`](https://dora.privacy.ethrex.xyz/tx/0xdd9435ead4cbd54031a441df59cfe5185c8f1251decd24e540570273d0b7774d) | 490,684 | 58,684 | 100 · 5,379 · 2,479 · 2,479 |
| owner 0 commits the account to `R0` (`0x04`) | [`0x80eacfb1…`](https://dora.privacy.ethrex.xyz/tx/0x80eacfb18f48e0fdebb0b650d8f0b1f68a0ab29af8517bae0bca5e6e0154f981) | 490,686 | 130,391 | VERIFY 2,404 · 12,393 + **97,920** |
| the envelope under `R0` and the phrase, from ticket 2's fresh sender | [`0x720d4ae3…`](https://dora.privacy.ethrex.xyz/tx/0x720d4ae3ac119e2e2d23b3d2de4b9a6dd050d1c55cbdec88e05aa31b7fd0fc63) | 490,688 | 336,772 | 100 · ticket 122,006 + 183,600 · 6,689 |
| **hostile:** guardians 2 and 3, told the account and its salt, start a recovery to their own key, signed by `R0` | [`0x723f22ff…`](https://dora.privacy.ethrex.xyz/tx/0x723f22ffbdc289e4159223bbd5ed63e27fc420612112efcf2e58eddf40b8ed51) | 490,690 | 33,900 | VERIFY 3,130 · start 12,452 |
| owner 0 cancels inside the delay (`0x03`) | [`0x9fa99861…`](https://dora.privacy.ethrex.xyz/tx/0x9fa998610a63f70845d2c58aec1744da95c1b981e2045cb18f8c02807148aa1a) | 490,692 | 31,951 | VERIFY 2,404 · cancel 12,373 |
| their key's finish, after the unlock time | **refused at admission**, "validation prefix frame reverted" | | | |
| owner 0 rotates to `R1`, guardians 4 to 6 (`0x04`) | [`0x37f39d70…`](https://dora.privacy.ethrex.xyz/tx/0x37f39d706584fba6591deb158895ba07aab7b1f5e0dae4f77cdc972bb0d2143b) | 490,712 | 32,471 | VERIFY 2,404 · 12,393 |
| the envelope under `R1` and the phrase, from ticket 3's fresh sender | [`0x3ad00c4d…`](https://dora.privacy.ethrex.xyz/tx/0x3ad00c4db6d044e5fd2245d62973cbc3eed320848f585ba421abd86a3a351814) | 490,714 | 336,736 | 100 · ticket 122,006 + 183,600 · 6,689 |
| guardians 1 and 2 (the old set) start a recovery, signed by `R0` | **refused at admission**, "validation prefix frame reverted" | | | |

Off the chain, the same two hostile guardians:
- opened an envelope sealed under `R0` alone, not posted, and had the seed at once. Owner 0's key
  came out of it, and the keychain listed the wallet's pool note from the pool's events;
- failed to open the posted envelope without the phrase, and with a guess.

**After every device is lost.** The new device has the phrase, the public addresses, and two
guardians willing to help:

| Step | Tx | Block | `gasUsed` | Frames |
|---|---|---|---|---|
| guardian 4 posts its share, sealed to the new device's transport key | [`0xffb79c46…`](https://dora.privacy.ethrex.xyz/tx/0xffb79c466ae7741a7ab06e0b69ee1b70c444a881f5401f9186bcec6e9839b862) | 490,717 | 32,646 | 100 · 5,379 |
| guardian 6 does the same | [`0x8289dd19…`](https://dora.privacy.ethrex.xyz/tx/0x8289dd193d24b03925c54fffd15ff150cc1ecd46f54e680df8306a330779d184) | 490,719 | 32,646 | 100 · 5,379 |
| the device joins `R1`, finds the envelope by its locator, opens it with the phrase (186 ms) and has the seed | off chain | | | |
| `R1` starts a recovery to owner 1 | [`0x09df2934…`](https://dora.privacy.ethrex.xyz/tx/0x09df293493345eebf8a5d3164e8cd1c84b7bfd5d9a5ce413221791c76314aba8) | 490,721 | 33,924 | VERIFY 3,130 · start 12,452 |
| owner 1 finishes, at the first block past the unlock time | [`0x0a47dc4f…`](https://dora.privacy.ethrex.xyz/tx/0x0a47dc4f997d1fb69def4cb103fb265a5946aad5f8508f57b17f939136938004) | 490,739 | 42,604 | VERIFY 4,807 · finish 20,623 |
| owner 1 rotates to `R2`, guardians 7 to 9 | [`0xf63b35d6…`](https://dora.privacy.ethrex.xyz/tx/0xf63b35d6c086f9a6d91e48df2b9874abe405d643ae2102ed3dbc7a4009fd44b1) | 490,741 | 32,471 | VERIFY 2,404 · 12,393 |
| the envelope under `R2`, from ticket 4's fresh sender, the ticket rebuilt from its answer on the board | [`0xb82aa08b…`](https://dora.privacy.ethrex.xyz/tx/0xb82aa08b029f655314764c67a051946afb516b7721904ae0a889ca3aeb105b89) | 490,743 | 336,772 | 100 · ticket 122,006 + 183,600 · 6,689 |
| guardians 1 and 2 with the phrase open the first envelope, still on the board | off chain: **opened** | | | |

The finish used the same frame gas as experiment 31's under the EIP's rule (4,807 and 20,623).
A first attempt mined three transactions (`0x52c0f490…`, `0xcda325e7…`, `0xb84c86eb…`, blocks
490,670 to 490,674: guardian gas, a paymaster and three answers) and then stopped at the first
commitment, which had no state gas for its fresh slot. They are fixtures too.

## What each guardian holds and learns

| | Holds | Receives | Can compute alone | With a second guardian |
|---|---|---|---|---|
| at setup | an index and 32 bytes, a share of `R`; its own posting key | its share, from the owner's device | nothing: for a threshold of two, one share is independent of `R` | `R`, so `address(R)` and the envelope's locator; not the phrase, so not the seed; not the salt, so not the commitment, and not which account is committed to `R` |
| at recovery | the same | a request, and the new device's transport public key | nothing more | the same as at setup; the device joins the shares, so the guardians never hold `R` |
| watching the chain | | | its own post, then a start that reveals `address(R)` and the account two blocks later: observation 3 | |

## Observations

1. **A delay protects only what the chain enforces.** The account cannot change hands before
   its unlock time, whoever signs. A seed is not on the chain: whoever opens it has every note,
   every ticket and the owner's key at once, and could cancel the real owner's recovery. A
   recovery key that opens the seed by itself turns guardians into holders of the seed. A
   second factor the guardians do not hold is what keeps them on the chain's side of the delay.
   Here it is a phrase the user keeps. A quorum of guardians can still guess it against the
   public envelope, at one Argon2id evaluation per guess: 144 to 186 ms and 64 MiB here, for a
   five-word phrase of about 55 bits.
2. **The salt is a second lock on the account.** The commitment hides `address(R)` behind a salt
   from the seed. A quorum that holds `R` but not the seed cannot reveal the commitment, so it
   cannot start a recovery at all. The hostile start here had to be given the account and its
   salt. A recovery reveals both, so the set should be rotated after every recovery, as owner 1
   did.
3. **The board carried the shares, and the board is public.** Guardians 4 and 6 posted from
   their own addresses, under a public tag, two and four blocks before `R1`'s start. Anyone
   watching, the guardians included, can tie those two addresses to account 0 by timing alone. A
   share delivered off the chain, or posted untagged from a fresh sender, with the start sent
   later, would not leave that trace. And the posts are sealed with secp256k1 ECDH, so a quantum
   adversary who keeps them can open them later (item 6).
4. **Rotation takes back the account, not the envelope.** The old set's start was refused, and
   the owner needed nobody to rotate. The first envelope stays on the board for good, and the old
   set with the phrase opened it after the recovery. Only an envelope in a store that can drop
   it, or a new seed after a rotation, ends that. This is the vault post 30 names.
5. **An account deployed with an empty commitment pays for its first one.** Experiment 45 kept
   the commitment out of the CREATE2 address, so that the seed alone finds the account. The first
   `0x04` then writes a fresh slot: 97,920 state gas, once.
6. **Post-quantum status.**
   - *Holds:* Shamir's shares, which are information-theoretic; the envelope, AES-256-GCM under
     HKDF-SHA256 of `R` and an Argon2id stretch, at about 128 bits against Grover's search;
     the commitment, a hash that shows nothing of `R` until a recovery.
   - *Does not hold:* the signature the account checks. `R` and the owner are secp256k1 keys,
     and `R`'s public key appears when it starts a recovery; the owner's appears on its first
     transaction. The shares' transport, ECDH announcements on a public board: a quantum
     adversary who keeps them recovers `R1`, and with the phrase, guessed or known, the seed
     from the envelope. A post-quantum account would check a hash-based one-time key for `R`, as
     experiment 17's account does, and the shares would travel off the chain or under a
     post-quantum KEM.
