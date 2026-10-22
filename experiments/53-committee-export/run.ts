// Experiment 53: a note's opening handed to a committee. The owner deposits a fresh note in
// experiment 06's keyed pool, secret-shares the withdrawal's witness to co-withdraw's three
// members (exp-e2e-frames c8eb5cc, unmodified), the members prove, and the proof is mined
// through the pool's VERIFY. Then: what two members' files hold.
//
//   deposit   the note's commitment into the keyed pool                              mined
//   split     the owner: inputs from the chain's leaves, then three replicated shares
//   local     the three members prove, over loopback TCP
//   R1        shares of a witness whose secret is changed by one                    no valid proof
//   R2        the committee's proof with another recipient                          refused
//   A         the withdrawal, the committee's proof checked in the pool's VERIFY     mined
//   after     members 0 and 1's files, summed; each member alone
//
// usage: RUN=<label> npx tsx experiments/53-committee-export/run.ts
// CO_WITHDRAW_BIN: the directory with co-withdraw and committee-tool (release builds)
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Address, type Hex, concatHex, formatEther, keccak256, slice, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { REPO_ROOT } from '../../src/contracts.js'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  type FrameTx,
  frameReceiptGas,
  frameReceiptStatus,
  makeClient,
  sendFrameTx,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { keyedPool } from '../06-privacy-pool/deployment.js'
import { DENOMINATION, FEE, type PoolProof, depositFrame, poolLeaves, recentRoots, withdrawalTx } from '../06-privacy-pool/pool.js'

const DIR = 'experiments/53-committee-export'
const BIN = process.env.CO_WITHDRAW_BIN ?? resolve(REPO_ROOT, '../4w44h9jckz-boop/exp-e2e-frames/committee/target/release')
const RUN = process.env.RUN ?? `${Date.now()}`
const work = resolve(REPO_ROOT, DIR, 'work', RUN) // gitignored: the shares hold the note's opening
mkdirSync(work, { recursive: true })
const sh = (bin: string, args: string[]) => execFileSync(resolve(BIN, bin), args, { cwd: work, encoding: 'utf8', maxBuffer: 1 << 26 })

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey } = loadKey()
const derive = (l: string) => keccak256(concatHex([privateKey, toHex(`exp-frames/53/${RUN}/${l}`)]))
const recipient = (l: string): Address => privateKeyToAddress(derive(`recipient/${l}`))

type Row = { step: string; outcome: string; hash?: Hex; block?: bigint; gasUsed?: bigint; frames?: string }
const rows: Row[] = []
const record: Record<string, unknown> = { run: RUN, coWithdraw: 'exp-e2e-frames c8eb5cc80df46fec185367fdb7758d1b528c950f', pool: keyedPool.address }

// ---- the note ----

// 31 bytes of nullifier and 31 of secret, as experiment 06 derives its notes.
const noteHex = concatHex([slice(derive('nullifier'), 0, 31), slice(derive('secret'), 0, 31)])
const { commitment, nullifierHash } = JSON.parse(sh('committee-tool', ['note', noteHex])) as { commitment: Hex; nullifierHash: Hex }
record.commitment = commitment
record.nullifierHash = nullifierHash
console.log(`pool ${keyedPool.address}; note commitment ${commitment}, nullifier hash ${nullifierHash}`)

let leaves = await poolLeaves(client, keyedPool.address)
if (!leaves.includes(commitment)) {
  const r = await sendFrames(client, privateKey, [depositFrame(keyedPool.address, commitment)], { label: 'deposit: the note, 0.001 ETH, into the keyed pool' })
  if (!r?.hash || !r.receipt) throw new Error('deposit not mined')
  rows.push({ step: 'deposit: the note into experiment 06\'s keyed pool', outcome: 'mined', hash: r.hash, block: BigInt(r.receipt.blockNumber), gasUsed: BigInt(r.receipt.gasUsed) })
  leaves = await poolLeaves(client, keyedPool.address)
}
writeFileSync(resolve(work, 'leaves.json'), JSON.stringify(leaves))
record.leafIndex = leaves.indexOf(commitment)
record.leaves = leaves.length

