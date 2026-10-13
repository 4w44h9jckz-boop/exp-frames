import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  slice,
  toHex,
} from 'viem'
import { REPO_ROOT, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxFees,
  Mode,
  NEW_ACCOUNT_STATE_GAS,
  NONCE_MANAGER,
  RECENT_ROOT,
  STORAGE_SET_STATE_GAS,
  keyedNonceSlot,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'

const DIR = 'experiments/06-privacy-pool'

// ---- contracts ----

/** Every pool here takes notes of 0.001 ETH. */
export const DENOMINATION = 10n ** 15n

/**
 * The fee every note in this experiment pays: 10^10 wei, far above any max cost at the fees
 * below. The proof binds it, so it is fixed before proving.
 */
export const FEE = 10n ** 10n

/** Base fee sits at 7 wei on the testnet; a 1 wei tip is enough to be included. */
export const POOL_FEES: FrameTxFees = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }

const vendored = (name: string): Hex =>
  (JSON.parse(readFileSync(resolve(REPO_ROOT, DIR, 'vendor', `${name}.json`), 'utf8')) as { bytecode: Hex }).bytecode

/** Tornado's MiMCSponge hasher, from kohaku-rs `crates/fork-kit/fixtures/hasher.json`. */
export const HASHER_INITCODE = vendored('hasher')
/** Tornado's Groth16 verifier, from kohaku-rs `crates/fork-kit/fixtures/verifier.json`. */
export const VERIFIER_INITCODE = vendored('verifier')

/**
 * The stock verifier calls each pairing precompile as `staticcall(sub(gas(), 2000), ...)`:
 * PUSH2 0x07d0, GAS, SUB, STATICCALL. A validation trace may use GAS only immediately before a
 * *CALL, so the stock verifier cannot run in a public-mempool VERIFY frame. Replacing the five
 * bytes before STATICCALL with PUSH0 POP PUSH0 POP GAS keeps the stack effect and every jump
 * offset, and forwards all gas instead of all but 2,000.
 */
export function patchVerifier(initcode: Hex): Hex {
  const stock = '6107d05a03fa'
  const patched = '5f505f505afa'
  const body = initcode.slice(2)
  const count = body.split(stock).length - 1
  if (count !== 3) throw new Error(`expected 3 pairing-precompile calls to patch, found ${count}`)
  return `0x${body.replaceAll(stock, patched)}`
}
export const PATCHED_VERIFIER_INITCODE = patchVerifier(VERIFIER_INITCODE)

export const FRAME_POOL_CODE = compileYul(`${DIR}/FramePool.yul`)
export const POOL_SPONSOR_CODE = compileYul(`${DIR}/PoolSponsor.yul`)

export const PoolMode = { STORAGE: 0, KEYED: 1 } as const

export type PoolConfig = {
  verifier: Address
  hasher: Address
  mode: number
  /** Mode 0 only: 0 keeps every root, H keeps the last H. */
  history: number
  /** Mode 1 only: the EIP-8272 salt; source_id = keccak256(pool || salt). */
  salt: Hex
  label: string
}

