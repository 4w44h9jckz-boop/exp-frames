// Experiment 14: what ModularAccount refuses, and which rule refuses it. Simulation only; run
// example-modular.ts first.
//
// usage: npx tsx experiments/14-modular-account/negative.ts
import { parseEther } from 'viem'
import { CREATE2_DEPLOYER, type FrameTx, simulateFrameTx, senderFrame, signAll } from '../../src/frametx/index.js'
import { Kind, client, countingValidator, derive, externalOwnerValidator, funder, modularAccount, ownerValidator, viaModule } from './modular.js'

const alice = derive('alice')
const stranger = derive('stranger')
const account = modularAccount(ownerValidator.address, Kind.DELEGATE, alice.address, 'modular-account/v1').address
if (!(await client.getCode({ address: account }))) throw new Error('run example-modular.ts first')
const pay = senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })

const cases: [string, () => Promise<FrameTx>][] = [
  ['OwnerValidator, alice signs (baseline)', () => viaModule(account, ownerValidator.address, alice, [pay])],
  ['OwnerValidator, a stranger signs', () => viaModule(account, ownerValidator.address, stranger, [pay])],
  ['OwnerValidator, alice signs an explicit msg', async () => {
    const tx = await viaModule(account, ownerValidator.address, alice, [pay])
    return signAll({ ...tx, signatures: [{ ...tx.signatures[0], msg: `0x${'11'.repeat(32)}`, signature: '0x' }] }, [alice.key])
  }],
  ['a module that is not installed (the CREATE2 deployer)', () => viaModule(account, CREATE2_DEPLOYER, alice, [pay])],
  ['VERIFY data of 19 bytes', async () => {
    const tx = await viaModule(account, ownerValidator.address, alice, [pay])
    return signAll({ ...tx, frames: tx.frames.map((f, i) => (i === 0 ? { ...f, data: `0x${f.data.slice(2, 40)}` as const } : f)) }, [alice.key])
  }],
  ['ExternalOwnerValidator, alice signs', () => viaModule(account, externalOwnerValidator.address, alice, [pay])],
  ['ExternalOwnerValidator, a stranger signs', () => viaModule(account, externalOwnerValidator.address, stranger, [pay])],
  ['CountingValidator, alice signs', () => viaModule(account, countingValidator.address, alice, [pay])],
  ['CountingValidator, a stranger signs', () => viaModule(account, countingValidator.address, stranger, [pay])],
]

console.log('| Case | valid | violation | payer |\n|---|---|---|---|')
for (const [label, build] of cases) {
  const tx = await build()
  const sim = await simulateFrameTx(client, tx).catch((e: Error) => ({ valid: 'error', violation: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9), payer: null }))
  console.log(`| ${label} | ${sim.valid} | ${sim.violation ?? ''} | ${sim.payer ? 'set' : ''} |`)
}
