// Experiment 42: the transfer as a frame transaction. Deploys NotePool against Barretenberg's
// zero-knowledge verifier and the Poseidon2 hasher, deposits four notes, proves a transfer of two
// of them, and builds the transaction with one EIP-8250 nonce key per nullifier. Each transaction
// is simulated and offered to the testnet, and every answer is recorded, whatever it is.
//
// The same is then done with a second NotePool whose verifier is AcceptAnyProof, to separate the
// verifier's gas from everything else the transfer asks of the chain; the real proof is checked
// by eth_call against Barretenberg's verifier for both.
//
// The proof comes from the wallet's prover, build/prove.mjs, run where Noir and bb.js are
// installed (NOIR_PROVER_DIR, default ../noirwork).
//
// usage: npx tsx experiments/42-noir-transfer/pool.ts [--dry-run]     the two pools, proved by build/prove.mjs
//        npx tsx experiments/42-noir-transfer/pool.ts --rust [--dry-run]  then a second transfer, from kohaku-rs
//        npx tsx experiments/42-noir-transfer/pool.ts --groth16 [--dry-run]  a third pool, on Groth16
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type Address,
  type Hex,
  concatHex,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  toHex,
} from 'viem'
import { REPO_ROOT, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN } from '../../src/execute.js'
import {
  Approve,
  CPSB,
  type Frame,
  type FrameTx,
  MAX_VERIFY_GAS_TESTNET,
  Mode,
  RECENT_ROOT,
  STORAGE_SET_STATE_GAS,
  makeClient,
  rpc,
  senderFrame,
  serializeFrameTx,
  simulateFrameTx,
  verifyFrame,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { HASHER } from './hasher.js'

const DIR = 'experiments/42-noir-transfer'
const file = (f: string) => resolve(REPO_ROOT, DIR, f)
const word = (x: bigint | number) => numberToHex(BigInt(x), { size: 32 })
const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n
const [OWNER, NOTE] = [1n, 2n]

/** Note values are in units of 10^12 wei; the fee is 10^10 wei, far above the transfer's max cost. */
const UNIT = 10n ** 12n
const FEE = 10n ** 10n
const FEES = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }
/** VERIFY: Barretenberg's zero-knowledge verifier measured 3,494,968; the pool's checks around it. */
const VERIFY_EXECUTION = 3_600_000n
/** NotePool's floors for frame 2. */
const INSERT_EXECUTION = 2_500_000n
const INSERT_STATE = 4n * STORAGE_SET_STATE_GAS

const abi = parseAbi([
  'function deposit(bytes32 owner, bytes32 randomness) payable',
  'function transfer(bytes32 root, bytes32 n0, bytes32 n1, bytes32 out0, bytes32 out1, uint256 fee, bytes proof)',
  'function getLastRoot() view returns (bytes32)',
  'function nextIndex() view returns (uint256)',
  'function sourceId() view returns (bytes32)',
  'event Note(bytes32 indexed note, uint256 index)',
  'event RecentRoot(bytes32 root, uint64 slot)',
])

const client = makeClient()
const { privateKey } = loadKey()
const chainId = BigInt(await client.getChainId())

// ---- the pools ----

const verifiers = JSON.parse(readFileSync(file('verifiers.json'), 'utf8')) as { results: { target: string; address: Address }[] }
const HONK = verifiers.results.find((r) => r.target === 'evm')!.address
const ACCEPT_INITCODE = compileYul(`${DIR}/AcceptAnyProof.yul`)
const ACCEPT_SALT = saltOf('exp-frames/42/accept-any-proof')
const ACCEPT = create2Address(ACCEPT_INITCODE, ACCEPT_SALT)
const NOTE_POOL = compileYul(`${DIR}/NotePool.yul`)

const derive = (label: string) => hexToBigInt(keccak256(concatHex([privateKey, toHex(`exp-frames/42/${label}`)]))) % P
const H = async (inputs: bigint[]) => hexToBigInt((await client.call({ to: HASHER, data: concatHex(inputs.map(word)) })).data!)
const proverDir = process.env.NOIR_PROVER_DIR ?? resolve(REPO_ROOT, '../noirwork')
const honkAbi = parseAbi(['function verify(bytes proof, bytes32[] publicInputs) view returns (bool)'])

