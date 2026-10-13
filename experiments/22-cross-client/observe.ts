// Experiment 22, part A: what four clients agree on, read from blocks they built.
//
// frames-devnet-0 runs geth, Nethermind, reth and ethrex behind one balancer, and pins each request
// to one of them on request (RPC_UPSTREAM / makeClient's `upstream`). Every block one of them
// builds, the other three re-execute and accept, so the canonical chain is already a cross-client
// test of every frame transaction in it. This script reads it back:
//
// 1. Heads: the same block hash, state root and receipts root at the same height from all four.
// 2. Conformance: every frame transaction in the last N blocks, read from a rotating client,
//    re-encoded with this library's plain envelope to its hash, every secp256k1 entry recovered
//    over this library's sig hash, and its receipt's gasUsed settled from frame receipts with
//    this library's gas model. Tallied by the client that built the block.
// 3. JSON: one transaction of each shape, and its receipt, as each client serves them.
//
// usage: npx tsx experiments/22-cross-client/observe.ts [blocks]
import { p256 } from '@noble/curves/p256'
import { type Hex, hexToBigInt, hexToBytes, isAddressEqual, keccak256, recoverAddress, serializeSignature } from 'viem'
import {
  FRAMES_DEVNET_0_RPC_URL,
  type FrameReceiptJson,
  type FrameTx,
  type FrameTxJson,
  Scheme,
  frameReceiptGas,
  frameSigHash,
  frameTxFromJson,
  frameTxHash,
  makeClient,
  rpc,
  settledGasUsed,
} from '../../src/frametx/index.js'

export const CLIENTS = ['geth', 'nethermind', 'reth', 'ethrex'] as const
export type ClientName = (typeof CLIENTS)[number]
export const clientOf = (name: ClientName) => makeClient(FRAMES_DEVNET_0_RPC_URL, name)

/** The block builder's client, from `extraData`. */
export function builderOf(extraData: Hex): string {
  const text = Buffer.from(extraData.slice(2), 'hex').toString('latin1').toLowerCase()
  return CLIENTS.find((c) => text.includes(c)) ?? `other(${text.replace(/[^\x20-\x7e]/g, '')})`
}

async function recoverSecp256k1(digest: Hex, sig: Hex) {
  const yParity = Number.parseInt(sig.slice(2, 4), 16)
  return recoverAddress({
    hash: digest,
    signature: serializeSignature({ yParity, r: `0x${sig.slice(4, 68)}`, s: `0x${sig.slice(68, 132)}` }),
  })
}

function p256Verifies(digest: Hex, sig: Hex, signer: Hex): boolean {
  const b = hexToBytes(sig)
  const qxqy = b.slice(64)
  if (!isAddressEqual(`0x${keccak256(qxqy).slice(26)}`, signer)) return false
  return p256.verify(b.slice(0, 64), hexToBytes(digest), new Uint8Array([4, ...qxqy]), { prehash: false, lowS: true })
}

export type Check = { hash: boolean; signatures: boolean; gas: boolean }

/** This library's view of a mined frame transaction against what the chain says about it. */
export async function check(json: FrameTxJson, receipt: { gasUsed: Hex; frameReceipts: FrameReceiptJson[] }): Promise<Check & { tx: FrameTx }> {
  const tx = frameTxFromJson(json)
  const sigHash = frameSigHash(tx)
  let signatures = true
  for (const s of tx.signatures) {
    const digest = s.msg === '0x' ? sigHash : s.msg
    const signer = s.signer ?? tx.sender
    if (s.scheme === Scheme.SECP256K1) signatures &&= isAddressEqual(await recoverSecp256k1(digest, s.signature), signer)
    if (s.scheme === Scheme.P256) signatures &&= p256Verifies(digest, s.signature, signer)
  }
  const gas = settledGasUsed(tx, receipt.frameReceipts.map(frameReceiptGas)) === hexToBigInt(receipt.gasUsed)
  return { tx, hash: frameTxHash(tx) === json.hash, signatures, gas }
}

/** A short shape key: modes, flags and targets of the frames, schemes of the entries. */
export function shapeOf(tx: FrameTx): string {
  const frames = tx.frames.map((f) => {
    const mode = ['DEFAULT', 'VERIFY', 'SENDER'][f.mode] ?? `mode${f.mode}`
    const flags = f.flags ? `/${f.flags}` : ''
    const expiry = f.target?.toLowerCase() === '0x0000000000000000000000000000000000008141' ? '@expiry' : ''
    const value = f.value ? '+value' : ''
    return `${mode}${flags}${expiry}${value}`
  })
  const sigs = tx.signatures.map((s) => ['ARBITRARY', 'SECP256K1', 'P256'][s.scheme] ?? `scheme${s.scheme}`)
  return `${frames.join(' ')} [${sigs.join(',')}]`
}

const flatKeys = (o: unknown, p = ''): string[] =>
  o === null || typeof o !== 'object' || Array.isArray(o)
    ? [p]
    : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => flatKeys(Array.isArray(v) ? (v[0] ?? null) : v, p ? `${p}.${k}` : k))