export function framePool(c: PoolConfig) {
  const words = [pad(c.verifier), pad(c.hasher), numberToHex(DENOMINATION, { size: 32 }), numberToHex(c.mode, { size: 32 }), numberToHex(c.history, { size: 32 }), c.salt]
  const initcode = concatHex([FRAME_POOL_CODE, ...words])
  const salt = saltOf(`exp-frames/06/${c.label}`)
  return { ...c, initcode, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}
export type FramePoolInstance = ReturnType<typeof framePool>

export function poolSponsor(pool: Address, owner: Address, label: string) {
  const initcode = concatHex([POOL_SPONSOR_CODE, pad(pool), pad(owner)])
  const salt = saltOf(`exp-frames/06/${label}`)
  return { initcode, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}

/** The EIP-8272 source id the predeploy files a pool's roots under. */
export function sourceIdOf(pool: Address, salt: Hex): Hex {
  return keccak256(concatHex([pool, salt]))
}

export const poolAbi = parseAbi([
  'function deposit(bytes32 commitment) payable',
  'function withdraw(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund)',
  'function claim(address who)',
  'function republish()',
  'function getLastRoot() view returns (bytes32)',
  'function nextIndex() view returns (uint256)',
  'function isKnownRoot(bytes32 root) view returns (bool)',
  'function isSpent(bytes32 nullifierHash) view returns (bool)',
  'function owed(address who) view returns (uint256)',
  'function sourceId() view returns (bytes32)',
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  'event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)',
  'event RecentRoot(bytes32 root, uint64 slot)',
])

export function depositFrame(pool: Address, commitment: Hex): Frame {
  return senderFrame({
    target: pool,
    value: DENOMINATION,
    data: encodeFunctionData({ abi: poolAbi, functionName: 'deposit', args: [commitment] }),
    execution: 1_500_000n,
    state: 3_000_000n,
  })
}

// ---- notes and proofs (kohaku-rs `frame-pool` binary) ----

const CLI = process.env.FRAME_POOL_CLI ?? resolve(REPO_ROOT, '../kohaku-rs/crates/target/release/frame-pool')

function cli<T>(args: string[], input?: string): T {
  return JSON.parse(execFileSync(CLI, args, { input, encoding: 'utf8' })) as T
}

export type NoteInfo = { note: Hex; commitment: Hex; nullifierHash: Hex }

/**
 * Notes are derived from PRIVATE_KEY, so the same notes come back on every run and nothing new
 * is stored: nullifier || secret = the first 62 bytes of keccak(base || label) || keccak(...).
 */
export function deriveNote(base: Hex, label: string): NoteInfo {
  const a = keccak256(concatHex([base, toHex(`exp-frames/06/note/${label}`)]))
  const b = keccak256(concatHex([base, toHex(`exp-frames/06/note/${label}/secret`)]))
  return cli<NoteInfo>(['note', concatHex([slice(a, 0, 31), slice(b, 0, 31)])])
}

export type PoolProof = {
  leafIndex: number
  commitment: Hex
  inputs: { root: Hex; nullifierHash: Hex; recipient: Address; relayer: Address; fee: Hex; refund: Hex }
  proof: Hex
}

export function prove(note: NoteInfo, leaves: Hex[], recipient: Address, relayer: Address, fee = FEE): PoolProof {
  const req = { note: note.note, leaves, recipient, relayer, fee: toHex(fee), refund: '0x0' }
  return cli<PoolProof>(['prove'], JSON.stringify(req))
}

// ---- chain reads ----

/** The pool's commitments in insertion order, from its Deposit events. */
export async function poolLeaves(client: PublicClient, pool: Address): Promise<Hex[]> {
  const logs = await client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'Deposit', fromBlock: 'earliest' })
  const leaves: Hex[] = []
  for (const l of logs) leaves[Number(l.args.leafIndex)] = l.args.commitment as Hex
  if (leaves.some((x) => x === undefined)) throw new Error('gap in the deposit events')
  return leaves
}

/** Roots the pool has written to the EIP-8272 predeploy, oldest first. */
export async function recentRoots(client: PublicClient, pool: Address): Promise<{ root: Hex; slot: bigint }[]> {
  const logs = await client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'RecentRoot', fromBlock: 'earliest' })
  return logs.map((l) => ({ root: l.args.root as Hex, slot: l.args.slot as bigint }))
}

/** Spent: in mode 0 the pool's own flag, in mode 1 the nonce key's sequence in NONCE_MANAGER. */
export async function isSpent(client: PublicClient, pool: FramePoolInstance, nullifierHash: Hex): Promise<boolean> {
  if (pool.mode === PoolMode.STORAGE) {
    return client.readContract({ address: pool.address, abi: poolAbi, functionName: 'isSpent', args: [nullifierHash] })
  }
  const v = await client.getStorageAt({ address: NONCE_MANAGER, slot: keyedNonceSlot(pool.address, hexToBigInt(nullifierHash)) })
  return !!v && hexToBigInt(v) > 0n
}