type Proved = { root: Hex; nullifiers: Hex[]; outHashes: Hex[]; proof: Hex; publicInputs: Hex[]; proveMs: number }

async function receiptOf(label: string, hash: Hex) {
  const r = await rpc<{ blockNumber: Hex; gasUsed: Hex; frameReceipts: { gasUsed: Hex; stateGasUsed?: Hex; status: Hex }[] }>(client, 'eth_getTransactionReceipt', [hash])
  return {
    label,
    hash,
    block: Number(r.blockNumber),
    gasUsed: Number(r.gasUsed),
    frames: r.frameReceipts.map((f) => ({ execution: Number(f.gasUsed), state: Number(f.stateGasUsed ?? '0x0'), status: Number(f.status) })),
  }
}

async function offer(tx: FrameTx) {
  const raw = serializeFrameTx(tx)
  const simulation = await simulateFrameTx(client, tx)
  try {
    return { raw, rawBytes: (raw.length - 2) / 2, simulation, hash: await rpc<Hex>(client, 'eth_sendRawTransaction', [raw]) }
  } catch (e) {
    const err = e as { details?: string; message: string }
    return { raw, rawBytes: (raw.length - 2) / 2, simulation, error: err.details ?? err.message.split('\n')[0] }
  }
}

/**
 * The wallet's prover: `build/prove.mjs` under Node with Noir's and Barretenberg's packages
 * (NOIR_PROVER_DIR), or kohaku-rs's `kohaku-noir-transfer`, which runs Noir's executor and drives
 * Barretenberg's `bb` (KOHAKU_RS_DIR, BB).
 */
function proveWith(prover: 'js' | 'rust', request: unknown, name: string): Proved & { prover: string } {
  const response = resolve(proverDir, `out/transfer.${name}.json`)
  const input = JSON.stringify(request)
  if (prover === 'js') {
    execFileSync('node', [resolve(proverDir, 'prove.mjs'), response], { cwd: proverDir, input, stdio: ['pipe', 'ignore', 'inherit'] })
  } else {
    const crates = process.env.KOHAKU_RS_DIR ?? resolve(REPO_ROOT, '../kohaku-rs/crates')
    const bb = process.env.BB ?? resolve(proverDir, 'node_modules/@aztec/bb.js/build/amd64-linux/bb')
    execFileSync('cargo', ['run', '--quiet', '--release', '-p', 'kohaku-noir-transfer', '--example', 'prove', '--', response], {
      cwd: crates,
      input,
      env: { ...process.env, BB: bb },
      stdio: ['pipe', 'ignore', 'inherit'],
    })
  }
  const proved = JSON.parse(readFileSync(response, 'utf8')) as Proved & { prover?: string }
  return { ...proved, prover: proved.prover ?? 'build/prove.mjs, Noir 1.0.0-rc.6, bb.js 5.2.1' }
}

function transferTx(pool: Address, sourceId: Hex, slot: bigint, proved: Proved, verifyExecution: bigint): FrameTx {
  const [n0, n1] = proved.nullifiers
  return {
    chainId,
    nonceKeys: [hexToBigInt(n0), hexToBigInt(n1)],
    nonceSeq: 0n,
    sender: getAddress(pool),
    frames: [
      {
        mode: Mode.VERIFY,
        flags: Approve.NONE,
        target: RECENT_ROOT,
        limits: { execution: 10_000n, state: 0n },
        value: 0n,
        data: concatHex([sourceId, numberToHex(slot, { size: 8 }), proved.root]),
      },
      // Each nonce key's first use sets a slot, charged to the frame that approves payment.
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: verifyExecution, state: 2n * STORAGE_SET_STATE_GAS }),
      senderFrame({
        target: pool,
        data: encodeFunctionData({ abi, functionName: 'transfer', args: [proved.root, n0, n1, proved.outHashes[0], proved.outHashes[1], FEE, proved.proof] }),
        execution: INSERT_EXECUTION,
        state: INSERT_STATE,
      }),
    ],
    signatures: [],
    fees: FEES,
    blobVersionedHashes: [],
  }
}

