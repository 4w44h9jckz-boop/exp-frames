// Experiment 12: session keys. The owner grants a second key the right to pay one merchant, until
// a deadline, within a budget that counts both the value sent and the fees; the account's VERIFY
// frame checks every frame of a session transaction against that grant.
//
// Session transaction
// | Frame | Mode   | Target          | Data                              | Checked by VERIFY                       |
// | 0     | VERIFY | EXPIRY_VERIFIER | deadline (8)                      | deadline <= session.validUntil          |
// | 1     | VERIFY | Null (sender)   |                                   | entry 0 signed by the session key       |
// | 2     | SENDER | sender          | 0x03 ‖ key ‖ amount               | amount >= max cost + value; fits budget |
// | 3+    | SENDER | merchant        | (empty: selector 0)               | target, selector                        |
//
// usage: npx tsx experiments/12-session-keys/example-session.ts [--dry-run]
import { type Hex, formatEther, parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { DRY_RUN } from '../../src/execute.js'
import {
  type FrameTx,
  NEW_ACCOUNT_STATE_GAS,
  describeReceipt,
  describeSimulation,
  describeTx,
  frameTxHash,
  rpc,
  sendFrameTx,
  senderFrame,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { addSession, client, derive, funder, ownerTx, privateKey, readSession, revokeSession, sessionAccount, sessionTx } from './session.js'

const owner = derive('owner')
const session = derive('session')
const merchant = derive('merchant').address
const account = sessionAccount(owner.address, 'exp-frames/12/session-account/v1')
console.log(`owner ${owner.address}, session key ${session.address}, merchant ${merchant}`)
console.log(`SessionAccount ${account.address}`)

const head = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp
const show = async (label: string) => {
  const s = await readSession(account.address, session.address)
  console.log(`${label}: active=${s.active} spent ${formatEther(s.spent)} of ${formatEther(s.budget)} ETH, validUntil ${s.validUntil}`)
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

// Setup: the funder deploys the account (674 bytes) and funds it, and gives the merchant 1 wei so
// that its account exists. Paying an address with no account creates one, which costs 183,600
// state gas that a session's call frames do not carry (the first run found this the hard way).
const FUNDING = parseEther('0.01')
const hasCode = Boolean(await client.getCode({ address: account.address }))
const balance = await client.getBalance({ address: account.address })
const merchantExists = (await client.getBalance({ address: merchant })) > 0n
if (!hasCode || balance < FUNDING / 2n || !merchantExists) {
  const frames = []
  if (!hasCode) frames.push(account.deploy)
  if (balance < FUNDING / 2n) frames.push(senderFrame({ target: account.address, value: FUNDING - balance, execution: 30_000n }))
  if (!merchantExists) frames.push(senderFrame({ target: merchant, value: 1n, execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS }))
  await sendFrames(client, privateKey, frames, { label: 'setup: deploy and fund the SessionAccount' })
} else console.log('setup: already done')
if (DRY_RUN && !hasCode) process.exit(0)

const BUDGET = parseEther('0.002')
const grant = async () => ({ target: merchant, selector: '0x00000000' as Hex, validUntil: (await head()) + 3600n, budget: BUDGET })

// 1. The owner grants the session: one hour, 0.002 ETH including fees, plain transfers to the merchant.
await send('1. owner adds the session', await ownerTx(account.address, owner, [addSession(account.address, session.address, await grant())]))
await show('after grant')

// A. The session key pays the merchant.
await send('A. session key pays the merchant 0.0001 ETH', await sessionTx(account.address, session, merchant, [{ value: parseEther('0.0001') }], { deadline: (await head()) + 300n }))
await show('after A')

// B. Two payments in one transaction; the spend record covers both.
await send(
  'B. session key pays the merchant twice in one transaction',
  await sessionTx(account.address, session, merchant, [{ value: parseEther('0.0001') }, { value: parseEther('0.0002') }], { deadline: (await head()) + 300n }),
)
await show('after B')

// C. More than the budget has left: refused at VERIFY, so nothing is paid, not even gas.
await send('C. session key tries 0.0015 ETH, more than the budget has left', await sessionTx(account.address, session, merchant, [{ value: parseEther('0.0015') }], { deadline: (await head()) + 300n }))

// D. The owner revokes; the same session transaction is refused afterwards.
await send('D. owner revokes the session', await ownerTx(account.address, owner, [revokeSession(account.address, session.address)]))
await show('after D')
await send('D. session key tries again after revocation', await sessionTx(account.address, session, merchant, [{ value: parseEther('0.0001') }], { deadline: (await head()) + 300n }))

// E. Revocation against a pending session transaction. Re-grant, send a session transaction, and
// at once send the owner's revocation at the same nonce with fees 25% higher: a replacement.
if (!DRY_RUN) {
  await send('E. owner grants the session again', await ownerTx(account.address, owner, [addSession(account.address, session.address, await grant())]))
  console.log('\n=== E. a pending session transaction, replaced by the owner\'s revocation ===')
  const pending = await sessionTx(account.address, session, merchant, [{ value: parseEther('0.0001') }], { deadline: (await head()) + 300n })
  const bump = (x: bigint) => (x * 125n + 99n) / 100n
  const revoke = await ownerTx(account.address, owner, [revokeSession(account.address, session.address)], {
    fees: { ...pending.fees, maxFeePerGas: bump(pending.fees.maxFeePerGas), maxPriorityFeePerGas: bump(pending.fees.maxPriorityFeePerGas) },
  })
  const h1 = await sendFrameTx(client, pending)
  let h2: Hex | undefined
  try {
    h2 = await sendFrameTx(client, revoke)
  } catch (e) {
    console.log(`revocation refused: ${(e as Error).message.split('\n').find((l) => l.startsWith('Details:')) ?? (e as Error).message.split('\n')[0]}`)
  }
  console.log(`session tx ${h1}\nrevocation ${h2 ?? frameTxHash(revoke)}`)
  for (const [name, hash] of [['session', h1], ['revocation', h2]] as const) {
    if (!hash) continue
    const r = await waitForFrameTxReceipt(client, hash, { timeoutMs: 30_000 }).catch(() => null)
    console.log(`${name}: ${r ? `mined in block ${BigInt(r.blockNumber)}` : 'no receipt in 30 s'}`)
  }
  console.log('pool', JSON.stringify(await rpc(client, 'txpool_status', [])))
  await show('after E')
}

const [after, nonce] = await Promise.all([client.getBalance({ address: account.address }), client.getTransactionCount({ address: account.address })])
console.log(`\n${account.address}: ${formatEther(after)} ETH, nonce ${nonce}; merchant ${formatEther(await client.getBalance({ address: merchant }))} ETH`)
