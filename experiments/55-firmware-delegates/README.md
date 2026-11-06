# 55 - Who decides where a hardware wallet's account can delegate

EIP-7702 lets an externally owned account point its code at a contract, the delegate. Whoever
chooses the delegate chooses what the account can do from then on. A hardware wallet signs the
authorization, so its firmware is where a user's choice can be widened or narrowed.

This experiment reads Trezor's firmware at a pinned commit:

- [`trezor/trezor-firmware`](https://github.com/trezor/trezor-firmware), commit
  `8ef55098ffa25d46c18d514ae685b424beb1f04b` (2026-11-05).

It answers three questions:
- where the list of delegates comes from;
- how that list changed, release by release;
- whether anything a host sends can add to it.

Then it runs the emulator on three authorizations.

The firmware is GPLv3. Nothing from it is copied here: the firmware is cloned and built in a work
directory outside this repository. The runs import `trezorlib` (LGPLv3) from that checkout, without
vendoring it. Addresses, chain IDs, names and error strings are quoted as facts.

## Written before any run

**The claim.** The firmware alone decides which delegate a user can authorise. The list is
compiled in, keyed by chain ID, and only a firmware release changes it. A host cannot add a
delegate, signed or not.

**It would be shown wrong if any of these is observed:**
- the firmware signs an authorization to a delegate it does not list, after a warning or
  otherwise;
- a host-supplied definition, signed or not, adds a delegate;
- the list is read from anything but the compiled template.

**It is done when** there is:
- the template's history, with each delegate's arrival and departure and the first release that
  carries it;
- the answer on signed definitions;
- the three emulator outcomes below.

**The plan, fixed before the emulator runs:**
- Build the emulator for model T3T1 at the pinned commit. Run it with experimental features
  enabled, since the authorization field is marked experimental.
- Drive it with `trezorlib`'s `ethereum.sign_tx_eip1559`, with an authorization on chain 1, and
  read the screens through the debug link.
- The three runs:
  - **(1)** the delegate is `0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9`, which the list names
    "Simple7702Account" on chain 1;
  - **(2)** the delegate is an address the list does not hold;
  - **(3)** the delegate is the zero address, a revocation.
- Record for each run:
  - signed or refused, and the device's reason;
  - the screens' text;
  - for a signed run, whether the transaction's signature and the authorization tuple's signature
    both recover to the account.

**Predictions:**

| Run | Prediction |
|---|---|
| (1) | signed; a screen names "Simple7702Account" and shows its address; both signatures recover to the account |
| (2) | refused with `DataError` "Unknown EIP-7702 delegate address", before any confirmation screen |
| (3) | signed after a revocation screen; both signatures recover |

## What the source says, read on 2026-11-06

This part is a reading of the source, not a run. It came before this README was written.

### Where the list comes from

- The list is `_EIP7702_ADDRESSES`, a dictionary from chain ID to (address, name) pairs.
- It lives in the template `core/src/apps/ethereum/sc_constants.py.mako`, which the build renders
  into `sc_constants.py`.
- The template refuses to render if the dictionary has a key 0. EIP-7702 uses chain ID 0 for an
  authorization valid on every chain, so a delegate cannot be allowed on all chains at once.
- The authorization is handled by `_handle_eip7702` in `core/src/apps/ethereum/sign_tx_eip1559.py`:
  - it reads the delegate's name with `lookup_eip7702_address(chain_id, delegate)`, which compares
    against the compiled list only;
  - an address not in the list raises `DataError("Unknown EIP-7702 delegate address")`, with no
    screen and no warning to accept;
  - the zero address skips the lookup and shows a revocation screen.
- The same handler adds these limits, each a `DataError`:
  - the transaction's chain ID must not be 0;
  - its `to` must be set, its value must be 0, and its calldata must be empty;
  - it must carry no payment request;
  - the network must be known;
  - the transaction carries at most one authorization;
  - the authorization's nonce is the transaction's nonce plus one.

  So the device signs only a self-sponsored type `0x04` transaction that does nothing but delegate.
- On the wire, the authorization is the field `auth7702` of `EthereumSignTxEIP1559`, holding one
  delegate address. The field is marked `experimental_field`, and its messages `experimental_message`.
- An earlier standalone message, `EthereumSignAuth7702`, which signed a tuple alone, was dropped
  on 2026-08-11 (`bd6186c4a`).

### The template's history

From `git log -- core/src/apps/ethereum/sc_constants.py.mako` at the pinned commit. The log has 12
commits; these are the ones that touch the delegate list or its lookup.

| Commit | Date | What changed |
|---|---|---|
| `0cd72f033` | 2026-07-21 | The list appears with two delegates and no chain: Ambire (`0x5a7fc113...6f6d`) and MetaMask (`0x63c0c19a...e32b`). Signing is by the standalone message |
| `afd4279ca` | 2026-08-05 | The list is keyed by chain ID: Ethereum, Gnosis, Base and Arbitrum, each with both delegates. "Unknown chains are now disallowed" |
| `bd6186c4a` | 2026-08-11 | The standalone message is dropped. (This commit does not touch the template) |
| `9a044adb3` | 2026-08-12 | Authorization moves into `EthereumSignTxEIP1559`, at most one tuple per transaction. The template gains its refusal of chain ID 0. The commit says "The feature is still experimental" |
| `255787a94` | 2026-08-22 | Simple7702Account (`0x4Cd241E8...66c9`) is added on Ethereum |
| `b1d65d51d` | 2026-08-24 | Simple7702Account is added on Optimism, BNB, Polygon, Base and Arbitrum |
| `1528e6ea1` | 2026-10-30 | MetaMask is removed from every chain: "drop MetaMask EIP-7702 support". The commit gives no reason |

The releases, from the tags that contain each commit:

| Release | Date | Delegates |
|---|---|---|
| core v2.12.4 | 2026-08-03 | Ambire and MetaMask, on any chain, through the standalone message |
| core v2.12.5 | 2026-08-31 | keyed by chain: Ambire and MetaMask on 1, 100, 8453 and 42161; Simple7702Account on 1, 10, 56, 137, 8453 and 42161 |
| core v2.13.0 | 2026-10-08 | the same as v2.12.5 |
| unreleased, `8ef5509` | 2026-11-05 | MetaMask gone: Ambire on 1, 100, 8453 and 42161; Simple7702Account on 1, 10, 56, 137, 8453 and 42161 |

In every release the messages that carry an authorization are marked experimental.

### Can a signed definition carry a delegate?

**No, at this commit.**
- The host can send signed definitions of four kinds (`common/protob/messages-definitions.proto`,
  `DefinitionType`):
  - `ETHEREUM_NETWORK`, a chain's ID, symbol, SLIP-44 and name;
  - `ETHEREUM_TOKEN`;
  - `SOLANA_TOKEN`;
  - `ETHEREUM_DISPLAY_FORMAT`, an ERC-7730 clear-signing format for one contract function.
- None of the four has a field for a delegate.
- The delegate check reads no definition. The only definition the authorization path uses is the
  network's: an unknown network is refused.
- A display format names addresses inside calldata, and an authorization must have empty
  calldata, so no display format applies.
- A signed network definition can make a new chain known. The delegate list still has no entry
  for it, so every delegate on that chain is refused. Only a revocation to the zero address could
  be signed there.

### What follows, before the runs

- Under the claim, each delegate is a release decision.
- The history shows the list growing by chains and contracts, then shrinking. Between
  2026-10-08 and the next release, a delegate users relied on (MetaMask) is about to stop being
  signable on the device.
- The device can still sign a revocation, so a user can always leave a delegate, but cannot
  re-point the account at another one off the list.

## The runs

Not run yet. The session that wrote this could not install the firmware's pinned toolchain or
build the emulator: its permission policy refused the Rust nightly install and the Python
environment's sync, as code from an outside source. The runs wait for that permission, or for a
session that has it.

**Post-quantum status.** None. EIP-7702 authorizations, and the transactions that carry them, are
secp256k1 signatures. The device would need a post-quantum scheme for both before any of this
applies to a post-quantum account.