// ---- the owner: inputs and shares ----

const to = recipient('A')
const t0 = Date.now()
sh('committee-tool', ['inputs', noteHex, 'leaves.json', to, keyedPool.address, toHex(FEE), 'inputs.json'])
sh('co-withdraw', ['split', '--inputs', 'inputs.json', '--out-dir', 'shares'])
const splitMs = Date.now() - t0
const shareBytes = [0, 1, 2].map((i) => readFileSync(resolve(work, `shares/share-${i}.bin`)).length)
console.log(`split: ${splitMs} ms; shares ${shareBytes.join(', ')} bytes`)

// ---- the committee ----

type Member = {
  member: number
  solidity: Hex
  publicInputs: string[]
  verified: boolean
  proveMs: number
  peers: { peer: number; messagesSent: number; messagesReceived: number; bytesSent: number; bytesReceived: number }[]
}
const t1 = Date.now()
sh('co-withdraw', ['local', '--shares', 'shares', '--out', 'members.json'])
const localMs = Date.now() - t1
const members = JSON.parse(readFileSync(resolve(work, 'members.json'), 'utf8')) as Member[]
if (!members.every((m) => m.verified && m.solidity === members[0].solidity)) throw new Error('the members disagree, or the proof does not verify')
console.log(`committee: ${localMs} ms in all; proveMs ${members.map((m) => m.proveMs).join(', ')}`)
record.shareBytes = shareBytes
record.splitMs = splitMs
record.localMs = localMs
record.members = members.map(({ member, verified, proveMs, peers }) => ({ member, verified, proveMs, peers }))
record.proof = members[0].solidity
record.publicInputs = members[0].publicInputs

const hex = (d: string) => toHex(BigInt(d), { size: 32 })
const [root, nh, rcpt, relayer, fee, refund] = members[0].publicInputs
const proof: PoolProof = {
  leafIndex: leaves.indexOf(commitment),
  commitment,
  inputs: { root: hex(root), nullifierHash: hex(nh), recipient: slice(hex(rcpt), 12), relayer: slice(hex(relayer), 12), fee: toHex(BigInt(fee)), refund: toHex(BigInt(refund)) },
  proof: members[0].solidity,
}
if (proof.inputs.nullifierHash !== nullifierHash) throw new Error('the proof names another nullifier')
const slot = (await recentRoots(client, keyedPool.address)).filter((r) => r.root === proof.inputs.root).at(-1)?.slot
if (slot === undefined) throw new Error('the proof root was never published')

async function refused(step: string, tx: FrameTx) {
  const sim = await simulateFrameTx(client, tx)
  if (sim.valid && sim.executionStatus === 'success') throw new Error(`${step}: expected a refusal`)
  let admission = 'not sent'
  if (!sim.valid) {
    try {
      await sendFrameTx(client, tx)
      throw new Error(`${step}: admitted`)
    } catch (e) {
      if ((e as Error).message.endsWith('admitted')) throw e
      admission = `eth_sendRawTransaction refused: ${(e as Error).message.split('\n')[0].slice(0, 80)}`
    }
  }
  const why = sim.valid ? `valid, but a frame reverts (${sim.executionError})` : `refused: ${sim.violation}`
  console.log(`${step}: ${why}; ${admission}`)
  rows.push({ step, outcome: `${why}; ${admission}` })
}

// ---- R1: an opening that does not match the note ----