/** A verifier (Barretenberg's by default) on a proof and the public inputs the pool would pass it, by eth_call. */
async function honkAccepts(pool: Address, proved: Proved, verifier: Address = HONK) {
  const [n0, n1] = proved.nullifiers
  const inputs = [proved.root, n0, n1, proved.outHashes[0], proved.outHashes[1], word(FEE), word(hexToBigInt(pool))]
  if (inputs.some((x, i) => hexToBigInt(x) !== hexToBigInt(proved.publicInputs[i]))) throw new Error('public inputs out of order')
  return client.readContract({ address: verifier, abi: honkAbi, functionName: 'verify', args: [proved.proof, inputs] })
}

/** The slot EIP-8272 filed a pool's root at, most recently. */
async function slotOf(pool: Address, root: Hex) {
  const roots = await client.getContractEvents({ address: pool, abi, eventName: 'RecentRoot', fromBlock: 'earliest' })
  const filed = roots.filter((r) => r.args.root === root)
  if (!filed.length) throw new Error(`root ${root} was never filed`)
  return filed[filed.length - 1].args.slot as bigint
}

/**
 * One pool, end to end: deploy, deposit four notes, prove a transfer of two of them, and offer the
 * transfer once for each VERIFY limit in `verifyLimits`; then offer the same spend again.
 */
