# Experiment 25, ethrex's budget fill: one set of listed transactions, many orders

Run 2026-10-08 against lambdaclass/ethrex `c94964843d39d04914dff178e55e60daf7707089` (branch `hegota-testnet`, the code the testnet runs), with `ethrex/exp25_fill_order.rs` copied into `crates/blockchain/tests/`. rustc 1.97.0 (2d8144b78 2026-07-07), release profile (ethrex pins 1.93.0; nothing here depends on the difference). CPU: Intel(R) Xeon(R) Processor @ 2.80GHz, 4 cores, one test thread. The timings are of one idle core and are a lower bound on what an attester under load spends.

Inputs: `ethrex/scenarios.txt` (from `scenarios.ts`) and `ethrex/delivered.txt` (from `cl_order.py`, `PYTHONHASHSEED` 0 to 7 for each of `mixed`, `committee` and `flood`).

```bash
# from a checkout of lambdaclass/ethrex at c94964843d; EXP is this directory
cp $EXP/ethrex/exp25_fill_order.rs crates/blockchain/tests/
EXP25_SCENARIOS=$EXP/ethrex/scenarios.txt:$EXP/ethrex/delivered.txt \
  cargo test -q --release -p ethrex-blockchain --test exp25_fill_order -- --nocapture --test-threads 1
```

