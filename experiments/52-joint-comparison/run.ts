// Experiment 52: Alice and Bob compare sealed bids with no committee. One joint Groth16 proof,
// made over additive shares with Paillier for the cross terms, settles in one frame transaction;
// bonds and deadlines price an abort.
//
// Setup  deploy the verifier and SealedPair; fund Alice, Bob, and the contract's gas
//   open/join  Alice opens sessions 1 to 5, Bob joins 1, 3, 4 and 5                   mined
//   S3   the joint prover stops partway (Bob stops answering)                         off chain
//   S1   joint proof; Alice posts her share; refusals; Bob settles                     mined
//   S4   joint proof; Alice posts her share; Bob stops                                 mined
//   S5   the control: snarkjs alone, given both bids; settled the same way             mined
//   S2, S3, S4 after their deadlines: a late settlement refused; each reclaim          mined
//
// usage: npx tsx experiments/52-joint-comparison/run.ts
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Hex, concatHex, formatEther, keccak256, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { REPO_ROOT } from '../../src/contracts.js'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  frameReceiptGas,
  frameReceiptStatus,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  sendFrameTx,
  signFrameTx,
  simulateFrameTx,
  verifyFrame,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { Channel, type Session, commit, combine, jointProve, jointWitness, outputOf, singleProve } from './joint.js'
import * as P from './paillier.js'
import { DIR, joinFrame, openFrame, pair, pairAbi, proofWords, reclaimFrame, revealFrame, sessionOf, settleTx, verifier } from './pair.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey } = loadKey()
const derive = (l: string) => keccak256(concatHex([privateKey, toHex(`exp-frames/52/${l}`)]))
const aliceKey = derive('alice')
const bobKey = derive('bob')
const alice = privateKeyToAddress(aliceKey)
const bob = privateKeyToAddress(bobKey)
const BOND = 10n ** 15n
const field = (l: string) => BigInt(derive(l)) >> 8n

type Row = { step: string; outcome: string; hash?: Hex; block?: bigint; gasUsed?: bigint; frames?: string }
const rows: Row[] = []
const record: Record<string, unknown> = {}

async function mine(step: string, tx: FrameTx) {
  const sim = await simulateFrameTx(client, tx)
  if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${step}: ${sim.violation ?? sim.executionError}`)
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  const frames = r.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f)}:${g.execution}${g.state ? `+${g.state}s` : ''}`
  })
  console.log(`${step}: ${hash} block ${BigInt(r.blockNumber)} gasUsed ${BigInt(r.gasUsed)} frames ${frames.join(' / ')}`)
  rows.push({ step, outcome: 'mined', hash, block: BigInt(r.blockNumber), gasUsed: BigInt(r.gasUsed), frames: frames.join(' / ') })
  if (!r.frameReceipts.every((f) => frameReceiptStatus(f) === 1)) throw new Error(`${step}: a frame failed`)
  return hash
}

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

/** A call from an owner's account, through sendFrames, kept as a row. */
async function as(step: string, key: Hex, frames: Parameters<typeof sendFrames>[2]) {
  const r = await sendFrames(client, key, frames, { label: step })
  if (!r?.hash || !r.receipt) throw new Error(`${step}: not mined`)
  rows.push({ step, outcome: 'mined', hash: r.hash, block: BigInt(r.receipt.blockNumber), gasUsed: BigInt(r.receipt.gasUsed) })
  return r.hash
}

/** An owner's own transaction, signed, not sent: for the refusals. */
async function ownerTx(key: Hex, frames: Frame[]) {
  const tx = await prepareFrameTx(client, {
    sender: privateKeyToAddress(key),
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), ...frames],
    signatures: [secp256k1Placeholder()],
  })
  return signFrameTx(tx, key)
}

const chainTime = async () => (await client.getBlock()).timestamp
async function waitUntil(t: bigint) {
  while ((await chainTime()) <= t) await new Promise((r) => setTimeout(r, 6000))
}
const balances = async () => ({ alice: await client.getBalance({ address: alice }), bob: await client.getBalance({ address: bob }) })

