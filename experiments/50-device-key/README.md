# 50 - A note whose owner is a P-256 key, the kind a phone's enclave holds

Experiment 32's registry lets whoever holds a note's secrets update it: the kernel proof is the
whole authorization. A wallet that keeps those secrets in ordinary memory loses the note to
anything that reads that memory. Phones and laptops have a better place for one secret: a key
generated inside the device's secure element, which signs on request and never leaves it. Those
elements speak P-256, not secp256k1. Post 29's "hardware trap" calls such a key, on a device the
user holds, a reasonable trust: no one else is involved, and what remains is trust in the chip.

This experiment puts such a key in charge of a note. The note commits to the key, the kernel
proof says which key that is, and the registry's `VERIFY` checks a P-256 signature from that key
over the transaction, with EIP-7951's precompile at `0x100`.

**Simulated.** There is no enclave here. The owner key is a software P-256 key in this process,
derived from `PRIVATE_KEY`. Everything this experiment shows is about what the chain checks; it
says nothing about whether a real enclave keeps its key.

## Written before any run

**The claim.** An update of private owned state can be authorized by a P-256 key that only the
owner's device holds, and checked entirely in the registry's `VERIFY` frame: the precompile at
`0x100` verifies the key's signature over the transaction's signature hash, and the kernel proof
ties that key to the note being spent. Nobody but the owner takes part, and no one else needs to
be online.

**It would be shown wrong if any of these is observed:**
- the gas the owner key's check adds to `VERIFY` (the precompile call and the work around it,
  measured as the difference against the same update without it) is above 100,000, EIP-8141's
  validation budget. The kernel proof's own check is already known to be above that budget
  (experiment 32) and is not what this measures;
- the precompile is missing on the testnet, or refuses a valid signature;
- what the transaction needs signed cannot be signed by a key that only signs a 32-byte digest
  it is handed, the way a device's secure element does through its platform's API;
- the update needs anyone besides the owner: a relayer, a co-signer, a service that must answer;
- holding the note's secrets without the key is enough to spend it, or the key's signature for
  one update can be reused for another.

**It is done when** a note owned by a P-256 key is updated on the testnet by a transaction whose
`VERIFY` frame calls the precompile, the transaction is mined, and the README records the
precompile's availability, the gas of each frame and the gas the key's check adds. The refusals
in the plan are each run and recorded.

**The plan, fixed before the run:**
- The kernel is experiment 32's with one change: the note's inner commitment becomes
  `H(nullifierSecret, secret, owner)`, and `owner` becomes a seventh public input. `owner` is the
  P-256 key's address as EIP-8141 defines it, `keccak256(qx || qy)[12:]`, read as a number. A
  new Groth16 key is made the same way as experiment 32's, from the same powers of tau.
- The registry is experiment 32's, version 3, with one more word per update, `owner`, and one
  more check in `VERIFY`: signature entry 0 is ARBITRARY with an empty `msg` and 128 bytes,
  `r || s || qx || qy`; `keccak256(qx || qy)[12:]` equals `owner`; `s` is at most half the curve
  order; and `0x100` accepts `(TXPARAM(0x08), r, s, qx, qy)`. ARBITRARY bytes are left out of the
  signature hash, so the signature can cover it.
- A second route is measured beside it: the same registry also accepts a P256 entry (scheme 2)
  that the protocol itself checks, with its `signer` equal to `owner`. That route does not call
  the precompile from `VERIFY`, so it is the comparison, not the claim.
- The change note, if any, names a fresh P-256 key, so that two updates of one owner's notes do
  not show the same key.
- The run: deploy the verifier, the registry and experiment 32's `Balance` application; deposit
  two notes; update one through the ARBITRARY route with a change note (A), the change note
  through the P256 route (B), and the other note through the ARBITRARY route (C). Then, by
  simulation, the refusals: a stranger's key signs (D1); the owner signs with high `s` (D2); no
  signature at all, with valid secrets and proof (D3); A's signature on a copy of the update
  with another recipient (D4); a proof whose `owner` is not the note's (D5, at the prover).

## Design

| File | What |
|---|---|
| [`kernel.circom`](kernel.circom) | Experiment 32's kernel with `owner` in the note and as the seventh public input, 33,973 wires |
| [`OwnedStateRegistry.yul`](OwnedStateRegistry.yul) | Version 3: one update per transaction, `owner` in word 6, the owner's signature checked in `VERIFY`; 2,742 B of creation code. A `keyed` word of 0 gives the control |
| [`device.ts`](device.ts) | Owner keys, notes, proofs, `updateTx`, `signUpdate` |
| [`run.ts`](run.ts) | The precompile probe, setup, A to E |
| [`rebuild.test.ts`](rebuild.test.ts) | The mined updates rebuilt byte for byte, their proofs and their owners' signatures verified offline |
| `build/` | The compiled circuit, the proving key (`kernel.zkey`) and the verifying key |