async function main() {
  const blocks = Number(process.argv[2] ?? 200)
  const clients = Object.fromEntries(CLIENTS.map((c) => [c, clientOf(c)])) as Record<ClientName, ReturnType<typeof clientOf>>
  // One client at a time throughout: the balancer merges identical requests in flight together.
  const each = async <T>(f: (c: ClientName) => Promise<T>) => {
    const out: T[] = []
    for (const c of CLIENTS) out.push(await f(c))
    return out
  }
  const versions = await each((c) => rpc<string>(clients[c], 'web3_clientVersion', []))
  console.log('## Clients\n')
  for (const [i, c] of CLIENTS.entries()) console.log(`- ${c}: \`${versions[i]}\``)

  // 1. Heads.
  const heads = await each(async (c) => Number(await rpc<Hex>(clients[c], 'eth_blockNumber', [])))
  const height = Math.min(...heads) - 2
  console.log(`\n## Heads\n\nHeads ${CLIENTS.map((c, i) => `${c} ${heads[i]}`).join(', ')}.`)
  let agree = 0
  const sampled = 50
  for (let n = height - sampled + 1; n <= height; n++) {
    const views = await each((c) => rpc<{ hash: Hex; stateRoot: Hex; receiptsRoot: Hex }>(clients[c], 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false]))
    const keys = views.map((b) => `${b.hash}${b.stateRoot}${b.receiptsRoot}`)
    if (keys.every((k) => k === keys[0])) agree++
    else console.log(`  block ${n}: ${CLIENTS.map((c, i) => `${c} ${views[i].hash.slice(0, 10)}`).join(' ')}`)
  }
  console.log(`Blocks ${height - sampled + 1}-${height}: hash, state root and receipts root equal from all four clients at ${agree} of ${sampled} heights.`)

  // 2. Conformance, by block builder.
  type Tally = { blocks: number; txs: number; hash: number; signatures: number; gas: number }
  const tally: Record<string, Tally> = {}
  const shapes = new Map<string, { hash: Hex; block: number; builder: string; n: number }>()
  const failures: string[] = []
  for (let n = height - blocks + 1; n <= height; n++) {
    const reader = CLIENTS[n % CLIENTS.length]
    const tag = `0x${n.toString(16)}`
    const [block, receipts] = await Promise.all([
      rpc<{ extraData: Hex; transactions: FrameTxJson[] }>(clients[reader], 'eth_getBlockByNumber', [tag, true]),
      rpc<{ transactionHash: Hex; gasUsed: Hex; frameReceipts: FrameReceiptJson[] }[]>(clients[reader], 'eth_getBlockReceipts', [tag]),
    ])
    const builder = builderOf(block.extraData)
    tally[builder] ??= { blocks: 0, txs: 0, hash: 0, signatures: 0, gas: 0 }
    const t = tally[builder]
    t.blocks++
    const byHash = new Map(receipts.map((r) => [r.transactionHash, r]))
    for (const json of block.transactions) {
      if (json.type !== '0x6') continue
      const receipt = byHash.get(json.hash)
      if (!receipt) throw new Error(`${json.hash}: no receipt from ${reader}`)
      const c = await check(json, receipt)
      t.txs++
      t.hash += Number(c.hash)
      t.signatures += Number(c.signatures)
      t.gas += Number(c.gas)
      if (!(c.hash && c.signatures && c.gas)) failures.push(`${json.hash} (block ${n}, built by ${builder}, read from ${reader}): ${JSON.stringify(c, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 200)}`)
      const shape = shapeOf(c.tx)
      const s = shapes.get(shape)
      if (s) s.n++
      else shapes.set(shape, { hash: json.hash, block: n, builder, n: 1 })
    }
  }
  console.log(`\n## Conformance over blocks ${height - blocks + 1}-${height}\n`)
  console.log('| Built by | Blocks | Frame txs | Re-encode to hash | Signatures recover | `gasUsed` settles |\n|---|---|---|---|---|---|')
  for (const [b, t] of Object.entries(tally).sort()) console.log(`| ${b} | ${t.blocks} | ${t.txs} | ${t.hash} | ${t.signatures} | ${t.gas} |`)
  for (const f of failures.slice(0, 20)) console.log(`- mismatch: ${f}`)
  console.log('\n| Shape | Count | Example |\n|---|---|---|')
  for (const [shape, s] of [...shapes.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`| \`${shape}\` | ${s.n} | \`${s.hash.slice(0, 10)}…\` (block ${s.block}, ${s.builder}) |`)

  // 3. JSON, per client.
  console.log('\n## JSON per client\n')
  const example = [...shapes.values()].sort((a, b) => b.n - a.n)
  const fields: Record<string, Record<ClientName, Set<string>>> = {}
  for (const { hash, block } of example) {
    for (const c of CLIENTS) {
      const [tx, receipt, inBlock] = await Promise.all([
        rpc<object>(clients[c], 'eth_getTransactionByHash', [hash]),
        rpc<object>(clients[c], 'eth_getTransactionReceipt', [hash]),
        rpc<{ transactions: { hash: Hex }[] }>(clients[c], 'eth_getBlockByNumber', [`0x${block.toString(16)}`, true]).then((b) => b.transactions.find((t) => t.hash === hash) ?? {}),
      ])
      for (const [part, obj] of [['transaction', tx], ['receipt', receipt], ['transaction in block', inBlock]] as const) {
        fields[part] ??= Object.fromEntries(CLIENTS.map((x) => [x, new Set<string>()])) as Record<ClientName, Set<string>>
        for (const k of flatKeys(obj)) fields[part][c].add(k)
      }
    }
  }
  for (const [part, byClient] of Object.entries(fields)) {
    const all = [...new Set(CLIENTS.flatMap((c) => [...byClient[c]]))].sort()
    const differing = all.filter((k) => !CLIENTS.every((c) => byClient[c].has(k)))
    console.log(`\n### ${part}: ${all.length} fields, ${differing.length} not served by all four\n`)
    console.log(`| Field | ${CLIENTS.join(' | ')} |\n|---|${CLIENTS.map(() => '---').join('|')}|`)
    for (const k of differing) console.log(`| \`${k}\` | ${CLIENTS.map((c) => (byClient[c].has(k) ? '✓' : '')).join(' | ')} |`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
