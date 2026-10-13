// Experiment 16: which transactions from one account may wait in the pool together. Run after
// example-subscriptions.ts. Re-subscribes merchant 2, waits until both merchants are due, then:
//
//   C2  merchant 1 and merchant 2 pull at the same moment, each on its own lane
//   C3  merchant 1 pulls (its lane), then alice sends on key 0 while the pull is pending
//   C4  merchant 1 pulls (its lane), then alice sends on a keyed lane of her own (key 1)
//
// usage: npx tsx experiments/16-subscriptions/concurrency.ts
import { type Hex, parseEther } from 'viem'
import { type FrameTx, rpc, sendFrameTx, senderFrame, waitForFrameTxReceipt } from '../../src/frametx/index.js'
import { client, derive, funder, ownerTx, pullTx, readPlan, subscribe, subscriptionAccount } from './subscription.js'

const alice = derive('alice')
const [m1, m2] = [derive('merchant-1'), derive('merchant-2')]
const account = subscriptionAccount(alice.address, 'subscription-account/v1').address
const head = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp

async function burst(label: string, txs: [string, FrameTx][]) {
  console.log(`\n=== ${label} ===`)
  const sent: [string, Hex | string][] = []
  for (const [name, tx] of txs) {
    try {
      sent.push([name, await sendFrameTx(client, tx)])
    } catch (e) {
      const m = (e as Error).message.split('\n')
      sent.push([name, `refused: ${(m.find((l) => l.startsWith('Details:')) ?? m[0]).replace('Details: Invalid params: ', '')}`])
    }
  }
  console.log('pool', JSON.stringify(await rpc(client, 'txpool_status', [])))
  for (const [name, h] of sent) {
    if (!h.startsWith('0x')) {
      console.log(`${name}: ${h}`)
      continue
    }
    const r = await waitForFrameTxReceipt(client, h as Hex)
    console.log(`${name}: ${h} block ${BigInt(r.blockNumber)} frames ${r.frameReceipts.map((f) => Number(f.status)).join(',')} gasUsed ${BigInt(r.gasUsed)}`)
  }
}

if ((await readPlan(account, m2.address)).amount === 0n) {
  const tx = await ownerTx(account, alice, [subscribe(account, m2.address, { amount: parseEther('0.0001'), period: 30n, firstDue: await head() })])
  const r = await waitForFrameTxReceipt(client, await sendFrameTx(client, tx))
  console.log(`re-subscribed merchant 2 in block ${BigInt(r.blockNumber)}`)
}
for (const m of [m1, m2]) {
  const { due } = await readPlan(account, m.address)
  while ((await head()) < due) await new Promise((r) => setTimeout(r, 3000))
}

await burst('C2. merchants 1 and 2 pull at the same moment, each on its own lane', [
  ['merchant 1 pulls', await pullTx(account, m1)],
  ['merchant 2 pulls', await pullTx(account, m2)],
])

await burst('C3. merchant 1 pulls on its lane, then alice sends on key 0 while it is pending', [
  ['merchant 1 pulls', await pullTx(account, m1)],
  ['alice pays (key 0)', await ownerTx(account, alice, [senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })])],
])

await burst('C4. merchant 1 pulls on its lane, then alice sends on her own keyed lane (key 1)', [
  ['merchant 1 pulls', await pullTx(account, m1)],
  ['alice pays (key 1)', await ownerTx(account, alice, [senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })], 1n)],
])
