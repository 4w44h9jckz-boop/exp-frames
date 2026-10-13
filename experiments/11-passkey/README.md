# 11 — Passkey accounts: raw P256 and WebAuthn

EIP-8141 validates P256 signatures in the protocol (scheme `0x2`, 6,700 gas). This experiment
checks what that buys a wallet whose key is a passkey. There are two kinds of P256 key, and the
protocol scheme serves only one of them.

- **A raw P256 key** signs any 32-byte digest it is given. Examples are the Secure Enclave through
  CryptoKit, Android Keystore, and an HSM. It can sign the sig hash directly.
- **A WebAuthn passkey** (`navigator.credentials.get()`) never signs a raw digest. It signs
  `sha256(authenticatorData ‖ sha256(clientDataJSON))`, where `clientDataJSON` carries the
  challenge in base64url. A protocol P256 entry over the sig hash is therefore out of reach. An
  explicit-digest entry would not help either: its digest would have to commit to the sig hash, and
  the sig hash commits to the entry (explicit-`msg` signatures are not elided).

So there are two accounts:

| Account | Signature entry | Who checks the signature | Code |
|---|---|---|---|
| [`P256Account.yul`](P256Account.yul) | P256, `signer` = owner, `msg` ∅ | the protocol; the account checks the signer with `SIGPARAM` | 78 B runtime + owner (110 B) |
| [`WebAuthnAccount.yul`](WebAuthnAccount.yul) | ARBITRARY, `msg` ∅, the whole assertion | the account: `SIGDATACOPY`, SHA-256 precompile, base64url of `TXPARAM(0x08)`, `P256VERIFY` (`0x100`) | 719 B runtime + `qx ‖ qy` (783 B) |

`P256Account` is experiment 02's `SimpleAccount` with the scheme check changed from SECP256K1 to
P256. The account still exists for a reason: the **default code accepts SECP256K1 only**. A P256
key's address (`keccak256(qx ‖ qy)[12:]`) cannot send a frame transaction until code is deployed there.

`WebAuthnAccount` reads one ARBITRARY entry laid out as
`authLen (2) ‖ challengeIndex (2) ‖ typeIndex (2) ‖ authenticatorData ‖ clientDataJSON ‖ r ‖ s`.
It requires all of the following:

- the user-presence flag is set;
- `"type":"webauthn.get"` appears at `typeIndex`;
- `"challenge":"<base64url(sig hash)>"` appears at `challengeIndex`;
- `s ≤ n/2`;
- `P256VERIFY` accepts the result.

ARBITRARY bytes are elided from the sig hash, so the challenge can be the sig hash itself without
circularity. [`passkey.ts`](passkey.ts) has a software authenticator that produces what a browser
would: `rpIdHash` of `exp-frames.test`, flags `UP|UV`, and the same `clientDataJSON` field order
browsers emit.

## Run

```bash
npx tsx experiments/11-passkey/example-passkey.ts   # setup (once), then A-C on the testnet
npx tsx experiments/11-passkey/negative.ts          # simulations only
```

Both P256 keys are derived from `PRIVATE_KEY` (labels `raw` and `webauthn`).

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

