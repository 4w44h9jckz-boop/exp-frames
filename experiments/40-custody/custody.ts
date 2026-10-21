// Experiment 40: the vaulted registry, its vaults, notes under a vault's scope, the context a
// proof is bound to, and the update transaction. The kernel, its key, the verifier, the hasher
// and the tree are experiment 32's, unchanged: the scope takes the application's address's place
// as the kernel's `tag`, and the context takes the binding's.
import { createHash } from 'node:crypto'
import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  hexToBytes,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  toHex,
} from 'viem'
import { compileYul } from '../../src/contracts.js'
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
import { recentRootFrame, sourceIdOf } from '../06-privacy-pool/pool.js'
import { FIELD, H, HASHER, type Secrets, proveInput, treeOf, verifier } from '../32-owned-state/registry.js'

export const DIR = 'experiments/40-custody'
const word = (x: bigint | number | string) => numberToHex(BigInt(x), { size: 32 })
const sha256 = (h: Hex): Hex => toHex(createHash('sha256').update(hexToBytes(h)).digest())

const fixed = (mixed: Hex, label: string) => {
  const initcode = mixed.toLowerCase() as Hex
  const salt = saltOf(`exp-frames/40/${label}`)
  return { label, initcode, salt, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}

// ---- contracts ----

export const ROOT_SALT = keccak256(toHex('exp-frames/40/registry'))
export const registry = fixed(
  concatHex([compileYul(`${DIR}/VaultedRegistry.yul`), pad(HASHER), pad(verifier.address), ROOT_SALT]),
  'registry/v1',
)
export const SOURCE_ID = sourceIdOf(registry.address, ROOT_SALT)

/** Experiment 32's rules: FixedPool's 0.001 ETH, spent whole; Balance's 0.002 ETH cap. */
export const DENOMINATION = 10n ** 15n
export const CAP = 2n * 10n ** 15n
export const Kind = { FIXED: 0n, BALANCE: 1n } as const

export type Vault = ReturnType<typeof fixed> & { kind: bigint; amount: bigint }
const vault = (label: string, kind: bigint, amount: bigint): Vault => ({
  ...fixed(concatHex([compileYul(`${DIR}/Vault.yul`), pad(registry.address), word(kind), word(amount)]), label),
  kind,
  amount,
})
/** Application A, FixedPool's rule; application B, Balance's; and C, A's twin: the same parameters at another address. */
export const vaultA = vault('vault/a', Kind.FIXED, DENOMINATION)
export const vaultB = vault('vault/b', Kind.BALANCE, CAP)
export const vaultC = vault('vault/c', Kind.FIXED, DENOMINATION)

/** What the registry keeps for the gas it pays, before any fee comes back. */
export const FLOAT = 10n ** 15n

export const registryAbi = parseAbi([
  'function deposit(address vault, bytes32 inner) payable',
  'function update(bytes32 root, uint256[15][] updates)',
  'function republish()',
  'function getLastRoot() view returns (bytes32)',
  'function nextIndex() view returns (uint256)',
  'function sourceId() view returns (bytes32)',
  'function scopeOf(address vault) view returns (uint256)',
  'event Inserted(address indexed vault, bytes32 leaf, uint32 index)',
  'event Updated(address indexed vault, bytes32 nullifier, address recipient, uint256 withdrawn, uint256 fee)',
  'event RecentRoot(bytes32 root, uint64 slot)',
])
export const vaultAbi = parseAbi([
  'function params() view returns (bytes32)',
  'function owed(address who) view returns (uint256)',
  'function registry() view returns (address)',
  'function claim(address who)',
  'event Paid(address indexed to, uint256 value)',
])

// ---- scope, notes, context ----

/** SHA-256(0x90 || kind || amount): a vault's parameters, as `params()` returns them. */
export const paramsOf = (v: { kind: bigint; amount: bigint }): Hex => sha256(concatHex(['0x90', word(v.kind), word(v.amount)]))

/** SHA-256(0x91 || params || uint64be(chain id) || vault) mod p. */
export const scopeOf = (v: Vault, chainId: bigint): bigint =>
  hexToBigInt(sha256(concatHex(['0x91', paramsOf(v), numberToHex(chainId, { size: 8 }), v.address]))) % FIELD

export const leafOf = (scope: bigint, inner: bigint, state: bigint) => H(scope, inner, state)
export const nullifierOf = (scope: bigint, s: Secrets) => H(scope, s.nullifierSecret)

/** SHA-256(0x61 || recipient || fee || max_priority_fee_per_gas || max_fee_per_gas) >> 8. */
export const contextOf = (recipient: Address, fee: bigint, fees: FrameTxFees): bigint =>
  hexToBigInt(sha256(concatHex(['0x61', pad(recipient), word(fee), word(fees.maxPriorityFeePerGas), word(fees.maxFeePerGas)]))) >> 8n

/** The fees each update is proved for: experiment 06's, a 1 wei tip and a 100 wei cap. */
export const FEES: FrameTxFees = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }
/** The fee each update pays the registry from its vault: as experiment 32, 10^10 wei. */
export const FEE = 10n ** 10n

// ---- chain reads ----

