// Experiment 32: the registry and its applications, notes and the shared tree, kernel proofs and
// the update transaction. Addresses come from CREATE2 with label salts, and note secrets from
// PRIVATE_KEY, so every script sees the same contracts and the same notes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildMimcSponge } from 'circomlibjs'
import * as snarkjs from 'snarkjs'
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
  toHex,
} from 'viem'
import { REPO_ROOT, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxFees,
  NEW_ACCOUNT_STATE_GAS,
  NONCE_MANAGER,
  STORAGE_SET_STATE_GAS,
  keyedNonceSlot,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'
import { HASHER_INITCODE, POOL_FEES, recentRootFrame, sourceIdOf } from '../06-privacy-pool/pool.js'

export const DIR = 'experiments/32-owned-state'
const file = (f: string) => resolve(REPO_ROOT, DIR, f)

/** BN254's scalar field, Tornado's FIELD_SIZE: secrets, leaves, nullifiers and roots. */
export const FIELD = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

const word = (x: bigint | number | string) => numberToHex(BigInt(x), { size: 32 })

// ---- contracts ----

/** Experiment 06's MiMC hasher, already on the testnet. */
export const HASHER = create2Address(HASHER_INITCODE, saltOf('exp-frames/06/hasher'))

type Vkey = {
  nPublic: number
  vk_alpha_1: string[]
  vk_beta_2: string[][]
  vk_gamma_2: string[][]
  vk_delta_2: string[][]
  IC: string[][]
}
/** The kernel's verifying key, from `build/kernel.zkey` (README, "The proving key"). */
export const VKEY = JSON.parse(readFileSync(file('build/kernel.vkey.json'), 'utf8')) as Vkey

const g1 = (p: string[]) => [word(p[0]), word(p[1])]
/** A G2 point in EIP-197's order: x1, x0, y1, y0. */
const g2 = (p: string[][]) => [word(p[0][1]), word(p[0][0]), word(p[1][1]), word(p[1][0])]

/** Groth16Verifier.yul with the key appended. */
export function verifierInitcode(vk: Vkey): Hex {
  return concatHex([
    compileYul(`${DIR}/Groth16Verifier.yul`),
    ...g1(vk.vk_alpha_1),
    ...g2(vk.vk_beta_2),
    ...g2(vk.vk_gamma_2),
    ...g2(vk.vk_delta_2),
    ...vk.IC.flatMap(g1),
    word(vk.nPublic),
  ])
}

const fixed = (mixed: Hex, label: string, constructorState = 0n) => {
  const initcode = mixed.toLowerCase() as Hex // padded addresses keep their checksum case
  const salt = saltOf(`exp-frames/32/${label}`)
  return { label, initcode, salt, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt, constructorState).frame }
}

export const verifier = fixed(verifierInitcode(VKEY), 'verifier')

/** The registry's EIP-8272 salt: its roots are filed under keccak256(registry || salt). */
export const ROOT_SALT = keccak256(toHex('exp-frames/32/registry'))
export const registry = fixed(
  concatHex([compileYul(`${DIR}/OwnedStateRegistry.yul`), pad(HASHER), pad(verifier.address), ROOT_SALT]),
  'registry/v1',
)
export const SOURCE_ID = sourceIdOf(registry.address, ROOT_SALT)

/** FixedPool: experiment 06's denomination, 0.001 ETH, spent whole. */
export const DENOMINATION = 10n ** 15n
/** Balance: any deposit, at most 0.002 ETH out per update. */
export const CAP = 2n * 10n ** 15n

export const fixedPool = fixed(concatHex([compileYul(`${DIR}/FixedPool.yul`), word(DENOMINATION)]), 'app/fixed-pool')
export const balance = fixed(concatHex([compileYul(`${DIR}/Balance.yul`), word(CAP)]), 'app/balance')
/** The control: its rule reads its own storage (one fresh slot in the constructor). */
export const storedRule = fixed(concatHex([compileYul(`${DIR}/StoredRule.yul`), word(CAP)]), 'app/stored-rule', STORAGE_SET_STATE_GAS)

export const registryAbi = parseAbi([
  'function deposit(address app, bytes32 inner) payable',
  'function update(bytes32 root, uint256[15][] updates)',
  'function claim(address who)',
  'function republish()',
  'function getLastRoot() view returns (bytes32)',
  'function nextIndex() view returns (uint256)',
  'function owed(address who) view returns (uint256)',
  'function sourceId() view returns (bytes32)',
  'event Inserted(address indexed app, bytes32 leaf, uint32 index)',
  'event Updated(address indexed app, bytes32 nullifier, address recipient, uint256 withdrawn, uint256 fee)',
  'event RecentRoot(bytes32 root, uint64 slot)',
])

// ---- notes ----

const mimc = await buildMimcSponge()

/** circomlib's MiMCSponge(n, 220, 1) with key 0: the kernel's H, and the deployed hasher's. */
export const H = (...xs: bigint[]): bigint => mimc.F.toObject(mimc.multiHash(xs, 0n, 1))

export type Secrets = { nullifierSecret: bigint; secret: bigint }

