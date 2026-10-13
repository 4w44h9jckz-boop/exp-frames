// Experiment 13: what RecoveryAccount (v2) refuses. Simulation only; run example-recovery.ts first,
// which leaves the new device's key as the owner and no recovery pending.
//
// usage: npx tsx experiments/13-social-recovery/negative.ts
import { type Hex, concatHex, keccak256, parseEther, toHex } from 'viem'
import { type FrameTx, simulateFrameTx, senderFrame } from '../../src/frametx/index.js'
import { type Guardians, Op, accountTx, client, derive, funder, initiate, op, privateKey, readState, recoveryAccount, reveal } from './recovery.js'

const alice = derive('alice')
const next = derive('alice-new-device')
const outsider = derive('outsider')
const guardians: Guardians = { salt: keccak256(toHex(`${privateKey}/exp-frames/13/salt`)), m: 2, guardians: ['g1', 'g2', 'g3'].map(derive) }
const [g1, g2, g3] = guardians.guardians
const account = recoveryAccount(alice.address, guardians, 60n, 'exp-frames/13/recovery-account').address
const state = await readState(account)
if (state.owner.toLowerCase() !== next.address.toLowerCase()) throw new Error('run example-recovery.ts first')

const data = reveal(guardians)
const start = initiate(account, outsider.address)
const pay = senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })
const asGuardians = (signers = [g1, g3], frames = [start], verifyData: Hex = data, sort = true) => accountTx(account, signers, frames, { verifyData, sort })

const cases: [string, () => Promise<FrameTx>][] = [
  ['owner pays (baseline)', () => accountTx(account, [next], [pay])],
  ['guardians 1 and 3 start a recovery (baseline)', () => asGuardians()],
  ['guardians 2 and 3 start a recovery', () => asGuardians([g2, g3])],
  ['guardian 1 alone', () => asGuardians([g1])],
  ['guardian 1 alone, revealing m = 1', () => asGuardians([g1], [start], reveal({ ...guardians, m: 1 }))],
  ['guardian 1 twice', () => asGuardians([g1, g1])],
  ['guardians 1 and 3 in descending order', async () => asGuardians([g1, g3].sort((a, b) => (BigInt(a.address) > BigInt(b.address) ? -1 : 1)), [start], data, false)],
  ['guardian 1 and an outsider', () => asGuardians([g1, outsider])],
  ['the right guardians, wrong salt', () => asGuardians([g1, g3], [start], reveal({ ...guardians, salt: keccak256('0x00') }))],
  ['the right guardians, a list with one extra address', () => asGuardians([g1, g3], [start], concatHex([data, outsider.address]))],
  ['guardians pay out instead', () => asGuardians([g1, g3], [pay])],
  ['guardians start a recovery and pay out', () => asGuardians([g1, g3], [start, pay])],
  ['guardians start a recovery to address 0', () => asGuardians([g1, g3], [op(account, concatHex([Op.INITIATE, `0x${'00'.repeat(20)}`]))])],
  ['guardians replace the guardian commitment', () => asGuardians([g1, g3], [op(account, concatHex([Op.SET_GUARDIANS, keccak256('0x01')]))])],
  ['guardians finish a recovery', () => asGuardians([g1, g3], [op(account, Op.FINALIZE)])],
  ['an outsider finishes (none pending)', () => accountTx(account, [outsider], [op(account, Op.FINALIZE)])],
  ['the old, lost key pays', () => accountTx(account, [alice], [pay])],
]

console.log('| Case | valid | violation |\n|---|---|---|')
for (const [label, build] of cases) {
  const tx = await build()
  const sim = await simulateFrameTx(client, tx).catch((e: Error) => ({ valid: 'error', violation: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) }))
  console.log(`| ${label} | ${sim.valid} | ${sim.violation ?? ''} |`)
}
