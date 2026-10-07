// Experiment 16: what SubscriptionAccount refuses at VERIFY, and what it leaves to execution.
// Simulation only; run example-subscriptions.ts first.
//
// usage: npx tsx experiments/16-subscriptions/negative.ts
import { concatHex, parseEther } from 'viem'
import { Approve, type FrameTx, simulateFrameTx } from '../../src/frametx/index.js'
import { client, derive, funder, laneOf, privateKey, pullTx, subscriptionAccount } from './subscription.js'

const alice = derive('alice')
const [m1, m2] = [derive('merchant-1'), derive('merchant-2')]
const stranger = derive('stranger')
const account = subscriptionAccount(alice.address, 'subscription-account/v1').address
if (!(await client.getCode({ address: account }))) throw new Error('run example-subscriptions.ts first')

const cases: [string, () => Promise<FrameTx>][] = [
  ['merchant 1 pulls (baseline)', () => pullTx(account, m1)],
  ['a stranger with no ETH pulls for itself', () => pullTx(account, stranger)],
  ['a stranger with ETH (the funder) pulls for itself', () => pullTx(account, { key: privateKey, address: funder })],
  ['merchant 1 pulls on nonce key 0', () => pullTx(account, m1, { nonceKeys: [0n] })],
  ['merchant 1 pulls on merchant 2\'s lane', () => pullTx(account, m1, { nonceKeys: [laneOf(m2.address)] })],
  ['merchant 1 pulls and asks the account to pay', () => pullTx(account, m1, { scope: Approve.EXECUTION_AND_PAYMENT })],
  ['merchant 1 pulls for merchant 2', () => pullTx(account, m1, { edit: (fs) => fs.map((f, i) => (i === 2 ? { ...f, data: concatHex(['0x03', m2.address]) } : f)) })],
  ['merchant 1 pulls with value on the pull frame', () => pullTx(account, m1, { edit: (fs) => fs.map((f, i) => (i === 2 ? { ...f, value: parseEther('0.001') } : f)) })],
  ['merchant 1 pulls, then a second frame', () => pullTx(account, m1, { edit: (fs) => [...fs, fs[2]] })],
]

console.log('| Case | valid | violation | execution |\n|---|---|---|---|')
for (const [label, build] of cases) {
  const sim = await simulateFrameTx(client, await build()).catch((e: Error) => ({ valid: 'error', violation: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9), executionStatus: null }))
  console.log(`| ${label} | ${sim.valid} | ${sim.violation ?? ''} | ${sim.valid === true ? sim.executionStatus : ''} |`)
}
