// Experiment 27's vectors: transactions whose execution digest every implementation must agree on,
// and, for the in-process ethrex run, signed copies that the account must accept or refuse.
//
// Run: npx tsx experiments/27-execution-digest/vectors.ts
// Writes vectors.json (name, raw signed transaction, domain separator, struct hash, E) and
// ethrex/cases.txt (the account, the sponsors, and every signed case with the verdict expected).
//
// The keys are derived from public labels: these are test vectors, not accounts.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { type Address, type Hex, concatHex, keccak256, numberToHex, parseSignature, stringToHex, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { EVM_VERSION, REPO_ROOT } from '../../src/contracts.js'
import {
  Approve,
  EXPIRY_VERIFIER,
  STORAGE_SET_STATE_GAS,
  type Frame,
  type FrameTx,
  defaultFrame,
  expiryFrame,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  signAll,
  verifyFrame,
} from '../../src/frametx/index.js'
import { domainSeparator, executionDigest, executionTypedData, isPayFrame, structHash } from './digest.js'

const key = (label: string): Hex => keccak256(stringToHex(`exp-frames/27 ${label}`))
const at = (n: number): Address => numberToHex(0x2700n * 2n ** 144n + BigInt(n), { size: 20 })

export const OWNER_KEY = key('vector owner')
export const OWNER = privateKeyToAccount(OWNER_KEY).address
export const SPONSOR_KEYS = [key('vector sponsor 1'), key('vector sponsor 2')]
export const SPONSORS = SPONSOR_KEYS.map((k) => privateKeyToAccount(k).address)
/** The account under test, and a second one with the same owner. */
export const SENDER = at(1)
export const TWIN = at(2)
/** A third, whose legacy nonce is 7. */
export const SEVENTH = at(3)
const TOKEN = at(0x10)
const POOL = at(0x11)
const FACTORY = at(0x12)
const FRIEND = at(0x13)

const transfer = (to: Address, amount: bigint): Hex =>
  concatHex(['0xa9059cbb', numberToHex(BigInt(to), { size: 32 }), numberToHex(amount, { size: 32 })])

const onlyVerify = (target: Address | null = null) => verifyFrame({ scope: Approve.EXECUTION, target, execution: 30_000n })
const pay = (sponsor = 0) => verifyFrame({ scope: Approve.PAYMENT, target: SPONSORS[sponsor], execution: 10_000n })

function base(frames: Frame[], over: Partial<FrameTx> = {}): FrameTx {
  return {
    chainId: 8141n,
    nonceKeys: [0n],
    nonceSeq: 0n,
    sender: SENDER,
    frames,
    signatures: [secp256k1Placeholder(OWNER, '0x'), secp256k1Placeholder(SPONSORS[0])],
    fees: { maxPriorityFeePerGas: 1_000n, maxFeePerGas: 2_000_000_000n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
    ...over,
  }
}

const blob = (b: number): Hex => `0x01${toHex(b, { size: 1 }).slice(2).repeat(31)}`

export type Case = { name: string; note: string; tx: FrameTx }

export const CASES: Case[] = [
  {
    name: 'sponsored-transfer',
    note: 'only_verify | pay, then one token transfer: the shape the draft exists for',
    tx: base([onlyVerify(), pay(), senderFrame({ target: TOKEN, data: transfer(FRIEND, 10n ** 18n), execution: 60_000n, state: 97_920n })]),
  },
  {
    name: 'with-expiry',
    note: 'the expiry verifier frame first, which E pins like any other frame',
    tx: base([expiryFrame(1_900_000_000n), onlyVerify(), pay(), senderFrame({ target: TOKEN, data: transfer(FRIEND, 1n), execution: 60_000n })]),
  },
  {
    name: 'atomic-approve-swap',
    note: 'an approve batched with the swap that spends it',
    tx: base([
      onlyVerify(),
      pay(),
      senderFrame({ target: TOKEN, data: concatHex(['0x095ea7b3', numberToHex(BigInt(POOL), { size: 32 }), numberToHex(10n ** 19n, { size: 32 })]), execution: 50_000n, state: 97_920n, atomic: true }),
      senderFrame({ target: POOL, data: concatHex(['0x12345678', numberToHex(10n ** 19n, { size: 32 })]), execution: 120_000n }),
    ]),
  },
  {
    name: 'deploy-first',
    note: 'a deploy frame before the verification, pinned with the rest',
    tx: base([
      defaultFrame({ target: FACTORY, data: concatHex(['0xdeadbeef', numberToHex(1n, { size: 32 })]), execution: 70_000n, state: 200_000n }),
      onlyVerify(SENDER),
      pay(),
      senderFrame({ target: FRIEND, value: 1n, execution: 30_000n }),
    ]),
  },
  {
    name: 'keyed-nonces',
    note: 'two EIP-8250 nonce keys at sequence 0',
    // The first use of a keyed nonce charges the frame that approves payment (EIP-8250): the payer's frame.
    tx: base([onlyVerify(), { ...pay(), limits: { execution: 10_000n, state: 2n * STORAGE_SET_STATE_GAS } }, senderFrame({ target: FRIEND, value: 5n, execution: 30_000n })], {
      nonceKeys: [3n, 9n],
    }),
  },
  {
    name: 'legacy-nonce-7',
    note: 'nonce_keys [0] at sequence 7: also what a plain EIP-8141 envelope with nonce 7 digests to',
    tx: base([onlyVerify(), pay(), senderFrame({ target: FRIEND, value: 5n, execution: 30_000n })], { nonceSeq: 7n, sender: SEVENTH }),
  },
  {
    name: 'value-and-default',
    note: 'a value transfer and a DEFAULT frame after the sender frames',
    tx: base([
      onlyVerify(),
      pay(),
      senderFrame({ target: FRIEND, value: 10n ** 17n, execution: 30_000n }),
      defaultFrame({ target: POOL, data: '0x01', execution: 40_000n }),
    ]),
  },
  {
    name: 'blobs',
    note: 'two blob versioned hashes, which BLOBHASH exposes to every frame',
    tx: base([onlyVerify(), pay(), senderFrame({ target: POOL, data: '0xaabbccdd', execution: 80_000n })], {
      blobVersionedHashes: [blob(0x11), blob(0x22)],
      fees: { maxPriorityFeePerGas: 1_000n, maxFeePerGas: 2_000_000_000n, maxFeePerBlobGas: 1_000_000n },
    }),
  },
  {
    name: 'many-frames',
    note: 'twelve frames, data of 0, 1, 31, 32, 33 and 1,000 bytes',
    tx: base([
      onlyVerify(),
      pay(),
      ...[0, 1, 31, 32, 33, 1000, 0, 1, 31, 32].map((len, i) =>
        (i % 2 ? defaultFrame : senderFrame)({ target: at(0x20 + i), data: len ? `0x${'5a'.repeat(len)}` : '0x', execution: 20_000n + BigInt(i) }),
      ),
    ]),
  },
  {
    name: 'self-paying',
    note: 'self_verify: E is defined, but the draft forbids approving payment on it',
    tx: base([verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 30_000n }), senderFrame({ target: FRIEND, value: 1n, execution: 30_000n })], {
      signatures: [secp256k1Placeholder(OWNER, '0x')],
    }),
  },
]

