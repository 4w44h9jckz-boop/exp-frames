// Experiment 53, the second arm (README, "Addendum"): after delegating, the owner re-commits its
// state under fresh randomness on its own. What do the shares the members kept still open?
//
//   N2 deposit   this experiment's account deposits note N2                         mined
//   committee    N2's opening shared, proved, withdrawn to the owner's fresh address R mined
//   re-commit    R, topped up for gas, deposits N3 with fresh randomness             mined
//   after        members 0 and 1's files for N2, rebuilt; N2 spent?; N3's opening in them?
//
// usage: RUN=<label> npx tsx experiments/53-committee-export/arm2.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Address, type Hex, concatHex, keccak256, slice, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { REPO_ROOT } from '../../src/contracts.js'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { frameReceiptGas, frameReceiptStatus, makeClient, senderFrame, sendFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/frametx/index.js'
import { keyedPool } from '../06-privacy-pool/deployment.js'
import { FEE, type PoolProof, depositFrame, isSpent, poolLeaves, recentRoots, withdrawalTx } from '../06-privacy-pool/pool.js'

const DIR = 'experiments/53-committee-export'
const BIN = process.env.CO_WITHDRAW_BIN ?? resolve(REPO_ROOT, '../4w44h9jckz-boop/exp-e2e-frames/committee/target/release')
const RUN = process.env.RUN ?? `${Date.now()}`
const work = resolve(REPO_ROOT, DIR, 'work', `arm2-${RUN}`)
mkdirSync(work, { recursive: true })
const sh = (bin: string, args: string[]) => execFileSync(resolve(BIN, bin), args, { cwd: work, encoding: 'utf8', maxBuffer: 1 << 26 })

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey } = loadKey()
const derive = (l: string) => keccak256(concatHex([privateKey, toHex(`exp-frames/53/arm2/${RUN}/${l}`)]))
const rKey = derive('owner/R')
const R: Address = privateKeyToAddress(rKey)
const noteOf = (l: string) => concatHex([slice(derive(`${l}/nullifier`), 0, 31), slice(derive(`${l}/secret`), 0, 31)])
const info = (hex: Hex) => JSON.parse(sh('committee-tool', ['note', hex])) as { commitment: Hex; nullifierHash: Hex }

type Row = { step: string; outcome: string; hash?: Hex; block?: string; gasUsed?: string }
const rows: Row[] = []
const record: Record<string, unknown> = { run: RUN, coWithdraw: 'exp-e2e-frames c8eb5cc80df46fec185367fdb7758d1b528c950f', pool: keyedPool.address, R }

async function as(step: string, key: Hex, frames: Parameters<typeof sendFrames>[2]) {
  const r = await sendFrames(client, key, frames, { label: step })
  if (!r?.hash || !r.receipt) throw new Error(`${step}: not mined`)
  rows.push({ step, outcome: 'mined', hash: r.hash, block: BigInt(r.receipt.blockNumber).toString(), gasUsed: BigInt(r.receipt.gasUsed).toString() })
}

// ---- N2: deposit, delegate, withdraw to R ----

