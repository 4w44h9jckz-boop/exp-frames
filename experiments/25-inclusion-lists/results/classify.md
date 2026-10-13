# Experiment 25, classify.ts: eligibility, budget and capacity of every mined frame transaction

Run 2026-10-08 from the tooling base 0ddb484, reading the fixtures of every remote-tracking head listed below. No network.

```bash
git fetch origin && npx tsx experiments/25-inclusion-lists/classify.ts
```

Branches read (remote-tracking heads):
exp/01-simple-tx@fa9324c, exp/02-account-deployment@06a3467, exp/03-atomic-batch@b2ad332, exp/04-sponsored-erc20@253a9e7, exp/05-multisig@b642e12, exp/06-privacy-pool@3b46bb5, exp/07-threshold-wallet@90132cf, exp/08-multisig-ops@9dde50e, exp/09-paymasters@2120f59, exp/10-expiry@7766250, exp/11-passkey@2aed6f6, exp/12-session-keys@c2801e3, exp/13-social-recovery@944fb91, exp/14-modular-account@999e9c5, exp/15-eip7702-sender@17ebc24, exp/16-subscriptions@93bd322, exp/17-pq-account@7b4894f, exp/18-introspection@044d60e, exp/19-mempool-rules@e4d82da, exp/20-signature-service@977a1e8, exp/21-erc4337-side-by-side@ad7e206, exp/22-cross-client@820ced6, exp/23-approval-scope@8aa56e4, exp/24-sealed-paymaster@1904c6e, tooling@0ddb484

183 mined frame transactions: 177 from the Hegota testnet, 6 from frames-devnet-0.

## 1. Eligibility of every mined transaction

| rule | eligible | not eligible |
|---|---:|---:|
| Profile 2 candidate, EIP-8369 as written | 173 | 10 |
| Profile 2 candidate, skipping both verifier frames (EIP-8272, ethrex) | 183 | 0 |
| proposed Profile 1 (directly evaluable prefix) | 68 | 115 |
| either Profile 2 (EIP-8272 reading) or proposed Profile 1 | 183 | 0 |

Candidates under EIP-8272's rule that EIP-8369's text excludes: 10, all with shape(s) recent_root_verify | self_verify; recent_root_verify | only_verify | pay; expiry_verify | recent_root_verify | only_verify | pay.

Why the rest are not Profile 2 candidates (EIP-8272 reading):
- none: every mined transaction is a candidate.

Why the rest are not eligible for the proposed Profile 1:
- self_verify runs account code: 76
- only_verify runs account code: 15
- recent-root frame (EIP-8272 state): 10
- pay runs account code: 8
- deploy frame (runs factory code): 6

## 2. By experiment and validation prefix

Budget = signature verification + declared execution limits up to the payer frame (EIP-8369, ethrex). "Used" = the same with each frame's measured execution gas.