The update's layout is experiment 32's: frame 0 the EIP-8272 root, frame 1 the registry's `VERIFY`
(scope 3: it approves and pays), frame 2 the registry's `update`, with the nullifier as the only
nonce key. What changes is one signature entry. The owner's device is asked for one thing: a P-256
signature over the 32-byte signature hash, with no hashing of its own (`signUpdate`). That is what
a raw P-256 key signs, the kind experiment 11 calls raw: an enclave reached through its platform's
digest-signing call. A WebAuthn passkey does not sign a bare digest (experiment 11), so it would
need experiment 11's `WebAuthnAccount` checks inside the registry, which this experiment does not
build.

The registry and the experiment reuse experiment 06's MiMC hasher and experiment 32's `Balance`
application, both already on the testnet, and experiment 32's `Groth16Verifier.yul` with this
kernel's key.

### The proving key

Made as experiment 32's was: phase 1 is the same `ppot_0080_16.ptau` (sha256
`ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`, retrieved 2026-10-21 from the
same host), and phase 2 one contribution made in this session from 64 random bytes that were
never printed or stored. A single contribution is a test network's setup.

| | |
|---|---|
| circuit hash | `3a6b24f8 55d886be 86b642bf fc0d7ec7 0c3fb1da c903a8e5 4e98ab52 1d6a1ded 102111a6 f67757ac 4f46f5fd 5d200ec4 42535009 123feb4f 46ac705b 6c86ef5a` |
| contribution hash | `b5988b9d 40617ffd 2e20a86a ae84b23a 23572f33 dd30a72a fbcbc8d2 a226bc17 433b9e06 b9f830aa db124920 e9645ab3 87a58ecb 36a9e46a 35e2e460 66ff453a` |
| `kernel.r1cs` sha256 | `5b2a9aff5c46dd68178223f7aeb878f7395be2a34f9e9c7d83ba58904640efb7` (circom 2.2.3, rebuilt, not committed) |
| `kernel.wasm` sha256 | `b5c40448f959b406f6e93bbc9084462223f9d89420277dda9a285011f621fcb4` |
| `kernel.zkey` sha256 | `18f87890be972bb94f52f2877ae02e58be8469a662bd82b19558d59bc3b37c66` |

`snarkjs zkey verify` accepts the key against the circuit and phase 1. The commands are experiment
32's, with this directory.

## Run

```bash
npx tsx experiments/50-device-key/run.ts --dry-run   # simulate only
npx tsx experiments/50-device-key/run.ts             # probe, setup, A to E
```

Each step is skipped once done. The owner keys, note secrets and recipients are derived from
`PRIVATE_KEY` and a label.

## Results (2026-10-21, ethrex `v23.0.0-hegota-testnet-hotfix-64b8fc09`)

**Simulated.** Every owner key below is a software key. Nothing here tests an enclave.

**The precompile is there.** Before any deployment, at head 491,039 and again in `run.ts`, a call
to `0x100` with a fresh signature returned `1` (a 32-byte word), and with `s` changed in one bit
it returned nothing, as EIP-7951 specifies for an invalid signature.

The registry v3 is `0x1C9F1f8aA4Ce97Eec5534d89bCE82dC13813531b`, its control
`0x0dbEB0f932318fC9C4d8d13FA342f11bDd098517`, the verifier
`0x37c5Dff8221f3109B1eC9102350c81bBe0Fa9c03`. The application is experiment 32's Balance,
`0x0E2180d727a6CD4B2216cB16BD3e9e607a7Ebf0a`.

