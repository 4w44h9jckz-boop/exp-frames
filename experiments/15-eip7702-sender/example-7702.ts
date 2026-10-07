// Experiment 15: an EIP-7702-delegated EOA as the sender of frame transactions. Dana is a plain
// EOA. She pays with the default code, delegates to PasskeyDelegate (a type-4 transaction the
// funder sends), registers a device P256 key, pays with it, and finally clears the delegation.
//
// | Frame | Mode   | Target        | Signatures                                                        |
// | 0     | VERIFY | Null (sender) | SECP256K1 by dana, or (delegated, key registered) P256 by device  |
// | 1     | SENDER | funder        |                                                                   |
//
// usage: npx tsx experiments/15-eip7702-sender/example-7702.ts [--dry-run]
import { type Hex, concatHex, formatEther, keccak256, numberToHex, parseEther, toHex } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { DRY_RUN } from '../../src/execute.js'
import {
  type FrameTx,
  NEW_ACCOUNT_STATE_GAS,
  describeReceipt,
  describeSimulation,
  describeTx,
  type FrameTxReceiptJson,
  rpc,
  type P256Key,
  p256Address,
  p256Placeholder,
  secp256k1Placeholder,
  sendFrameTx,
  senderFrame,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { p256 } from '@noble/curves/p256'
import { clearDelegation, client, codeOf, delegate, derive, eoaTx, funder, privateKey, registerPasskey, setDelegation } from './delegated.js'

const dana = derive('dana')
const device: P256Key = { scheme: 'p256', privateKey: numberToHex((BigInt(keccak256(concatHex([privateKey, toHex('exp-frames/15/device')]))) % (p256.CURVE.n - 1n)) + 1n, { size: 32 }) }
console.log(`dana ${dana.address}; device key ${p256Address(device)}; PasskeyDelegate ${delegate.address}`)

/**
 * Simulate, send, and follow the transaction: poll the pool and the receipt every 2 s. If it
 * leaves the pool without a receipt, say so and send it once more, re-signed at the same nonce.
 */
async function send(label: string, tx: FrameTx, rebuild?: () => Promise<FrameTx>): Promise<Hex | undefined> {
  console.log(`\n=== ${label} ===`)
  console.log(describeTx(tx))
  const sim = await simulateFrameTx(client, tx)
  console.log(describeSimulation(sim))
  if (DRY_RUN || !sim.valid) return undefined
  let hash: Hex
  try {
    hash = await sendFrameTx(client, tx)
  } catch (e) {
    const m = (e as Error).message.split('\n')
    console.log(`refused: ${m.find((l) => l.startsWith('Details:')) ?? m[0]}`)
    return undefined
  }
  const sentAt = await client.getBlockNumber()
  console.log(`sent ${hash} at head ${sentAt}`)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const [receipt, pool] = await Promise.all([rpc<FrameTxReceiptJson | null>(client, 'eth_getTransactionReceipt', [hash]), rpc<{ pending: Hex }>(client, 'txpool_status', [])])
    if (receipt) {
      console.log(describeReceipt(tx, receipt))
      return hash
    }
    if (BigInt(pool.pending) === 0n) {
      console.log(`DROPPED: not in the pool and no receipt, ${i * 2 + 2} s after sending (head ${await client.getBlockNumber()})`)
      if (!rebuild) return undefined
      return send(`${label} (resent)`, await rebuild())
    }
  }
  console.log('still pending after 60 s')
  return hash
}
async function delegation(label: string, run: () => Promise<Hex>) {
  console.log(`\n=== ${label} ===`)
  if (DRY_RUN) return
  const hash = await run()
  const r = await client.waitForTransactionReceipt({ hash })
  console.log(`type-4 ${hash} mined in block ${r.blockNumber}, status ${r.status}, gasUsed ${r.gasUsed}`)
  console.log(`dana's code: ${(await codeOf(dana.address)) ?? '(none)'}; nonce ${await client.getTransactionCount({ address: dana.address })}`)
}

// Setup: deploy PasskeyDelegate and fund dana.
const frames = []
if (!(await client.getCode({ address: delegate.address }))) frames.push(delegate.deploy)
const balance = await client.getBalance({ address: dana.address })
if (balance < parseEther('0.005')) frames.push(senderFrame({ target: dana.address, value: parseEther('0.01') - balance, execution: 30_000n, state: balance ? 0n : NEW_ACCOUNT_STATE_GAS }))
if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy PasskeyDelegate, fund dana' })
else console.log('setup: already done')
if ((await codeOf(dana.address)) && !DRY_RUN) await delegation('setup: clear a delegation left by an earlier run', () => clearDelegation(dana))

