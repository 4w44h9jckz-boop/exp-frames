# The execution digest's assets

The test cases and reference implementations the draft ERC ([`../erc-draft.md`](../erc-draft.md))
names under its assets folder. Every file here is marked `CC0-1.0, pending the copyright waiver`:
it is meant for a CC0 release when the ERC is filed, and is not released yet.

| File | What |
|---|---|
| `vectors.json` | Eleven transactions under EIP-8250 at [`1a086d5c`](https://github.com/ethereum/EIPs/blob/1a086d5c67cdcf3a134cc571eb4bb4b9bed6fb02/EIPS/eip-8250.md), where `nonce_keys == []` selects the legacy nonce and key 0 is an ordinary key. Each holds its fields, its domain separator, struct hash, `E`, pay frames and raw signed transaction |
| `cases.txt` | Twenty signed transactions under the same revision, with the verdict the reference account must give, and the accounts a fresh chain needs |
| `vectors-eip8250-f3079a0.json`, `cases-eip8250-f3079a0.txt` | The same without the key-0 vector, under EIP-8250 at [`f3079a09e8`](https://github.com/ethereum/EIPs/blob/f3079a09e8c606afcb0e5e1a309ff228b88dc067/EIPS/eip-8250.md), where `[0]` selected the legacy nonce. The ethrex Hegota testnet follows that revision |
| `digest.ts` | `E` through viem's EIP-712 encoder, and by hand from the layout. It imports nothing but viem |
| `digest.rs` | `E` through alloy's EIP-712 derive. It imports nothing but alloy (and serde for its test) |
| `ExecutionScopeAccount.yul` | The reference account: execution-only approval on `E`, self-payment only over the canonical hash |

The two revisions differ only in which nonce keys select the legacy nonce. So a plain EIP-8141
envelope's nonce digests as `[]` under the first and as `[0]` under the second, and every vector
using the legacy nonce has a different `E` in the two sets. The keyed-nonce vector is the same in
both.

`vectors.json` and the cases files are written by [`../vectors.ts`](../vectors.ts). They are
generated, not edited.

## Checked by

- the experiment's two TypeScript implementations, and `digest.ts` here, on both sets
  (`../digest.test.ts`);
- `digest.rs` here, on both sets, and kohaku-rs's `crates/frame-kit` `digest.rs`, which decodes each
  set's raw transactions under that set's rules;
- the account, inside ethrex's validation-prefix simulation: the `f3079a0` cases in ethrex at
  `c94964843d`, and the master cases in the same commit with
  [`../ethrex/eip8250-master.patch`](../ethrex/eip8250-master.patch) applied. No client implements
  master's legacy-nonce rule yet. Both runs: [`../results/ethrex-2026-10-20.md`](../results/ethrex-2026-10-20.md).