| Tx | What | Frames: execution / state gas | `gasUsed` |
|---|---|---|---|
| [`0xce4c72f4…`](https://dora.privacy.ethrex.xyz/tx/0xce4c72f4c32141e626e31212e878a2469920a5c9f5b43631c8ce1eece367b503) | setup: funder prefunds the P256Account address, deploys and funds the WebAuthnAccount | VERIFY 100/0 · fund 3,000/183,600 · deploy 15,789/1,381,590 · fund 121/0 | 1,651,874 |
| [`0x0db33e7d…`](https://dora.privacy.ethrex.xyz/tx/0x0db33e7d82508c0b47c7ebfba9f79cd1df24a557cb5f8a00f4c1df16e44f9421) | **A.** P256Account deploys itself at `tx.sender` and pays (Example 1b with a P256 owner) | DEFAULT 15,241/168,300 · VERIFY **288**/0 · SENDER 3,000/0 | 217,786 |
| [`0x380b7d11…`](https://dora.privacy.ethrex.xyz/tx/0x380b7d11153462b0817d06026cc3c95edd2669b4a6f16728a6c461e68f31efa3) | **B.** P256Account sends 0.0001 ETH | VERIFY **288**/0 · SENDER 3,000/0 | 35,314 |
| [`0xc408bec9…`](https://dora.privacy.ethrex.xyz/tx/0xc408bec9af822098f53bf8e015fbc18354843cc650af26d41213f0e7c337db80) | **C.** WebAuthnAccount sends 0.0001 ETH on a 243-byte WebAuthn assertion | VERIFY **15,542**/0 · SENDER 3,000/0 | 41,444 |

The same transfer under three owners:

| Owner | entry | signature gas | entry bytes | VERIFY | intrinsic + execution | floor | `gasUsed` |
|---|---|---|---|---|---|---|---|
| secp256k1 (`SimpleAccount`, gas model) | SECP256K1 | 2,800 | 65 | 288 | 26,446 | 27,382 | ~27,382 |
| raw P256 (`P256Account`, B) | P256 | 6,700 | 128 | 288 | 31,342 | **35,314** | 35,314 |
| WebAuthn passkey (`WebAuthnAccount`, C) | ARBITRARY | 100 | 243 | 15,542 | **41,444** | 34,794 | 41,444 |

The secp256k1 row is the B transaction re-priced with the gas model and a 65-byte signature. It was
not mined here. Experiment 02 mined that account at the same VERIFY cost, 288.

### Refusals (`negative.ts`, simulated)

| Case | valid | Node says |
|---|---|---|
| code-less sender = the raw P256 key's own address, P256 entry | false | `validation prefix frame reverted` (the default code wants SECP256K1) |
| P256Account: owner signs (baseline) | true | |
| P256Account: a stranger's P256 key signs | false | prefix reverted (signer is not the owner) |
| P256Account: owner signs with high `s` | false | `frame signature list does not authenticate the sender` (protocol: low `s` is a consensus rule) |
| P256Account: owner signs an explicit digest | false | prefix reverted |
| WebAuthn: baseline | true | |
| WebAuthn: assertion over another challenge | false | prefix reverted |
| WebAuthn: high `s` | false | prefix reverted (the account's canonical-`s` check) |
| WebAuthn: user-presence flag clear | false | prefix reverted |
| WebAuthn: `type` is `webauthn.create` | false | prefix reverted |
| WebAuthn: origin edited after signing | false | prefix reverted (the signed hash no longer matches) |
| WebAuthn: one byte appended to the entry | false | prefix reverted |
| WebAuthn: a stranger's passkey signs | false | prefix reverted |
| WebAuthn: assertion in entry 1, entry 0 empty | false | prefix reverted |
| WebAuthn: entry 0 carries an explicit `msg` | false | prefix reverted |
| WebAuthn: a protocol P256 entry by the passkey instead | false | prefix reverted |

Flipping `s` to `n − s` in a WebAuthn assertion leaves the sig hash unchanged and moves the
transaction hash (`0x2415378c…` vs `0x6ba89eb7…` in the run above). The account's `s ≤ n/2` check
is what closes that malleability.

## Observations

1. **The protocol's P256 scheme serves raw P256 keys, not browser passkeys.** The scheme verifies a
   signature over the sig hash, and a WebAuthn authenticator signs only its own envelope. A
   browser-passkey wallet on frames needs EVM verification (`P256VERIFY`, 6,900 gas) inside an
   ARBITRARY entry, as ERC-4337 passkey accounts do today. That cost 15,542 VERIFY gas here, against
   288 for the protocol path. The protocol scheme suits device keys: the Secure Enclave, Android
   Keystore, HSMs, and custodial signers.
2. **The protocol path is cheaper, 128-byte signature and all.** B paid 35,314
   and C paid 41,444. Against secp256k1, P256 costs 3,900 more in signature gas plus 63 more bytes at
   the calldata floor, about 8,000 in all for a transfer this small.
3. **A P256 key cannot own an address without code.** The default code requires a SECP256K1 entry, so
   a P256-only user needs an account contract. P256Account's 110 bytes fit
   `MAX_VERIFY_STATE_GAS` and self-deploy in the first transaction (A, deploy state 168,300).
   WebAuthnAccount's 783 bytes need 1,381,590 state gas, well over the 500,000 cap. A counterfactual
   WebAuthn account has to be deployed by someone else first (setup), or sit behind a small proxy.
   The second option is experiment 05b's subject.
4. **ARBITRARY entries need canonical encodings.** Their bytes are outside the sig hash, so every
   alternative encoding a verifier accepts is another transaction hash for the same authorisation. The
   EIP's security section warns about exactly this. For WebAuthn the alternatives are high `s`,
   trailing bytes, and alternative `challengeIndex`/`typeIndex` values that point at repeated
   substrings. The account rejects the first two. The third needs a repeated `"type":"webauthn.get"`
   inside one `clientDataJSON`, which no browser emits.
5. **Neither account checks `rpIdHash` or `origin`.** An authenticator binds a credential to its
   relying party, so another site cannot get assertions from this passkey. The relying party that
   holds the credential can, however, ask it to sign any challenge, including a sig hash. Whoever
   operates that RP is part of the trust base, as with 4337 passkey accounts. Checking `rpIdHash`
   against a constant would pin the account to one RP.
6. **The validation trace passes the public mempool.** C was mined through `eth_sendRawTransaction`.
   Its trace makes three `STATICCALL`s to precompiles with `GAS` immediately before each call, and
   reads no storage.