const pay = senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })
const asDana = (fs = [pay]) => eoaTx(dana.address, secp256k1Placeholder(dana.address), dana.key, fs)
const asDevice = (fs = [pay]) => eoaTx(dana.address, p256Placeholder(p256Address(device)), device, fs)

// A. Plain EOA: the default code checks dana's signature.
await send('A. dana pays (no code: the default code)', await asDana(), () => asDana())

// B. Dana delegates to PasskeyDelegate. The funder sends the type-4 transaction.
await delegation('B. dana delegates to PasskeyDelegate (type 4, sent and paid by the funder)', () => setDelegation(dana, delegate.address))

// C. Delegated: dana's key, now checked by PasskeyDelegate's VERIFY.
await send('C. dana pays (delegated: PasskeyDelegate checks the EOA key)', await asDana(), () => asDana())

// C2. Storage outlives a delegation. If an earlier run registered the device key, it is live
// again the moment dana re-delegates, before she registers anything.
{
  const tx = await asDevice()
  const sim = await simulateFrameTx(client, tx)
  console.log(`\n=== C2. the device key, right after re-delegation (simulated) ===\nvalid=${sim.valid}${sim.violation ? ` (${sim.violation})` : ''}`)
}

// D. Dana registers the device key, in her own storage.
await send('D. dana registers the device P256 key', await asDana([registerPasskey(dana.address, p256Address(device))]), () => asDana([registerPasskey(dana.address, p256Address(device))]))

// E. The device key pays from dana's address.
await send('E. the device key pays from dana\'s address (P256 entry)', await asDevice(), () => asDevice())

// E2. While delegated, simulated: what PasskeyDelegate refuses.
{
  const stranger = derive('stranger')
  const other: P256Key = { scheme: 'p256', privateKey: numberToHex(12345n, { size: 32 }) }
  const cases: [string, () => Promise<FrameTx>][] = [
    ['a stranger\'s secp256k1 key', () => eoaTx(dana.address, secp256k1Placeholder(stranger.address), stranger.key, [pay])],
    ['an unregistered P256 key', () => eoaTx(dana.address, p256Placeholder(p256Address(other)), other, [pay])],
    ['dana signs an explicit msg', () => eoaTx(dana.address, secp256k1Placeholder(dana.address, `0x${'11'.repeat(32)}`), dana.key, [pay])],
  ]
  console.log('\n=== E2. refusals while delegated (simulated) ===')
  for (const [label, build] of cases) {
    const sim = await simulateFrameTx(client, await build())
    console.log(`${label}: valid=${sim.valid}${sim.violation ? ` (${sim.violation})` : ''}`)
  }
}

// F0. A race: the device key's transaction is pending when the funder clears the delegation.
if (!DRY_RUN) {
  console.log('\n=== F0. device-key transaction pending; the delegation is cleared at once ===')
  const pending = await asDevice()
  const h = await sendFrameTx(client, pending)
  const clear = await clearDelegation(dana)
  console.log(`frame tx ${h}\ntype-4  ${clear}`)
  const r4 = await client.waitForTransactionReceipt({ hash: clear })
  console.log(`type-4 mined in block ${r4.blockNumber}`)
  const r = await waitForFrameTxReceipt(client, h, { timeoutMs: 30_000 }).catch(() => null)
  console.log(`frame tx: ${r ? `mined in block ${BigInt(r.blockNumber)}` : 'no receipt in 30 s'}; pool ${JSON.stringify(await rpc(client, 'txpool_status', []))}`)
  console.log(`dana's code: ${(await codeOf(dana.address)) ?? '(none)'}`)
}

// F. Dana clears the delegation: back to the default code, which knows nothing of the device key.
if (await codeOf(dana.address)) await delegation('F. dana clears the delegation (type 4 to address 0)', () => clearDelegation(dana))
await send('F. dana pays (no code again: the default code)', await asDana(), () => asDana())
await send('F. the device key tries to pay', await asDevice())

const [after, nonce] = await Promise.all([client.getBalance({ address: dana.address }), client.getTransactionCount({ address: dana.address })])
console.log(`\ndana ${dana.address}: ${formatEther(after)} ETH, nonce ${nonce}`)
