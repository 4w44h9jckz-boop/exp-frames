# 56 - The execution digest on a hardware wallet, with unchanged firmware

Experiment 27 defined the execution digest $E$ as EIP-712 typed data, `FrameExecution`, so that
a wallet with no frame support can sign it through `eth_signTypedData_v4`. A hardware wallet is
the hardest such wallet: it computes the hash itself and shows what it signs on a small screen.
This experiment signs experiment 27's vectors on Trezor's firmware emulator, without changing the
firmware.

The firmware is [`trezor/trezor-firmware`](https://github.com/trezor/trezor-firmware) at commit
`8ef55098ffa25d46c18d514ae685b424beb1f04b` (2026-11-05). It is cloned and built in a work
directory outside this repository, and nothing from it is copied here. The runner imports
`trezorlib` (LGPLv3) from that checkout, without vendoring it.

## Written before any run

**The claim.** A hardware wallet can sign $E$ today through EIP-712, and its screens let a user
see each frame's target, value and data before signing.

**It would be shown wrong if any of these is observed:**
- the device refuses $E$, for its size or its nesting;
- it signs, but shows a frame's data only as truncated hex or a hash, so the user cannot tell what
  they authorise;
- its signature does not recover to the expected signer over the vector's $E$.

**It is done when** the table below is filled for every vector, with the screens' text captured.

**The plan, fixed before the run:**
- **The firmware.** Build the emulator for model T3T1 at the pinned commit, unchanged. Load the
  standard test mnemonic through the debug link. The signer is the device's account at
  `m/44'/60'/0'/0/0`.
- **The vectors.** Experiment 27's set for EIP-8250 at `1a086d5c`
  (`experiments/27-execution-digest/erc-assets/vectors.json`), eleven vectors. The set at
  `f3079a0` differs only in the nonce keys, so it is run second, for the hashes alone.
  - `many-frames` is the twelve-frame vector, with data of 0, 1, 31, 32, 33 and 1,000 bytes.
  - $E$ does not depend on the account's owner: the domain's verifying contract is the sender.
    So each vector's $E$ is signed as it stands, and the signature must recover to the device's
    own address.
- **The calls.** Each vector goes through `trezorlib.ethereum.sign_typed_data` as
  `eth_signTypedData_v4` JSON. It is called once with `metamask_v4_compat=True`, the default, and
  once with `False`.
- **The screens.** The debug link reads each screen's title and text, and presses through every
  "show full" choice, so that every value the firmware can show is shown.
- **Recorded for each vector:**
  - signed or refused, and the device's reason;
  - the number of screens, with the "show full" choices taken and with them declined;
  - how the domain appears: name, version, chain ID, and the sender as verifying contract;
  - for each frame, whether its target, value and data appear decoded, as full hex, truncated, or
    not at all;
  - whether the signature recovers to the device's address over the vector's $E$.

**Predictions**, from reading the firmware's EIP-712 signer at the pinned commit before the run:

| What | Prediction |
|---|---|
| refused | none of the eleven. The signer sets no limit on a field's size, and `Frame[]` is one level of array of structs, which it handles |
| recovery, `metamask_v4_compat=True` | every signature recovers to the device's address over the vector's $E$ |
| recovery, `metamask_v4_compat=False` | no signature recovers over $E$. The firmware then encodes each struct in `Frame[]` by its members' encoding rather than its hash, so its digest differs from viem's |
| domain | one screen with name `FrameExecution`, version `1`, the chain ID as a decimal, and the sender as an address |
| frames, by default | not shown: the message screen offers "show full message", and declining it signs having shown the domain alone |
| frames, shown in full | an "array of N Frame" screen, then each frame's seven fields, one screen each: mode, flags, limits and value as decimals, the target as an address, and the data as full hex, paged, never decoded |
| data of 1,000 bytes | 2,000 hex characters, over many pages, with nothing to say what call they encode |
| screens, `many-frames`, shown in full | over 90 (twelve frames times seven fields, plus the array, the struct, the domain and the final screens) |

If the predictions hold, the claim holds in its first half and fails in its second. The device
signs $E$ correctly, and it can show every byte. But it shows the data as raw hex, and it lets
the user sign without seeing any frame.

## The runs

Not run yet. The session that wrote this could not install the firmware's pinned toolchain or
build the emulator: its permission policy refused the Rust nightly install and the Python
environment's sync, as code from an outside source. The runs wait for that permission, or for a
session that has it.

**Post-quantum status.** None. EIP-712 signatures on the device are secp256k1, and the firmware
has no post-quantum scheme for Ethereum. $E$ itself does not depend on the scheme. A post-quantum
account would need the device to sign $E$ with the account's own scheme, through EIP-8288's
leanSPHINCS dependency or a successor (experiment 49).
