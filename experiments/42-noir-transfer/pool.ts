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
// usage: npx tsx experiments/42-noir-transfer/pool.ts [--dry-run]
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
 * One pool, end to end: deploy, deposit four notes, prove a transfer of two of them, and offer the
 * transfer once for each VERIFY limit in `verifyLimits`; then offer the same spend again.
 */
async function runPool(label: string, verifier: Address, verifyLimits: bigint[]) {
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
  const request = { nsk: nsk.toString(), spend, outs, fee: FEE.toString(), context: hexToBigInt(pool).toString(), leaves: leaves.slice(0, 4), target: 'evm' }
  const response = resolve(proverDir, `out/transfer.${label}.json`)
  execFileSync('node', [resolve(proverDir, 'prove.mjs'), response], { cwd: proverDir, input: JSON.stringify(request), stdio: ['pipe', 'ignore', 'inherit'] })
  const proved = JSON.parse(readFileSync(response, 'utf8')) as Proved
  const [n0, n1] = proved.nullifiers
  console.log(`${label}: proved in ${proved.proveMs} ms; nullifiers ${n0} < ${n1}`)

  // Barretenberg's verifier on the same proof and public inputs, by eth_call, where no
  // validation budget applies.
  const inputs = [proved.root, n0, n1, proved.outHashes[0], proved.outHashes[1], word(FEE), word(hexToBigInt(pool))]
  if (inputs.some((x, i) => hexToBigInt(x) !== hexToBigInt(proved.publicInputs[i]))) throw new Error('public inputs out of order')
  const honkAccepts = await client.readContract({ address: HONK, abi: honkAbi, functionName: 'verify', args: [proved.proof, inputs] })

  // The root the proof opens is the pool's, and is filed with EIP-8272 at a slot.
  const roots = await client.getContractEvents({ address: pool, abi, eventName: 'RecentRoot', fromBlock: 'earliest' })
  const filed = roots.filter((r) => r.args.root === proved.root)
  if (!filed.length) throw new Error(`the prover's root ${proved.root} was never filed`)
  const slot = filed[filed.length - 1].args.slot as bigint
  const sourceId = await client.readContract({ address: pool, abi, functionName: 'sourceId' })

  const transferTx = (verifyExecution: bigint): FrameTx => ({
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
  })

  const attempts = []
  for (const limit of verifyLimits) {
    const a = await offer(transferTx(limit))
    console.log(label, limit, a.simulation.valid, a.simulation.violation, a.hash ?? a.error)
    if (a.hash) {
      const r = await waitForFrameTxReceipt(client, a.hash)
      txs.push(await receiptOf('transfer', a.hash))
      console.log(label, 'mined in', Number(r.blockNumber))
    }
    attempts.push({ verifyExecution: Number(limit), ...a })
  }
  // The same two notes again, to another output: the nonce keys are used.
  const again = await offer(transferTx(verifyLimits[verifyLimits.length - 1]))
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
      honkAcceptsByCall: honkAccepts,
      attempts,
      again,
    },
  }
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
