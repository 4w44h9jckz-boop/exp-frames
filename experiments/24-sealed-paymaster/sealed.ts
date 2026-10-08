import { type Address, type Hex, concatHex, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, pad, parseEther, toFunctionSelector, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  Mode,
  NEW_ACCOUNT_STATE_GAS,
  RECENT_ROOT,
  STORAGE_SET_STATE_GAS,
  makeClient,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

/** secp256k1 keys derived from PRIVATE_KEY: the same accounts on every run, nothing stored. */
export function derive(label: string): { key: Hex; address: Address } {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/24/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

/** The sponsor: an EOA that writes policy roots to EIP-8272 and holds no other role. */
export const sponsor = derive('sponsor')
/** Someone else writing roots: same predeploy, another source id. */
export const stranger = derive('stranger')
/** The SelfSendingPaymaster's owner. */
export const owner = derive('owner')
/** Users with no ETH, sponsored. `user(i)` is a fresh one per run index. */
export const user = (i: number | string) => derive(`user-${i}`)

// ---- EIP-8272 ----

export const POLICY_SALT = saltOf('exp-frames/24 policy')
/** source_id = keccak256(source_address ‖ salt), the address as its 20 bytes. */
export const sourceIdOf = (source: Address, salt: Hex): Hex => keccak256(concatHex([source, salt]))
export const SOURCE_ID = sourceIdOf(sponsor.address, POLICY_SALT)

/** The write: a call from the source address with calldata salt ‖ root. One fresh slot at most. */
export const publishRootFrame = (salt: Hex, root: Hex): Frame =>
  senderFrame({ target: RECENT_ROOT, data: concatHex([salt, root]), execution: 60_000n, state: STORAGE_SET_STATE_GAS })

export type RootRef = { sourceId: Hex; slot: bigint; root: Hex }

/** The verifier frame for one or more (source_id, slot, root) tuples. */
export const recentRootFrame = (refs: RootRef[], execution = 20_000n): Frame => ({
  mode: Mode.VERIFY,
  flags: Approve.NONE,
  target: RECENT_ROOT,
  limits: { execution, state: 0n },
  value: 0n,
  data: concatHex(refs.flatMap((r) => [r.sourceId, numberToHex(r.slot, { size: 8 }), r.root])),
})

// ---- contracts ----

const token = compileSolidity('contracts/TestToken.sol', 'TestToken')
export const tokenAbi = token.abi
/** TestToken's runtime as solc emits it: CBOR metadata appended. Used by the scan census. */
export const TEST_TOKEN_RUNTIME = token.deployedBytecode
const SEALED = compileYul('experiments/24-sealed-paymaster/SealedPaymaster.yul')
const SELF_SENDING = compileYul('experiments/24-sealed-paymaster/SelfSendingPaymaster.yul')

const salt = (label: string) => saltOf(`exp-frames/24/${label}`)
const tokenInit = concatHex([token.bytecode, encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['Token S', 'TKS'])])
const TOKEN = deployFrame(tokenInit, salt('token'), 2n * STORAGE_SET_STATE_GAS)
const SEALED_PM = deployFrame(concatHex([SEALED, SOURCE_ID]), salt('sealed-paymaster'))
const SELF_SENDING_PM = deployFrame(concatHex([SELF_SENDING, pad(owner.address)]), salt('self-sending-paymaster'))

export const TOKEN_ADDRESS = TOKEN.address
export const SEALED_ADDRESS = SEALED_PM.address
export const SELF_SENDING_ADDRESS = SELF_SENDING_PM.address
export const deployments = [TOKEN, SEALED_PM, SELF_SENDING_PM]
export { create2Address }

export const MINT = toFunctionSelector('mint(address,uint256)')
export const TRANSFER = toFunctionSelector('transfer(address,uint256)')

export const mintFrame = (to: Address, amount = parseEther('1'), target: Address = TOKEN_ADDRESS) =>
  senderFrame({
    target,
    data: encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [to, amount] } as Parameters<typeof encodeFunctionData>[0]),
    execution: 60_000n,
    // a fresh balance slot, and totalSupply's first write if this is the first mint
    state: 2n * STORAGE_SET_STATE_GAS,
  })

export const transferFrame = (to: Address, amount: bigint) =>
  senderFrame({
    target: TOKEN_ADDRESS,
    data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [to, amount] } as Parameters<typeof encodeFunctionData>[0]),
    execution: 60_000n,
    state: STORAGE_SET_STATE_GAS,
  })

/** only_verify through the user's default code (entry 0). */
export const onlyVerify = verifyFrame({ scope: Approve.EXECUTION, execution: 20_000n })

// ---- the policy tree ----

export type Policy = { target: Address; selector: Hex; cap: bigint; notAfter: bigint }

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })

/** leaf = keccak256(target ‖ selector ‖ cap ‖ notAfter), each a 32-byte word, as the contract hashes it. */
export const leafOf = (p: Policy): Hex => keccak256(concatHex([pad(p.target), pad(p.selector), word(p.cap), word(p.notAfter)]))

const node = (l: Hex, r: Hex) => keccak256(concatHex([l, r]))
const ZERO = `0x${'00'.repeat(32)}` as Hex

/**
 * A depth-`depth` tree with `policies` at leaves 0..n-1 and zero leaves elsewhere (no keccak
 * output is zero, so an empty leaf proves nothing). Sparse: unused subtrees are cached zeros.
 */
export function policyTree(policies: Policy[], depth: number) {
  if (policies.length > 2 ** depth) throw new Error('too many policies for the depth')
  const zeros: Hex[] = [ZERO]
  for (let i = 1; i <= depth; i++) zeros.push(node(zeros[i - 1], zeros[i - 1]))
  const levels: Hex[][] = [policies.map(leafOf)]
  for (let i = 0; i < depth; i++) {
    const below = levels[i]
    const above: Hex[] = []
    for (let j = 0; j < below.length; j += 2) above.push(node(below[j], below[j + 1] ?? zeros[i]))
    levels.push(above.length ? above : [zeros[i + 1]])
  }
  const root = levels[depth][0]
  const proof = (index: number): Hex[] => {
    const path: Hex[] = []
    let k = index
    for (let i = 0; i < depth; i++) {
      path.push(levels[i][k ^ 1] ?? zeros[i])
      k >>= 1
    }
    return path
  }
  return { root, depth, policies, proof }
}
export type PolicyTree = ReturnType<typeof policyTree>

/** Pay-frame data: t ‖ cap ‖ notAfter ‖ index ‖ depth ‖ siblings. */
export function sealedPayData(tree: PolicyTree, index: number, t = 0): Hex {
  const p = tree.policies[index]
  return concatHex([word(t), word(p.cap), word(p.notAfter), word(index), word(tree.depth), ...tree.proof(index)])
}

/**
 * The pay frame. State gas covers APPROVE creating the sender (a user with no ETH has no account
 * yet). Execution: about 1,200 plus about 110 per level, measured; 20,000 leaves room.
 */
export const sealedPayFrame = (data: Hex, senderExists: boolean, execution = 20_000n): Frame =>
  verifyFrame({ scope: Approve.PAYMENT, target: SEALED_ADDRESS, data, execution, state: senderExists ? 0n : NEW_ACCOUNT_STATE_GAS })

export const AMOUNTS = {
  sealedFloat: parseEther('0.02'),
  selfSendingFloat: parseEther('0.01'),
  sponsorEth: parseEther('0.005'),
  ownerEth: parseEther('0.001'),
  /** A per-transaction cap on max cost: well above what one mint costs at the testnet's base fee. */
  cap: parseEther('0.001'),
}