/**
 * Sign as a wallet would: the owner through eth_signTypedData_v4 (viem's `signTypedData`), its
 * output turned into the frame entry's `yParity ‖ r ‖ s`; then the sponsor over the canonical
 * sig hash, which covers the owner's entry.
 */
export async function signCase(tx: FrameTx, sponsorKey: Hex = SPONSOR_KEYS[0], digest = executionDigest(tx)): Promise<FrameTx> {
  const sig = parseSignature(await privateKeyToAccount(OWNER_KEY).signTypedData(executionTypedData(tx)))
  const entry0 = {
    ...tx.signatures[0],
    msg: digest,
    signature: concatHex([toHex(sig.yParity ?? 0, { size: 1 }), numberToHex(BigInt(sig.r), { size: 32 }), numberToHex(BigInt(sig.s), { size: 32 })]),
  }
  const withOwner = { ...tx, signatures: [entry0, ...tx.signatures.slice(1)] }
  return withOwner.signatures.length > 1 ? signAll(withOwner, [sponsorKey]) : withOwner
}

/** Keep the owner's entry, change the transaction under it, let the sponsor re-sign. */
async function mutate(signed: FrameTx, change: (tx: FrameTx) => FrameTx, sponsorKey = SPONSOR_KEYS[0]): Promise<FrameTx> {
  const tx = change(signed)
  const entry0 = signed.signatures[0]
  const sponsor = privateKeyToAccount(sponsorKey).address
  const rest = tx.signatures.slice(1).map((s) => ({ ...s, signer: sponsor, signature: '0x' as Hex }))
  return signAll({ ...tx, signatures: [entry0, ...rest] }, [sponsorKey])
}

const withFrames = (frames: Frame[]) => (tx: FrameTx): FrameTx => ({ ...tx, frames })

