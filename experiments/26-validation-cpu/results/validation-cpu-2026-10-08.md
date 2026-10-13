# Experiment 26, the validation prefix timed in ethrex's admission path

Run 2026-10-08 against lambdaclass/ethrex `c94964843d39d04914dff178e55e60daf7707089` (branch `hegota-testnet`, the code the testnet runs), with `ethrex/exp26_validation_cpu.rs` copied into `crates/blockchain/tests/`. rustc 1.97.0 (2d8144b78 2026-07-07), release profile, ethrex-crypto with its default features (`std`, `kzg-rs`, `secp256k1`, `aws-lc-rs`, `blst`), as the node binary builds it. CPU: Intel(R) Xeon(R) Processor @ 2.80GHz, 4 vCPUs of a shared virtual machine, one test thread. Precompile cache off. State in memory.

Input: `ethrex/workloads.txt`, written by `workloads.ts` (29 workloads, 145 shared accounts).

```bash
# from a checkout of lambdaclass/ethrex at c94964843d; EXP is this directory
cp $EXP/ethrex/exp26_validation_cpu.rs crates/blockchain/tests/
EXP26_WORKLOADS=$EXP/ethrex/workloads.txt \
  cargo test -q --release -p ethrex-blockchain --features ethrex-crypto/default \
    --test exp26_validation_cpu -- --nocapture --test-threads 1
```

Five runs, back to back. Each run times each workload in 7 rounds of about 200 ms and keeps the median round. The table gives the median and the range of those five per-run figures. `ns/gas` is marginal: (time minus the time of `empty`) divided by (gas minus the gas of `empty`).

## Summary of five runs

```text
workload           group          gas   us med       us min-max ns/gas med   ns min-max runs
empty              realistic      108     29.7    27.5-32.4              -            - 5
eoa                realistic      100    118.9   115.1-145.1             -            - 5
groth16-tornado    realistic   245443   3249.3  3011.5-3517.0         13.1    12.2-14.2 5
ecrecover-40       realistic   129157   1964.2  1885.2-2159.6         15.0    14.4-16.5 5
p256-1             realistic     9313    103.6   100.7-110.3           7.8      7.7-9.0 5
wots-shape         realistic    46306    293.7   266.9-395.6           5.7      5.1-8.0 5
fill-mulmod        fill         84146    325.3   318.4-378.1           3.5      3.4-4.1 5
fill-exp           fill        100106    454.2   425.7-492.9           4.2      4.0-4.6 5
fill-keccak-32     fill        117136    685.3   640.6-807.8           5.6      5.2-6.7 5
fill-keccak-1k     fill        116163   1332.8  1258.3-1419.9         11.2    10.6-12.0 5
fill-ecrecover     fill        100575   1470.3  1426.1-1626.1         14.3    13.9-15.9 5
fill-sha256        fill        112453    331.1   299.8-365.3           2.7      2.4-3.0 5
fill-ripemd        fill        104898    109.1    99.1-129.3           0.8      0.7-0.9 5
fill-identity      fill        116803    241.7   221.2-251.3           1.8      1.6-1.9 5
fill-modexp-256    fill         87278    544.7   535.8-578.6           5.9      5.8-6.3 5
fill-modexp-2048   fill         91135    522.7   505.5-534.7           5.4      5.2-5.5 5
fill-ecadd         fill        105577   1514.7  1477.8-1613.7         14.1    13.7-15.0 5
fill-ecmul         fill        100982   1645.1  1561.2-1831.4         16.0    15.2-17.9 5
fill-ecpairing     fill         81391   1203.6  1191.9-1340.0         14.5    14.3-16.1 5
fill-blake2f-12    fill        103976    320.6   311.5-333.6           2.8      2.7-2.9 5
fill-blake2f-90k   fill         92399    993.8   979.4-1026.9         10.4    10.3-10.8 5
fill-bls-g1add     fill        111839   1256.3  1179.9-1384.6         11.0    10.3-12.1 5
fill-bls-pairing   fill         72709   1188.2  1141.6-1241.3         15.9    15.3-16.7 5
fill-bls-map-g2    fill         98139   1004.3   969.7-1038.0         10.0     9.6-10.3 5
fill-p256          fill        101237    963.7   906.5-1043.5          9.2     8.7-10.0 5
fill-sload         fill         97166    163.6   154.6-174.1           1.4      1.3-1.5 5
fill-extcodehash   fill        103544    174.0   165.4-175.2           1.4      1.3-1.4 5
fill-call-24k      fill         92847    170.3   160.8-198.2           1.5      1.4-1.8 5
fill-call-64k      fill         92847    171.7   152.2-177.7           1.5      1.3-1.6 5
```

