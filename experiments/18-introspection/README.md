# 18 — The introspection opcodes, checked word by word

Every experiment so far has relied on a handful of the introspection opcodes:
- `TXPARAM` for the sig hash, the max cost and the nonce keys;
- `FRAMEPARAM` for modes, targets and scopes;
- `SIGPARAM` for resolved signers;
- `FRAMEDATALOAD`, `FRAMEDATACOPY` and `SIGDATACOPY` for data and signature bytes.

This experiment reads all of them, from every mode, and compares each value with a model built
from the EIP's tables and this repository's encoder. It also probes every case the EIP says must
halt.

[`Introspector.yul`](Introspector.yul) is an account, owner key in code, that can dump everything
the opcodes return:
- `TXPARAM` 0x00-0x10;
- for every frame, `FRAMEPARAM` 0x00-0x04 and 0x06-0x09 and its first data word, and for frames
  already run, 0x05, 0x0A and 0x0B;
- for every signature, `SIGPARAM` 0x01, 0x02, and 0x00 or 0x03 according to its scheme.

From a SENDER frame, a DEFAULT frame or a nested call it logs the dump. VERIFY cannot log, so it
checks itself instead. Entry 1 of the transaction is a 32-byte ARBITRARY entry with `msg` ∅, so
it is outside the sig hash, the very value it describes. It holds keccak256 of the dump the
script expects VERIFY to see, and VERIFY approves only if its own dump hashes to it. A
transaction that is valid is therefore a proof that VERIFY saw exactly the model.

[`introspector.ts`](introspector.ts) holds that model, `model(tx, frame, context)`: one labelled
word per value. It is written from the EIP's tables, with the tooling's `maxCost` and
`frameSigHash`, and with the per-frame receipts for the status and gas of frames already run.

| File | What |
|---|---|
| [`Introspector.yul`](Introspector.yul) | The account: dump, single-opcode probes, opcode gas, revert, nested call |
| [`introspector.ts`](introspector.ts) | Owner key, address, calldata builders, the model, decoding |
| [`example-introspection.ts`](example-introspection.ts) | Setup, then A (dumps), B (probes), C (outside a frame transaction) |

## Run

```bash
npx tsx experiments/18-introspection/example-introspection.ts
```

One detail of building A and B is worth knowing. The max cost, `TXPARAM(0x06)`, is part of the
dump, and it depends on how many zero bytes entry 1 holds: 4 gas each against 16 for others.
So the script prices entry 1 as 32 non-zero bytes and rejects a dump hash that contains a zero
byte. It then changes one value and tries again; 12% of hashes need this.

## Results (2026-10-07, ethrex `v23.0.0-hegota-testnet-hotfix-4738681`)

