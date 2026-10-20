// Experiment 30, part 2: one withdrawal with no relayer, priced the way a wallet prices a
// transaction, from two pools.
//
//   baseline   experiment 06's keyed pool, pool pays: [8272, P VERIFY, W]. The note's fee must
//              cover the maximum cost; whatever the gas does not use stays in the pool.
//   refund     RefundPool, the same pool plus a last DEFAULT frame: [8272, P VERIFY, W, R]. R
//              hands the recipient back the fee less what the transaction can at most be charged.
//
// Both are priced alike: a 0.1 gwei tip and a 0.2 gwei max fee. The testnet's base fee is 7 wei,
// so the max fee is the room a wallet leaves for the base fee to double. Limits are set as
// experiment 28's wallet sets them: simulate with generous limits, then 1.25 x used + 5,000,
// never below the floors the pool enforces. The note's fee is the maximum cost of the same
// transaction with every calldata byte non-zero, so a fee fixed before the proof exists still
// covers the proof's bytes.
//
// usage: npx tsx experiments/30-relayer-free-withdrawal/refund.ts [--dry-run]
import { type Address, type Hex, concatHex, formatEther, keccak256, numberToHex, pad, toHex } from 'viem'
import { compileYul } from '../../src/contracts.js'
import { deployFrame, saltOf } from '../../src/deploy.js'
import { DRY_RUN, execute } from '../../src/execute.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, makeClient, maxCost, simulateFrameTx } from '../../src/frametx/index.js'
import { hasher, keyedPool, note, patchedVerifier, recipient, sendFrames } from '../06-privacy-pool/deployment.js'
import {
  DENOMINATION,
  type FramePoolInstance,
  PoolMode,
  depositFrame,
  hasCode,
  isSpent,
  poolLeaves,
  prove,
  recentRoots,
} from '../06-privacy-pool/pool.js'
import { REFUND_POOL_SALT, layoutTx, tighten, worstMaxCost } from './layout.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const FEE_REFUND_TOPIC = keccak256(toHex('FeeRefund(address,uint256,uint256)'))

// ---- RefundPool: experiment 06's hasher and patched verifier, 0.001 ETH notes ----
const salt = REFUND_POOL_SALT
const initcode = concatHex([compileYul('experiments/30-relayer-free-withdrawal/RefundPool.yul'), pad(patchedVerifier.address), pad(hasher.address), numberToHex(DENOMINATION, { size: 32 }), salt])
const deployed = deployFrame(initcode, saltOf('exp-frames/30/refund-pool/v1'))
// The shape experiment 06's withdrawal builder takes: mode 1 (keyed) is the layout's first three frames.
const refundPool = { ...keyedPool, label: 'refund-pool/v1', initcode, salt, address: deployed.address, deploy: deployed.frame } as FramePoolInstance
console.log(`baseline: experiment 06's keyed pool ${keyedPool.address}; RefundPool ${refundPool.address}`)

// ---- setup: deploy, then a note in each pool ----
if (!(await hasCode(client, refundPool.address))) await sendFrames(client, [refundPool.deploy], 'deploy RefundPool')
const LABELS = { baseline: ['30/baseline/0', '30/baseline/1', '30/baseline/2'], refund: ['30/refund/0', '30/refund/1', '30/refund/2'] }
for (const [pool, labels] of [[keyedPool, LABELS.baseline], [refundPool, LABELS.refund]] as const) {
  const leaves = await poolLeaves(client, pool.address)
  const missing = labels.filter((l) => !leaves.includes(note(l).commitment))
  if (missing.length) await sendFrames(client, missing.map((l) => depositFrame(pool.address, note(l).commitment)), `deposit ${missing.join(', ')}`)
}
if (DRY_RUN && !(await hasCode(client, refundPool.address))) process.exit(0)

// ---- the withdrawal ----
type Built = { tx: FrameTx; fee: bigint; to: Address }

function layout(pool: FramePoolInstance, withRefund: boolean, labelOf: string, leaves: Hex[], slot: bigint, fee: bigint, limits?: bigint[]): Built {
  const to = recipient(labelOf)
  const proof = prove(note(labelOf), leaves, to, pool.address, fee)
  return { tx: layoutTx({ chainId, pool, proof, slot, withRefund, limits }), fee, to }
}