## Raw output

### Run 1

```text
running 1 test
admission check per transaction, release build, median of 7 rounds of at least 200 ms
workload           group           gas    us/check    ns/gas  note
empty              realistic       108        29.7         -  APPROVE and nothing else: the fixed cost of an admission
eoa                realistic       100       145.1         -  default code: one SECP256K1 entry, checked by the protocol
groth16-tornado    realistic    245443      3298.8      13.3  Tornado's verifier, patched as in 06, on the proof of 0x2719e945... (06), called from VERIFY
ecrecover-40       realistic    129157      2159.6      16.5  40 ECDSA recoveries, the 40-key multisig of 05
p256-1             realistic      9313       104.7       8.1  one P256VERIFY, the passkey account of 11
wots-shape         realistic     46306       293.7       5.7  513 keccak-256 of 32 bytes: a w = 16 WOTS signature (67 chains, 7.5 steps on average) and a 10-level path, as in 17
fill-mulmod        fill          84146       329.3       3.6  MULMOD on 256-bit operands
fill-exp           fill         100106       445.0       4.2  EXP with a 32-byte exponent
fill-keccak-32     fill         117136       640.6       5.2  KECCAK256 of 32 bytes, chained
fill-keccak-1k     fill         116163      1258.3      10.6  KECCAK256 of 1,024 bytes
fill-ecrecover     fill         100575      1426.1      13.9  ECRECOVER (0x01)
fill-sha256        fill         112453       299.8       2.4  SHA256 (0x02), 32 bytes
fill-ripemd        fill         104898        99.1       0.7  RIPEMD160 (0x03), 32 bytes
fill-identity      fill         116803       221.2       1.6  IDENTITY (0x04), 32 bytes
fill-modexp-256    fill          87278       578.6       6.3  MODEXP (0x05), 256-bit base, exponent and modulus
fill-modexp-2048   fill          91135       505.5       5.2  MODEXP (0x05), 2048-bit base and modulus, exponent 3
fill-ecadd         fill         105577      1477.8      13.7  alt_bn128 ADD (0x06)
fill-ecmul         fill         100982      1777.5      17.3  alt_bn128 MUL (0x07)
fill-ecpairing     fill          81391      1340.0      16.1  alt_bn128 PAIRING (0x08), one pair
fill-blake2f-12    fill         103976       320.3       2.8  BLAKE2F (0x09), 12 rounds
fill-blake2f-90k   fill          92399       987.5      10.4  BLAKE2F (0x09), 90,000 rounds
fill-bls-g1add     fill         111839      1384.6      12.1  BLS12_G1ADD (0x0b)
fill-bls-pairing   fill          72709      1144.5      15.4  BLS12_PAIRING_CHECK (0x0f), one pair
fill-bls-map-g2    fill          98139      1038.0      10.3  BLS12_MAP_FP2_TO_G2 (0x11)
fill-p256          fill         101237       963.7       9.2  P256VERIFY (0x100)
fill-sload         fill          97166       163.9       1.4  cold SLOAD of the sender's own slots, 1 to 45
fill-extcodehash   fill         103544       175.2       1.4  EXTCODEHASH of 33 distinct cold accounts
fill-call-24k      fill          92847       198.2       1.8  STATICCALL into distinct cold 24,576-byte contracts
fill-call-64k      fill          92847       173.9       1.6  STATICCALL into distinct cold 65,536-byte contracts
ns/gas is marginal: (time - time of `empty`) / (gas - gas of `empty`).
.
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 42.90s
```

### Run 2