// R1a: the owner's own witness extension, from inputs whose secret is changed by one.
// R1b: the committee given shares of a full witness whose secret wire is changed by one, the
// owner's extension skipped (`split --witness`): the members prove, and the result must not
// verify. In run r1, R1b was run by hand after A, with these same commands (README).
function attempt(what: string, steps: string[][]): string {
  try {
    for (const [bin, ...args] of steps) sh(bin, args)
    return 'A VALID PROOF'
  } catch (e) {
    const m = ((e as { stderr?: string }).stderr ?? (e as Error).message).split('\n').find((l) => l.startsWith('Error')) ?? ''
    return `${what}: ${m.replace(/\/Users\/[^ ]*\//, '')}`.slice(0, 220)
  }
}
{
  const wrong = JSON.parse(readFileSync(resolve(work, 'inputs.json'), 'utf8'))
  wrong.secret = toHex(BigInt(wrong.secret) + 1n)
  writeFileSync(resolve(work, 'inputs-wrong.json'), JSON.stringify(wrong, null, 2))
  const a = attempt('refused by the owner\'s witness extension', [['co-withdraw', 'split', '--inputs', 'inputs-wrong.json', '--out-dir', 'shares-wrong']])
  const b = attempt('refused by the committee', [
    ['committee-tool', 'witness', 'inputs.json', 'witness-wrong.json', '8'],
    ['co-withdraw', 'split', '--witness', 'witness-wrong.json', '--out-dir', 'shares-wrong-witness'],
    ['co-withdraw', 'local', '--shares', 'shares-wrong-witness', '--out', 'members-wrong.json', '--port', '10020'],
  ])
  for (const [step, outcome] of [
    ['R1a. the owner extends a witness with the secret changed by one', a],
    ['R1b. the committee proves over shares of a witness with the secret changed by one', b],
  ]) {
    console.log(`${step}: ${outcome}`)
    rows.push({ step, outcome })
    if (outcome === 'A VALID PROOF') throw new Error(`${step}: a valid proof`)
  }
}

// ---- R2 and A ----

await refused('R2. the committee\'s proof, paying another recipient', withdrawalTx({ chainId, pool: keyedPool, proof: { ...proof, inputs: { ...proof.inputs, recipient: recipient('other') } }, slot }))
{
  const tx = withdrawalTx({ chainId, pool: keyedPool, proof, slot })
  const sim = await simulateFrameTx(client, tx)
  if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`A: ${sim.violation ?? sim.executionError}`)
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  const frames = r.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f)}:${g.execution}${g.state ? `+${g.state}s` : ''}`
  })
  console.log(`A: ${hash} block ${BigInt(r.blockNumber)} gasUsed ${BigInt(r.gasUsed)} frames ${frames.join(' / ')}`)
  rows.push({ step: "A. the withdrawal, the committee's proof checked in the keyed pool's VERIFY", outcome: 'mined', hash, block: BigInt(r.blockNumber), gasUsed: BigInt(r.gasUsed), frames: frames.join(' / ') })
  if (!r.frameReceipts.every((f) => frameReceiptStatus(f) === 1)) throw new Error('A: a frame failed')
  console.log(`recipient ${to}: ${formatEther(await client.getBalance({ address: to }))} ETH (denomination ${formatEther(DENOMINATION)})`)
}

// ---- afterwards: what the members' files hold ----

const after = JSON.parse(sh('committee-tool', ['reconstruct', 'shares', 'inputs.json']))
const inputs = JSON.parse(readFileSync(resolve(work, 'inputs.json'), 'utf8'))
after.nullifierMatches = BigInt(after.nullifierReadByMembers01) === BigInt(inputs.nullifier)
after.secretMatches = BigInt(after.secretReadByMembers01) === BigInt(inputs.secret)
// What two members read, and what it opens: the deposit's commitment, so the deposit and the
// withdrawal are linked. Only booleans go into the committed record; the values stay in `work/`.
after.nullifierReadByMembers01 = undefined
after.secretReadByMembers01 = undefined
console.log(`after: ${JSON.stringify(after)}`)
record.after = after
record.rows = rows.map((r) => ({ ...r, block: r.block?.toString(), gasUsed: r.gasUsed?.toString() }))
writeFileSync(resolve(REPO_ROOT, DIR, `record-${RUN}.json`), `${JSON.stringify(record, null, 2)}\n`)

console.log('\n| Step | Outcome | Tx | Block | gasUsed | Frames |\n|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.step} | ${r.outcome} | ${r.hash ?? ''} | ${r.block ?? ''} | ${r.gasUsed ?? ''} | ${r.frames ?? ''} |`)
process.exit(0)
