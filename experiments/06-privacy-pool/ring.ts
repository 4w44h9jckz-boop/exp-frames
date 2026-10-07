// A root history kept in a ring (Tornado keeps 30 roots; this pool keeps 2) against one that
// keeps every root. A withdrawal proven against a root stays valid in the append-only pool; in
// the ring it turns invalid once enough deposits have rotated its root out, and every pending
// withdrawal built on that root goes with it.
//
//   1. deposit ring/0, prove ring/0 against the root after it, simulate     -> valid
//   2. deposit ring/1, simulate the same transaction                        -> valid (2 roots)
//   3. deposit ring/2, simulate the same transaction                        -> invalid
//   4. prove again against the current root and withdraw (mined)
//
// One shot: once the pool has deposits, it only reports. usage: npx tsx experiments/06-privacy-pool/ring.ts
import { execute } from '../../src/execute.js'
import { type FrameTx, makeClient, simulateFrameTx } from '../../src/frametx/index.js'
import { note, recipient, ringPool, sendFrames } from './deployment.js'
import { depositFrame, hasCode, isSpent, poolAbi, poolLeaves, prove, withdrawalTx } from './pool.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())

if (!(await hasCode(client, ringPool.address))) await sendFrames(client, [ringPool.deploy], 'deploy the ring pool (history 2)')
const index = await client.readContract({ address: ringPool.address, abi: poolAbi, functionName: 'nextIndex' })
if (index > 0n) {
  console.log(`${ringPool.address} has ${index} deposits: already run (results in the README)`)
  process.exit(0)
}

const deposit = (label: string) => sendFrames(client, [depositFrame(ringPool.address, note(label).commitment)], `deposit ${label}`)
const nonce = async () => BigInt(await client.getTransactionCount({ address: ringPool.address }))
async function simulate(step: string, tx: FrameTx) {
  const sim = await simulateFrameTx(client, tx)
  const verify = sim.frames?.[0] ? BigInt(sim.frames[0].gasUsed) : undefined
  console.log(`${step}: valid=${sim.valid} ${sim.valid ? `VERIFY ${verify} gas` : sim.violation}`)
}

await deposit('ring/0')
const first = prove(note('ring/0'), await poolLeaves(client, ringPool.address), recipient('ring/0'), ringPool.address)
const tx = withdrawalTx({ chainId, pool: ringPool, proof: first, nonce: await nonce() })
await simulate('1. after 1 deposit, root R1 is the newest', tx)
await deposit('ring/1')
await simulate('2. after 2 deposits, R1 is the older of two', tx)
await deposit('ring/2')
await simulate('3. after 3 deposits, R1 has rotated out', tx)

const fresh = prove(note('ring/0'), await poolLeaves(client, ringPool.address), recipient('ring/0'), ringPool.address)
await execute(client, withdrawalTx({ chainId, pool: ringPool, proof: fresh, nonce: await nonce() }), [], {
  label: '4. ring/0 proven again against the current root',
})
console.log(`ring/0 spent: ${await isSpent(client, ringPool, note('ring/0').nullifierHash)}`)