const n2 = noteOf('N2')
const N2 = info(n2)
record.N2 = N2
const done = await isSpent(client, keyedPool, N2.nullifierHash) // a rerun resumes after N2's withdrawal
if (!(await poolLeaves(client, keyedPool.address)).includes(N2.commitment)) {
  await as('N2: this experiment\'s account deposits note N2', privateKey, [depositFrame(keyedPool.address, N2.commitment)])
}
const leaves = await poolLeaves(client, keyedPool.address)
writeFileSync(resolve(work, 'leaves.json'), JSON.stringify(leaves))
if (!done) {
  sh('committee-tool', ['inputs', n2, 'leaves.json', R, keyedPool.address, toHex(FEE), 'inputs.json'])
  sh('co-withdraw', ['split', '--inputs', 'inputs.json', '--out-dir', 'shares'])
  sh('co-withdraw', ['local', '--shares', 'shares', '--out', 'members.json', '--port', '10030'])
}
const members = JSON.parse(readFileSync(resolve(work, 'members.json'), 'utf8')) as { solidity: Hex; publicInputs: string[]; verified: boolean }[]
if (!members.every((m) => m.verified && m.solidity === members[0].solidity)) throw new Error('the members disagree, or the proof does not verify')
const hex = (d: string) => toHex(BigInt(d), { size: 32 })
const [root, nh, rcpt, relayer, fee, refund] = members[0].publicInputs
const proof: PoolProof = {
  leafIndex: leaves.indexOf(N2.commitment),
  commitment: N2.commitment,
  inputs: { root: hex(root), nullifierHash: hex(nh), recipient: slice(hex(rcpt), 12), relayer: slice(hex(relayer), 12), fee: toHex(BigInt(fee)), refund: toHex(BigInt(refund)) },
  proof: members[0].solidity,
}
const slot = done ? 0n : (await recentRoots(client, keyedPool.address)).filter((r) => r.root === proof.inputs.root).at(-1)?.slot
if (slot === undefined) throw new Error('root not published')
if (!done) {
  const tx = withdrawalTx({ chainId, pool: keyedPool, proof, slot })
  const sim = await simulateFrameTx(client, tx)
  if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`withdrawal: ${sim.violation ?? sim.executionError}`)
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  if (!r.frameReceipts.every((f) => frameReceiptStatus(f) === 1)) throw new Error('withdrawal: a frame failed')
  const frames = r.frameReceipts.map((f) => frameReceiptGas(f).execution).join(' / ')
  console.log(`N2 withdrawn to R by the committee's proof: ${hash}, block ${BigInt(r.blockNumber)}, frames ${frames}`)
  rows.push({ step: "N2: the committee's proof, withdrawing to the owner's fresh address R", outcome: 'mined', hash, block: BigInt(r.blockNumber).toString(), gasUsed: BigInt(r.gasUsed).toString() })
}

// ---- the re-commit: R deposits N3 under fresh randomness ----

await as("top-up: gas for R, from this experiment's account", privateKey, [senderFrame({ target: R, value: 10n ** 16n, execution: 30_000n })])
const n3 = noteOf('N3')
const N3 = info(n3)
record.N3 = N3
await as('re-commit: R deposits N3, fresh randomness, no committee', rKey, [depositFrame(keyedPool.address, N3.commitment)])

// ---- what the retained shares open ----

const after = JSON.parse(sh('committee-tool', ['reconstruct', 'shares', 'inputs.json']))
const inputs = JSON.parse(readFileSync(resolve(work, 'inputs.json'), 'utf8'))
const n3Opening = [BigInt(slice(n3, 0, 31)), BigInt(slice(n3, 31))]
const opened = [BigInt(after.nullifierReadByMembers01), BigInt(after.secretReadByMembers01)]
const result = {
  pairsRebuildN2: after.pairs.every((p: { equalsWitness: boolean }) => p.equalsWitness),
  n2OpeningRead: opened[0] === BigInt(inputs.nullifier) && opened[1] === BigInt(inputs.secret),
  n2Spent: await isSpent(client, keyedPool, N2.nullifierHash),
  n3OpeningInRetainedShares: opened.some((v) => n3Opening.includes(v)),
  n3Live: !(await isSpent(client, keyedPool, N3.nullifierHash)) && (await poolLeaves(client, keyedPool.address)).includes(N3.commitment),
  chainLink: `N2's withdrawal paid R (${R}); R's own deposit put N3 in the pool: the chain links N2 to N3's leaf, though not to N3's opening`,
}
console.log(JSON.stringify(result, null, 2))
record.after = result
record.rows = rows
writeFileSync(resolve(REPO_ROOT, DIR, `record-arm2-${RUN}.json`), `${JSON.stringify(record, null, 2)}\n`)
for (const r of rows) console.log(`| ${r.step} | ${r.outcome} | ${r.hash ?? ''} | ${r.block ?? ''} | ${r.gasUsed ?? ''} |`)
process.exit(0)
