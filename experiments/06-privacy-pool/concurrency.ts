// Can two withdrawals from the same pool wait in the public mempool at the same time?
//
// Every withdrawal has the same tx.sender, the pool, and EIP-8141's public mempool admits one
// pending frame transaction per sender. ethrex relaxes that for EIP-8250 keyed transactions whose
// validation prefix provably cannot be invalidated by the sender's other transactions: the
// prefix reads no sender storage and the keys are disjoint (keyed_concurrency_verdict).
//
//   1. keyed pool, pool pays, two notes:    expected both admitted.
//   2. keyed pool, sponsor pays, two notes: the sponsor is a non-canonical paymaster, which may
//      have one pending transaction.
//   3. storage pool, pool pays, two notes, both built on the pool's current nonce: expected the
//      second refused.
//   4. as 3, but B built on the next nonce.
//   5. as 3, but B pays double the fees: a replacement, which evicts A, someone else's
//      withdrawal.
//   6. keyed pool, the same note twice, to two recipients: one nonce key, so B can only
//      replace A, never join it.
//
// Each pair is built and proven first, then sent back to back. A refused or evicted transaction
// is rebuilt and sent again once the other is mined, so no note is left behind.
//
// usage: npx tsx experiments/06-privacy-pool/concurrency.ts
import type { Address, Hex } from 'viem'
import {
  type FrameTx,
  type FrameTxFees,
  frameTxHash,
  getFrameTxJson,
  makeClient,
  rpc,
  serializeFrameTx,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { keyedPool, keyedSponsor, note, recipient, storagePool } from './deployment.js'
import { type FramePoolInstance, POOL_FEES, PoolMode, isSpent, poolLeaves, prove, recentRoots, withdrawalTx } from './pool.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())

type BuildOpts = { sponsor?: Address; nonceOffset?: bigint; fees?: FrameTxFees; to?: string }

async function build(pool: FramePoolInstance, noteLabel: string, { sponsor, nonceOffset = 0n, fees, to }: BuildOpts = {}): Promise<FrameTx | null> {
  const n = note(noteLabel)
  if (await isSpent(client, pool, n.nullifierHash)) return null
  const leaves = await poolLeaves(client, pool.address)
  const proof = prove(n, leaves, recipient(to ?? noteLabel), sponsor ?? pool.address)
  const slot =
    pool.mode === PoolMode.KEYED ? (await recentRoots(client, pool.address)).filter((r) => r.root === proof.inputs.root).at(-1)?.slot : undefined
  const nonce = BigInt(await client.getTransactionCount({ address: pool.address })) + nonceOffset
  const tx = withdrawalTx({ chainId, pool, proof, sponsor, slot, nonce, fees })
  if (nonceOffset === 0n) {
    const sim = await simulateFrameTx(client, tx)
    if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${noteLabel}: simulation ${sim.violation ?? sim.executionError}`)
  }
  return tx
}

async function send(tx: FrameTx): Promise<{ hash?: Hex; error?: string }> {
  try {
    return { hash: await rpc<Hex>(client, 'eth_sendRawTransaction', [serializeFrameTx(tx)]) }
  } catch (e) {
    const err = e as { details?: string; shortMessage?: string; message: string }
    return { error: err.details ?? err.shortMessage ?? err.message.split('\n')[0] }
  }
}

async function pair(label: string, pool: FramePoolInstance, labels: [string, string], opts: { sponsor?: Address; b?: BuildOpts } = {}) {
  console.log(`\n### ${label}`)
  const txs = await Promise.all([build(pool, labels[0], { sponsor: opts.sponsor }), build(pool, labels[1], { sponsor: opts.sponsor, ...opts.b })])
  if (txs.some((t) => t === null)) {
    console.log('already done (a note is spent)')
    return
  }
  const [a, b] = txs as [FrameTx, FrameTx]
  const t0 = Date.now()
  const ra = await send(a)
  const rb = await send(b)
  console.log(`A ${labels[0]}: ${ra.hash ?? `refused: ${ra.error}`}`)
  console.log(`B ${labels[1]}: ${rb.hash ?? `refused: ${rb.error}`}  (${Date.now() - t0} ms after A)`)
  const status = async (h?: Hex) => {
    if (!h) return 'not admitted'
    const j = await getFrameTxJson(client, h)
    return j ? (j.blockNumber ? `in block ${BigInt(j.blockNumber)}` : 'pending') : 'gone from the pool'
  }
  const after = [await status(ra.hash), await status(rb.hash)]
  console.log(`right after sending: A ${after[0]}, B ${after[1]}`)

  const left: number[] = []
  const mined: string[] = []
  for (const [i, r] of [ra, rb].entries()) {
    if (!r.hash || after[i] === 'gone from the pool') {
      left.push(i)
      continue
    }
    const receipt = await waitForFrameTxReceipt(client, r.hash)
    mined.push(`${'AB'[i]} in block ${BigInt(receipt.blockNumber)} (index ${BigInt(receipt.transactionIndex)}, status ${receipt.status})`)
  }
  console.log(mined.join('; '))

  // Rebuild what was refused or evicted on the state the other left behind, and send it alone.
  for (const i of left) {
    const again = await build(pool, labels[i], { sponsor: opts.sponsor })
    if (!again) continue
    const r = await send(again)
    if (!r.hash) throw new Error(`${'AB'[i]} refused again: ${r.error}`)
    const receipt = await waitForFrameTxReceipt(client, r.hash)
    console.log(`${'AB'[i]} resent alone: ${frameTxHash(again)} in block ${BigInt(receipt.blockNumber)}`)
  }
}

await pair('keyed pool, pool pays', keyedPool, ['keyed/2', 'keyed/3'])
await pair('keyed pool, sponsor pays', keyedPool, ['keyed/4', 'keyed/5'], { sponsor: keyedSponsor.address })
await pair('storage pool, pool pays, same nonce', storagePool, ['storage/2', 'storage/3'])
await pair('storage pool, pool pays, B on the next nonce', storagePool, ['storage/4', 'storage/5'], { b: { nonceOffset: 1n } })
const double = { maxPriorityFeePerGas: POOL_FEES.maxPriorityFeePerGas * 2n, maxFeePerGas: POOL_FEES.maxFeePerGas * 2n, maxFeePerBlobGas: 0n }
await pair('storage pool, pool pays, same nonce, B pays double', storagePool, ['storage/6', 'storage/7'], { b: { fees: double } })
await pair('keyed pool, the same note twice, to two recipients', keyedPool, ['keyed/late', 'keyed/late'], { b: { to: 'keyed/late/other' } })