export async function registryLeaves(client: PublicClient): Promise<{ leaf: bigint; vault: Address }[]> {
  const logs = await client.getContractEvents({ address: registry.address, abi: registryAbi, eventName: 'Inserted', fromBlock: 'earliest' })
  const out: { leaf: bigint; vault: Address }[] = []
  for (const l of logs) out[Number(l.args.index)] = { leaf: hexToBigInt(l.args.leaf as Hex), vault: getAddress(l.args.vault as Address) }
  if (out.some((x) => x === undefined)) throw new Error('gap in the Inserted events')
  return out
}

export async function rootSlot(client: PublicClient, root: bigint): Promise<bigint | undefined> {
  const logs = await client.getContractEvents({ address: registry.address, abi: registryAbi, eventName: 'RecentRoot', fromBlock: 'earliest' })
  return logs.filter((l) => hexToBigInt(l.args.root as Hex) === root).at(-1)?.args.slot
}

export async function isSpent(client: PublicClient, nullifier: bigint): Promise<boolean> {
  const v = await client.getStorageAt({ address: NONCE_MANAGER, slot: keyedNonceSlot(registry.address, nullifier) })
  return !!v && hexToBigInt(v) > 0n
}

// ---- deposits ----

export function depositFrame(v: Address, inner: bigint, value: bigint, first = false): Frame {
  return senderFrame({
    target: registry.address,
    value,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'deposit', args: [v, word(inner)] }),
    execution: 1_300_000n,
    state: first ? 2_600_000n : 500_000n,
  })
}

// ---- proofs ----

export type Update = {
  nullifier: bigint
  newCommitment: bigint
  vault: Address
  withdrawn: bigint
  recipient: Address
  fee: bigint
  /** A.x A.y B.x1 B.x0 B.y1 B.y0 C.x C.y */
  proof: bigint[]
}

export type Spend = {
  /** The vault the note was deposited in, and the chain: they make its scope. */
  vault: Vault
  chainId: bigint
  secrets: Secrets
  state: bigint
  index: number
  withdrawn: bigint
  newInner?: bigint
  recipient: Address
  fee: bigint
  /** The fees the transaction will carry, which the context binds. */
  fees: FrameTxFees
}

/** Experiment 32's kernel input, with the scope as `tag` and the context as `binding`. */
export function kernelInput(s: Spend, leaves: bigint[]) {
  const tree = treeOf(leaves)
  const { pathElements, pathIndices } = tree.path(s.index)
  const scope = scopeOf(s.vault, s.chainId)
  const newState = s.state - s.withdrawn
  return {
    root: tree.root,
    nullifier: nullifierOf(scope, s.secrets),
    newCommitment: s.newInner === undefined ? 0n : H(scope, s.newInner, newState),
    tag: scope,
    withdrawn: s.withdrawn,
    binding: contextOf(s.recipient, s.fee, s.fees),
    nullifierSecret: s.secrets.nullifierSecret,
    secret: s.secrets.secret,
    state: s.state,
    newInner: s.newInner ?? 0n,
    pathElements,
    pathIndices: pathIndices.map(BigInt),
  }
}

export async function prove(s: Spend, leaves: bigint[]): Promise<{ root: bigint; update: Update }> {
  const input = kernelInput(s, leaves)
  const proof = await proveInput(input)
  return {
    root: input.root,
    update: { nullifier: input.nullifier, newCommitment: input.newCommitment, vault: s.vault.address, withdrawn: s.withdrawn, recipient: s.recipient, fee: s.fee, proof },
  }
}

// ---- the update transaction ----

export const updateWords = (u: Update): bigint[] => [u.nullifier, u.newCommitment, hexToBigInt(u.vault), u.withdrawn, hexToBigInt(u.recipient), u.fee, 0n, ...u.proof]

export function updateCalldata(root: bigint, u: Update): Hex {
  return encodeFunctionData({ abi: registryAbi, functionName: 'update', args: [word(root), [updateWords(u)] as never] })
}

/** VERIFY: experiment 32's checks, the vault's rule and parameters, and two SHA-256 calls. */
export const VERIFY_EXECUTION = 290_000n
/** Frame 2's floors, as VaultedRegistry.yul requires them. */
export const UPDATE_EXECUTION = 150_000n
export const INSERT_EXECUTION = 1_200_000n
export const INSERT_STATE = 2n * STORAGE_SET_STATE_GAS

export type UpdateOpts = { chainId: bigint; root: bigint; slot: bigint; update: Update; fees: FrameTxFees }

export function updateTx(o: UpdateOpts): FrameTx {
  const insert = o.update.newCommitment !== 0n ? 1n : 0n
  const payout = o.update.withdrawn > o.update.fee ? 1n : 0n
  return {
    chainId: o.chainId,
    nonceKeys: [o.update.nullifier],
    nonceSeq: 0n,
    sender: registry.address,
    frames: [
      recentRootFrame(SOURCE_ID, o.slot, word(o.root)),
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: VERIFY_EXECUTION, state: STORAGE_SET_STATE_GAS }),
      senderFrame({
        target: registry.address,
        data: updateCalldata(o.root, o.update),
        execution: UPDATE_EXECUTION + INSERT_EXECUTION * insert,
        state: NEW_ACCOUNT_STATE_GAS * payout + INSERT_STATE * insert,
      }),
    ],
    signatures: [],
    fees: o.fees,
    blobVersionedHashes: [],
  }
}