```text
running 1 test
admission check per transaction, release build, median of 7 rounds of at least 200 ms
workload           group           gas    us/check    ns/gas  note
empty              realistic       108        30.2         -  APPROVE and nothing else: the fixed cost of an admission
eoa                realistic       100       126.5         -  default code: one SECP256K1 entry, checked by the protocol
groth16-tornado    realistic    245443      3517.0      14.2  Tornado's verifier, patched as in 06, on the proof of 0x2719e945... (06), called from VERIFY
ecrecover-40       realistic    129157      1921.2      14.7  40 ECDSA recoveries, the 40-key multisig of 05
p256-1             realistic      9313       102.4       7.8  one P256VERIFY, the passkey account of 11
wots-shape         realistic     46306       302.4       5.9  513 keccak-256 of 32 bytes: a w = 16 WOTS signature (67 chains, 7.5 steps on average) and a 10-level path, as in 17
fill-mulmod        fill          84146       318.4       3.4  MULMOD on 256-bit operands
fill-exp           fill         100106       454.2       4.2  EXP with a 32-byte exponent
fill-keccak-32     fill         117136       685.3       5.6  KECCAK256 of 32 bytes, chained
fill-keccak-1k     fill         116163      1305.0      11.0  KECCAK256 of 1,024 bytes
fill-ecrecover     fill         100575      1494.6      14.6  ECRECOVER (0x01)
fill-sha256        fill         112453       331.1       2.7  SHA256 (0x02), 32 bytes
fill-ripemd        fill         104898       109.1       0.8  RIPEMD160 (0x03), 32 bytes
fill-identity      fill         116803       244.3       1.8  IDENTITY (0x04), 32 bytes
fill-modexp-256    fill          87278       544.7       5.9  MODEXP (0x05), 256-bit base, exponent and modulus
fill-modexp-2048   fill          91135       509.4       5.3  MODEXP (0x05), 2048-bit base and modulus, exponent 3
fill-ecadd         fill         105577      1537.3      14.3  alt_bn128 ADD (0x06)
fill-ecmul         fill         100982      1831.4      17.9  alt_bn128 MUL (0x07)
fill-ecpairing     fill          81391      1203.5      14.4  alt_bn128 PAIRING (0x08), one pair
fill-blake2f-12    fill         103976       311.5       2.7  BLAKE2F (0x09), 12 rounds
fill-blake2f-90k   fill          92399       993.8      10.4  BLAKE2F (0x09), 90,000 rounds
fill-bls-g1add     fill         111839      1256.3      11.0  BLS12_G1ADD (0x0b)
fill-bls-pairing   fill          72709      1215.2      16.3  BLS12_PAIRING_CHECK (0x0f), one pair
fill-bls-map-g2    fill          98139       969.7       9.6  BLS12_MAP_FP2_TO_G2 (0x11)
fill-p256          fill         101237      1037.3      10.0  P256VERIFY (0x100)
fill-sload         fill          97166       163.6       1.4  cold SLOAD of the sender's own slots, 1 to 45
fill-extcodehash   fill         103544       165.4       1.3  EXTCODEHASH of 33 distinct cold accounts
fill-call-24k      fill          92847       163.3       1.4  STATICCALL into distinct cold 24,576-byte contracts
fill-call-64k      fill          92847       152.2       1.3  STATICCALL into distinct cold 65,536-byte contracts
ns/gas is marginal: (time - time of `empty`) / (gas - gas of `empty`).
.
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 42.86s
```

### Run 3

```text
running 1 test
admission check per transaction, release build, median of 7 rounds of at least 200 ms
workload           group           gas    us/check    ns/gas  note
empty              realistic       108        32.4         -  APPROVE and nothing else: the fixed cost of an admission
eoa                realistic       100       118.9         -  default code: one SECP256K1 entry, checked by the protocol
groth16-tornado    realistic    245443      3249.3      13.1  Tornado's verifier, patched as in 06, on the proof of 0x2719e945... (06), called from VERIFY
ecrecover-40       realistic    129157      1988.6      15.2  40 ECDSA recoveries, the 40-key multisig of 05
p256-1             realistic      9313       103.6       7.7  one P256VERIFY, the passkey account of 11
wots-shape         realistic     46306       276.8       5.3  513 keccak-256 of 32 bytes: a w = 16 WOTS signature (67 chains, 7.5 steps on average) and a 10-level path, as in 17
fill-mulmod        fill          84146       378.1       4.1  MULMOD on 256-bit operands
fill-exp           fill         100106       492.9       4.6  EXP with a 32-byte exponent
fill-keccak-32     fill         117136       744.4       6.1  KECCAK256 of 32 bytes, chained
fill-keccak-1k     fill         116163      1419.9      12.0  KECCAK256 of 1,024 bytes
fill-ecrecover     fill         100575      1470.3      14.3  ECRECOVER (0x01)
fill-sha256        fill         112453       323.8       2.6  SHA256 (0x02), 32 bytes
fill-ripemd        fill         104898       129.3       0.9  RIPEMD160 (0x03), 32 bytes
fill-identity      fill         116803       236.5       1.7  IDENTITY (0x04), 32 bytes
fill-modexp-256    fill          87278       535.8       5.8  MODEXP (0x05), 256-bit base, exponent and modulus
fill-modexp-2048   fill          91135       522.7       5.4  MODEXP (0x05), 2048-bit base and modulus, exponent 3
fill-ecadd         fill         105577      1514.7      14.1  alt_bn128 ADD (0x06)
fill-ecmul         fill         100982      1645.1      16.0  alt_bn128 MUL (0x07)
fill-ecpairing     fill          81391      1191.9      14.3  alt_bn128 PAIRING (0x08), one pair
fill-blake2f-12    fill         103976       320.6       2.8  BLAKE2F (0x09), 12 rounds
fill-blake2f-90k   fill          92399      1010.2      10.6  BLAKE2F (0x09), 90,000 rounds
fill-bls-g1add     fill         111839      1274.3      11.1  BLS12_G1ADD (0x0b)
fill-bls-pairing   fill          72709      1188.2      15.9  BLS12_PAIRING_CHECK (0x0f), one pair
fill-bls-map-g2    fill          98139      1023.3      10.1  BLS12_MAP_FP2_TO_G2 (0x11)
fill-p256          fill         101237       919.5       8.8  P256VERIFY (0x100)
fill-sload         fill          97166       154.6       1.3  cold SLOAD of the sender's own slots, 1 to 45
fill-extcodehash   fill         103544       174.0       1.4  EXTCODEHASH of 33 distinct cold accounts
fill-call-24k      fill          92847       179.4       1.6  STATICCALL into distinct cold 24,576-byte contracts
fill-call-64k      fill          92847       171.7       1.5  STATICCALL into distinct cold 65,536-byte contracts
ns/gas is marginal: (time - time of `empty`) / (gas - gas of `empty`).
.
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 43.62s
```

