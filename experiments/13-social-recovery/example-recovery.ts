// Experiment 13: social recovery. Alice owns the account; three guardians, two of whom suffice,
// can hand it to a new key after a delay, and the owner can cancel during the delay. The
// guardians are hidden behind a salted commitment until they act.
//
// Guardian transaction (starts a recovery)
// | Frame | Mode   | Target        | Data                           | Signatures                        |
// | 0     | VERIFY | Null (sender) | salt ‖ m ‖ guardians (reveal)  | m guardians, ascending, msg ∅     |
// | 1     | SENDER | sender        | 0x01 ‖ newOwner                |                                   |
//
// Pending-owner transaction (finishes it, once now >= unlock)
// | 0     | VERIFY | Null (sender) |                                | the pending owner                 |
// | 1     | SENDER | sender        | 0x02                           |                                   |
//
// usage: npx tsx experiments/13-social-recovery/example-recovery.ts [--v1] [--dry-run]
import { type Hex, formatEther, keccak256, parseEther, toHex } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { DRY_RUN } from '../../src/execute.js'
import { type FrameTx, describeReceipt, describeSimulation, describeTx, sendFrameTx, senderFrame, simulateFrameTx, waitForFrameTxReceipt } from '../../src/frametx/index.js'
import { type Guardians, Op, VERSION, accountTx, client, derive, funder, initiate, op, privateKey, readState, recoveryAccount, reveal } from './recovery.js'

const DELAY = 60n // seconds; days in practice
const alice = derive('alice')
const lost = alice
const next = derive('alice-new-device')
const guardians: Guardians = { salt: keccak256(toHex(`${privateKey}/exp-frames/13/salt`)), m: 2, guardians: ['g1', 'g2', 'g3'].map(derive) }
const [g1, g2, g3] = guardians.guardians
const account = recoveryAccount(alice.address, guardians, DELAY, 'exp-frames/13/recovery-account')
console.log(`owner ${alice.address}; guardians ${guardians.guardians.map((g) => g.address).join(', ')} (2 of 3); new device ${next.address}`)
console.log(`RecoveryAccount ${VERSION} ${account.address}, delay ${DELAY} s`)

const head = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp
const show = async (label: string) => {
  const s = await readState(account.address)
  console.log(`${label}: owner ${s.owner}, pending ${s.pending}, unlock ${s.unlock}${s.unlock ? ` (head ${await head()})` : ''}`)
}

async function send(label: string, tx: FrameTx): Promise<Hex | undefined> {
  console.log(`\n=== ${label} ===`)
  console.log(describeTx(tx))
  const sim = await simulateFrameTx(client, tx)
  console.log(describeSimulation(sim))
  if (DRY_RUN || !sim.valid) return undefined
  const hash = await sendFrameTx(client, tx)
  console.log(`sent ${hash}`)
  console.log(describeReceipt(tx, await waitForFrameTxReceipt(client, hash)))
  return hash
}

// Setup: the funder deploys (two constructor slots) and funds the account.
const FUNDING = parseEther('0.01')
const hasCode = Boolean(await client.getCode({ address: account.address }))
const balance = await client.getBalance({ address: account.address })
if (!hasCode || balance < FUNDING / 2n) {
  const frames = []
  if (!hasCode) frames.push(account.deploy)
  if (balance < FUNDING / 2n) frames.push(senderFrame({ target: account.address, value: FUNDING - balance, execution: 30_000n }))
  await sendFrames(client, privateKey, frames, { label: 'setup: deploy and fund the RecoveryAccount' })
} else console.log('setup: already done')
if (DRY_RUN && !hasCode) process.exit(0)
await show('start')

const state = await readState(account.address)
if (state.owner.toLowerCase() !== alice.address.toLowerCase()) throw new Error('the account has already been recovered; change the label to run again')
const pay = senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })

// A. Alice uses the account.
await send('A. owner pays', await accountTx(account.address, [alice], [pay]))

// B. Alice loses her key. Guardians 1 and 3 start a recovery to her new device's key.
await send('B. guardians 1 and 3 start a recovery to the new key', await accountTx(account.address, [g1, g3], [initiate(account.address, next.address)], { verifyData: reveal(guardians) }))
await show('after B')

// C. The new key tries to finish at once. VERIFY cannot see the clock, so the transaction is valid
// and is included; the finish frame reverts in execution and the account pays for it.
await send('C. new key finishes before the delay is over', await accountTx(account.address, [next], [op(account.address, Op.FINALIZE)]))
await show('after C')

// D. After the delay, the new key finishes.
if (!DRY_RUN) {
  const { unlock } = await readState(account.address)
  while ((await head()) < unlock) await new Promise((r) => setTimeout(r, 3000))
  console.log(`\nhead ${await head()} >= unlock ${unlock}`)
}
await send('D. new key finishes after the delay', await accountTx(account.address, [next], [op(account.address, Op.FINALIZE)]))
await show('after D')

// E. The new key uses the account; the lost key no longer can.
await send('E. new owner pays', await accountTx(account.address, [next], [pay]))
await send('E. the lost key tries to pay', await accountTx(account.address, [lost], [pay]))

// F. Two guardians turn hostile and start a recovery to their own key; the owner cancels.
const thief = derive('thief')
await send('F. guardians 1 and 2 start a recovery to a key of their own', await accountTx(account.address, [g1, g2], [initiate(account.address, thief.address)], { verifyData: reveal(guardians) }))
await show('after F')
await send('F. owner cancels during the delay', await accountTx(account.address, [next], [op(account.address, Op.CANCEL)]))
await show('after cancel')
await send('F. the thief tries to finish', await accountTx(account.address, [thief], [op(account.address, Op.FINALIZE)]))

const [after, nonce] = await Promise.all([client.getBalance({ address: account.address }), client.getTransactionCount({ address: account.address })])
console.log(`\n${account.address}: ${formatEther(after)} ETH, nonce ${nonce}`)
