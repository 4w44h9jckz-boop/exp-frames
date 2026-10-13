// The static batch rules, and two more batch layouts, checked by simulation only. Needs the
// contracts from example-2-approve-swap.ts.
//
// usage: npx tsx experiments/03-atomic-batch/negative.ts
import { type Hex, parseEther } from 'viem'
import { loadKey } from '../../src/env.js'
import {
  ATOMIC_BATCH_FLAG,
  Approve,
  type Frame,
  type FrameTx,
  STORAGE_SET_STATE_GAS,
  defaultFrame,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signFrameTx,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { TOKEN_A, TOY_DEX, call, dex, token } from './setup.js'

const { privateKey, address: trader } = loadKey()
const client = makeClient()
const amount = parseEther('10')

if (!(await client.getCode({ address: TOY_DEX }))) throw new Error('run example-2-approve-swap.ts first')

const verify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n })
const approve = (atomic: boolean) =>
  senderFrame({ target: TOKEN_A, data: call(token.abi, 'approve', [TOY_DEX, amount]), execution: 50_000n, state: STORAGE_SET_STATE_GAS, atomic })
const swap = (minOut: bigint, atomic = false) =>
  senderFrame({ target: TOY_DEX, data: call(dex.abi, 'swap', [amount, minOut]), execution: 150_000n, state: 2n * STORAGE_SET_STATE_GAS, atomic })
const withFlags = (frame: Frame, flags: number): Frame => ({ ...frame, flags })

const cases: [string, Frame[]][] = [
  // Static rules: each of these should be refused before anything executes.
  ['ATOMIC_BATCH_FLAG on the last frame', [verify, approve(false), withFlags(swap(amount), ATOMIC_BATCH_FLAG)]],
  ['ATOMIC_BATCH_FLAG on a VERIFY frame', [withFlags(verify, Approve.NONE | ATOMIC_BATCH_FLAG), verify, approve(false)]],
  ['batch terminated by a VERIFY frame', [verify, approve(true), verifyFrame({ scope: Approve.NONE, execution: 20_000n })]],
  ['approval scope on a batched frame (ATOMIC | PAYMENT)', [verify, withFlags(approve(false), ATOMIC_BATCH_FLAG | Approve.PAYMENT), swap(amount)]],
  ['approval scope on the frame that terminates a batch', [verify, approve(true), withFlags(swap(amount), Approve.PAYMENT)]],
  ['reserved flag bit 3 (0x8)', [verify, withFlags(approve(false), 0x8), swap(amount)]],
  // Valid layouts.
  ['two back-to-back batches, only the second fails', [verify, approve(true), swap(amount), approve(true), swap(amount + 1n)]],
  [
    'DEFAULT frame (caller ENTRY_POINT) batched with a failing SENDER frame',
    [
      verify,
      defaultFrame({ target: TOKEN_A, data: call(token.abi, 'mint', [trader, 1n]), execution: 50_000n, atomic: true }),
      swap(amount + 1n),
    ],
  ],
]

for (const [name, frames] of cases) {
  let tx: FrameTx
  try {
    tx = await signFrameTx(await prepareFrameTx(client, { sender: trader, frames, signatures: [secp256k1Placeholder()] }), privateKey)
  } catch (e) {
    console.log(`\n• ${name}\n  refused while preparing: ${(e as Error).message.split('\n')[0]}`)
    continue
  }
  const sim = await simulateFrameTx(client, tx).catch((e: Error) => ({ error: e.message.split('\n')[0] }))
  console.log(`\n• ${name}  flags=[${frames.map((f) => `0x${f.flags.toString(16)}`).join(', ')}]`)
  if ('error' in sim) {
    console.log(`  RPC error: ${sim.error}`)
    continue
  }
  console.log(`  valid=${sim.valid} shape=${sim.prefixShape}${sim.violation ? `\n  violation: ${sim.violation}` : ''}`)
  if (sim.frames) console.log(`  frames: ${sim.frames.map((f, i) => `[${i}] ${f.succeeded ? 'ok' : 'FAILED'} gas=${BigInt(f.gasUsed as Hex)}`).join('  ')}`)
  if (sim.executionError) console.log(`  executionError: ${sim.executionError}`)
}