/** A note's secrets, from PRIVATE_KEY and a label, independent of the application. */
export function secretsOf(base: Hex, label: string): Secrets {
  const f = (part: string) => hexToBigInt(keccak256(concatHex([base, toHex(`exp-frames/32/note/${label}/${part}`)]))) % FIELD
  return { nullifierSecret: f('nullifier'), secret: f('secret') }
}

export const innerOf = (s: Secrets) => H(s.nullifierSecret, s.secret)
export const tagOf = (app: Address) => hexToBigInt(app)
export const leafOf = (app: Address, inner: bigint, state: bigint) => H(tagOf(app), inner, state)
/** The application's nullifier: the same secrets give unrelated ones in two applications. */
export const nullifierOf = (app: Address, s: Secrets) => H(tagOf(app), s.nullifierSecret)

// ---- the tree ----

export const LEVELS = 20
/** zeros(0) = keccak256("tornado") mod p, zeros(i + 1) = H(zeros(i), zeros(i)). */
export const ZEROS: bigint[] = [hexToBigInt(keccak256(toHex('tornado'))) % FIELD]
for (let i = 0; i < LEVELS; i++) ZEROS.push(H(ZEROS[i], ZEROS[i]))

export function treeOf(leaves: bigint[]) {
  const layers: bigint[][] = [leaves]
  for (let l = 0; l < LEVELS; l++) {
    const below = layers[l]
    const up: bigint[] = []
    for (let j = 0; j < below.length; j += 2) up.push(H(below[j], below[j + 1] ?? ZEROS[l]))
    layers.push(up)
  }
  return {
    root: layers[LEVELS][0] ?? ZEROS[LEVELS],
    path(index: number) {
      const pathElements: bigint[] = []
      const pathIndices: number[] = []
      for (let l = 0, i = index; l < LEVELS; l++, i >>= 1) {
        pathElements.push(layers[l][i ^ 1] ?? ZEROS[l])
        pathIndices.push(i & 1)
      }
      return { pathElements, pathIndices }
    },
  }
}

// ---- chain reads ----

/** Every leaf, deposits and change notes alike, in insertion order. */
export async function registryLeaves(client: PublicClient, at: Address = registry.address): Promise<{ leaf: bigint; app: Address }[]> {
  const logs = await client.getContractEvents({ address: at, abi: registryAbi, eventName: 'Inserted', fromBlock: 'earliest' })
  const out: { leaf: bigint; app: Address }[] = []
  for (const l of logs) out[Number(l.args.index)] = { leaf: hexToBigInt(l.args.leaf as Hex), app: getAddress(l.args.app as Address) }
  if (out.some((x) => x === undefined)) throw new Error('gap in the Inserted events')
  return out
}

/** The latest EIP-8272 slot in which the registry published `root`. */
export async function rootSlot(client: PublicClient, root: bigint, at: Address = registry.address): Promise<bigint | undefined> {
  const logs = await client.getContractEvents({ address: at, abi: registryAbi, eventName: 'RecentRoot', fromBlock: 'earliest' })
  return logs.filter((l) => hexToBigInt(l.args.root as Hex) === root).at(-1)?.args.slot
}

/** Spent: the nullifier's nonce key has been used. */
export async function isSpent(client: PublicClient, nullifier: bigint, at: Address = registry.address): Promise<boolean> {
  const v = await client.getStorageAt({ address: NONCE_MANAGER, slot: keyedNonceSlot(at, nullifier) })
  return !!v && hexToBigInt(v) > 0n
}

// ---- deposits ----

/**
 * A deposit, as a SENDER frame of the depositor's transaction. The first insertion writes all 20
 * of the tree's fresh slots; later ones write none, only the root's publication.
 */
export function depositFrame(app: Address, inner: bigint, value: bigint, first = false): Frame {
  return senderFrame({
    target: registry.address,
    value,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'deposit', args: [app, word(inner)] }),
    execution: 1_200_000n,
    state: first ? 2_600_000n : 500_000n,
  })
}

// ---- proofs ----

/**
 * What the registry binds to a proof: keccak256(recipient || fee || link) >> 8, and with
 * experiment 33's version 2, keccak256(recipient || fee || link || deadline) >> 8.
 */
export function bindingOf(recipient: Address, fee: bigint, link: bigint, deadline?: bigint): bigint {
  const words = [pad(recipient), word(fee), word(link), ...(deadline === undefined ? [] : [word(deadline)])]
  return hexToBigInt(keccak256(concatHex(words))) >> 8n
}

/** One update: 15 words in frame 2's data. */
export type Update = {
  nullifier: bigint
  newCommitment: bigint
  tag: bigint
  withdrawn: bigint
  recipient: Address
  fee: bigint
  link: bigint
  /** A.x A.y B.x1 B.x0 B.y1 B.y0 C.x C.y */
  proof: bigint[]
}

export type Spend = {
  app: Address
  secrets: Secrets
  state: bigint
  /** The note's leaf index. */
  index: number
  withdrawn: bigint
  /** Whose change note: its owner's inner. None when nothing is left. */
  newInner?: bigint
  recipient: Address
  fee: bigint
  /** In a pair, what the other update is (version 1: its nullifier); 0 alone. */
  link?: bigint
  /** Version 2 (experiment 33): the deadline of the transaction's expiry frame. */
  deadline?: bigint
}