export async function hasCode(client: PublicClient, address: Address): Promise<boolean> {
  const code = await client.getCode({ address })
  return !!code && code !== '0x'
}

// ---- the withdrawal transaction ----

export function withdrawCalldata(p: PoolProof): Hex {
  const i = p.inputs
  return encodeFunctionData({
    abi: poolAbi,
    functionName: 'withdraw',
    args: [p.proof, i.root, i.nullifierHash, i.recipient, i.relayer, hexToBigInt(i.fee), hexToBigInt(i.refund)],
  })
}

/** The EIP-8272 verifier frame for one (source_id, slot, root) tuple. */
export function recentRootFrame(sourceId: Hex, slot: bigint, root: Hex, execution = 10_000n): Frame {
  return {
    mode: Mode.VERIFY,
    flags: Approve.NONE,
    target: RECENT_ROOT,
    limits: { execution, state: 0n },
    value: 0n,
    data: concatHex([sourceId, numberToHex(slot, { size: 8 }), root]),
  }
}

/** State gas the pool requires the withdrawal frame to carry (FramePool.withdrawStateFloor). */
export function withdrawStateFloor(mode: number, relayerIsPool: boolean): bigint {
  return NEW_ACCOUNT_STATE_GAS + (mode === PoolMode.STORAGE ? STORAGE_SET_STATE_GAS : 0n) + (relayerIsPool ? 0n : STORAGE_SET_STATE_GAS)
}

export type WithdrawalOpts = {
  chainId: bigint
  pool: FramePoolInstance
  proof: PoolProof
  /** Who pays: the pool itself, or a PoolSponsor at this address. */
  sponsor?: Address
  /** Mode 1: the recent-root tuple's slot. */
  slot?: bigint
  /** Mode 0: the pool's account nonce. */
  nonce?: bigint
  verifyExecution?: bigint
  fees?: FrameTxFees
}

/**
 * The withdrawal, laid out as FramePool's VERIFY requires. No signatures: `tx.sender` is the
 * pool and the proof is the authorisation.
 */
export function withdrawalTx(o: WithdrawalOpts): FrameTx {
  const { pool, proof } = o
  const keyed = pool.mode === PoolMode.KEYED
  const sponsored = o.sponsor !== undefined
  const firstUse = keyed ? STORAGE_SET_STATE_GAS : 0n // EIP-8250 first use of the nonce key
  const frames: Frame[] = []
  if (keyed) {
    if (o.slot === undefined) throw new Error('a keyed withdrawal needs the recent root slot')
    frames.push(recentRootFrame(sourceIdOf(pool.address, pool.salt), o.slot, proof.inputs.root))
  }
  frames.push(
    verifyFrame({
      scope: sponsored ? Approve.EXECUTION : Approve.EXECUTION_AND_PAYMENT,
      target: null,
      execution: o.verifyExecution ?? 400_000n,
      state: sponsored ? 0n : firstUse,
    }),
  )
  if (sponsored) frames.push(verifyFrame({ scope: Approve.PAYMENT, target: o.sponsor, execution: 10_000n, state: firstUse }))
  frames.push(
    senderFrame({
      target: pool.address,
      data: withdrawCalldata(proof),
      execution: 100_000n,
      state: withdrawStateFloor(pool.mode, !sponsored),
    }),
  )
  return {
    chainId: o.chainId,
    nonceKeys: keyed ? [hexToBigInt(proof.inputs.nullifierHash)] : [0n],
    nonceSeq: keyed ? 0n : (o.nonce ?? 1n),
    sender: getAddress(pool.address),
    frames,
    signatures: [],
    fees: o.fees ?? POOL_FEES,
    blobVersionedHashes: [],
  }
}
