// EIP-8141 Example 2: atomic approve + swap.
//
// | Frame | Mode   | Caller      | Flags                         | Target        | Value | Data                 |
// | 0     | VERIFY | ENTRY_POINT | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | 0     | Empty                |
// | 1     | SENDER | Sender      | ATOMIC_BATCH_FLAG             | ERC-20        | 0     | approve(DEX, amount) |
// | 2     | SENDER | Sender      | APPROVE_SCOPE_NONE            | DEX           | 0     | swap(...)            |
//
// Three runs from the same EOA:
//   A. the example as written: both frames succeed;
//   B. the swap reverts inside a three-frame batch: the approve is rolled back, the frame after
//      the failure is SKIPPED;
//   C. the same failure without ATOMIC_BATCH_FLAG: the approve survives (a dangling allowance).
// A last transaction resets the allowance so the experiment can be re-run from the same state.
//
// usage: npx tsx experiments/03-atomic-batch/example-2-approve-swap.ts [--dry-run]
import { type Address, formatEther, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { loadKey } from '../../src/env.js'
import { DRY_RUN, execute } from '../../src/execute.js'
import {
  Approve,
  type Frame,
  STORAGE_SET_STATE_GAS,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'
import { TOKEN_A, TOKEN_B, TOY_DEX, balances, call, dex, ensureSetup, token } from './setup.js'

const { privateKey, address: trader } = loadKey()
const client = makeClient()
const amount = parseEther('10')

await ensureSetup(client, privateKey, trader)
if (DRY_RUN && !(await client.getCode({ address: TOY_DEX }))) {
  console.log('(dry run: contracts not deployed yet, nothing more to simulate)')
  process.exit(0)
}

const show = async (label: string) => {
  const b = await balances(client, trader)
  console.log(`${label}: A=${formatEther(b.a)} B=${formatEther(b.b)} allowance(A → DEX)=${formatEther(b.allowance)}`)
  return b
}

const approve = (value: bigint, atomic: boolean): Frame =>
  senderFrame({ target: TOKEN_A, data: call(token.abi, 'approve', [TOY_DEX, value]), execution: 50_000n, state: STORAGE_SET_STATE_GAS, atomic })
// Fresh balance slots on the first swap: the DEX's Token A and the trader's Token B.
const swap = (minOut: bigint, atomic: boolean): Frame =>
  senderFrame({ target: TOY_DEX, data: call(dex.abi, 'swap', [amount, minOut]), execution: 150_000n, state: 2n * STORAGE_SET_STATE_GAS, atomic })
const sendB = (to: Address): Frame =>
  senderFrame({ target: TOKEN_B, data: call(token.abi, 'transfer', [to, parseEther('1')]), execution: 50_000n, state: STORAGE_SET_STATE_GAS })

const run = async (label: string, frames: Frame[]) => {
  const tx = await prepareFrameTx(client, {
    sender: trader,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), ...frames],
    signatures: [secp256k1Placeholder()],
  })
  return execute(client, tx, [privateKey], { label })
}

const start = await show('start')
if (start.allowance !== 0n) await run('reset a leftover allowance', [approve(0n, false)])

await run('A. Example 2 as written: approve (batched) + swap', [approve(amount, true), swap(amount, false)])
await show('after A')

const stranger = privateKeyToAddress(generatePrivateKey())
await run('B. atomic batch, swap reverts: approve → swap(minOut too high) → send 1 B', [
  approve(amount, true),
  swap(amount + 1n, true),
  sendB(stranger),
])
await show('after B')

await run('C. no batch flag, swap reverts: approve → swap(minOut too high) → send 1 B', [
  approve(amount, false),
  swap(amount + 1n, false),
  sendB(stranger),
])
const end = await show('after C')

if (!DRY_RUN && end.allowance !== 0n) {
  await run('cleanup: reset the dangling allowance', [approve(0n, false)])
  await show('after cleanup')
}