async function runPool(label: string, verifier: Address, verifyLimits: bigint[], target = 'evm', checker: Address = HONK) {
  const initcode = concatHex([NOTE_POOL, pad(verifier), pad(HASHER), keccak256(toHex(`exp-frames/42/${label}/8272`))])
  const salt = saltOf(`exp-frames/42/note-pool/${label}`)
  const pool = create2Address(initcode, salt)
  const txs: Awaited<ReturnType<typeof receiptOf>>[] = []
  const sent = async (what: string, frames: Frame[]) => {
    const done = await sendFrames(client, privateKey, frames, { label: `${label}: ${what}` })
    if (DRY_RUN) process.exit(0)
    if (done?.hash) txs.push(await receiptOf(what, done.hash))
  }

  // The constructor hashes the tree's 32 empty subtrees and appends them to the code it deposits.
  if (!(await client.getCode({ address: pool }))) {
    const deploy = deployFrame(initcode, salt).frame
    await sent('deploy', [{ ...deploy, limits: { execution: 1_500_000n, state: deploy.limits.state + 1152n * CPSB } }])
  }

  // Notes derived from PRIVATE_KEY, so that every run finds the same ones.
  const nsk = derive('nsk')
  const owner = await H([OWNER, nsk])
  const other = await H([OWNER, derive('other/nsk')])
  const deposits = [
    { owner, value: 700n * UNIT, randomness: derive('note/0') },
    { owner: other, value: 5n * UNIT, randomness: derive('note/1') },
    { owner, value: 400n * UNIT, randomness: derive('note/2') },
    { owner: other, value: 9n * UNIT, randomness: derive('note/3') },
  ]
  if ((await client.readContract({ address: pool, abi, functionName: 'nextIndex' })) === 0n) {
    await sent(
      'deposit four notes',
      // The first insertion sets all 32 of the tree's filled-subtree slots, and the pool's index
      // and root; later ones set none.
      deposits.map((d, i) =>
        senderFrame({
          target: pool,
          value: d.value,
          data: encodeFunctionData({ abi, functionName: 'deposit', args: [word(d.owner), word(d.randomness)] }),
          execution: 2_000_000n,
          state: (i === 0 ? 36n : 4n) * STORAGE_SET_STATE_GAS,
        }),
      ),
    )
  }
  const notes = await client.getContractEvents({ address: pool, abi, eventName: 'Note', fromBlock: 'earliest' })
  const leaves: Hex[] = []
  for (const l of notes) leaves[Number(l.args.index)] = l.args.note as Hex
  for (const [i, d] of deposits.entries()) {
    if (hexToBigInt(leaves[i]) !== (await H([NOTE, d.owner, d.value, d.randomness]))) throw new Error(`leaf ${i} is not deposit ${i}`)
  }
  if (!txs.some((t) => t.label === 'deposit four notes')) txs.push(await receiptOf('deposit four notes', notes[0].transactionHash))

  // The proof, over the first four leaves, with this pool as its context.
  const spend = [0, 2].map((index) => ({ index, value: deposits[index].value.toString(), randomness: deposits[index].randomness.toString() }))
  const outs = [
    { owner: other.toString(), value: (600n * UNIT).toString(), randomness: derive('out/0').toString() },
    { owner: owner.toString(), value: (500n * UNIT - FEE).toString(), randomness: derive('out/1').toString() },
  ]
  const request = { nsk: nsk.toString(), spend, outs, fee: FEE.toString(), context: hexToBigInt(pool).toString(), leaves: leaves.slice(0, 4), target }
  const proved = proveWith('js', request, label)
  const [n0, n1] = proved.nullifiers
  console.log(`${label}: proved in ${proved.proveMs} ms; nullifiers ${n0} < ${n1}`)
  // Barretenberg's verifier on the same proof, by eth_call, where no validation budget applies.
  const honkAcceptsByCall = await honkAccepts(pool, proved, checker)

  // The root the proof opens is the pool's, and is filed with EIP-8272 at a slot.
  const slot = await slotOf(pool, proved.root)
  const sourceId = await client.readContract({ address: pool, abi, functionName: 'sourceId' })

  const attempts = []
  for (const limit of verifyLimits) {
    const a = await offer(transferTx(pool, sourceId, slot, proved, limit))
    console.log(label, limit, a.simulation.valid, a.simulation.violation, a.hash ?? a.error)
    if (a.hash) {
      const r = await waitForFrameTxReceipt(client, a.hash)
      txs.push(await receiptOf('transfer', a.hash))
      console.log(label, 'mined in', Number(r.blockNumber))
    }
    attempts.push({ verifyExecution: Number(limit), ...a })
  }
  // The same two notes again, to another output: the nonce keys are used.
  const again = await offer(transferTx(pool, sourceId, slot, proved, verifyLimits[verifyLimits.length - 1]))
  console.log(label, 'again', again.simulation.valid, again.simulation.violation, again.hash ?? again.error)

  return {
    label,
    pool,
    verifier,
    txs,
    transfer: {
      root: proved.root,
      slot: Number(slot),
      nullifiers: proved.nullifiers,
      outHashes: proved.outHashes,
      fee: FEE.toString(),
      proveMs: proved.proveMs,
      proofBytes: (proved.proof.length - 2) / 2,
      honkAcceptsByCall,
      prover: proved.prover,
      attempts,
      again,
    },
  }
}

/**
 * A second transfer in the layout pool, proved by kohaku-rs: the recipient of the first spends
 * the note it received (index 4) with one it deposited (index 1).
 */
