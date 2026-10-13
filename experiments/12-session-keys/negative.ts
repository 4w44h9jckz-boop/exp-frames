// Experiment 12: what SessionAccount refuses. Simulation only, except that it grants the session
// again (one owner transaction) if example-session.ts left it revoked.
//
// usage: npx tsx experiments/12-session-keys/negative.ts
import { concatHex, parseEther } from 'viem'
import {
  ATOMIC_BATCH_FLAG,
  type Frame,
  type FrameTx,
  Mode,
  maxCost,
  sendFrameTx,
  senderFrame,
  simulateFrameTx,
  suggestFees,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { addSession, client, derive, funder, ownerTx, readSession, sessionAccount, sessionTx } from './session.js'

const owner = derive('owner')
const session = derive('session')
const stranger = derive('stranger')
const merchant = derive('merchant').address
const account = sessionAccount(owner.address, 'exp-frames/12/session-account/v1')
if (!(await client.getCode({ address: account.address }))) throw new Error('run example-session.ts first')

const head = (await client.getBlock({ blockTag: 'latest' })).timestamp
let state = await readSession(account.address, session.address)
if (!state.active) {
  const tx = await ownerTx(account.address, owner, [
    addSession(account.address, session.address, { target: merchant, selector: '0x00000000', validUntil: head + 3600n, budget: parseEther('0.002') }),
  ])
  const hash = await sendFrameTx(client, tx)
  await waitForFrameTxReceipt(client, hash)
  console.log(`granted the session again: ${hash}`)
  state = await readSession(account.address, session.address)
}
console.log(`session: spent ${state.spent} of ${state.budget} wei, validUntil ${state.validUntil}\n`)

const pay = [{ value: parseEther('0.0001') }]
const deadline = head + 300n
const at = (i: number, f: (frame: Frame) => Frame) => (frames: Frame[]) => frames.map((x, j) => (j === i ? f(x) : x))

const cases: [string, () => Promise<FrameTx>][] = [
  ['session key pays the merchant (baseline)', () => sessionTx(account.address, session, merchant, pay, { deadline })],
  ['owner pays the merchant: VERIFY, SENDER only', () => ownerTx(account.address, owner, [senderFrame({ target: merchant, value: parseEther('0.0001'), execution: 30_000n })])],
  ['a stranger\'s key, same shape', () => sessionTx(account.address, stranger, merchant, pay, { deadline })],
  ['no expiry frame', () => sessionTx(account.address, session, merchant, pay, { deadline, edit: (fs) => fs.slice(1) })],
  ['deadline one second after validUntil', () => sessionTx(account.address, session, merchant, pay, { deadline: state.validUntil + 1n })],
  ['deadline in the past', () => sessionTx(account.address, session, merchant, pay, { deadline: head - 60n })],
  ['pays another address', () => sessionTx(account.address, session, funder, pay, { deadline })],
  ['pays the merchant with calldata (selector 0 means none)', () => sessionTx(account.address, session, merchant, [{ value: parseEther('0.0001'), data: '0xdeadbeef' }], { deadline })],
  ['declares half the amount', () => sessionTx(account.address, session, merchant, pay, { deadline, amount: (a) => a / 2n })],
  ['declares exactly max cost + value (computed from the signed transaction)', async () => exact()],
  ['declares one wei less than that', async () => exact(-1n)],
  ['spend frame with 29,999 execution gas', () => sessionTx(account.address, session, merchant, pay, { deadline, edit: at(2, (f) => ({ ...f, limits: { ...f.limits, execution: 29_999n } })) })],
  ['spend frame in an atomic batch with the payment', () => sessionTx(account.address, session, merchant, pay, { deadline, edit: at(2, (f) => ({ ...f, flags: ATOMIC_BATCH_FLAG })) })],
  [
    'spend frame records the spend against another key',
    () => sessionTx(account.address, session, merchant, pay, { deadline, edit: at(2, (f) => ({ ...f, data: concatHex(['0x03', stranger.address, `0x${f.data.slice(44)}`]) })) }),
  ],
  [
    'an extra frame granting the session key a second session',
    () =>
      sessionTx(account.address, session, merchant, pay, {
        deadline,
        edit: (fs) => [...fs, addSession(account.address, session.address, { target: funder, selector: '0x00000000', validUntil: head + 3600n, budget: parseEther('1') })],
      }),
  ],
  ['payment as a DEFAULT frame', () => sessionTx(account.address, session, merchant, pay, { deadline, edit: at(3, (f) => ({ ...f, mode: Mode.DEFAULT, value: 0n })) })],
  ['0.0019 ETH: with the max cost, past the 0.002 budget', () => sessionTx(account.address, session, merchant, [{ value: parseEther('0.0019') }], { deadline })],
]

/** A session tx whose amount equals max cost + value of the final signed bytes, found by retrying. */
async function exact(delta = 0n): Promise<FrameTx> {
  const fees = await suggestFees(client)
  const build = (amount: bigint) => sessionTx(account.address, session, merchant, pay, { deadline, fees, amount: () => amount })
  let amount = BigInt(`0x${(await sessionTx(account.address, session, merchant, pay, { deadline, fees })).frames[2].data.slice(44)}`)
  for (let i = 0; i < 32; i++) {
    const want = maxCost(await build(amount)) + parseEther('0.0001')
    if (want === amount) return build(amount + delta)
    amount = want
  }
  throw new Error('no fixed point')
}

console.log('| Case | valid | violation | gasUsed |\n|---|---|---|---|')
for (const [label, build] of cases) {
  const tx = await build()
  const sim = await simulateFrameTx(client, tx).catch((e: Error) => ({ valid: 'error', violation: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9), gasUsed: null }))
  console.log(`| ${label} | ${sim.valid} | ${sim.violation ?? ''} | ${sim.valid === true && sim.gasUsed ? BigInt(sim.gasUsed) : ''} |`)
}