export async function harnessCases(): Promise<{ name: string; expect: 'valid' | 'refused'; note: string; tx: FrameTx }[]> {
  const out: { name: string; expect: 'valid' | 'refused'; note: string; tx: FrameTx }[] = []
  const signed = new Map<string, FrameTx>()
  for (const c of CASES) {
    const tx = await signCase(c.tx)
    signed.set(c.name, tx)
    out.push({ name: c.name, expect: c.name === 'self-paying' ? 'refused' : 'valid', note: c.note, tx })
  }
  const st = signed.get('sponsored-transfer')!
  const [v, p, t] = st.frames
  const front = defaultFrame({ target: POOL, data: '0x0badf00d', execution: 90_000n })
  out.push(
    {
      name: 'payer-replaced',
      expect: 'valid',
      note: "sponsor 2 with its own pay frame (other limits, other data), 20 times the fees, the owner's entry byte for byte",
      tx: await mutate(
        st,
        (tx) => ({
          ...tx,
          frames: [v, { ...pay(1), limits: { execution: 25_000n, state: 0n }, data: '0x1234' }, t],
          fees: { maxPriorityFeePerGas: 20_000n, maxFeePerGas: 40_000_000_000n, maxFeePerBlobGas: 0n },
        }),
        SPONSOR_KEYS[1],
      ),
    },
    {
      name: 'target-written-out',
      expect: 'valid',
      note: "the only_verify frame's null target written out as the sender",
      tx: await mutate(st, withFrames([{ ...v, target: SENDER }, p, t])),
    },
    { name: 'inserted-default', expect: 'refused', note: 'a DEFAULT frame inserted before the transfer', tx: await mutate(st, withFrames([v, p, front, t])) },
    { name: 'appended-default', expect: 'refused', note: 'a DEFAULT frame appended', tx: await mutate(st, withFrames([v, p, t, front])) },
    {
      name: 'state-limit-lowered',
      expect: 'refused',
      note: "the transfer's state budget cut to zero, so a fresh balance slot would halt it",
      tx: await mutate(st, withFrames([v, p, { ...t, limits: { ...t.limits, state: 0n } }])),
    },
    {
      name: 'transfer-retargeted',
      expect: 'refused',
      note: 'the transfer sent to another token contract',
      tx: await mutate(st, withFrames([v, p, { ...t, target: POOL }])),
    },
    {
      name: 'payer-is-sender',
      expect: 'refused',
      note: 'the relay names the account itself in the pay frame: E is unchanged, so only the rule against paying on E stops it',
      tx: { ...st, frames: [v, { ...p, target: SENDER }, t], signatures: [st.signatures[0]] },
    },
    {
      name: 'other-account',
      expect: 'refused',
      note: 'the same owner signature presented by a second account with the same owner',
      tx: await mutate(st, (tx) => ({ ...tx, sender: TWIN })),
    },
  )
  const bl = signed.get('blobs')!
  out.push({
    name: 'blob-swapped',
    expect: 'refused',
    note: 'the second blob replaced by the relay',
    tx: await mutate(bl, (tx) => ({ ...tx, blobVersionedHashes: [tx.blobVersionedHashes[0], blob(0x33)] })),
  })
  return out
}

/** The account's runtime code, as its constructor would leave it: solc's runtime object, owner appended. */
export function accountRuntime(owner: Address): Hex {
  const file = 'experiments/27-execution-digest/ExecutionScopeAccount.yul'
  const solc = createRequire(import.meta.url)('solc') as { compile(input: string): string }
  const input = {
    language: 'Yul',
    sources: { [file]: { content: readFileSync(resolve(REPO_ROOT, file), 'utf8') } },
    settings: { evmVersion: EVM_VERSION, optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } },
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input)))
  const [contract] = Object.values(out.contracts[file]) as { evm: { deployedBytecode: { object: string } } }[]
  return concatHex([`0x${contract.evm.deployedBytecode.object}`, numberToHex(BigInt(owner), { size: 32 })])
}

async function main() {
  const vectors = CASES.map((c) => ({
    name: c.name,
    note: c.note,
    domainSeparator: domainSeparator(c.tx.chainId, c.tx.sender),
    structHash: structHash(c.tx),
    executionDigest: executionDigest(c.tx),
    payFrames: c.tx.frames.flatMap((f, i) => (isPayFrame(f) ? [i] : [])),
  }))
  const raws: Record<string, Hex> = {}
  for (const c of CASES) raws[c.name] = serializeFrameTx(await signCase(c.tx))
  writeFileSync(
    new URL('./vectors.json', import.meta.url),
    `${JSON.stringify(
      { owner: OWNER, sponsors: SPONSORS, cases: vectors.map((v) => ({ ...v, raw: raws[v.name] })) },
      null,
      2,
    )}\n`,
  )

  const lines = [
    '# exp-frames/27: generated by vectors.ts. account <address> <balance> <nonce> <code>; case <name> <expect> <raw> # note',
    `account ${SENDER} 0x${(10n ** 20n).toString(16)} 0 ${accountRuntime(OWNER)}`,
    `account ${TWIN} 0x${(10n ** 20n).toString(16)} 0 ${accountRuntime(OWNER)}`,
    `account ${SEVENTH} 0x${(10n ** 20n).toString(16)} 7 ${accountRuntime(OWNER)}`,
    ...SPONSORS.map((s) => `account ${s} 0x${(10n ** 21n).toString(16)} 0 0x`),
    // EIP-8141's expiry verifier: an ordinary contract, so a fresh genesis needs it.
    `account ${EXPIRY_VERIFIER} 0x0 1 0x60083614600a575f5ffd5b5f3560c01c4211601657005b5f5ffd`,
  ]
  for (const c of await harnessCases()) lines.push(`case ${c.name} ${c.expect} ${serializeFrameTx(c.tx)} # ${c.note}`)
  writeFileSync(new URL('./ethrex/cases.txt', import.meta.url), `${lines.join('\n')}\n`)
  console.log(`${vectors.length} vectors -> vectors.json; ${lines.length - 7} cases -> ethrex/cases.txt`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