### Run 4

```text
running 1 test
admission check per transaction, release build, median of 7 rounds of at least 200 ms
workload           group           gas    us/check    ns/gas  note
empty              realistic       108        29.6         -  APPROVE and nothing else: the fixed cost of an admission
eoa                realistic       100       115.1         -  default code: one SECP256K1 entry, checked by the protocol
groth16-tornado    realistic    245443      3011.5      12.2  Tornado's verifier, patched as in 06, on the proof of 0x2719e945... (06), called from VERIFY
ecrecover-40       realistic    129157      1964.2      15.0  40 ECDSA recoveries, the 40-key multisig of 05
p256-1             realistic      9313       100.7       7.7  one P256VERIFY, the passkey account of 11
wots-shape         realistic     46306       266.9       5.1  513 keccak-256 of 32 bytes: a w = 16 WOTS signature (67 chains, 7.5 steps on average) and a 10-level path, as in 17
fill-mulmod        fill          84146       325.3       3.5  MULMOD on 256-bit operands
fill-exp           fill         100106       425.7       4.0  EXP with a 32-byte exponent
fill-keccak-32     fill         117136       666.3       5.4  KECCAK256 of 32 bytes, chained
fill-keccak-1k     fill         116163      1345.3      11.3  KECCAK256 of 1,024 bytes
fill-ecrecover     fill         100575      1455.8      14.2  ECRECOVER (0x01)
fill-sha256        fill         112453       339.1       2.8  SHA256 (0x02), 32 bytes
fill-ripemd        fill         104898       104.1       0.7  RIPEMD160 (0x03), 32 bytes
fill-identity      fill         116803       241.7       1.8  IDENTITY (0x04), 32 bytes
fill-modexp-256    fill          87278       569.2       6.2  MODEXP (0x05), 256-bit base, exponent and modulus
fill-modexp-2048   fill          91135       534.7       5.5  MODEXP (0x05), 2048-bit base and modulus, exponent 3
fill-ecadd         fill         105577      1511.9      14.1  alt_bn128 ADD (0x06)
fill-ecmul         fill         100982      1639.6      16.0  alt_bn128 MUL (0x07)
fill-ecpairing     fill          81391      1251.5      15.0  alt_bn128 PAIRING (0x08), one pair
fill-blake2f-12    fill         103976       321.1       2.8  BLAKE2F (0x09), 12 rounds
fill-blake2f-90k   fill          92399       979.4      10.3  BLAKE2F (0x09), 90,000 rounds
fill-bls-g1add     fill         111839      1179.9      10.3  BLS12_G1ADD (0x0b)
fill-bls-pairing   fill          72709      1141.6      15.3  BLS12_PAIRING_CHECK (0x0f), one pair
fill-bls-map-g2    fill          98139       998.4       9.9  BLS12_MAP_FP2_TO_G2 (0x11)
fill-p256          fill         101237      1043.5      10.0  P256VERIFY (0x100)
fill-sload         fill          97166       174.1       1.5  cold SLOAD of the sender's own slots, 1 to 45
fill-extcodehash   fill         103544       175.0       1.4  EXTCODEHASH of 33 distinct cold accounts
fill-call-24k      fill          92847       170.3       1.5  STATICCALL into distinct cold 24,576-byte contracts
fill-call-64k      fill          92847       154.6       1.3  STATICCALL into distinct cold 65,536-byte contracts
ns/gas is marginal: (time - time of `empty`) / (gas - gas of `empty`).
.
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 42.21s
```

