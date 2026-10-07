// What VERIFY and the node refuse. Simulations only (ethrex_simulateFrameTransaction against the
// head): nothing is sent, so the `neg` notes stay unspent and the script can be re-run.
//
// usage: npx tsx experiments/06-privacy-pool/negative.ts
import { type Address, hexToBigInt, keccak256, parseEther, toHex } from 'viem'
import { ATOMIC_BATCH_FLAG, type Frame, type FrameTx, makeClient, senderFrame, simulateFrameTx } from '../../src/frametx/index.js'
import { funder, keyedPool, keyedSponsor, note, recipient, stockPool, storagePool, storageSponsor } from './deployment.js'
import {
  FEE,
  type FramePoolInstance,
  type PoolProof,
  PoolMode,
  poolLeaves,
  prove,
  recentRootFrame,
  recentRoots,
  sourceIdOf,
  withdrawCalldata,
  withdrawalTx,
} from './pool.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())

type Built = { tx: FrameTx; proof: PoolProof; slot?: bigint }

/** A withdrawal of `noteLabel` proven against the root right after its own deposit, or the latest. */
async function built(pool: FramePoolInstance, noteLabel: string, relayer?: Address, sponsor?: Address, latest = false): Promise<Built> {
  const n = note(noteLabel)
  const all = await poolLeaves(client, pool.address)
  const leaves = latest ? all : all.slice(0, all.indexOf(n.commitment) + 1)
  const proof = prove(n, leaves, recipient(noteLabel), relayer ?? sponsor ?? pool.address)
  const slot = pool.mode === PoolMode.KEYED ? (await recentRoots(client, pool.address)).filter((r) => r.root === proof.inputs.root).at(-1)?.slot : undefined
  const nonce = BigInt(await client.getTransactionCount({ address: pool.address }))
  return { tx: withdrawalTx({ chainId, pool, proof, sponsor, slot, nonce }), proof, slot }
}

const lastIndex = (tx: FrameTx) => tx.frames.length - 1
const withW = (tx: FrameTx, f: (w: Frame) => Frame): FrameTx => ({ ...tx, frames: tx.frames.map((x, i) => (i === lastIndex(tx) ? f(x) : x)) })
const withFrame = (tx: FrameTx, i: number, f: (x: Frame) => Frame): FrameTx => ({ ...tx, frames: tx.frames.map((x, j) => (j === i ? f(x) : x)) })
const withInputs = (b: Built, inputs: Partial<PoolProof['inputs']>): FrameTx =>
  withW(b.tx, (w) => ({ ...w, data: withdrawCalldata({ ...b.proof, inputs: { ...b.proof.inputs, ...inputs } }) }))

const rows: string[] = []
async function check(label: string, tx: FrameTx) {
  const sim = await simulateFrameTx(client, tx)
  const verifyGas = sim.frames
    ?.map((f, i) => ({ f, i }))
    .filter(({ i }) => tx.frames[i].mode === 1 && tx.frames[i].target === null)
    .map(({ f }) => BigInt(f.gasUsed))[0]
  const said = sim.valid ? `VERIFY ${verifyGas?.toLocaleString('en-US') ?? '?'} gas` : (sim.violation ?? sim.executionError ?? '?')
  const row = `| ${label} | ${sim.valid} | ${said.replaceAll('|', '/')} |`
  rows.push(row)
  console.log(row)
}

