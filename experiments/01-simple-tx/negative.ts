// Break Example 1a in small ways and ask the node what it thinks. Simulation only: nothing
// here is sent, so it costs nothing and can be re-run at will.
//
// usage: npx tsx experiments/01-simple-tx/negative.ts
import { type Hex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type FrameTx,
  NEW_ACCOUNT_STATE_GAS,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signFrameTx,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'

const { privateKey, address: sender } = loadKey()
const client = makeClient()
const destination = privateKeyToAddress(generatePrivateKey())

const verify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n })
const transfer = senderFrame({ target: destination, value: parseEther('0.001'), execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS })
const base = await prepareFrameTx(client, { sender, frames: [verify, transfer], signatures: [secp256k1Placeholder()] })
const sign = (tx: FrameTx, key: Hex = privateKey) => signFrameTx(tx, key)

const cases: [string, () => Promise<FrameTx>][] = [
  ['baseline (Example 1a)', () => sign(base)],
  [
    'signature v as 27/28 instead of 0/1',
    async () => {
      const tx = await sign(base)
      const s = tx.signatures[0].signature
      const v = Number.parseInt(s.slice(2, 4), 16) + 27
      return { ...tx, signatures: [{ ...tx.signatures[0], signature: `0x${v.toString(16)}${s.slice(4)}` as Hex }] }
    },
  ],
  [
    'signed by a different key, entry claims the sender',
    async () => {
      const wrongKey = generatePrivateKey()
      const tx = await sign({ ...base, signatures: [secp256k1Placeholder(privateKeyToAddress(wrongKey))] }, wrongKey)
      return { ...tx, signatures: [{ ...tx.signatures[0], signer: sender }] }
    },
  ],
  [
    'frame value changed after signing',
    async () => {
      const tx = await sign(base)
      return { ...tx, frames: [verify, { ...transfer, value: parseEther('0.002') }] }
    },
  ],
  ['SENDER frame before the VERIFY frame', () => sign({ ...base, frames: [transfer, verify] })],
  ['VERIFY frame with no approval scope (flags = 0)', () => sign({ ...base, frames: [{ ...verify, flags: Approve.NONE }, transfer] })],
  ['VERIFY approves execution only: nobody pays', () => sign({ ...base, frames: [{ ...verify, flags: Approve.EXECUTION }, transfer] })],
  ['VERIFY frame with 50 execution gas (cannot cover the target access)', () => sign({ ...base, frames: [{ ...verify, limits: { execution: 50n, state: 0n } }, transfer] })],
  ['transfer to a new account with no state budget', () => sign({ ...base, frames: [verify, { ...transfer, limits: { execution: 30_000n, state: 0n } }] })],
  ['no signatures at all', async () => ({ ...base, signatures: [] })],
]

for (const [name, build] of cases) {
  const sim = await simulateFrameTx(client, await build()).catch((e: Error) => ({ error: e.message.split('\n')[0] }))
  console.log(`\n• ${name}`)
  if ('error' in sim) {
    console.log(`  RPC error: ${sim.error}`)
    continue
  }
  console.log(`  valid=${sim.valid} shape=${sim.prefixShape} payer=${sim.payer ? 'set' : 'none'}${sim.violation ? `\n  violation: ${sim.violation}` : ''}`)
  if (sim.frames) console.log(`  frames: ${sim.frames.map((f, i) => `[${i}] ${f.succeeded ? 'ok' : 'FAILED'} gas=${BigInt(f.gasUsed)}`).join('  ')}`)
  if (sim.executionError) console.log(`  executionError: ${sim.executionError}`)
}
