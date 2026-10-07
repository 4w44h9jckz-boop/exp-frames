// Experiment 10, the mempool half: does the pool drop a transaction whose deadline passes while it
// waits? EIP-8141: "A node MUST drop a frame transaction from the public mempool if it contains an
// expiry_verify frame whose deadline is less than the node's view of the current block timestamp
// at any point."
//
// A transaction has to wait in the pool for that to be observable. Two ways to make it wait:
//   1. underpriced (maxFeePerGas below the base fee);
//   2. a nonce gap (nonce_seq one ahead of the account's nonce).
// Each is tried with a deadline 20 s out (`late`) and without one (`control`). Then the control's
// gap is filled to see whether its queued transaction is promoted and mined.
//
// usage: npx tsx experiments/10-expiry/pool.ts
import { execute } from '../../src/execute.js'
import { expiryFrame, getNonceSeq, prepareFrameTx, secp256k1Placeholder, signAll } from '../../src/frametx/index.js'
import { client, follow, fundedAccount, funder, headTimestamp, probe, selfVerify, tip, whereIs } from './common.js'

const late = await fundedAccount('late')
const control = await fundedAccount('control')

const build = async (key: `0x${string}`, sender: `0x${string}`, opts: { deadline?: bigint; gap?: boolean; underpriced?: boolean }) => {
  const base = (await client.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? 0n
  const seq = await getNonceSeq(client, sender)
  const tx = await prepareFrameTx(client, {
    sender,
    frames: [...(opts.deadline === undefined ? [] : [expiryFrame(opts.deadline)]), selfVerify, tip(funder)],
    signatures: [secp256k1Placeholder()],
    nonceSeq: opts.gap ? seq + 1n : seq,
    fees: opts.underpriced ? { maxPriorityFeePerGas: 1n, maxFeePerGas: base - 1n, maxFeePerBlobGas: 0n } : undefined,
  })
  return signAll(tx, [key])
}

console.log('\n=== 1. underpriced: maxFeePerGas = base fee - 1 ===')
await probe('late: deadline = head + 20 s', await build(late.key, late.address, { deadline: (await headTimestamp()) + 20n, underpriced: true }))
await probe('control: no deadline', await build(control.key, control.address, { underpriced: true }))

console.log('\n=== 2. nonce gap: nonce_seq = account nonce + 1 ===')
const deadline = (await headTimestamp()) + 20n
const lateGap = await probe(`late: deadline = head + 20 s (${deadline})`, await build(late.key, late.address, { deadline, gap: true }))
const controlGap = await probe('control: no deadline', await build(control.key, control.address, { gap: true }))
if (lateGap.hash) console.log(`    late -> ${await follow(lateGap.hash, 45_000, deadline)}`)
if (controlGap.hash) {
  console.log(`    control after the same wait: ${await whereIs(controlGap.hash)}`)
  const fill = await prepareFrameTx(client, { sender: control.address, frames: [selfVerify, tip(funder)], signatures: [secp256k1Placeholder()] })
  await execute(client, fill, [control.key], { label: 'control: fill the gap' })
  console.log(`    control's queued transaction -> ${await follow(controlGap.hash, 30_000)}`)
}