// ---- setup ----

console.log(`SealedPair ${pair.address}, verifier ${verifier.address}; Alice ${alice}, Bob ${bob}`)
if (!(await client.getCode({ address: pair.address }))) {
  await as('setup: deploy the verifier and SealedPair, fund Alice, Bob and the contract', privateKey, [
    verifier.deploy,
    pair.deploy,
    senderFrame({ target: alice, value: 2n * 10n ** 16n, execution: 30_000n, state: 183_600n }),
    senderFrame({ target: bob, value: 2n * 10n ** 16n, execution: 30_000n, state: 183_600n }),
    senderFrame({ target: pair.address, value: 3n * 10n ** 16n, execution: 30_000n }),
  ])
}

// The bids: Alice 700, Bob 650, each with its commitment's randomness. A session label of its own
// per run keeps reruns apart.
const RUN = process.env.RUN ?? `${Date.now()}`
const A = { x: 700n, r: field(`alice/r/${RUN}`) }
const B = { x: 650n, r: field(`bob/r/${RUN}`) }
const Ca = commit(A.x, A.r)
const Cb = commit(B.x, B.r)
const ids = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [i, sessionOf(`${RUN}/${i}`)])) as Record<number, bigint>
const sess = (i: number): Session => ({ Ca, Cb, session: ids[i] })
record.run = RUN
record.sessions = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, toHex(v)]))
record.Ca = toHex(Ca)
record.Cb = toHex(Cb)

const now = await chainTime()
const deadline: Record<number, bigint> = { 1: now + 1200n, 2: now + 60n, 3: now + 60n, 4: now + 480n, 5: now + 1200n }
record.deadlines = Object.fromEntries(Object.entries(deadline).map(([k, v]) => [k, v.toString()]))
const before = await balances()

await as('open: Alice opens sessions 1 to 5, a bond each', aliceKey, [1, 2, 3, 4, 5].map((i) => openFrame(ids[i], Ca, bob, deadline[i], BOND)))
await as('join: Bob joins sessions 1, 3, 4 and 5', bobKey, [1, 3, 4, 5].map((i) => joinFrame(ids[i], Cb, BOND)))

// Alice's Paillier key, made once, for every session.
const t0 = Date.now()
const keys = P.keygen()
console.log(`Alice's Paillier key: ${Date.now() - t0} ms`)

// ---- S3: the joint prover stops partway ----

{
  const ch = new Channel()
  const stopAt = 5 // Bob stops before answering level 2
  const send = ch.send.bind(ch)
  ch.send = (from, what, bytes) => {
    if (ch.flights.length + 1 >= stopAt && from === 'B') throw new Error(`Bob stopped at flight ${ch.flights.length + 1}: ${what}`)
    send(from, what, bytes)
  }
  try {
    await jointWitness(ch, keys, A, B, sess(3))
    throw new Error('S3 did not stop')
  } catch (e) {
    console.log(`S3: ${(e as Error).message}; flights before it ${ch.flights.length}, ${ch.bytes()} bytes`)
    rows.push({ step: 'S3. the joint prover: Bob stops answering at level 2', outcome: (e as Error).message })
    record.s3 = { stoppedAfter: ch.flights }
  }
}

// ---- S1 and S4: the joint proof, then Alice's share on chain ----

async function joint(i: number) {
  const ch = new Channel()
  const t = Date.now()
  const { wA, wB } = await jointWitness(ch, keys, A, B, sess(i))
  const tw = Date.now() - t
  const p = await jointProve(ch, keys, wA, wB)
  const tp = Date.now() - t - tw
  console.log(`S${i}: joint witness ${tw} ms, joint prover ${tp} ms; ${ch.flights.length} flights, Alice ${ch.bytes('A')} B, Bob ${ch.bytes('B')} B`)
  record[`s${i}`] = { witnessMs: tw, proveMs: tp, flights: ch.flights, pi_a: p.pi_a, pi_b: p.pi_b, aliceShare: p.cA }
  return p
}

