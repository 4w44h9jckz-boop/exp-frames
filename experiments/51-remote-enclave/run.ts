// Experiment 51: a remote enclave, SIMULATED as a process with a sealed key. Two bids encrypted
// to it are posted on the board; it compares them; its output is mined once on its attestation
// and once on its zero-knowledge proof, each checked in VERIFY.
//
// Setup  deploy the verifier and the outcome contract, fund it; provision the enclave
//   post   the two ciphertexts on experiment 33's board                               mined
//   run    the enclave process: output, attestation, proof
//   D0-D2  attestation route: another key signs (D0, refused); the attestation key signs the
//          wrong output (D1) or a measurement that never ran (D2), both expected accepted
//   A      the output on its attestation                                                mined
//   D3-D5  proof route: output flipped, another ciphertext, another enclave key        refused
//   B      the output on its proof                                                      mined
//   D6     a changed enclave source opens the sealed file                               fails off chain
//
// usage: npx tsx experiments/51-remote-enclave/run.ts [--dry-run]
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { p256 } from '@noble/curves/p256'
import { type Hex, concatHex, formatEther, keccak256, numberToHex, toHex } from 'viem'
import { REPO_ROOT } from '../../src/contracts.js'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN } from '../../src/execute.js'
import {
  type FrameTx,
  type P256Key,
  frameReceiptGas,
  frameReceiptStatus,
  makeClient,
  senderFrame,
  sendFrameTx,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { boardMessages } from '../33-owned-state-swap/announce.js'
import { board, postFrame } from '../33-owned-state-swap/swap.js'
import {
  type Ciphertext,
  DIR,
  type EnclaveRun,
  MEASUREMENT,
  Route,
  SUB_ORDER,
  type Statement,
  attest,
  attestationDigest,
  callEnclave,
  ciphertextBytes,
  encrypt,
  outcomeContract,
  outcomeTx,
  verifier,
} from './outcome.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey } = loadKey()
const label = (l: string) => BigInt(keccak256(concatHex([privateKey, toHex(`exp-frames/51/${l}`)])))
const p256Key = (l: string): P256Key => ({ scheme: 'p256', privateKey: numberToHex((label(l) % (p256.CURVE.n - 1n)) + 1n, { size: 32 }) })

// The manufacturer's attestation key, and the machine's fused secret: both SIMULATED, both
// derived here, which is the point: whoever holds them is in the trust path.
const attestationKey = p256Key('attestation')
const deviceSecret = keccak256(concatHex([privateKey, toHex('exp-frames/51/device-secret')]))
const outcome = outcomeContract(attestationKey)

type Row = { step: string; outcome: string; hash?: Hex; block?: bigint; gasUsed?: bigint; frames?: string }
const rows: Row[] = []

async function send(step: string, tx: FrameTx, expect: 'mined' | 'refused' | 'valid'): Promise<void> {
  const sim = await simulateFrameTx(client, tx)
  const ok = sim.valid && sim.executionStatus === 'success'
  if (!ok) {
    let admission = 'not sent'
    if (!sim.valid && !DRY_RUN) {
      try {
        await sendFrameTx(client, tx)
        admission = 'ADMITTED'
      } catch (e) {
        admission = `eth_sendRawTransaction refused: ${(e as Error).message.split('\n')[0].slice(0, 120)}`
      }
    }
    const why = sim.valid ? `valid, but a frame reverts (${sim.executionError})` : `refused: ${sim.violation}`
    console.log(`${step}: ${why}; ${admission}`)
    rows.push({ step, outcome: `${why}; ${admission}` })
    if (expect !== 'refused' || admission === 'ADMITTED') throw new Error(`${step}: expected ${expect}`)
    return
  }
  const simFrames = sim.frames?.map((f) => BigInt(f.gasUsed)).join(' / ')
  if (expect === 'refused') throw new Error(`${step}: expected a refusal, but simulation admits it`)
  if (expect === 'valid' || DRY_RUN) {
    console.log(`${step}: valid in simulation, not sent; gasUsed ${BigInt(sim.gasUsed ?? '0x0')}, frames ${simFrames}`)
    rows.push({ step, outcome: 'valid in simulation, not sent', frames: simFrames })
    return
  }
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  const frames = r.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f)}:${g.execution}${g.state ? `+${g.state}s` : ''}`
  })
  const good = r.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  console.log(`${step}: ${hash} block ${BigInt(r.blockNumber)} gasUsed ${BigInt(r.gasUsed)} frames ${frames.join(' / ')}`)
  rows.push({ step, outcome: good ? 'mined' : 'mined, a frame failed', hash, block: BigInt(r.blockNumber), gasUsed: BigInt(r.gasUsed), frames: frames.join(' / ') })
  if (!good) throw new Error(`${step}: a frame failed`)
}

// ---- setup ----

console.log(`measurement (SHA-256 of enclave.ts) ${MEASUREMENT}`)
console.log(`outcome ${outcome.address}, verifier ${verifier.address}, board ${board.address}`)
const absent = []
for (const c of [verifier, outcome]) if (!(await client.getCode({ address: c.address }))) absent.push(c.deploy)
if (absent.length) {
  // The outcome contract pays for the outputs it records: fund it in the same transaction.
  absent.push(senderFrame({ target: outcome.address, value: 2n * 10n ** 16n, execution: 30_000n }))
  await sendFrames(client, privateKey, absent, { label: 'setup: deploy the verifier and the outcome contract, and fund it' })
  if (DRY_RUN) process.exit(0)
}

// The enclave makes its key and seals it; the host keeps only the sealed file and the public key.
const SEALED_DIR = resolve(REPO_ROOT, DIR, 'sealed')
const SEALED = resolve(SEALED_DIR, 'enclave.sealed.json')
const PK = resolve(SEALED_DIR, 'pk.json')
if (!existsSync(SEALED)) {
  mkdirSync(SEALED_DIR, { recursive: true })
  const p = callEnclave<{ measurement: Hex; pk: [string, string] }>({ cmd: 'provision', sealed: SEALED, attestationKey: attestationKey.privateKey }, deviceSecret)
  if (p.measurement !== MEASUREMENT) throw new Error('the enclave reports another measurement')
  writeFileSync(PK, JSON.stringify(p.pk))
  console.log('provisioned the enclave')
}
const pk = (JSON.parse(readFileSync(PK, 'utf8')) as string[]).map(BigInt) as [bigint, bigint]
console.log(`enclave key pk = (${toHex(pk[0])}, ${toHex(pk[1])})`)

// ---- the bids, encrypted and posted ----

const BIDS = { alice: 700n, bob: 650n }
const cts: Ciphertext[] = [
  encrypt(pk, BIDS.alice, label('r/alice') % SUB_ORDER),
  encrypt(pk, BIDS.bob, label('r/bob') % SUB_ORDER),
]
const posted = new Set((await boardMessages(client, board.address)).map((m) => m.message.toLowerCase()))
if (!cts.every((c) => posted.has(ciphertextBytes(c).toLowerCase()))) {
  await sendFrames(client, privateKey, cts.map((c) => postFrame(ciphertextBytes(c))), { label: "post: Alice's and Bob's bids, encrypted to the enclave" })
  if (DRY_RUN) process.exit(0)
}
const postTx = (await boardMessages(client, board.address)).find((m) => m.message.toLowerCase() === ciphertextBytes(cts[0]).toLowerCase())
console.log(`ciphertexts on the board in ${postTx?.tx}, block ${postTx?.block}`)

// ---- the enclave runs ----

const t0 = Date.now()
const run = callEnclave<EnclaveRun>({ cmd: 'run', sealed: SEALED, ciphertexts: cts.map((c) => c.map(String)) }, deviceSecret)
console.log(`enclave: out ${run.out} in ${Date.now() - t0} ms (process start, unseal, decrypt, sign, prove)`)
const statement: Statement = run.statement.map(BigInt)
if (statement[8] !== BigInt(run.out) || run.measurement !== MEASUREMENT) throw new Error('enclave answer inconsistent')
const [r, s] = run.attestation.map(BigInt)
const zeros = Array(6).fill(0n)
writeFileSync(resolve(SEALED_DIR, 'run.json'), JSON.stringify(run, null, 2))

const attested = (st: Statement, ev: bigint[], m: Hex = MEASUREMENT) => outcomeTx({ chainId, contract: outcome, route: Route.ATTESTED, measurement: m, statement: st, evidence: ev })
const proved = (st: Statement) => outcomeTx({ chainId, contract: outcome, route: Route.PROVED, measurement: `0x${'00'.repeat(32)}`, statement: st, evidence: run.proof.map(BigInt) })
const flipped: Statement = [...statement.slice(0, 8), 1n - statement[8]]

const attestedLog = await client.getContractEvents({ address: outcome.address, abi: (await import('./outcome.js')).outcomeAbi, eventName: 'Outcome', fromBlock: 'earliest' })
const done = new Set(attestedLog.map((l) => l.args.route))

// ---- A and the attestation route's checks ----

if (!done.has(Route.ATTESTED)) {
  const stranger = p256Key('not-the-manufacturer')
  await send('D0. attestation by another P-256 key', attested(statement, [...attest(stranger, attestationDigest(MEASUREMENT, statement)), ...zeros]), 'refused')
  await send('D1. the attestation key signs the wrong output', attested(flipped, [...attest(attestationKey, attestationDigest(MEASUREMENT, flipped)), ...zeros]), 'valid')
  const never = keccak256(toHex('exp-frames/51/a measurement that never ran'))
  await send('D2. the attestation key signs for a measurement that never ran', attested(statement, [...attest(attestationKey, attestationDigest(never, statement)), ...zeros], never), 'valid')
  await send('A. the output, on its attestation (P256VERIFY in VERIFY)', attested(statement, [r, s, ...zeros]), 'mined')
} else console.log('A already mined')

// ---- B and the proof route's checks ----

if (!done.has(Route.PROVED)) {
  await send('D3. the proof, with the output flipped', proved(flipped), 'refused')
  const otherCt = [...statement]
  otherCt[4] = (otherCt[4] + 1n) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n
  await send("D4. the proof, with Alice's ciphertext changed", proved(otherCt), 'refused')
  const otherPk: Statement = [...encrypt(pk, 0n, 1n).slice(0, 2), ...statement.slice(2)] // B8 * 1's coordinates: another key
  await send('D5. the proof, under another enclave key', proved(otherPk), 'refused')
  await send('B. the output, on its zero-knowledge proof (Groth16 in VERIFY)', proved(statement), 'mined')
} else console.log('B already mined')

// ---- D6. a changed enclave cannot open the seal ----

const changed = resolve(SEALED_DIR, 'enclave-changed.ts') // inside the repository, for its node_modules
copyFileSync(resolve(REPO_ROOT, DIR, 'enclave.ts'), changed)
appendFileSync(changed, '\n// one changed line: another measurement\n')
try {
  callEnclave({ cmd: 'run', sealed: SEALED, ciphertexts: cts.map((c) => c.map(String)) }, deviceSecret, changed)
  throw new Error('D6: a changed enclave opened the seal')
} catch (e) {
  const msg = (e as Error).message
  if (msg.startsWith('D6')) throw e
  const reason = /Unsupported state or unable to authenticate data/.test(msg) ? 'AES-GCM refuses: unable to authenticate data' : msg.split('\n')[0].slice(0, 120)
  console.log(`D6. a changed enclave source: ${reason}`)
  rows.push({ step: 'D6. a changed enclave source opens the sealed file', outcome: `fails: ${reason}` })
}

console.log('\n| Step | Outcome | Tx | Block | gasUsed | Frames |\n|---|---|---|---|---|---|')
for (const x of rows) console.log(`| ${x.step} | ${x.outcome} | ${x.hash ?? ''} | ${x.block ?? ''} | ${x.gasUsed ?? ''} | ${x.frames ?? ''} |`)
console.log(`outcome contract balance ${formatEther(await client.getBalance({ address: outcome.address }))} ETH`)
process.exit(0)