/** The circuit's input for a spend against `leaves`. */
export function kernelInput(s: Spend, leaves: bigint[]) {
  const tree = treeOf(leaves)
  const { pathElements, pathIndices } = tree.path(s.index)
  const tag = tagOf(s.app)
  const newState = s.state - s.withdrawn
  const newCommitment = s.newInner === undefined ? 0n : H(tag, s.newInner, newState)
  const link = s.link ?? 0n
  return {
    root: tree.root,
    nullifier: nullifierOf(s.app, s.secrets),
    newCommitment,
    tag,
    withdrawn: s.withdrawn,
    binding: bindingOf(s.recipient, s.fee, link, s.deadline),
    nullifierSecret: s.secrets.nullifierSecret,
    secret: s.secrets.secret,
    state: s.state,
    newInner: s.newInner ?? 0n,
    pathElements,
    pathIndices: pathIndices.map(BigInt),
  }
}

type KernelInput = ReturnType<typeof kernelInput>

const decimal = (x: Record<string, bigint | bigint[]>) =>
  Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]))

/** Prove with snarkjs, and check the proof against the key before anything relies on it. */
export async function proveInput(input: KernelInput): Promise<bigint[]> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(decimal(input), file('build/kernel_js/kernel.wasm'), file('build/kernel.zkey'))
  if (!(await snarkjs.groth16.verify(VKEY, publicSignals, proof))) throw new Error('snarkjs produced a proof its own key refuses')
  const b = proof.pi_b
  return [proof.pi_a[0], proof.pi_a[1], b[0][1], b[0][0], b[1][1], b[1][0], proof.pi_c[0], proof.pi_c[1]].map(BigInt)
}

export async function prove(s: Spend, leaves: bigint[]): Promise<{ root: bigint; update: Update }> {
  const input = kernelInput(s, leaves)
  const proof = await proveInput(input)
  const { nullifier, newCommitment, tag, withdrawn } = input
  return { root: input.root, update: { nullifier, newCommitment, tag, withdrawn, recipient: s.recipient, fee: s.fee, link: s.link ?? 0n, proof } }
}

// ---- the update transaction ----

export const updateWords = (u: Update): bigint[] => [u.nullifier, u.newCommitment, u.tag, u.withdrawn, hexToBigInt(u.recipient), u.fee, u.link, ...u.proof]

export function updateCalldata(root: bigint, updates: Update[]): Hex {
  const rows = updates.map(updateWords) as unknown as readonly (readonly bigint[])[]
  return encodeFunctionData({ abi: registryAbi, functionName: 'update', args: [word(root), rows as never] })
}

/** VERIFY: the layout, the app's rule and one Groth16 check per update (README, "Gas"). */
export const VERIFY_EXECUTION = 260_000n
/** Frame 2's floors, as OwnedStateRegistry.yul requires them. */
export const UPDATE_EXECUTION = 100_000n
export const INSERT_EXECUTION = 1_200_000n
export const INSERT_STATE = 2n * STORAGE_SET_STATE_GAS

/** The fee each update in this experiment pays the registry: as experiment 06, 10^10 wei. */
export const FEE = 10n ** 10n

export type UpdateOpts = {
  chainId: bigint
  root: bigint
  slot: bigint
  /** Ascending by nullifier, as EIP-8250 requires of the nonce keys. */
  updates: Update[]
  verifyExecution?: bigint
  fees?: FrameTxFees
}

/**
 * The update, laid out as the registry's VERIFY requires: no signatures, the nullifiers as the
 * nonce keys, at sequence 0.
 */
export function updateTx(o: UpdateOpts): FrameTx {
  const k = BigInt(o.updates.length)
  const inserts = BigInt(o.updates.filter((u) => u.newCommitment !== 0n).length)
  const payouts = BigInt(o.updates.filter((u) => u.withdrawn > u.fee).length)
  const keys = o.updates.map((u) => u.nullifier)
  if (keys.some((x, i) => i > 0 && x <= keys[i - 1])) throw new Error('updates must be in ascending nullifier order')
  return {
    chainId: o.chainId,
    nonceKeys: keys,
    nonceSeq: 0n,
    sender: registry.address,
    frames: [
      recentRootFrame(SOURCE_ID, o.slot, word(o.root)),
      verifyFrame({
        scope: Approve.EXECUTION_AND_PAYMENT,
        target: null,
        execution: o.verifyExecution ?? VERIFY_EXECUTION * k,
        state: STORAGE_SET_STATE_GAS * k, // EIP-8250 first use of each nonce key
      }),
      senderFrame({
        target: registry.address,
        data: updateCalldata(o.root, o.updates),
        execution: UPDATE_EXECUTION * k + INSERT_EXECUTION * inserts,
        state: NEW_ACCOUNT_STATE_GAS * payouts + INSERT_STATE * inserts,
      }),
    ],
    signatures: [],
    fees: o.fees ?? POOL_FEES,
    blobVersionedHashes: [],
  }
}