const p1 = await joint(1)
await as("S1. Alice posts her share of pi_c", aliceKey, [revealFrame(ids[1], p1.cA)])
// Bob, who alone holds both shares now, learns the output first.
const proof1 = await combine(p1.pi_a, p1.pi_b, p1.cA, p1.cB)
const out1 = await outputOf(proof1, sess(1))
if (out1 !== 1n) throw new Error(`S1: the joint proof is valid for ${out1}`)
console.log(`S1: Bob combines the shares; the proof is valid for out = ${out1}`)
await refused('S1. refused: the settlement with out flipped', settleTx({ chainId, session: ids[1], deadline: deadline[1], out: 0n, proof: proofWords(proof1) }))
await refused('S1. refused: a reclaim before the deadline', await ownerTx(aliceKey, [reclaimFrame(ids[1])]))
await mine('S1. Bob settles: one frame transaction, the joint proof checked in VERIFY', settleTx({ chainId, session: ids[1], deadline: deadline[1], out: out1, proof: proofWords(proof1) }))

const p4 = await joint(4)
await as("S4. Alice posts her share of pi_c", aliceKey, [revealFrame(ids[4], p4.cA)])
const out4 = await outputOf(await combine(p4.pi_a, p4.pi_b, p4.cA, p4.cB), sess(4))
console.log(`S4: Bob learns out = ${out4} and stops`)
record.s4out = String(out4)

// ---- S5: the control ----

const t5 = Date.now()
const proof5 = await singleProve(A, B, sess(5))
console.log(`S5: snarkjs alone, ${Date.now() - t5} ms; valid for out = ${await outputOf(proof5, sess(5))}`)
await mine('S5. the control: the same statement proved by one prover, settled the same way', settleTx({ chainId, session: ids[5], deadline: deadline[5], out: 1n, proof: proofWords(proof5) }))

// ---- after the deadlines ----

await waitUntil(deadline[3])
await as('S2. after the deadline, Bob never joined: Alice reclaims her bond', aliceKey, [reclaimFrame(ids[2])])
await as('S3. after the deadline, the prover stopped: each reclaims its own bond', bobKey, [reclaimFrame(ids[3])])
await waitUntil(deadline[4])
const p4full = await combine(p4.pi_a, p4.pi_b, p4.cA, p4.cB)
await refused('S4. refused: Bob settles after the deadline', settleTx({ chainId, session: ids[4], deadline: deadline[4], out: out4 ?? 1n, proof: proofWords(p4full) }))
await as("S4. after the deadline, Bob stopped after Alice's share: Alice takes both bonds", aliceKey, [reclaimFrame(ids[4])])

const after = await balances()
record.balances = { before: { alice: before.alice.toString(), bob: before.bob.toString() }, after: { alice: after.alice.toString(), bob: after.bob.toString() } }
const steps = await client.getContractEvents({ address: pair.address, abi: pairAbi, eventName: 'Step', fromBlock: 'earliest' })
record.steps = steps.filter((s) => Object.values(ids).includes(BigInt(s.args.session as Hex))).map((s) => ({ tx: s.transactionHash, session: s.args.session, state: String(s.args.state), x: String(s.args.x), y: String(s.args.y) }))
record.rows = rows.map((r) => ({ ...r, block: r.block?.toString(), gasUsed: r.gasUsed?.toString() }))
writeFileSync(resolve(REPO_ROOT, DIR, `record-${RUN}.json`), `${JSON.stringify(record, null, 2)}\n`)

console.log('\n| Step | Outcome | Tx | Block | gasUsed | Frames |\n|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.step} | ${r.outcome} | ${r.hash ?? ''} | ${r.block ?? ''} | ${r.gasUsed ?? ''} | ${r.frames ?? ''} |`)
console.log(`Alice ${formatEther(before.alice)} -> ${formatEther(after.alice)}; Bob ${formatEther(before.bob)} -> ${formatEther(after.bob)} (bond ${formatEther(BOND)})`)
process.exit(0)