### Run 5

```text
running 1 test
admission check per transaction, release build, median of 7 rounds of at least 200 ms
workload           group           gas    us/check    ns/gas  note
empty              realistic       108        27.5         -  APPROVE and nothing else: the fixed cost of an admission
eoa                realistic       100       118.3         -  default code: one SECP256K1 entry, checked by the protocol
groth16-tornado    realistic    245443      3101.0      12.5  Tornado's verifier, patched as in 06, on the proof of 0x2719e945... (06), called from VERIFY
ecrecover-40       realistic    129157      1885.2      14.4  40 ECDSA recoveries, the 40-key multisig of 05
p256-1             realistic      9313       110.3       9.0  one P256VERIFY, the passkey account of 11
wots-shape         realistic     46306       395.6       8.0  513 keccak-256 of 32 bytes: a w = 16 WOTS signature (67 chains, 7.5 steps on average) and a 10-level path, as in 17
fill-mulmod        fill          84146       318.9       3.5  MULMOD on 256-bit operands
fill-exp           fill         100106       477.6       4.5  EXP with a 32-byte exponent
fill-keccak-32     fill         117136       807.8       6.7  KECCAK256 of 32 bytes, chained
fill-keccak-1k     fill         116163      1332.8      11.2  KECCAK256 of 1,024 bytes
fill-ecrecover     fill         100575      1626.1      15.9  ECRECOVER (0x01)
fill-sha256        fill         112453       365.3       3.0  SHA256 (0x02), 32 bytes
fill-ripemd        fill         104898       115.0       0.8  RIPEMD160 (0x03), 32 bytes
fill-identity      fill         116803       251.3       1.9  IDENTITY (0x04), 32 bytes
fill-modexp-256    fill          87278       540.7       5.9  MODEXP (0x05), 256-bit base, exponent and modulus
fill-modexp-2048   fill          91135       531.7       5.5  MODEXP (0x05), 2048-bit base and modulus, exponent 3
fill-ecadd         fill         105577      1613.7      15.0  alt_bn128 ADD (0x06)
fill-ecmul         fill         100982      1561.2      15.2  alt_bn128 MUL (0x07)
fill-ecpairing     fill          81391      1203.6      14.5  alt_bn128 PAIRING (0x08), one pair
fill-blake2f-12    fill         103976       333.6       2.9  BLAKE2F (0x09), 12 rounds
fill-blake2f-90k   fill          92399      1026.9      10.8  BLAKE2F (0x09), 90,000 rounds
fill-bls-g1add     fill         111839      1248.2      10.9  BLS12_G1ADD (0x0b)
fill-bls-pairing   fill          72709      1241.3      16.7  BLS12_PAIRING_CHECK (0x0f), one pair
fill-bls-map-g2    fill          98139      1004.3      10.0  BLS12_MAP_FP2_TO_G2 (0x11)
fill-p256          fill         101237       906.5       8.7  P256VERIFY (0x100)
fill-sload         fill          97166       158.9       1.4  cold SLOAD of the sender's own slots, 1 to 45
fill-extcodehash   fill         103544       167.9       1.4  EXTCODEHASH of 33 distinct cold accounts
fill-call-24k      fill          92847       160.8       1.4  STATICCALL into distinct cold 24,576-byte contracts
fill-call-64k      fill          92847       177.7       1.6  STATICCALL into distinct cold 65,536-byte contracts
ns/gas is marginal: (time - time of `empty`) / (gas - gas of `empty`).
.
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 42.59s
```

## Without the node's crypto features

The first run built the test without `--features ethrex-crypto/default`, as the workspace takes the crate. The BLS12-381 precompiles then revert (unsupported) and P256 takes the portable path:

```text
fill-p256          fill         101237      3672.6      36.0  P256VERIFY (0x100)
p256-1             realistic      9313       353.0      35.3  one P256VERIFY, the passkey account of 11
fill-bls-g1add     fill      not run: validation prefix frame reverted
```
