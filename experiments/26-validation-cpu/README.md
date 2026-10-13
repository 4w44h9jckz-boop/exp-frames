# 26 — What a gas cap on the validation prefix bounds, in time

A node admits a frame transaction by running its validation prefix. `MAX_VERIFY_GAS` caps that
run at 100,000 gas (EIP-8141 master, read 2026-10-08: "Maximum amount of gas a node should expend
validating signatures and simulating the validation prefix"). The post's suggestion 9 splits the
cap in two:
- a cap on cold state access, which is what mass invalidation and disk reads are made of;
- a cap on total work, set from a CPU benchmark.

This experiment is that benchmark. It asks what a gas cap actually bounds, in microseconds, when
the gas is spent on the most expensive work a prefix may legally do. It also asks how far the
workloads that need more than 100,000 gas are from that worst case.

## Method

Each workload is an account whose code is the work, run as a self-paying `VERIFY` frame that ends
in `APPROVE(EXECUTION_AND_PAYMENT)`. [`workloads.ts`](workloads.ts) writes the Yul sources to
[`yul/`](yul/) and the accounts and signed transactions to
[`ethrex/workloads.txt`](ethrex/workloads.txt).

[`ethrex/exp26_validation_cpu.rs`](ethrex/exp26_validation_cpu.rs) runs inside ethrex's own test
tree. It builds an in-memory Hegota chain whose genesis holds every account, then for each
workload:
- reads the prefix's gas from `Evm::simulate_frame_validation_prefix`;
- times `Blockchain::validate_transaction`, the check a transaction from a peer goes through. That
  includes decoding, the signature list, the prefix-shape rules and the prefix simulation.

| Group | Workloads |
|---|---|
| realistic | `empty` (APPROVE only), `eoa` (default code, one `SECP256K1` entry), `groth16-tornado` (Tornado's verifier on experiment 06's proof, patched as in 06), `ecrecover-40` (experiment 05's 40-key multisig), `p256-1` (experiment 11's passkey), `wots-shape` (513 keccak-256 of 32 bytes, a $w = 16$ WOTS signature plus a 10-level path, experiment 17) |
| fill | one operation repeated to about 100,000 gas: every precompile from `0x01` to `0x11` and `0x100`, `MULMOD`, `EXP`, `KECCAK256` on 32 and 1,024 bytes, and the state reads a prefix may make (cold `SLOAD` of the sender's slots, `EXTCODEHASH`, `STATICCALL` into 24 KB and 64 KB contracts) |

The prefix may not read `GAS` except right before a call, so every loop runs a fixed count.

The full table, the command and all five runs are in
[`results/validation-cpu-2026-10-08.md`](results/validation-cpu-2026-10-08.md). It used ethrex
`c94964843d` (the testnet's code), a release build with the node's crypto backends, and one
thread on an Intel Xeon @ 2.80GHz (4 vCPUs, shared VM). The precompile cache was off and state was
in memory.

## Results

Median of five runs, with the range across runs.

| Workload | Gas | µs per check | ns per gas |
|---|---:|---:|---:|
| `empty` | 108 | 29.7 (27.5–32.4) | |
| `eoa`, one `SECP256K1` entry | 100 | 118.9 (115.1–145.1) | |
| **`groth16-tornado`** | 245,443 | **3,249** (3,012–3,517) | **13.1** (12.2–14.2) |
| **`ecrecover-40`** | 129,157 | **1,964** (1,885–2,160) | **15.0** (14.4–16.5) |
| `p256-1` | 9,313 | 104 (101–110) | 7.8 (7.7–9.0) |
| `wots-shape` | 46,306 | 294 (267–396) | 5.7 (5.1–8.0) |
| `fill-ecmul`, alt_bn128 MUL | 100,982 | 1,645 | **16.0** (15.2–17.9) |
| `fill-bls-pairing`, one pair | 72,709 | 1,188 | **15.9** (15.3–16.7) |
| `fill-ecpairing`, one pair | 81,391 | 1,204 | 14.5 (14.3–16.1) |
| `fill-ecrecover` | 100,575 | 1,470 | 14.3 (13.9–15.9) |
| `fill-ecadd` | 105,577 | 1,515 | 14.1 (13.7–15.0) |
| `fill-keccak-1k` | 116,163 | 1,333 | 11.2 (10.6–12.0) |
| `fill-bls-g1add`, `fill-bls-map-g2` | | | 11.0, 10.0 |
| `fill-blake2f-90k` | 92,399 | 994 | 10.4 |
| `fill-p256` | 101,237 | 964 | 9.2 (8.7–10.0) |
| `fill-modexp-256`, `fill-modexp-2048` | | | 5.9, 5.4 |
| `fill-keccak-32` | 117,136 | 685 | 5.6 |
| `fill-exp`, `fill-mulmod` | | | 4.2, 3.5 |
| `fill-blake2f-12`, `fill-sha256`, `fill-identity`, `fill-ripemd` | | | 2.8, 2.7, 1.8, 0.8 |
| `fill-sload`, 45 cold slots of the sender | 97,166 | 164 | **1.4** (1.3–1.5) |
| `fill-extcodehash`, `fill-call-24k`, `fill-call-64k` | | | 1.4, 1.5, 1.5 |

## Findings

**A. Gas bounds a prefix's compute time to within its worst rate, about 16 ns per gas on this
core.** The slowest work per gas is elliptic-curve arithmetic: alt_bn128 MUL at 16.0, a BLS12-381
pairing at 15.9, ECDSA recovery at 14.3. So a cap of $C$ gas bounds compute at about $C \times 16$
ns:

| Cap | Worst compute |
|---:|---:|
| 100,000 (`MAX_VERIFY_GAS`) | 1.6 ms |
| 250,000 (fits experiment 06's Groth16 prefix) | 4.0 ms |
| 500,000 (the Hegota testnet's node flag) | 8.0 ms |

**B. The prefixes that need more than 100,000 gas already run near that worst rate.** Groth16 runs
at 13.1 ns/gas and the 40-key multisig at 15.0, within $1.25\times$ of the slowest precompile. A
cap set from the worst rate therefore wastes little on them. Hash-based verification is the
exception: the WOTS shape runs at 5.7 ns/gas, keccak on 32-byte inputs at 5.6. So a cap set for
curves gives a hash-based, post-quantum account about three times the margin it needs.

**C. A state read from memory costs a tenth of the worst compute per gas.** Cold `SLOAD`,
`EXTCODEHASH` and calls into 64 KB contracts all run at 1.3 to 1.8 ns/gas, about 2.9 µs per
2,100-gas slot read. In a node whose state is cached, a prefix of state reads is therefore far from
the worst case per gas: compute is. The case for metering cold state separately rests on two things
this harness does not measure:
- disk I/O. State becomes the binding resource per gas once one cold read costs more than
  $2{,}100 \times 16 \text{ ns} \approx 34$ µs for a slot, or $2{,}600 \times 16 \text{ ns} \approx
  42$ µs for an account;
- fan-out (how many admitted transactions one write invalidates), which is about the number of
  reads, not their time. Section 2 of the post argues it.

**D. Every admission has a fixed cost of about 30 µs, whatever the prefix does.** `empty` uses 108
gas and takes 29.7 µs. At the worst rate that is about 1,900 gas of compute that no cap counts.

**E. ethrex checks each protocol signature twice on admission.** One `SECP256K1` entry adds
89.2 µs over `empty`. One ECDSA recovery in this build costs about 43 µs ($14.3$ ns/gas $\times$
3,000 gas), so 89.2 µs is two of them. `Blockchain::validate_transaction` verifies the signature
list (`crates/blockchain/blockchain.rs`, `validate_frame_signatures` before the prefix rules). The
prefix simulation then verifies it again (`crates/vm/levm/src/vm.rs`,
`run_frame_validation_prefix_with_observer`). The protocol charges 2,800 gas for the entry. This
is a client inefficiency, not an EIP question, but it doubles the most common admission's
signature work.

**F. The price of `P256VERIFY` assumes an assembly backend.** ethrex-crypto routes P256 through
aws-lc-rs only when its `aws-lc-rs` feature is on. The workspace takes the crate without default
features, and the node binary turns them back on. Built without it, as a first run of this
harness was, P256 costs 36.0 ns/gas: more than twice the slowest operation above, and $3.9\times$
its own figure with the backend. ethrex's comments say zkVM guest builds take that portable path.
A gas cap is a time bound only for clients built like the one that set the price.

## What this means for suggestion 9

The total dimension can stay denominated in gas. Gas tracks compute closely enough for a cap, and
the cap's value is a time budget divided by the worst rate. On this core that is 16 ns per gas;
the testnet's 500,000 already implies 8 ms.

The state dimension is a different resource, and its cap has to come from disk and from fan-out,
not from this benchmark. That is the argument for two caps rather than one larger one. Raising the
single cap to 250,000 for Groth16 raises the state-read allowance with it, from 47 to 119 cold
slots. A separate state cap keeps that allowance at 47 and lets compute alone grow to 4 ms.

## Not measured

- **Disk.** All state is in memory, so every state figure is a lower bound.
- **Other clients and other machines.** One client, one CPU model, a shared VM. The run-to-run
  range is up to 20 per cent.
- **Load.** One thread on an otherwise idle process. There is no contention with block import.
- **Signature lists.** Only `eoa` carries an entry; the other workloads are signature-free so that
  their time is the prefix's.
- **The precompile cache.** It is off. With it on, ethrex returns a repeated precompile input from
  memory, which an attacker defeats by varying the inputs.

## Run

```bash
git fetch origin   # workloads.ts reads experiment 06's verifier and proof from its branch
npx tsx experiments/26-validation-cpu/workloads.ts
# then, from a checkout of lambdaclass/ethrex at c94964843d:
cp experiments/26-validation-cpu/ethrex/exp26_validation_cpu.rs crates/blockchain/tests/
EXP26_WORKLOADS=$PWD/.../ethrex/workloads.txt \
  cargo test -q --release -p ethrex-blockchain --features ethrex-crypto/default \
    --test exp26_validation_cpu -- --nocapture --test-threads 1
```