```text
running 2 tests
MAX_VERIFY_GAS_PER_IL = 1048576

scenario withdrawals: 4 transactions, 24 orders (all)
  W1  cost    410000  admitted in    12 of 24 orders (50.0%)
  W2  cost    410000  admitted in    12 of 24 orders (50.0%)
  W3  cost    410000  admitted in    12 of 24 orders (50.0%)
  W4  cost    410000  admitted in    12 of 24 orders (50.0%)
  distinct admitted sets: 6
        4 orders admit {W1, W2}
        4 orders admit {W1, W3}
        4 orders admit {W1, W4}
        4 orders admit {W2, W3}
        4 orders admit {W2, W4}
        4 orders admit {W3, W4}
  canonical order (cost, hash): W1 W2 W3 W4 -> admits {W1, W2}

scenario grief: 4 transactions, 24 orders (all)
  A   cost   1048576  admitted in     6 of 24 orders (25.0%)
  W1  cost    410000  admitted in    18 of 24 orders (75.0%)
  S1  cost     67800  admitted in    18 of 24 orders (75.0%)
  E1  cost     22800  admitted in    18 of 24 orders (75.0%)
  distinct admitted sets: 2
       18 orders admit {E1, S1, W1}
        6 orders admit {A}
  canonical order (cost, hash): E1 S1 W1 A -> admits {E1, S1, W1}

scenario grief-honest: 3 transactions, 6 orders (all)
  W1  cost    410000  admitted in     6 of 6 orders (100.0%)
  S1  cost     67800  admitted in     6 of 6 orders (100.0%)
  E1  cost     22800  admitted in     6 of 6 orders (100.0%)
  distinct admitted sets: 1
        6 orders admit {E1, S1, W1}
  canonical order (cost, hash): E1 S1 W1 -> admits {E1, S1, W1}

scenario mixed: 11 transactions, 5040 orders (sampled, seed 0x25)
  W1  cost    410000  admitted in  2419 of 5040 orders (48.0%)
  W2  cost    410000  admitted in  2409 of 5040 orders (47.8%)
  W3  cost    410000  admitted in  2395 of 5040 orders (47.5%)
  W4  cost    410000  admitted in  2411 of 5040 orders (47.8%)
  S1  cost     67800  admitted in  3664 of 5040 orders (72.7%)
  S2  cost     67800  admitted in  3678 of 5040 orders (73.0%)
  S3  cost     67800  admitted in  3611 of 5040 orders (71.6%)
  E1  cost     22800  admitted in  4728 of 5040 orders (93.8%)
  E2  cost     22800  admitted in  4710 of 5040 orders (93.5%)
  E3  cost     22800  admitted in  4717 of 5040 orders (93.6%)
  E4  cost     22800  admitted in  4724 of 5040 orders (93.7%)
  distinct admitted sets: 46
      259 orders admit {E1, E2, E3, E4, S1, S3, W1, W3}
      254 orders admit {E1, E2, E3, E4, S1, S2, W2, W4}
      247 orders admit {E1, E2, E3, E4, S1, S2, W1, W2}
      242 orders admit {E1, E2, E3, E4, S2, S3, W3, W4}
      237 orders admit {E1, E2, E3, E4, S1, S2, W1, W4}
      235 orders admit {E1, E2, E3, E4, S1, S2, W1, W3}
      235 orders admit {E1, E2, E3, E4, S2, S3, W2, W4}
      233 orders admit {E1, E2, E3, E4, S2, S3, W1, W4}
  canonical order (cost, hash): E1 E2 E3 E4 S1 S2 S3 W1 W2 W3 W4 -> admits {E1, E2, E3, E4, S1, S2, S3, W1}

scenario grief-under: 6 transactions, 720 orders (all)
  U1  cost    400000  admitted in   360 of 720 orders (50.0%)
  U2  cost    400000  admitted in   360 of 720 orders (50.0%)
  U3  cost    400000  admitted in   360 of 720 orders (50.0%)
  W1  cost    410000  admitted in   360 of 720 orders (50.0%)
  S1  cost     67800  admitted in   720 of 720 orders (100.0%)
  E1  cost     22800  admitted in   720 of 720 orders (100.0%)
  distinct admitted sets: 6
      120 orders admit {E1, S1, U1, U2}
      120 orders admit {E1, S1, U1, U3}
      120 orders admit {E1, S1, U1, W1}
      120 orders admit {E1, S1, U2, U3}
      120 orders admit {E1, S1, U2, W1}
      120 orders admit {E1, S1, U3, W1}
  canonical order (cost, hash): E1 S1 U2 U3 U1 W1 -> admits {E1, S1, U2, U3}

scenario committee: 10 transactions, 5040 orders (sampled, seed 0x25)
  A   cost   1048576  admitted in   505 of 5040 orders (10.0%)
  U1  cost    400000  admitted in  1851 of 5040 orders (36.7%)
  U2  cost    400000  admitted in  1865 of 5040 orders (37.0%)
  U3  cost    400000  admitted in  1807 of 5040 orders (35.9%)
  W1  cost    410000  admitted in  1791 of 5040 orders (35.5%)
  S1  cost     67800  admitted in  4535 of 5040 orders (90.0%)
  E1  cost     22800  admitted in  4535 of 5040 orders (90.0%)
  W2  cost    410000  admitted in  1756 of 5040 orders (34.8%)
  S2  cost     67800  admitted in  4535 of 5040 orders (90.0%)
  E2  cost     22800  admitted in  4535 of 5040 orders (90.0%)
  distinct admitted sets: 11
      505 orders admit {A}
      494 orders admit {E1, E2, S1, S2, U1, U2}
      475 orders admit {E1, E2, S1, S2, U2, U3}
      465 orders admit {E1, E2, S1, S2, U1, U3}
      465 orders admit {E1, E2, S1, S2, U1, W1}
      449 orders admit {E1, E2, S1, S2, U2, W1}
      447 orders admit {E1, E2, S1, S2, U2, W2}
      446 orders admit {E1, E2, S1, S2, W1, W2}
  canonical order (cost, hash): E1 E2 S1 S2 U2 U3 U1 W1 W2 A -> admits {E1, E2, S1, S2, U2, U3}
  per list (EIP-8369), [A] [U1 U2 U3] [W1 S1 E1] [W2 W1 S2 E2] -> admits {A, E1, E2, S1, S2, U1, U2, W1, W2}

scenario flood: 41 transactions, 5040 orders (sampled, seed 0x25)
  W1  cost    410000  admitted in  1299 of 5040 orders (25.8%)
  W2  cost    410000  admitted in  1316 of 5040 orders (26.1%)
  S1  cost     67800  admitted in  2171 of 5040 orders (43.1%)
  S2  cost     67800  admitted in  2208 of 5040 orders (43.8%)
  E1  cost     22800  admitted in  2615 of 5040 orders (51.9%)
  E2  cost     22800  admitted in  2638 of 5040 orders (52.3%)
  W3  cost    410000  admitted in  1336 of 5040 orders (26.5%)
  W4  cost    410000  admitted in  1365 of 5040 orders (27.1%)
  S3  cost     67800  admitted in  2161 of 5040 orders (42.9%)
  E3  cost     22800  admitted in  2697 of 5040 orders (53.5%)
  E4  cost     22800  admitted in  2625 of 5040 orders (52.1%)
  F1-F30 cost     34952 each, admitted in 2267 of 5040 orders on average (45.0%)
  distinct admitted sets: 5040
  canonical order (cost, hash): 41 listed, 30 of them F -> admits {E1, E2, E3, E4, 27 x F}
  per list (EIP-8369), [30 listed, 30 of them F] [W1 W2 S1 S2 E1 E2] [W3 W4 S3 E3 E4] -> admits {E1, E2, E3, E4, S1, S2, S3, W1, W2, W3, W4, 30 x F}

scenario as-delivered mixed PYTHONHASHSEED=0: W3 E2 W2 S2 S1 E1 E3 E4 S3 W1 W4 -> admits {E1, E2, E3, E4, S1, S2, W2, W3}

scenario as-delivered mixed PYTHONHASHSEED=1: S1 E3 E4 W2 W4 E2 E1 W1 W3 S3 S2 -> admits {E1, E2, E3, E4, S1, S3, W2, W4}

scenario as-delivered mixed PYTHONHASHSEED=2: S1 W1 E3 E1 S3 W2 W4 W3 S2 E4 E2 -> admits {E1, E2, E3, E4, S1, S3, W1, W2}

scenario as-delivered mixed PYTHONHASHSEED=3: E4 W2 W3 S3 S2 W4 E1 E2 E3 S1 W1 -> admits {E1, E2, E3, E4, S2, S3, W2, W3}

scenario as-delivered mixed PYTHONHASHSEED=4: E3 S3 W2 S2 W4 S1 E1 W3 E4 E2 W1 -> admits {E3, S1, S2, S3, W2, W4}

scenario as-delivered mixed PYTHONHASHSEED=5: W3 E2 W4 W1 E3 S1 S2 W2 E4 S3 E1 -> admits {E1, E2, E3, E4, S1, S2, W3, W4}

scenario as-delivered mixed PYTHONHASHSEED=6: W1 W4 S2 S3 W2 E4 W3 E1 E3 E2 S1 -> admits {E1, E2, E3, E4, S2, S3, W1, W4}

scenario as-delivered mixed PYTHONHASHSEED=7: E1 W4 E3 S1 E4 S2 W1 E2 S3 W2 W3 -> admits {E1, E2, E3, E4, S1, S2, W1, W4}

scenario as-delivered committee PYTHONHASHSEED=0: E2 W2 S2 A S1 U1 E1 U2 W1 U3 -> admits {E1, E2, S1, S2, U1, W2}

scenario as-delivered committee PYTHONHASHSEED=1: S1 A U3 W2 E2 E1 W1 U1 U2 S2 -> admits {E1, E2, S1, S2, U3, W2}

scenario as-delivered committee PYTHONHASHSEED=2: S1 W1 U1 U3 E1 W2 S2 U2 E2 A -> admits {E1, E2, S1, S2, U1, W1}

scenario as-delivered committee PYTHONHASHSEED=3: U1 A U2 W2 S2 E1 S1 E2 U3 W1 -> admits {E1, E2, S1, S2, U1, U2}

scenario as-delivered committee PYTHONHASHSEED=4: U2 U1 W2 S2 A S1 E1 U3 E2 W1 -> admits {E1, E2, S1, S2, U1, U2}

scenario as-delivered committee PYTHONHASHSEED=5: E2 W1 S1 U2 E1 S2 A W2 U3 U1 -> admits {E1, E2, S1, S2, U2, W1}

scenario as-delivered committee PYTHONHASHSEED=6: W1 U1 S2 U2 W2 A U3 E1 E2 S1 -> admits {E1, E2, S1, S2, U1, W1}

scenario as-delivered committee PYTHONHASHSEED=7: E1 U3 A S1 U2 U1 S2 W1 E2 W2 -> admits {E1, E2, S1, S2, U2, U3}

scenario as-delivered flood PYTHONHASHSEED=0: 41 listed, 30 of them F -> admits {E3, E4, S1, S2, W3, 13 x F}

scenario as-delivered flood PYTHONHASHSEED=1: 41 listed, 30 of them F -> admits {E2, E3, E4, S1, W4, 14 x F}

scenario as-delivered flood PYTHONHASHSEED=2: 41 listed, 30 of them F -> admits {E2, E4, S2, S3, W4, 13 x F}

scenario as-delivered flood PYTHONHASHSEED=3: 41 listed, 30 of them F -> admits {E1, E2, E3, E4, S2, W1, 13 x F}

scenario as-delivered flood PYTHONHASHSEED=4: 41 listed, 30 of them F -> admits {E1, E2, E3, E4, S1, S3, 23 x F}

scenario as-delivered flood PYTHONHASHSEED=5: 41 listed, 30 of them F -> admits {E1, E2, E3, S1, W3, 14 x F}

scenario as-delivered flood PYTHONHASHSEED=6: 41 listed, 30 of them F -> admits {E1, E2, E3, W1, 16 x F}

scenario as-delivered flood PYTHONHASHSEED=7: 41 listed, 30 of them F -> admits {E1, E4, S1, S3, W4, 13 x F}
.
stateless check per transaction, release build, 4000 iterations x 5 rounds, median round
  T1    111 bytes      47.7 us/tx   73 per 8 KiB list    3.48 ms per list    55.7 ms per slot (16 lists)
  E1    242 bytes      48.2 us/tx   33 per 8 KiB list    1.59 ms per list    25.4 ms per slot (16 lists)
  E2    170 bytes      47.1 us/tx   48 per 8 KiB list    2.26 ms per list    36.2 ms per slot (16 lists)
  E3    251 bytes      49.2 us/tx   32 per 8 KiB list    1.58 ms per list    25.2 ms per slot (16 lists)
  E4    167 bytes      50.1 us/tx   49 per 8 KiB list    2.46 ms per list    39.3 ms per slot (16 lists)
  S1    702 bytes      55.2 us/tx   11 per 8 KiB list    0.61 ms per list     9.7 ms per slot (16 lists)
  S2   1214 bytes      53.1 us/tx    6 per 8 KiB list    0.32 ms per list     5.1 ms per slot (16 lists)
  S3    702 bytes      55.9 us/tx   11 per 8 KiB list    0.62 ms per list     9.8 ms per slot (16 lists)
  W1    747 bytes       5.1 us/tx   10 per 8 KiB list    0.05 ms per list     0.8 ms per slot (16 lists)
  W2    746 bytes       5.1 us/tx   10 per 8 KiB list    0.05 ms per list     0.8 ms per slot (16 lists)
  W3    747 bytes       5.4 us/tx   10 per 8 KiB list    0.05 ms per list     0.9 ms per slot (16 lists)
  W4    747 bytes       5.7 us/tx   10 per 8 KiB list    0.06 ms per list     0.9 ms per slot (16 lists)
.
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 16.13s

```
