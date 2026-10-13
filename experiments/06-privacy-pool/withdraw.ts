// Withdrawals with the pool as tx.sender and no signature: four mined transactions.
//
//   storage, pool pays     [P VERIFY scope 3, W]                         note storage/0, an old root
//   storage, sponsor pays  [P VERIFY scope 2, sponsor VERIFY, W]         note storage/1
//   keyed, pool pays       [8272 verifier, P VERIFY scope 3, W]          note keyed/0
//   keyed, sponsor pays    [8272 verifier, P VERIFY scope 2, sponsor, W] note keyed/1
//
// usage: npx tsx experiments/06-privacy-pool/withdraw.ts [--dry-run]
import { type Address, formatEther } from 'viem'
import { execute } from '../../src/execute.js'
import { makeClient } from '../../src/frametx/index.js'
import { keyedPool, keyedSponsor, note, recipient, storagePool, storageSponsor } from './deployment.js'
import {
  type FramePoolInstance,
  type PoolProof,
  PoolMode,
  isSpent as spent,
  poolAbi,
  poolLeaves,
  prove,
  recentRoots,
  withdrawalTx,
} from './pool.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())

const isSpent = (pool: FramePoolInstance, nullifierHash: `0x${string}`) => spent(client, pool, nullifierHash)

// The pools' roots against the Rust tree, before anything relies on them.
for (const pool of [storagePool, keyedPool]) {
  const leaves = await poolLeaves(client, pool.address)
  const onChain = await client.readContract({ address: pool.address, abi: poolAbi, functionName: 'getLastRoot' })
  const local = prove(note(pool === storagePool ? 'storage/0' : 'keyed/0'), leaves, recipient('check'), pool.address).inputs.root
  if (onChain !== local) throw new Error(`${pool.label}: on-chain root ${onChain} != Rust tree root ${local}`)
  console.log(`${pool.label}: ${leaves.length} leaves, root ${onChain} matches the Rust tree`)
}

async function withdraw(label: string, pool: FramePoolInstance, noteLabel: string, sponsor?: Address, rootAfter?: number) {
  console.log(`\n### ${label}`)
  const n = note(noteLabel)
  if (await isSpent(pool, n.nullifierHash)) {
    console.log(`${noteLabel} already withdrawn`)
    return
  }
  const leaves = await poolLeaves(client, pool.address)
  const to = recipient(noteLabel)
  // rootAfter = k proves against the root as it was after k deposits.
  const proof: PoolProof = prove(n, leaves.slice(0, rootAfter ?? leaves.length), to, sponsor ?? pool.address)
  let slot: bigint | undefined
  if (pool.mode === PoolMode.KEYED) {
    const rr = (await recentRoots(client, pool.address)).filter((r) => r.root === proof.inputs.root).at(-1)
    if (!rr) throw new Error('the proof root was never published to EIP-8272')
    slot = rr.slot
  }
  const nonce = BigInt(await client.getTransactionCount({ address: pool.address }))
  const tx = withdrawalTx({ chainId, pool, proof, sponsor, slot, nonce })
  console.log(`note ${noteLabel} leaf ${proof.leafIndex}, root ${proof.inputs.root}, recipient ${to}`)
  const { receipt } = await execute(client, tx, [], { label })
  if (receipt) {
    const balance = await client.getBalance({ address: to })
    console.log(`recipient balance ${formatEther(balance)} ETH; spent: ${await isSpent(pool, n.nullifierHash)}`)
  }
}

await withdraw('storage pool, pool pays, root after the first deposit', storagePool, 'storage/0', undefined, 1)
await withdraw('storage pool, sponsor pays', storagePool, 'storage/1', storageSponsor.address)
await withdraw('keyed pool, pool pays', keyedPool, 'keyed/0')
await withdraw('keyed pool, sponsor pays', keyedPool, 'keyed/1', keyedSponsor.address)
