// Experiment 09: a pending transaction replaced by a sponsored one. EIP-8141 §Replacement and
// Eviction: pending frame transactions are identified by (sender, nonce); a replacement must raise
// both max_fee_per_gas and max_priority_fee_per_gas by the node's minimum increment (10%), and
// "may name a different payer than the transaction it replaces".
//
// One slot (6 s), back to back:
//   1. the user pays for itself;
//   2. same nonce, +5% fees, sponsored by the canonical paymaster: too small a bump;
//   3. same nonce, +10% fees, sponsored: replaces 1.
// Then which of them was mined, and who paid.
//
// usage: npx tsx experiments/09-paymasters/replace.ts
import { type Hex, parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import {
  Approve,
  type FrameTxFees,
  NEW_ACCOUNT_STATE_GAS,
  getNonceSeq,
  prepareFrameTx,
  rpc,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  signAll,
  verifyFrame,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { client, derive, paymaster, ping, privateKey, sponsor, sponsored } from './paymaster.js'

const main = paymaster('canonical', 'main/v1')
const user = derive('switcher')
if ((await client.getBalance({ address: user.address })) < parseEther('0.0005')) {
  const exists = (await client.getTransactionCount({ address: user.address })) > 0
  await sendFrames(client, privateKey, [senderFrame({ target: user.address, value: parseEther('0.001'), execution: 30_000n, state: exists ? 0n : NEW_ACCOUNT_STATE_GAS })], { label: 'setup: fund the user' })
}

const base = (await client.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? 0n
const fees = (tip: bigint): FrameTxFees => ({ maxPriorityFeePerGas: tip, maxFeePerGas: 2n * base + tip + 1_000n, maxFeePerBlobGas: 0n })
// Rounded up: a bump that rounds down falls just short of the percentage (2014 * 1.1 = 2215.4).
const up = (x: bigint, pct: bigint) => (x * (100n + pct) + 99n) / 100n
const bump = (f: FrameTxFees, pct: bigint): FrameTxFees => ({ maxPriorityFeePerGas: up(f.maxPriorityFeePerGas, pct), maxFeePerGas: up(f.maxFeePerGas, pct), maxFeePerBlobGas: 0n })
const nonceSeq = await getNonceSeq(client, user.address)
const f1 = fees(1_000n)

const selfPaid = await signAll(
  await prepareFrameTx(client, { sender: user.address, frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), ping], signatures: [secp256k1Placeholder()], fees: f1, nonceSeq }),
  [user.key],
)
const small = await sponsored(user, main.address, [sponsor.key], { fees: bump(f1, 5n), nonceSeq })
const enough = await sponsored(user, main.address, [sponsor.key], { fees: bump(f1, 10n), nonceSeq })

const send = (label: string, raw: Hex) =>
  rpc<Hex>(client, 'eth_sendRawTransaction', [raw]).then(
    (hash) => (console.log(`${label}: accepted ${hash}`), hash),
    (e: Error) => (console.log(`${label}: rejected: ${e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9)}`), null),
  )

console.log(`nonce ${nonceSeq}; fees tip/max: self ${f1.maxPriorityFeePerGas}/${f1.maxFeePerGas}, +5% ${small.fees.maxPriorityFeePerGas}/${small.fees.maxFeePerGas}, +10% ${enough.fees.maxPriorityFeePerGas}/${enough.fees.maxFeePerGas}`)
const h1 = await send('1. self-paid', serializeFrameTx(selfPaid))
const h2 = await send('2. sponsored, +5%', serializeFrameTx(small))
const h3 = await send('3. sponsored, +10%', serializeFrameTx(enough))

for (const [label, h] of [['1', h1], ['2', h2], ['3', h3]] as const) {
  if (!h) continue
  try {
    const r = await waitForFrameTxReceipt(client, h, { timeoutMs: 30_000 })
    console.log(`${label}: mined in block ${BigInt(r.blockNumber)}, payer ${r.payer}, gasUsed ${BigInt(r.gasUsed)}`)
  } catch {
    console.log(`${label}: no receipt`)
  }
}