// ---- storage pool ----
console.log('\n## storage pool (mode 0), pool pays')
const s = await built(storagePool, 'storage/neg')
await check('valid', s.tx)
await check(
  'an extra SENDER frame moves 0.0005 ETH out of the pool',
  { ...s.tx, frames: [...s.tx.frames, senderFrame({ target: funder, value: parseEther('0.0005'), execution: 30_000n })] },
)
await check('recipient swapped in the withdraw frame', withInputs(s, { recipient: funder }))
await check('fee lowered in the withdraw frame', withInputs(s, { fee: toHex(FEE - 1n) }))
await check('root replaced by one the pool never had', withInputs(s, { root: toHex(12345n, { size: 32 }) }))
await check('a spent note (storage/0)', (await built(storagePool, 'storage/0')).tx)
await check('relayer is not the pool, while the pool pays', (await built(storagePool, 'storage/neg', funder)).tx)
await check('withdraw frame execution limit 99,999', withW(s.tx, (w) => ({ ...w, limits: { ...w.limits, execution: 99_999n } })))
await check('withdraw frame state limit one short of the floor', withW(s.tx, (w) => ({ ...w, limits: { ...w.limits, state: w.limits.state - 1n } })))
await check('withdraw frame carries value', withW(s.tx, (w) => ({ ...w, value: 1n })))
await check('withdraw frame has the atomic-batch flag', withW(s.tx, (w) => ({ ...w, flags: ATOMIC_BATCH_FLAG })))
await check('max fee 20,000 wei: max cost exceeds the note fee', { ...s.tx, fees: { ...s.tx.fees, maxFeePerGas: 20_000n } })
await check('VERIFY limit 100,000 (the spec MAX_VERIFY_GAS)', withFrame(s.tx, 0, (f) => ({ ...f, limits: { ...f.limits, execution: 100_000n } })))
await check('VERIFY limit 500,001 (over the testnet MAX_VERIFY_GAS)', withFrame(s.tx, 0, (f) => ({ ...f, limits: { ...f.limits, execution: 500_001n } })))
const sp = await built(storagePool, 'storage/neg', undefined, storageSponsor.address)
await check('sponsored: valid', sp.tx)
await check('sponsored: the paying sponsor is not the one the note names', withFrame(sp.tx, 1, (f) => ({ ...f, target: keyedSponsor.address })))

// ---- the stock verifier ----
console.log('\n## storage pool with the stock Tornado verifier')
await check('stock verifier: PUSH2 2000, GAS, SUB, STATICCALL', (await built(stockPool, 'stock/0')).tx)

// ---- keyed pool ----
console.log('\n## keyed pool (mode 1), pool pays')
const k = await built(keyedPool, 'keyed/neg')
const nh = hexToBigInt(k.proof.inputs.nullifierHash)
await check('valid, proven against a root of an earlier slot (a later deposit has moved on)', k.tx)
await check('nonce key is not the nullifier hash', { ...k.tx, nonceKeys: [nh + 1n] })
await check('a second nonce key besides the nullifier hash', { ...k.tx, nonceKeys: nh < 1n << 255n ? [nh, 1n << 255n] : [1n, nh] })
await check('legacy nonce key [0]', { ...k.tx, nonceKeys: [0n], nonceSeq: BigInt(await client.getTransactionCount({ address: keyedPool.address })) })
const spent = await built(keyedPool, 'keyed/0', undefined, undefined, true)
await check('a spent note (keyed/0), nonce_seq 0', spent.tx)
await check('a spent note (keyed/0), nonce_seq 1: the protocol nonce matches again', { ...spent.tx, nonceSeq: 1n })
// The keyed pool's first four deposits went in one transaction, so in one slot: each write
// replaced the last under the same storage key, and only the fourth root is still committed.
const [overwritten] = await recentRoots(client, keyedPool.address)
await check(
  'recent-root frame names a root since overwritten in its slot',
  withFrame(k.tx, 0, () => recentRootFrame(sourceIdOf(keyedPool.address, keyedPool.salt), overwritten.slot, overwritten.root)),
)
await check(
  'recent-root frame: slot off by one',
  withFrame(k.tx, 0, () => recentRootFrame(sourceIdOf(keyedPool.address, keyedPool.salt), (k.slot ?? 0n) - 1n, k.proof.inputs.root)),
)
await check(
  'recent-root frame: another salt, so another source',
  withFrame(k.tx, 0, () => recentRootFrame(sourceIdOf(keyedPool.address, keccak256(toHex('other'))), k.slot ?? 0n, k.proof.inputs.root)),
)
await check('no recent-root frame (the storage layout)', { ...k.tx, frames: k.tx.frames.slice(1) })
const ks = await built(keyedPool, 'keyed/neg', undefined, keyedSponsor.address)
await check('sponsored: valid', ks.tx)
await check(
  'sponsored: sponsor frame without state for the nonce key',
  withFrame(ks.tx, 2, (f) => ({ ...f, limits: { ...f.limits, state: 0n } })),
)
await check(
  'pool pays: VERIFY frame without state for the nonce key',
  withFrame(k.tx, 1, (f) => ({ ...f, limits: { ...f.limits, state: 0n } })),
)

console.log(`\n${rows.join('\n')}`)
