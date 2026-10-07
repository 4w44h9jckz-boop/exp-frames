// Experiment 16: subscriptions. Alice subscribes two merchants; each merchant collects by sending
// a transaction from alice's account, on its own nonce lane, paying the fees itself. The account
// checks the period in execution, so an early pull costs the merchant, not alice.
//
// Pull
// | Frame | Mode   | Target   | Scope     | Data   | Signatures                     |
// | 0     | VERIFY | (sender) | EXECUTION |        | entry 0: merchant              |
// | 1     | VERIFY | merchant | PAYMENT   |        | entry 1: merchant (default code) |
// | 2     | SENDER | (sender) | -         | 0x03 ‖ merchant |                       |
// nonce_keys = [merchant]
//
// usage: npx tsx experiments/16-subscriptions/example-subscriptions.ts [--dry-run]
import { type Hex, formatEther, parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { DRY_RUN } from '../../src/execute.js'
import {
  type FrameTx,
  type FrameTxReceiptJson,
  NEW_ACCOUNT_STATE_GAS,
  describeReceipt,
  describeSimulation,
  describeTx,
  rpc,
  sendFrameTx,
  senderFrame,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { cancel, client, derive, funder, ownerTx, privateKey, pullTx, readPlan, subscribe, subscriptionAccount } from './subscription.js'

const alice = derive('alice')
const [m1, m2] = [derive('merchant-1'), derive('merchant-2')]
const account = subscriptionAccount(alice.address, 'subscription-account/v1')
console.log(`owner ${alice.address}; merchants ${m1.address}, ${m2.address}; SubscriptionAccount ${account.address}`)

const head = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp
const balances = async (label: string) => {
  const [a, b1, b2] = await Promise.all([account.address, m1.address, m2.address].map((address) => client.getBalance({ address })))
  console.log(`${label}: account ${formatEther(a)}, merchant 1 ${formatEther(b1)}, merchant 2 ${formatEther(b2)} ETH`)
}

async function send(label: string, tx: FrameTx): Promise<FrameTxReceiptJson | undefined> {
  console.log(`\n=== ${label} ===`)
  console.log(describeTx(tx))
  const sim = await simulateFrameTx(client, tx)
  console.log(describeSimulation(sim))
  if (DRY_RUN || !sim.valid) return undefined
  const hash = await sendFrameTx(client, tx)
  console.log(`sent ${hash}`)
  const r = await waitForFrameTxReceipt(client, hash)
  console.log(describeReceipt(tx, r))
  return r
}

// Setup: deploy and fund the account; give each merchant gas money.
const frames = []
if (!(await client.getCode({ address: account.address }))) frames.push(account.deploy)
for (const [address, want] of [[account.address, parseEther('0.01')], [m1.address, parseEther('0.002')], [m2.address, parseEther('0.002')]] as const) {
  const balance = await client.getBalance({ address })
  if (balance < want / 2n) frames.push(senderFrame({ target: address, value: want - balance, execution: 30_000n, state: balance || address === account.address ? 0n : NEW_ACCOUNT_STATE_GAS }))
}
if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy and fund the account, give the merchants gas money' })
else console.log('setup: already done')
if (DRY_RUN && !(await client.getCode({ address: account.address }))) process.exit(0)

const PERIOD = 30n
const AMOUNT = parseEther('0.0001')

// 1. Alice subscribes both merchants, due now, every 30 s.
const now = await head()
await send('1. alice subscribes merchants 1 and 2', await ownerTx(account.address, alice, [
  subscribe(account.address, m1.address, { amount: AMOUNT, period: PERIOD, firstDue: now }),
  subscribe(account.address, m2.address, { amount: AMOUNT, period: PERIOD, firstDue: now }),
]))
await balances('after 1')

// A. Merchant 1 pulls: the first pull on its lane, which writes the keyed nonce slot.
await send('A. merchant 1 pulls (first use of its nonce lane)', await pullTx(account.address, m1))
console.log('merchant 1 plan', await readPlan(account.address, m1.address), 'head', await head())

// B. Merchant 1 pulls again at once: valid, included, refused in execution. Merchant 1 pays.
await send('B. merchant 1 pulls again before the period is over', await pullTx(account.address, m1))
await balances('after B')

// C. Three transactions from the same account at once, on three nonce lanes: alice pays someone
// (key 0), merchant 2 pulls (its lane, first use), merchant 1 tries again (its lane).
if (!DRY_RUN) {
  console.log('\n=== C. alice, merchant 2 and merchant 1 send from the account at the same moment ===')
  const txs = [
    ['alice pays (key 0)', await ownerTx(account.address, alice, [senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })])],
    ['merchant 2 pulls (its lane)', await pullTx(account.address, m2)],
    ['merchant 1 pulls again (its lane, early)', await pullTx(account.address, m1)],
  ] as const
  const hashes: [string, Hex | string][] = []
  for (const [label, tx] of txs) {
    try {
      hashes.push([label, await sendFrameTx(client, tx)])
    } catch (e) {
      const m = (e as Error).message.split('\n')
      hashes.push([label, `refused: ${m.find((l) => l.startsWith('Details:')) ?? m[0]}`])
    }
  }
  console.log('pool', JSON.stringify(await rpc(client, 'txpool_status', [])))
  for (const [label, h] of hashes) {
    if (!h.startsWith('0x')) {
      console.log(`${label}: ${h}`)
      continue
    }
    const r = await waitForFrameTxReceipt(client, h as Hex)
    console.log(`${label}: ${h} block ${BigInt(r.blockNumber)} frames ${r.frameReceipts.map((f) => f.status).join(',')} gasUsed ${BigInt(r.gasUsed)}`)
  }
  await balances('after C')
}

// D. After the period, merchant 1 pulls again.
if (!DRY_RUN) {
  const { due } = await readPlan(account.address, m1.address)
  while ((await head()) < due) await new Promise((r) => setTimeout(r, 3000))
}
await send('D. merchant 1 pulls after the period', await pullTx(account.address, m1))

// E. Alice cancels merchant 2; merchant 2's next pull is valid, included, and refused in execution.
await send('E. alice cancels merchant 2', await ownerTx(account.address, alice, [cancel(account.address, m2.address)]))
await send('E. merchant 2 pulls after cancellation', await pullTx(account.address, m2))
await balances('end')