async function build(pool: FramePoolInstance, withRefund: boolean, labelOf: string): Promise<Built> {
  const leaves = await poolLeaves(client, pool.address)
  const n = note(labelOf)
  const proofRoot = prove(n, leaves, recipient(labelOf), pool.address, 1n).inputs.root
  const rr = (await recentRoots(client, pool.address)).filter((r) => r.root === proofRoot).at(-1)
  if (!rr) throw new Error(`${pool.label}: the current root was never published to EIP-8272`)
  // 1. Generous limits, a fee that covers them, simulate.
  const draftShape = layout(pool, withRefund, labelOf, leaves, rr.slot, 1n)
  const draft = layout(pool, withRefund, labelOf, leaves, rr.slot, worstMaxCost(draftShape.tx))
  const sim = await simulateFrameTx(client, draft.tx)
  if (!sim.valid || !sim.frames) throw new Error(`${pool.label}: draft rejected: ${sim.violation}`)
  const used = sim.frames.map((f) => BigInt(f.gasUsed))
  // 2. Tighten as experiment 28's wallet does, keep the pool's floors, and prove the final fee.
  const limits = tighten(used, withRefund)
  const shape = layout(pool, withRefund, labelOf, leaves, rr.slot, 1n, limits)
  const fee = worstMaxCost(shape.tx)
  const final = layout(pool, withRefund, labelOf, leaves, rr.slot, fee, limits)
  console.log(`${pool.label}: draft execution used ${used.join(' / ')}; limits ${limits.join(' / ')}; fee ${fee} wei, max cost ${maxCost(final.tx)} wei`)
  return final
}

type Row = { label: string; hash: Hex; gasUsed: bigint; price: bigint; fee: bigint; charged: bigint; refund: bigint; chargedAtMost?: bigint; received: bigint; surplus: bigint; frames: string }
const rows: Row[] = []

for (const [label, pool, withRefund, labels] of [
  ['baseline: experiment 06 keyed pool', keyedPool, false, LABELS.baseline],
  ['RefundPool', refundPool, true, LABELS.refund],
] as const) {
  let labelOf: string | undefined
  for (const l of labels) if (!(await isSpent(client, pool, note(l).nullifierHash))) {
    labelOf = l
    break
  }
  if (!labelOf) {
    console.log(`${label}: every note spent; deposit more`)
    continue
  }
  const b = await build(pool, withRefund, labelOf)
  const poolBefore = await client.getBalance({ address: pool.address })
  const { hash, receipt } = await execute(client, b.tx, [], { label: `${label}: withdraw ${labelOf} to ${b.to}` })
  if (!receipt || !hash) continue
  const gasUsed = BigInt(receipt.gasUsed)
  const price = BigInt(receipt.effectiveGasPrice)
  const charged = gasUsed * price
  const poolAfter = await client.getBalance({ address: pool.address })
  const received = await client.getBalance({ address: b.to })
  let refund = 0n
  let chargedAtMost: bigint | undefined
  for (const fr of receipt.frameReceipts) {
    for (const lg of fr.logs) {
      if (lg.topics[0] === FEE_REFUND_TOPIC) {
        refund = BigInt(`0x${lg.data.slice(2, 66)}`)
        chargedAtMost = BigInt(`0x${lg.data.slice(66, 130)}`)
      }
    }
  }
  // What stays in the pool from this withdrawal: the fee, less the gas, less the refund.
  const surplus = poolAfter - (poolBefore - DENOMINATION)
  if (surplus !== b.fee - charged - refund) throw new Error(`${label}: pool balance moved by ${surplus}, expected ${b.fee - charged - refund}`)
  const frames = receipt.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f)}:${g.execution}${g.state ? `+${g.state}s` : ''}`
  })
  rows.push({ label, hash, gasUsed, price, fee: b.fee, charged, refund, chargedAtMost, received, surplus, frames: frames.join(' / ') })
}

const e = (w: bigint) => formatEther(w)
console.log('\n| Pool | Tx | `gasUsed` | Frames | Fee in the note | Gas charged | Refunded | Recipient got | Left in the pool |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  console.log(`| ${r.label} | [\`${r.hash.slice(0, 10)}...\`](https://dora.privacy.ethrex.xyz/tx/${r.hash}) | ${r.gasUsed} | ${r.frames} | ${e(r.fee)} | ${e(r.charged)} | ${e(r.refund)} | ${e(r.received)} | ${e(r.surplus)} |`)
  if (r.chargedAtMost !== undefined) console.log(`  RefundPool's bound on the charge: ${r.chargedAtMost} wei; actual ${r.charged}; difference ${r.chargedAtMost - r.charged} wei = ${(r.chargedAtMost - r.charged) / r.price} gas`)
  console.log(`  fee / gas charged: ${(Number(r.fee) / Number(r.charged)).toFixed(2)}; paid by the note net of refund / gas charged: ${(Number(r.fee - r.refund) / Number(r.charged)).toFixed(3)}`)
}
process.exit(0)