| Step | Tx | Block | `gasUsed` | Frames: execution + state gas |
|---|---|---|---|---|
| deploy the verifier, the registry and its control | [`0x32473dfe...`](https://dora.privacy.ethrex.xyz/tx/0x32473dfe4d2a64c12d1ce9e3fad7de371ae73a89825cba1418359a37a949d67e) | 491,104 | 11,818,710 | |
| deposit notes 1 (0.003 ETH, owner key 1) and 2 (0.001 ETH, owner key 2) | [`0x399a44d5...`](https://dora.privacy.ethrex.xyz/tx/0x399a44d54541dae9e324b7841804751320a63ea1b10a8d32edc78b9529ea2ffd) | 491,105 | 4,114,922 | |
| deposit the control's note (0.001 ETH) | [`0xb13f687e...`](https://dora.privacy.ethrex.xyz/tx/0xb13f687ebefc43d46b61fa86f7270bf6b554c06425397ec694a2bea01ebbc78a) | 491,106 | 3,335,601 | |
| **A.** note 1: 0.001 ETH out, 0.002 ETH in a change note owned by a fresh key 3; ARBITRARY entry, `P256VERIFY` in `VERIFY` | [`0x30978e72...`](https://dora.privacy.ethrex.xyz/tx/0x30978e720bbf4c9968315e3714b1cc0f84e5d0a91c759078c558f6b87276b5f0) | 491,109 | **1,654,836** | 8272 5,579 · VERIFY **243,379** + 97,920 · update 1,001,817 + 281,520 |
| **B.** the change note spent whole; P256 entry, checked by the protocol | [`0x4a2a10d3...`](https://dora.privacy.ethrex.xyz/tx/0x4a2a10d30be9da33e21d222d4f1db601af7349ac1013ff525033e0080e3ce712) | 491,112 | **569,075** | 8272 5,579 · VERIFY **236,137** + 97,920 · update 14,670 + 183,600 |
| **C.** note 2 spent whole; ARBITRARY entry, `P256VERIFY` in `VERIFY` | [`0x545b0204...`](https://dora.privacy.ethrex.xyz/tx/0x545b0204e217d83ba9ce6c57194545e54a881c38546a9178fa49a73f679f8dac) | 491,117 | **569,369** | 8272 5,579 · VERIFY **243,355** + 97,920 · update 14,670 + 183,600 |
| **E.** the control: C's shape, no owner check, no signature | [`0x5d83710e...`](https://dora.privacy.ethrex.xyz/tx/0x5d83710e73f8886950c391c13460cb8bea59473badc980489b5ccdbdb3b6eb09) | 491,120 | **559,865** | 8272 5,579 · VERIFY **235,983** + 97,920 · update 14,670 + 183,600 |

Each recipient is a fresh address and received `withdrawn` less the 10^10 wei fee. Every update
was sent through the public RPC by this experiment's funded account, with the registry as sender
and payer; nobody else signed or answered.

| Refused | How | Reason |
|---|---|---|
| **D1.** note 2's update signed by a stranger's P-256 key | simulation and `eth_sendRawTransaction` | "validation prefix frame reverted": the key's address is not `owner` |
| **D2.** signed by note 2's owner, with `s` replaced by `n - s` | simulation and `eth_sendRawTransaction` | the same: the registry's low-s rule (the precompile alone would accept it) |
| **D3.** note 2's secrets and a valid kernel proof, no signature | simulation and `eth_sendRawTransaction` | the same: the secrets alone do not spend |
| **D4.** C's own signature, on an update of note 2 paying another recipient, with a valid proof for it | simulation and `eth_sendRawTransaction` | the same: the signature covers the signature hash, which commits to frame 2's data |
| **D5.** a proof of note 2 under owner key 1 | the prover | the witness fails at the root (`kernel.circom` line 89): the owner is in the leaf |

Each refused transaction differs from C, which was then mined, in the one thing its row names.
`eth_sendRawTransaction` gave each refusal as "Missing or invalid parameters."; only the simulation
names the frame. A refusal leaves no hash; these are the run's reported outcomes.

Every mined transaction above is a fixture in `test/fixtures/chain/`. `rebuild.test.ts` rebuilds A,
B, C and E with `updateTx`, byte for byte, verifies each proof against `build/kernel.vkey.json`
with `owner` as its seventh input, and verifies each owner signature over the rebuilt signature
hash, by the key whose address is the proof's `owner` (6 of 6).

## Gas

| | Owner check in `VERIFY` | Whole transaction, against E |
|---|---|---|
| ARBITRARY entry, `P256VERIFY` called from `VERIFY` (C against E) | **+7,372** | +9,504 |
| P256 entry, checked by the protocol (B against E) | +154 | +9,210 |

C and E are the same shape: one note of 0.001 ETH spent whole to a fresh address, the same kernel
and verifier, the registries' code equal but for the `keyed` word. So C's 7,372 extra gas in
`VERIFY` is the owner check, the precompile call and the work around it, measured on chain. The
transaction's other 2,132 are the entry: its 128 bytes of calldata and the ARBITRARY scheme's 100.
B's `VERIFY` adds only the `SIGPARAM` comparison; the protocol's P256 scheme charges its fixed
6,700 instead, and B's entry also carries a 20-byte signer.

Against EIP-8141's 100,000: the owner check costs 7.4 % of it. The registry's whole `VERIFY`, at
243,355, does not fit it, because of the kernel proof's Groth16 check (experiment 32, "Gas"); that
was already so and is not changed by the key.

`eth_estimateGas` of a bare call to `0x100` read 25,581. That figure includes the call's intrinsic
and calldata cost, which this testnet's pricing sets, and is not used to price the precompile
here.

## Observations

1. **The claim holds on chain, with the enclave simulated.** A note whose owner is a P-256 key was
   spent three times (A, B, C), each time authorized by that key alone and checked in the
   registry's `VERIFY`: twice by the precompile at `0x100`, once by the protocol's P256 scheme. No
   one else signed or had to be online, and the key's check fits EIP-8141's budget with more than
   90,000 to spare. Nothing measured meets a condition of "would show it wrong".

2. **The secrets no longer spend the note; the key does.** D3 carried note 2's secrets and a valid
   proof, which in experiment 32 is everything an update needs, and was refused. D4 shows that a
   signature cannot be moved to another update: it covers the signature hash, and the signature
   hash commits to the update itself. So what an enclave adds is that reading the wallet's memory
   no longer moves its notes. Whoever can ask the enclave to sign still can, and the experiment
   does not test what stands between the enclave and that request.

3. **The registry must enforce low `s`; the precompile does not.** EIP-7951 accepts both `s` and
   `n - s`. An ARBITRARY entry is left out of the signature hash, so without the registry's rule
   anyone could swap `s` in flight and change the transaction's hash (D2). The protocol's P256
   scheme enforces it itself (experiment 11).

4. **Two routes, about the same price, one difference that matters.** The protocol's P256 entry
   costs about the same in total (B, +9,210) as the precompile in `VERIFY` (C, +9,504). On this
   client the protocol accepted a P256 entry whose signer is not `tx.sender`: the registry has no
   key, and the entry names the note's owner. The ARBITRARY route depends on nothing but
   EIP-7951, so it is the one a contract can rely on wherever the precompile exists; the P256
   route depends on the frame transaction's own scheme list.

5. **The owner key is public in every update.** `owner` is a public input, and the key itself is
   in the signature. Two notes owned by one key are linked by their updates. A device's secure
   element can make many keys, so the change note in A names a fresh key, and A and B show
   different owners. A wallet that keeps one enclave key for all its notes links all of them.
   Hiding the key would mean checking the P-256 signature inside the proof, which this
   experiment does not try. And every update in this registry shows that its owner holds a
   P-256 key, which separates such notes from notes owned by secrets alone, as experiment 32's
   public tag separates applications.

6. **A key that never leaves the device is not derived from a seed.** Experiment 45 rebuilds every
   secret of the wallet from one seed. An enclave key is made inside the enclave and cannot be
   exported, so a seed does not bring it back: a note owned by it is lost with the device unless
   the wallet also arranged another way to spend it. This experiment does not build that way.

7. **Not tested, and labelled:** the enclave's own protection of the key, its attestation, and any
   platform's API. The key is software, in this process.

## Cases a later reading listed, and which this run covers

Added after the run, at the coordinator's request; the claim and "would show it wrong" above are
unchanged. "By code" means the registry's source rules the case out, but no transaction tried it.

| Case | Covered? |
|---|---|
| protocol P256 entry, high `s` | not run on that route. D2 ran on the ARBITRARY route. For the P256 scheme the protocol itself enforces low `s` (experiment 11 measured the refusal) |
| protocol P256 entry, a signer other than the note's owner | not run on that route; by code (`SIGPARAM` signer must equal `owner`). D1 ran on the ARBITRARY route |
| an owner-key entry with a 32-byte `msg` | not run; by code (both routes require an empty `msg`) |
| WebAuthn: a challenge that is not the signature hash, no user-presence flag, the wrong relying party, trailing bytes | not built. This run has no WebAuthn arm; experiment 11's `WebAuthnAccount` makes those checks for an account, not for a note |
| a chain without `0x100` failing closed | not run; by code: a call to an empty address succeeds with no return data, and the registry requires the returned word to be 1, read from memory it zeroes first |
| a secp256k1 key, a delegation or an upgrade authorizing the same update | not run; by code: the registry has no other authorization path, no owner and no upgrade, and is deployed by CREATE2 without a proxy. D3 (no signature) is the nearest run case |
| an update on another chain | not run; the signature hash commits to the chain ID |

**What the ARBITRARY entry cost against the validation budget was not isolated.** The figures
show the entry's whole cost to the transaction: C's 2,132 gas beyond its `VERIFY` difference with
E is the scheme's 100 plus the 128 bytes' calldata. Whether the client counts the 100 alone, or
the 100 and the bytes, against the `VERIFY` budget is not separated by these runs: the `VERIFY`
frame's own gas (243,355) includes neither.