| branch | chain | prefix shape | txs | P2 (8369) | P2 (8272) | P1 (proposed) | budget declared | budget used | budget with state limits | bytes |
|---|---|---|---:|---|---|---|---:|---:|---:|---:|
| exp/01-simple-tx | Hegota | `self_verify` | 4 | yes | yes | yes | 22,800 | 2,900 | 22,800 | 167 to 251 |
| exp/02-account-deployment | Hegota | `deploy \| self_verify` | 1 | yes | yes | no | 92,800 | 18,329 | 475,300 | 391 |
| exp/02-account-deployment | Hegota | `self_verify` | 1 | yes | yes | no | 12,800 | 3,088 | 12,800 | 190 |
| exp/03-atomic-batch | Hegota | `self_verify` | 5 | yes | yes | yes | 22,800 | 2,900 | 22,800 | 234 to 6,782 |
| exp/04-sponsored-erc20 | Hegota | `only_verify \| pay` | 3 | yes | yes | 1/3 | 25,600 to 42,800 | 6,399 to 8,700 | 42,800 to 209,200 | 361 to 402 |
| exp/04-sponsored-erc20 | Hegota | `self_verify` | 2 | yes | yes | yes | 22,800 | 2,900 | 22,800 | 981 to 3,594 |
| exp/05-multisig | Hegota | `self_verify` | 4 | yes | yes | 2/4 | 22,800 to 39,500 | 2,900 to 10,707 | 22,800 to 39,500 | 280 to 8,612 |
| exp/06-privacy-pool | Hegota | `only_verify \| pay` | 1 | yes | yes | no | 410,000 | 252,344 | 410,000 | 638 |
| exp/06-privacy-pool | Hegota | `recent_root_verify \| only_verify \| pay` | 1 | no | yes | no | 420,000 | 253,749 | 517,920 | 778 |
| exp/06-privacy-pool | Hegota | `recent_root_verify \| self_verify` | 4 | no | yes | no | 410,000 | 250,387 | 507,920 | 746 to 747 |
| exp/06-privacy-pool | Hegota | `self_verify` | 2 | yes | yes | 1/2 | 22,800 to 400,000 | 2,900 to 248,982 | 22,800 to 400,000 | 201 to 607 |
| exp/07-threshold-wallet | Hegota | `self_verify` | 4 | yes | yes | 1/4 | 20,100 to 22,800 | 2,900 to 3,964 | 20,100 to 22,800 | 152 to 659 |
| exp/08-multisig-ops | Hegota | `deploy \| self_verify` | 2 | yes | yes | no | 125,600 | 25,103 to 37,311 | 506,570 to 624,380 | 542 to 555 |
| exp/08-multisig-ops | Hegota | `expiry_verify \| self_verify` | 1 | yes | yes | no | 50,600 | 12,913 | 148,520 | 416 |
| exp/08-multisig-ops | Hegota | `self_verify` | 6 | yes | yes | no | 45,600 | 9,862 to 12,042 | 45,600 to 143,520 | 340 to 377 |
| exp/09-paymasters | Hegota | `only_verify \| pay` | 6 | yes | yes | 1/6 | 40,600 to 58,400 | 8,700 to 12,913 | 40,600 to 242,000 | 281 to 381 |
| exp/09-paymasters | Hegota | `self_verify` | 2 | yes | yes | yes | 22,800 | 2,900 | 22,800 | 163 to 198 |
| exp/10-expiry | Hegota | `expiry_verify \| self_verify` | 4 | yes | yes | yes | 25,851 to 27,800 | 5,951 | 25,851 to 27,800 | 206 |
| exp/10-expiry | Hegota | `self_verify` | 2 | yes | yes | yes | 22,800 | 2,900 | 22,800 | 206 |
| exp/11-passkey | Hegota | `deploy \| self_verify` | 1 | yes | yes | no | 106,700 | 22,229 | 490,730 | 451 |
| exp/11-passkey | Hegota | `self_verify` | 2 | yes | yes | no | 26,700 to 60,100 | 6,988 to 15,642 | 26,700 to 60,100 | 249 to 345 |
| exp/12-session-keys | Hegota | `expiry_verify \| self_verify` | 3 | yes | yes | no | 67,800 | 13,319 to 13,497 | 67,800 | 312 to 349 |
| exp/12-session-keys | Hegota | `self_verify` | 8 | yes | yes | 2/8 | 22,800 | 2,900 to 3,140 | 22,800 | 163 to 938 |
| exp/13-social-recovery | Hegota | `self_verify` | 16 | yes | yes | 2/16 | 22,800 to 45,600 | 2,900 to 9,366 | 22,800 to 45,600 | 180 to 1,093 |
| exp/14-modular-account | Hegota | `self_verify` | 3 | yes | yes | 1/3 | 22,800 to 42,800 | 2,900 to 10,550 | 22,800 to 42,800 | 207 to 1,293 |
| exp/15-eip7702-sender | Hegota | `self_verify` | 7 | yes | yes | 2/7 | 22,800 to 36,700 | 2,900 to 12,175 | 22,800 to 36,700 | 186 to 501 |
| exp/16-subscriptions | Hegota | `only_verify \| pay` | 11 | yes | yes | no | 45,600 | 9,305 | 45,600 to 143,520 | 346 to 349 |
| exp/16-subscriptions | Hegota | `self_verify` | 6 | yes | yes | 1/6 | 22,800 | 2,900 to 3,134 | 22,800 to 120,720 | 186 to 838 |
| exp/17-pq-account | Hegota | `self_verify` | 8 | yes | yes | 1/8 | 22,800 to 500,000 | 2,900 to 230,510 | 22,800 to 500,000 | 572 to 4,528 |
| exp/18-introspection | Hegota | `self_verify` | 3 | yes | yes | 1/3 | 22,800 to 102,901 | 2,900 to 36,204 | 22,800 to 102,901 | 509 to 2,170 |
| exp/19-mempool-rules | Hegota | `self_verify` | 5 | yes | yes | 1/5 | 22,800 to 62,800 | 2,900 to 6,941 | 22,800 to 62,800 | 180 to 1,002 |
| exp/20-signature-service | Hegota | `self_verify` | 6 | yes | yes | yes | 22,800 to 49,600 | 2,900 to 29,700 | 22,800 to 49,600 | 424 to 19,283 |
| exp/21-erc4337-side-by-side | Hegota | `deploy \| self_verify` | 1 | yes | yes | no | 92,800 | 18,329 | 475,300 | 452 |
| exp/21-erc4337-side-by-side | Hegota | `self_verify` | 3 | yes | yes | 2/3 | 12,800 to 22,800 | 2,900 to 3,088 | 12,800 to 22,800 | 231 to 251 |
| exp/23-approval-scope | Hegota | `only_verify \| pay` | 1 | yes | yes | no | 60,600 | 11,514 | 60,600 | 780 |
| exp/23-approval-scope | Hegota | `self_verify` | 4 | yes | yes | 1/4 | 22,800 to 32,800 | 2,900 to 4,287 | 22,800 to 32,800 | 421 to 10,901 |
| exp/24-sealed-paymaster | Hegota | `expiry_verify \| recent_root_verify \| only_verify \| pay` | 3 | no | yes | no | 67,800 | 16,105 to 19,161 | 251,400 | 702 to 1,214 |
| exp/24-sealed-paymaster | Hegota | `self_verify` | 4 | yes | yes | 2/4 | 17,800 to 22,800 | 2,900 to 3,135 | 17,800 to 22,800 | 186 to 3,720 |
| tooling | devnet-0 | `expiry_verify \| self_verify` | 1 | yes | yes | yes | 12,800 | 5,951 | 12,800 | 204 |
| tooling | devnet-0 | `self_verify` | 5 | yes | yes | yes | 7,800 | 2,900 | 7,800 | 164 to 258 |
| tooling | Hegota | `deploy \| self_verify` | 1 | yes | yes | no | 92,800 | 18,329 | 475,300 | 383 |
| tooling | Hegota | `only_verify \| pay` | 4 | yes | yes | 1/4 | 25,600 to 202,800 | 6,417 to 8,700 | 42,800 to 209,200 | 353 to 660 |
| tooling | Hegota | `recent_root_verify \| self_verify` | 2 | no | yes | no | 40,800 to 352,800 | 8,479 to 263,064 | 138,720 to 548,640 | 1,034 to 1,307 |
| tooling | Hegota | `self_verify` | 20 | yes | yes | 14/20 | 7,800 to 82,800 | 109 to 10,707 | 12,800 to 203,640 | 119 to 437 |

