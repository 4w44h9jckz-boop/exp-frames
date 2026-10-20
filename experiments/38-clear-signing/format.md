# A display format for frame transactions, beside ERC-7730

Version 0, written for experiment 38. It says what a device shows when it is asked to sign an
entry of a type-`0x06` transaction (EIP-8141, with EIP-8250 nonce keys), or the execution digest
$E$ of experiment 27's draft as `eth_signTypedData_v4` typed data, and where each line comes from.
kohaku-rs's `kohaku-frame-display` implements it; the README beside this file has the run.

ERC-7730 was read at `ethereum/ERCs` `48dc87a2`, schema 2.1.0. EIP-8141 is the revision the Hegota
testnet pins, `b75cbe6115`; EIP-8250 is read at both `f3079a09e8` and `1a086d5c`.

The format has four parts:

1. **The frame container**: rules a wallet applies to every frame transaction. They need no
   descriptor, because EIP-8141 fixes what they show.
2. **ERC-7730 files**, unchanged, for the contracts the frames call, with container values set
   per frame.
3. **Account descriptors**, one per account implementation: what the account's `VERIFY` frame
   approves for a signature, and how to show the calls it makes to itself.
4. **Deployer descriptors**, for a deploy frame whose calldata is not ABI.

Beside these the wallet keeps its own data, which is not a descriptor: a token list, an address
book, and the accounts it set up with the implementation each runs.

## 1. The frame container

The device is given the transaction and the index $k$ of the signature entry it holds the key of.
Or it is given the typed data alone.

**What the signature covers.** The entry's `msg` decides.

| `msg` | The device shows | Source |
|---|---|---|
| empty | the whole transaction: every frame, the fees and who else signs (the canonical signature hash) | EIP-8141 |
| 32 bytes equal to $E$, recomputed from the transaction | every frame but the payer's, and not the fees | the execution digest draft |
| anything else | an explicit digest it cannot open: a blind gap, and the device should refuse | EIP-8141 |

**The account.** The device binds the sender to an implementation, in this order:

1. a non-`VERIFY` frame calls a deployer (part 4) whose new address is the sender, and the
   initcode is an account descriptor's `creationCode` followed by its arguments: bound by the
   transaction itself;
2. the wallet's own account list names the sender;
3. the entry's resolved signer is the sender: EIP-8141's default code. This assumes the key has
   signed no EIP-7702 delegation, which only the key's holder can know;
4. otherwise the sender is unbound. That leaves the signer blind only if the signature is not
   over the canonical hash.

**The nonce**, under the fork's EIP-8250 revision, which is the wallet's to know:
`nonce_keys == [0]` is the account nonce at `f3079a09e8` and key 0 of `NONCE_MANAGER` at master,
where `[]` is the account nonce. From typed data alone the device has `nonceKeysHash`. It can
name the account nonce, whose hash is a constant, and otherwise shows the hash: a gap, not blind.

**`VERIFY` frames**, each by its resolved target:

| Target | The device shows |
|---|---|
| the expiry verifier | "valid until" the 8-byte deadline as a date; any other data or scope makes the transaction invalid |
| the sender | the scope the frame's flags allow, then, from the account descriptor's `verify` rules, what it approves for this entry (part 3). Under default code: entry 0 for a scope with `EXECUTION`, entry 1 otherwise, a secp256k1 signature over the canonical hash |
| another address, scope `PAYMENT` | the payer |
| another address, no scope | a check that can only invalidate the transaction |
| in typed data, a pay frame | a payer, its target, limits and data not signed |

**Payment.** The payer is the first `VERIFY` frame that may approve `PAYMENT`. The maximum cost is
`max_gas * max_fee_per_gas + blob_gas * max_fee_per_blob_gas`, the bound over any blob base fee.
Under $E$ both are shown as not signed, with the current values beside.

**Calls**, the `SENDER` and `DEFAULT` frames, in order. ERC-7730's EVM transaction container
values are set per frame:

| Value | `SENDER` frame | `DEFAULT` frame |
|---|---|---|
| `@.from` | the sender | the entry point, `0xaa` |
| `@.to` | the frame's resolved target | the same |
| `@.value` | the frame's value | 0 (EIP-8141 allows value only in `SENDER` frames) |
| `@.chainId` | the transaction's | the same |

