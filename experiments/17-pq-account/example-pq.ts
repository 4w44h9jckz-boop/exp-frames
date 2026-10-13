// Experiment 17: a post-quantum account. Three WotsAccounts, one per parameter set, each holding
// a tree of 1,024 one-time WOTS keys; every transaction is signed by the key its nonce selects.
//
// | Frame | Mode   | Flags                         | Target        | Signatures                                  |
// | 0     | VERIFY | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | ARBITRARY, msg ∅: leaf ‖ R ‖ chains ‖ path |
// | 1     | SENDER | -                             | funder        |                                             |
//
//   A  one transfer from each account
//   B  a fee-bump race: attempt 0 and, at once, attempt 1 for the same nonce with fees +25%
//   C  w = 256 without grinding, at the testnet's verification cap and one gas past it
//
// usage: npx tsx experiments/17-pq-account/example-pq.ts [--dry-run]   (after setup.ts)
import { formatEther, parseEther } from 'viem'
import { DRY_RUN } from '../../src/execute.js'
import {
  type FrameTx,
  type FrameTxReceiptJson,
  calldataFloorGas,
  describeReceipt,
  describeSimulation,
  describeTx,
  intrinsicGas,
  rpc,
  sendFrameTx,
  senderFrame,
  simulateFrameTx,
  suggestFees,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { type PqTx, client, funder, pqTx, treeOf, wotsAccount } from './account.js'
import { VARIANTS, derived } from './wots.js'

const variants = Object.values(VARIANTS).map((p) => {
  const t0 = performance.now()
  const tree = treeOf(p)
  const account = wotsAccount(p, tree)
  console.log(`${p.name}: n = ${p.n} B, w = ${1 << p.b}, ${derived(p).l} chains, signature ${derived(p).sigLen} B, root ${tree.root.slice(0, 2 + 2 * p.n)}, account ${account.address} (keys in ${((performance.now() - t0) / 1000).toFixed(1)} s)`)
  return { p, tree, account }
})
const [v32, v16, v256] = variants

for (const { account } of variants) if (!(await client.getCode({ address: account.address }))) throw new Error('run setup.ts first')

const pay = () => senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })

function describe(label: string, { tx, signed, leaf }: PqTx) {
  console.log(`\n=== ${label} ===`)
  console.log(describeTx(tx))
  console.log(`leaf ${leaf} (nonce ${tx.nonceSeq}), ${signed.steps} verification steps, R found on try ${signed.tries}; intrinsic ${intrinsicGas(tx)}, calldata floor ${calldataFloorGas(tx)}`)
}

async function send(label: string, q: PqTx): Promise<FrameTxReceiptJson | undefined> {
  describe(label, q)
  const sim = await simulateFrameTx(client, q.tx)
  console.log(describeSimulation(sim))
  if (DRY_RUN || !sim.valid) return undefined
  const hash = await sendFrameTx(client, q.tx)
  console.log(`sent ${hash}`)
  const r = await waitForFrameTxReceipt(client, hash)
  console.log(describeReceipt(q.tx, r))
  return r
}

// A. One transfer from each account. w = 256 grinds R until verification fits the frame's
// 99,900 gas (the EIP's MAX_VERIFY_GAS of 100,000, less the ARBITRARY entry's 100): measure.ts
// found VERIFY = 8,575 + 87 x steps for it, so at most 1,049 steps, and the work comes in steps
// of 255 (510 + 255 x the checksum's high digit), so 1,020.
await send('A. n = 32, w = 16', await pqTx(v32.tree, v32.account.address, [pay()]))
await send('A. n = 16, w = 16', await pqTx(v16.tree, v16.account.address, [pay()]))
await send('A. n = 16, w = 256, R ground to at most 1,020 steps', await pqTx(v256.tree, v256.account.address, [pay()], { maxSteps: 1_020 }))

// B. Fee bump. Attempt 0 and attempt 1 sign different messages (the fees differ) with different
// one-time keys of the same nonce; whichever is mined, no key has signed twice.
if (!DRY_RUN) {
  console.log('\n=== B. n = 16, w = 16: attempt 0, then at once attempt 1 with fees +25% ===')
  const fees = await suggestFees(client)
  const bumped = { ...fees, maxFeePerGas: (fees.maxFeePerGas * 5n) / 4n, maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 5n) / 4n }
  const first = await pqTx(v16.tree, v16.account.address, [pay()], { fees })
  const second = await pqTx(v16.tree, v16.account.address, [pay()], { fees: bumped, attempt: 1, nonceSeq: first.tx.nonceSeq })
  const sent: [string, FrameTx, string][] = []
  for (const [name, q] of [['attempt 0', first], ['attempt 1, +25%', second]] as const) {
    try {
      sent.push([name, q.tx, await sendFrameTx(client, q.tx)])
    } catch (e) {
      sent.push([name, q.tx, `refused: ${(e as Error).message.split('\n').find((l) => l.startsWith('Details:')) ?? ''}`])
    }
  }
  console.log('pool', JSON.stringify(await rpc(client, 'txpool_status', [])))
  for (const [name, , h] of sent) {
    if (!h.startsWith('0x')) {
      console.log(`${name}: ${h}`)
      continue
    }
    const r = await waitForFrameTxReceipt(client, h as `0x${string}`, { timeoutMs: 30_000 }).catch(() => null)
    console.log(`${name}: ${h} ${r ? `block ${BigInt(r.blockNumber)} gasUsed ${BigInt(r.gasUsed)}` : 'no receipt (replaced)'}`)
  }
}

// C. w = 256 without grinding needs about 2,400 steps. The testnet runs with a verification cap of
// 500,000 rather than the EIP's 100,000: a frame limit of 499,900 is the most it admits.
{
  const fees = await suggestFees(client)
  const over = await pqTx(v256.tree, v256.account.address, [pay()], { verifyGas: 499_901n, fees })
  describe('C. n = 16, w = 256, no grinding, VERIFY limit 499,901', over)
  if (!DRY_RUN) {
    try {
      console.log(`sent ${await sendFrameTx(client, over.tx)} (accepted)`)
    } catch (e) {
      console.log(`refused: ${(e as Error).message.split('\n').find((l) => l.startsWith('Details:')) ?? (e as Error).message}`)
    }
  }
  // A refused transaction has still been shown to the node, so its one-time key counts as used:
  // the next attempt takes the next key.
  await send('C. n = 16, w = 256, no grinding, VERIFY limit 499,900', await pqTx(v256.tree, v256.account.address, [pay()], { verifyGas: 499_900n, fees, attempt: 1, nonceSeq: over.tx.nonceSeq }))
}

for (const { p, account } of variants) {
  const [balance, nonce] = await Promise.all([client.getBalance({ address: account.address }), client.getTransactionCount({ address: account.address })])
  console.log(`${p.name} ${account.address}: ${formatEther(balance)} ETH, nonce ${nonce}`)
}