## 3. What one slot of inclusion lists can protect

Per slot: 16 lists of 8,192 bytes. Budget 1,048,576 per list (EIP-8369) or per payload (ethrex, since the Engine API delivers one array). A homogeneous slot of each kind; "declared" uses the transaction's own limits, "tight" the gas it used.

| kind | example | bytes | budget declared / tight | per slot, ethrex (2^20 per payload) | per slot, EIP-8369 (2^20 per list) | per slot, proposed Profile 1 (bytes only) |
|---|---|---:|---:|---:|---:|---:|
| self-relayed EOA, default code (01) | `0x26ed3e31…` | 188 | 7,800 / 2,900 | 134 / 361 | 688 / 688 | 688 |
| EOA sponsored by a code-less EOA (04, 09) | `0x96800f6b…` | 353 | 25,600 / 8,700 | 40 / 120 | 368 / 368 | 368 |
| deadline-bounded EOA (10) | `0x7d3e237f…` | 206 | 25,851 / 5,951 | 40 / 176 | 624 / 624 | 624 |
| smart account, own VERIFY (05) | `0x8d3b555a…` | 280 | 35,600 / 6,729 | 29 / 155 | 464 / 464 | not eligible |
| privacy withdrawal, keyed pool (06) | `0x2719e945…` | 747 | 410,000 / 250,387 | 2 / 4 | 32 / 64 | not eligible |
| sealed-paymaster sponsorship (24) | `0x11594d4d…` | 702 | 67,800 / 16,105 | 15 / 65 | 176 / 176 | not eligible |

## 4. "Fits the remaining gas", in one dimension or two

EIP-8141 includes a frame transaction only if its execution reservation and its state reservation each fit their own dimension. EIP-7805 step 2 and ethrex's `gas_fits` compare one number, `max_gas`, against `gas_limit - gas_used`. The difference is what the one-dimensional rule additionally requires to be free.

- 104 of 183 transactions declare state gas; for them `max_gas` exceeds the execution reservation.
- `max_gas - execution_reservation`: median 97,920, largest 30,070,620 gas.
- The largest is `0xbb57dbc8…` on exp/20-signature-service: self_verify, then 5 frames declaring 30,070,620 state gas between them (contract creation). Under the one-dimensional rule it needs that much more room than its execution reservation in a block whose state dimension may be empty.