The Introspector is `0x901d009Ce49eE7B29Cc0619B6e84A0C0cBd48366`. Setup:
[`0x4f266e94…`](https://dora.privacy.ethrex.xyz/tx/0x4f266e949708b3c68ac7be63f7e2b38fcaaf4bf20b261a16ac352df1c0e1feda).

**A.** [`0xed4fae20…`](https://dora.privacy.ethrex.xyz/tx/0xed4fae2046cded263e5c4afd5e1fc43d46862205d301ef4fb3a8f5ff05bdaecc),
eleven frames, 339,796 gas:

| Frame | Mode | What | Status | Execution gas | Dump |
|---|---|---|---|---|---|
| 0 | VERIFY | owner's signature, then its own dump against entry 1 | SUCCESS | 18,699 | 133 words, hash matched |
| 1 | SENDER | dump, with a state budget of 97,920 | SUCCESS | 53,316 | 136 words, **all equal** |
| 2 | SENDER | 1 wei to the funder | SUCCESS | 3,000 | |
| 3 | DEFAULT | dump (caller is the entry point) | SUCCESS | 55,188 | 142 words, **all equal** |
| 4 | SENDER | revert | FAILURE | 265 | |
| 5 | SENDER, atomic | dump | SUCCESS (rolled back, log removed) | 56,967 | |
| 6 | SENDER, atomic | revert | FAILURE | 265 | |
| 7 | SENDER | dump | SKIPPED | 0 | |
| 8 | SENDER | dump: reads the status and gas of 0-7 | SUCCESS | 59,706 | 157 words, **all equal** |
| 9 | SENDER | opcode gas | SUCCESS | 2,408 | |
| 10 | SENDER | a call to itself, which dumps | SUCCESS | 61,865 | 163 words, **all equal** |

598 logged words, plus VERIFY's 133, agree with the model; none differ. Among them:
- `TXPARAM(0x0C)` is 97,920 in frame 1 and 0 elsewhere;
- `TXPARAM(0x06)` equals the tooling's `maxCost`;
- `TXPARAM(0x0F)` equals EIP-8250's `nonce_keys_hash`;
- the statuses frame 8 reads are 1, 1, 1, 1, 0, 1, 0, 2, as the receipts report them.

What each opcode costs (frame 9, from `GAS` before and after):

| Opcode | Gas | EIP |
|---|---|---|
| `TXPARAM(0x00)` | 2 | 2 |
| `TXPARAM(0x08)`, the sig hash | 2 | 2 |
| `TXPARAM(0x06)`, the max cost | 2 | 2 |
| `FRAMEPARAM(0x00, 0)` | 2 | 2 |
| `SIGPARAM(0x01, 0)` | 2 | 2 |
| `FRAMEDATALOAD(0, 0)` | 3 | 3 |

**B.** [`0x674b1541…`](https://dora.privacy.ethrex.xyz/tx/0x674b154165252e70b8d034bfffce687a1f844c5b3da524df7d062781f45e8665),
21 frames, 351,995 gas. VERIFY's 233-word dump matched again. Each probe frame runs one opcode
with 20,000 gas; a halt fails the frame and uses all of it.

| Probe | EIP says | Observed | Gas | Value |
|---|---|---|---|---|
| `TXPARAM(0x11)`, undefined | halt | FAILURE | 20,000 | |
| `TXPARAM(0x10)`, from EIP-8250 | value | success | 934 | 0 |
| `FRAMEPARAM(0x05)` of the current frame | halt | FAILURE | 20,000 | |
| `FRAMEPARAM(0x05)` of the next frame | halt | FAILURE | 20,000 | |
| `FRAMEPARAM(0x05)` of frame 0, the VERIFY frame | value | success | 954 | 1 |
| `FRAMEPARAM(0x0A)` of the current frame | halt | FAILURE | 20,000 | |
| `FRAMEPARAM(0x0B)` of the current frame | halt | FAILURE | 20,000 | |
| `FRAMEPARAM(0x0C)`, undefined | halt | FAILURE | 20,000 | |
| `FRAMEPARAM(0x00)` of frame 21, out of range | halt | FAILURE | 20,000 | |
| `FRAMEDATALOAD` of frame 21, out of range | halt | FAILURE | 20,000 | |
| `FRAMEDATALOAD` at offset 1000, past the data | value (zeros) | success | 996 | 0 |
| `FRAMEDATACOPY` of frame 21, out of range | halt | FAILURE | 20,000 | |
| `SIGPARAM(0x00)` of the ARBITRARY entry | halt | FAILURE | 20,000 | |
| `SIGPARAM(0x03)` of the SECP256K1 entry | halt | FAILURE | 20,000 | |
| `SIGPARAM(0x04)`, undefined | halt | FAILURE | 20,000 | |
| `SIGPARAM(0x01)` of entry 2, out of range | halt | FAILURE | 20,000 | |
| `SIGDATACOPY` of the SECP256K1 entry | halt | FAILURE | 20,000 | |
| `SIGDATACOPY` of the ARBITRARY entry | value | success | 1,036 | the entry's 32 bytes |
| `SIGPARAM(0x02)` of an empty-`msg` entry | value | success | 976 | 0 |
| `SIGPARAM(0x00)` of the SECP256K1 entry | value | success | 976 | the owner |

**C.** The same `TXPARAM(0x00)` through `eth_call`, outside any frame transaction: `execution
halted: reason=Invalid Opcode`.

## Observations

1. **ethrex's introspection matches the EIP, value for value and halt for halt.** 731 words from
   VERIFY, SENDER, DEFAULT and a nested call agree with a model written from the EIP's tables. All twenty probes behave as the
   EIP says, and each opcode costs what the EIP says. The opcodes see the same transaction from
   VERIFY, SENDER, DEFAULT and a nested call. Only the current-frame values differ, and they
   differ as specified:
   - `TXPARAM(0x0A)`;
   - `TXPARAM(0x0C)`;
   - which frames' status and gas can be read.

   This repository's encoder, which every other experiment builds on, agrees with the client on
   every field, including the max cost and the nonce keys hash.

2. **A VERIFY frame can prove what it saw.** VERIFY cannot log or write, so its view of the
   transaction is normally visible only as approve or revert. Putting a commitment to the
   expected view in an empty-`msg` ARBITRARY entry turns validity into an equality test over
   the whole view. This works because the entry is outside the sig hash but inside the
   transaction. The same trick serves any account that wants to commit to something about its
   own transaction that the signer cannot know until after signing. Its one trap is the one
   above: the bytes of the commitment feed the max cost it may contain.

3. **An empty `msg` reads as zero.** `SIGPARAM(0x02)` of an entry that signs the sig hash
   returns 0, not the sig hash. A contract that wants "the digest this entry signed" must
   substitute `TXPARAM(0x08)` itself when `msg` is 0. This matters to any contract that checks
   signatures on behalf of others (experiment 20).

4. **A later frame sees a rolled-back frame as a success.** Frame 5 ran, logged and was rolled
   back with its batch. Its receipt and `FRAMEPARAM(0x05)` both say 1, and only its log is gone
   (experiment 03 saw the same). To tell that frame 5 was undone, a contract has to read frame
   5's atomic flag and the failure of a later frame in its batch. `gas_used.execution` keeps the
   gas a rolled-back frame spent (56,967), as the EIP says it should.

5. **The sig hash and the max cost cost 2 gas.** Both are derived from the whole transaction, but
   ethrex computes them once, so reading them in every frame is cheap. A verifier has no reason
   to cache them in memory.

6. **The opcodes are undefined outside frame transactions.** `eth_call` reports an invalid
   opcode, the EIP's exceptional halt. A contract shared between frame and legacy callers has
   to gate its introspection on something else first, as the Introspector gates on its caller
   and calldata.