A call is shown by the first of: a deployer descriptor that binds the target; the account
descriptor, when the target is the sender and the frame is `SENDER`; the target's ERC-7730 file;
"send the value", when the data is empty. Otherwise the data is shown raw, as ERC-7730's fallback
says, and the frame is a blind gap.

**Grouping.** Calls before the end of the validation prefix, the shortest prefix that sets the
payer, are marked as running before payment. After it, each maximal run of frames joined by
`ATOMIC_BATCH_FLAG` is shown as "all succeed or all revert", and two or more calls outside any
batch as independent.

**Blobs** are listed by versioned hash. Their contents are not in the transaction: a gap, not
blind, since the frames see only the hashes.

**The intent** is the calls' intents joined with " and ", as ERC-7730 joins an EIP-5792 batch.

## 2. ERC-7730 files

As they stand, under schema 2.1.0: `context.contract.deployments` binds a file to a contract,
`display.formats` is keyed by ABI fragment, and the formats are ERC-7730's. Nothing in a file
says whether its call arrives in a frame transaction. The container values above are the whole
adaptation.

## 3. Account descriptors

One per account implementation, in the shape of an ERC-7730 file:

```json
{
  "$schema": "../../format.md#account-descriptors",
  "context": {
    "$id": "SessionAccount",
    "account": { "creationCode": "0x...", "args": "(address owner)" }
  },
  "metadata": { "owner": "...", "contractName": "SessionAccount", "enums": { } },
  "verify": [ { "entry": 0, "signer": "owner", "msg": "sigHash", "approves": "allowed", "intent": "..." } ],
  "display": { "formats": { "0x02 (address key)": { "intent": "Revoke a session", "fields": [ ] } } }
}
```

**`context.account`** binds by code, not address, since every user's account has its own
address. `creationCode` is what a deploy frame's initcode starts with; `runtimeCode` is what the
deployed code starts with, for a host that can read it. Either is followed by `args`, ABI-encoded:
for the experiments' accounts, the owner as one word. EIP-8141 recognises its canonical paymaster
the same way, by exact runtime code.

**`verify`** lists the ways the account's `VERIFY` frame approves:

| Key | Values |
|---|---|
| `entry` | the signature entry the frame reads |
| `signer` | `owner`, the `owner` argument; or `other`, any other signer |
| `msg` | `sigHash`, an empty `msg`; or `FrameExecution`, $E$ |
| `approves` | `allowed`, whatever the frame's flags allow; or a list of scopes |
| `intent` | what to show |
| `requires` | optional: what else the frame checks in the transaction |
| `state` | optional: what it reads from storage, shown as a gap the account enforces |

A frame whose allowed scope a matching rule cannot approve is shown as a refusal. An entry that
some rule reads but none matches is shown as a refusal too.

**`display.formats`** shows the calls the account makes to itself. A key is an ABI fragment, as
in ERC-7730, or a packed fragment:

```
0x01 (address key,address target,uint32 selector,uint64 validUntil,uint128 budget)
```

That is the tag bytes, then each field at its natural width (20 bytes for an address, $N/8$ for
`uintN`, $N$ for `bytesN`), with nothing between them and nothing after. The values take
ERC-7730's field formats.

## 4. Deployer descriptors

```json
{
  "context": {
    "$id": "CREATE2 deployer",
    "deployer": {
      "deployments": [{ "chainId": 8141, "address": "0x4e59b44847b379578588920cA78FbF26c0B4956C" }],
      "calldata": "salt (bytes32) || initcode",
      "address": "create2"
    }
  }
}
```

Only that layout is defined. The device computes the new address itself, from the deployer, the
salt and `keccak256(initcode)`, and matches the initcode against the account descriptors.

## 5. Gaps

Every review ends with what it could not show:

| Kind | Meaning | Blind |
|---|---|---|
| `noDescriptor` | a call's target or function has no descriptor; its data is shown raw | yes; for a deploy, only if it deploys the sender |
| `opaque` | the signed `msg` is not one the device can derive | yes |
| `account` | the sender is unbound and the signature is not over the canonical hash | yes |
| `hashOnly` | only a hash is given: the nonce keys in typed data | no |
| `notInTransaction` | committed to but not carried: blob contents | no |
| `state` | in account storage: a session's limits | no, the account enforces it |
| `refusal` | the account descriptor says the account will refuse | no |

"Blind" means the signer cannot tell, from the review, what their signature allows.