async function rustTransfer(pool: Address) {
  const notes = await client.getContractEvents({ address: pool, abi, eventName: 'Note', fromBlock: 'earliest' })
  const leaves: Hex[] = []
  for (const l of notes) leaves[Number(l.args.index)] = l.args.note as Hex
  const nsk = derive('other/nsk')
  const owner = await H([OWNER, derive('nsk')])
  const request = {
    nsk: nsk.toString(),
    spend: [
      { index: 1, value: (5n * UNIT).toString(), randomness: derive('note/1').toString() },
      { index: 4, value: (600n * UNIT).toString(), randomness: derive('out/0').toString() },
    ],
    outs: [
      { owner: owner.toString(), value: (300n * UNIT).toString(), randomness: derive('out/2').toString() },
      { owner: (await H([OWNER, nsk])).toString(), value: (305n * UNIT - FEE).toString(), randomness: derive('out/3').toString() },
    ],
    fee: FEE.toString(),
    context: hexToBigInt(pool).toString(),
    leaves,
    target: 'evm',
  }
  const proved = proveWith('rust', request, 'layout.rust')
  console.log(`layout, from kohaku-rs: proved in ${proved.proveMs} ms by ${proved.prover}`)
  const honkAcceptsByCall = await honkAccepts(pool, proved)
  const slot = await slotOf(pool, proved.root)
  const sourceId = await client.readContract({ address: pool, abi, functionName: 'sourceId' })
  const a = await offer(transferTx(pool, sourceId, slot, proved, MAX_VERIFY_GAS_TESTNET - 10_000n))
  console.log('layout, from kohaku-rs:', a.simulation.valid, a.simulation.violation, a.hash ?? a.error)
  const mined = a.hash ? (await waitForFrameTxReceipt(client, a.hash), await receiptOf('transfer from kohaku-rs', a.hash)) : null
  return {
    pool,
    prover: proved.prover,
    proveMs: proved.proveMs,
    root: proved.root,
    nullifiers: proved.nullifiers,
    outHashes: proved.outHashes,
    honkAcceptsByCall,
    attempt: a,
    mined,
  }
}

if (process.argv.includes('--rust')) {
  // Run once, after the main run: the layout pool's second transfer, proved from kohaku-rs.
  const record = JSON.parse(readFileSync(file('pool.json'), 'utf8')) as { pools: { label: string; pool: Address }[] }
  const result = await rustTransfer(record.pools.find((p) => p.label === 'layout')!.pool)
  if (!DRY_RUN) writeFileSync(file('pool.rust.json'), `${JSON.stringify({ chainId: Number(chainId), ...result }, null, 2)}\n`)
  process.exit(0)
}

if (process.argv.includes('--groth16')) {
  // A third pool, against gnark's Groth16 verifier behind Groth16Adapter, proved through
  // Sunspot: the transfer as it would run if the verifier fits the testnet's budget.
  const g16 = JSON.parse(readFileSync(file('groth16.json'), 'utf8')) as { address: Address }
  const initcode = concatHex([compileYul(`${DIR}/Groth16Adapter.yul`), pad(g16.address)])
  const salt = saltOf('exp-frames/42/groth16-adapter')
  const adapter = create2Address(initcode, salt)
  if (!(await client.getCode({ address: adapter }))) {
    await sendFrames(client, privateKey, [deployFrame(initcode, salt).frame], { label: 'deploy Groth16Adapter' })
    if (DRY_RUN) process.exit(0)
  }
  const result = await runPool('groth16', adapter, [MAX_VERIFY_GAS_TESTNET - 10_000n], 'groth16', adapter)
  const record = { chainId: Number(chainId), block: Number(await client.getBlockNumber()), groth16: g16.address, adapter, ...result }
  if (!DRY_RUN) writeFileSync(file('pool.groth16.json'), `${JSON.stringify(record, null, 2)}\n`)
  process.exit(0)
}

if (!(await client.getCode({ address: ACCEPT }))) {
  await sendFrames(client, privateKey, [deployFrame(ACCEPT_INITCODE, ACCEPT_SALT).frame], { label: 'deploy AcceptAnyProof' })
  if (DRY_RUN) process.exit(0)
}

// The pool as it would be used, against Barretenberg's zero-knowledge verifier: once with the gas
// the verifier needs, once with the gas the testnet allows the prefix.
const zk = await runPool('zk', HONK, [VERIFY_EXECUTION, MAX_VERIFY_GAS_TESTNET - 10_000n])
// The same pool code against AcceptAnyProof, for the layout only.
const layout = await runPool('layout', ACCEPT, [MAX_VERIFY_GAS_TESTNET - 10_000n])

const record = { chainId: Number(chainId), block: Number(await client.getBlockNumber()), hasher: HASHER, honk: HONK, accept: ACCEPT, pools: [zk, layout] }
if (!DRY_RUN) writeFileSync(file('pool.json'), `${JSON.stringify(record, null, 2)}\n`)
