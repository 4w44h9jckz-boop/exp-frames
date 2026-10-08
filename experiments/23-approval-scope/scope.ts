import {
  type Address,
  type Hex,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  numberToHex,
  pad,
  parseEther,
  stringToHex,
  toHex,
} from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  Mode,
  STORAGE_SET_STATE_GAS,
  defaultFrame,
  makeClient,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

/** secp256k1 keys derived from PRIVATE_KEY: the same accounts on every run, nothing stored. */
export function derive(label: string): { key: Hex; address: Address } {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/23/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

/** The owner of the account that follows the EIP's second branch, and of the scoped account. */
export const literalOwner = derive('literal-owner')
export const scopedOwner = derive('scoped-owner')
/** Two code-less sponsors, paying through the default code with signature entry 1. */
export const sponsor1 = derive('sponsor-1')
export const sponsor2 = derive('sponsor-2')

// ---- contracts ----

const token = compileSolidity('contracts/TestToken.sol', 'TestToken')
const amm = compileSolidity('experiments/23-approval-scope/ToyAmm.sol', 'ToyAmm')
const bot = compileSolidity('experiments/23-approval-scope/ToyAmm.sol', 'Sandwicher')
const LITERAL = compileYul('experiments/23-approval-scope/SenderFramesAccount.yul')
const SCOPED = compileYul('experiments/23-approval-scope/ScopedAccount.yul')
const PAY_THE_PAYER = compileYul('experiments/23-approval-scope/PayThePayer.yul')

export const tokenAbi = token.abi
export const ammAbi = amm.abi
export const botAbi = bot.abi

const tokenInit = (name: string, symbol: string): Hex =>
  concatHex([token.bytecode, encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [name, symbol])])
const salt = (label: string) => saltOf(`exp-frames/23/${label}`)

// The token constructor stores name and symbol (two fresh slots); the bot's constructor writes
// two allowances; the others write nothing.
const A = deployFrame(tokenInit('Token A', 'TKA'), salt('token-a'), 2n * STORAGE_SET_STATE_GAS)
const B = deployFrame(tokenInit('Token B', 'TKB'), salt('token-b'), 2n * STORAGE_SET_STATE_GAS)
const AMM = deployFrame(
  concatHex([amm.bytecode, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [A.address, B.address])]),
  salt('amm'),
)
const BOT = deployFrame(concatHex([bot.bytecode, encodeAbiParameters([{ type: 'address' }], [AMM.address])]), salt('bot'), 2n * STORAGE_SET_STATE_GAS)
const PAYER_FEE = deployFrame(PAY_THE_PAYER, salt('pay-the-payer'))
const LITERAL_ACCOUNT = deployFrame(concatHex([LITERAL, pad(literalOwner.address)]), salt('literal-account'))
const SCOPED_ACCOUNT = deployFrame(concatHex([SCOPED, pad(scopedOwner.address)]), salt('scoped-account'))

export const TOKEN_A = A.address
export const TOKEN_B = B.address
export const AMM_ADDRESS = AMM.address
export const BOT_ADDRESS = BOT.address
export const PAY_THE_PAYER_ADDRESS = PAYER_FEE.address
export const LITERAL_ACCOUNT_ADDRESS = LITERAL_ACCOUNT.address
export const SCOPED_ACCOUNT_ADDRESS = SCOPED_ACCOUNT.address

export const deployments = [A, B, AMM, BOT, PAYER_FEE, LITERAL_ACCOUNT, SCOPED_ACCOUNT]
export const deployedAt = deployments.map((d) => d.address)
export { create2Address }

export const call = (abi: typeof token.abi, functionName: string, args: unknown[]): Hex =>
  encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0])

// ---- frames ----

const STATE = STORAGE_SET_STATE_GAS

export const mint = (tokenAddress: Address, to: Address, amount: bigint) =>
  senderFrame({ target: tokenAddress, data: call(tokenAbi, 'mint', [to, amount]), execution: 80_000n, state: 2n * STATE })

export const approveFrame = (tokenAddress: Address, spender: Address, amount: bigint) =>
  senderFrame({ target: tokenAddress, data: call(tokenAbi, 'approve', [spender, amount]), execution: 50_000n, state: STATE })

export const swapFrame = (amountIn: bigint, minOut: bigint, to: Address) =>
  senderFrame({ target: AMM_ADDRESS, data: call(ammAbi, 'swap', [true, amountIn, minOut, to]), execution: 120_000n, state: STATE })

export const payThePayerFrame = (amount: bigint) =>
  senderFrame({ target: PAY_THE_PAYER_ADDRESS, data: concatHex([pad(TOKEN_A), numberToHex(amount, { size: 32 })]), execution: 60_000n, state: STATE })

export const frontFrame = (amountA: bigint) =>
  defaultFrame({ target: BOT_ADDRESS, data: call(botAbi, 'front', [amountA]), execution: 120_000n, state: STATE })

export const backFrame = () => defaultFrame({ target: BOT_ADDRESS, data: call(botAbi, 'back', []), execution: 120_000n, state: STATE })

export const selfVerify = (execution = 30_000n) => verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution })
export const onlyVerify = (execution = 30_000n) => verifyFrame({ scope: Approve.EXECUTION, execution })
export const payFrame = (payer: Address, execution = 15_000n) => verifyFrame({ scope: Approve.PAYMENT, target: payer, execution })

// ---- the two digests, as the accounts compute them ----

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })
const label = (s: string) => pad(stringToHex(s), { dir: 'right', size: 32 })
const resolved = (tx: FrameTx, f: Frame): Address => f.target ?? tx.sender

/** EIP-8250's nonce_keys_hash, which `TXPARAM(0x0F)` returns. */
export const nonceKeysHash = (keys: bigint[]): Hex => keccak256(concatHex([word(keys.length), ...keys.map(word)]))

/** SenderFramesAccount's digest: every SENDER frame, in order, and nothing else. */
export function senderFramesDigest(tx: FrameTx): Hex {
  const parts: Hex[] = [label('exp-frames/23 sender-frames'), word(tx.chainId), pad(tx.sender), nonceKeysHash(tx.nonceKeys), word(tx.nonceSeq)]
  for (const f of tx.frames) {
    if (f.mode !== Mode.SENDER) continue
    parts.push(pad(resolved(tx, f)), word(f.flags), word(f.limits.execution), word(f.limits.state), word(f.value), keccak256(f.data))
  }
  return keccak256(concatHex(parts))
}

/** A pay frame: VERIFY whose allowed scope is PAYMENT alone. */
export const isPayFrame = (f: Frame) => f.mode === Mode.VERIFY && (f.flags & 3) === Approve.PAYMENT

/** ScopedAccount's execution-scope digest: every frame but the payer's, with positions and count. */
export function executionDigest(tx: FrameTx): Hex {
  const parts: Hex[] = [
    label('exp-frames/23 execution scope'),
    word(tx.chainId),
    pad(tx.sender),
    nonceKeysHash(tx.nonceKeys),
    word(tx.nonceSeq),
    word(tx.frames.length),
  ]
  tx.frames.forEach((f, i) => {
    if (isPayFrame(f)) {
      parts.push(word(i), word((1n << 256n) - 1n))
      return
    }
    parts.push(word(i), word(f.mode), word(f.flags), pad(resolved(tx, f)), word(f.limits.execution), word(f.limits.state), word(f.value), keccak256(f.data))
  })
  return keccak256(concatHex(parts))
}

// ---- reading state ----

export async function balanceOf(tokenAddress: Address, who: Address): Promise<bigint> {
  return client.readContract({ address: tokenAddress, abi: tokenAbi, functionName: 'balanceOf', args: [who] } as Parameters<
    typeof client.readContract
  >[0]) as Promise<bigint>
}

export async function reserves(): Promise<{ a: bigint; b: bigint }> {
  const read = (functionName: string) =>
    client.readContract({ address: AMM_ADDRESS, abi: ammAbi, functionName, args: [] } as Parameters<typeof client.readContract>[0]) as Promise<bigint>
  const [a, b] = await Promise.all([read('reserveA'), read('reserveB')])
  return { a, b }
}

/** The pool's price function, in the contract's integer arithmetic. */
export const quote = (amountIn: bigint, rIn: bigint, rOut: bigint) => (amountIn * rOut) / (rIn + amountIn)

/**
 * The largest front-run (in A) that still leaves the victim's swap of `v` A at or above `minOut`,
 * and what the bot ends with after selling back. Pure arithmetic on the pool's formula.
 */
export function planSandwich(v: bigint, minOut: bigint, ra: bigint, rb: bigint, budget: bigint) {
  const run = (x: bigint) => {
    const botB = quote(x, ra, rb)
    const ra1 = ra + x
    const rb1 = rb - botB
    const victimB = quote(v, ra1, rb1)
    const ra2 = ra1 + v
    const rb2 = rb1 - victimB
    const botA = quote(botB, rb2, ra2)
    return { x, botB, victimB, botA, profit: botA - x }
  }
  let lo = 0n
  let hi = budget
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    if (run(mid).victimB >= minOut) lo = mid
    else hi = mid
  }
  return run(lo)
}

export const AMOUNTS = {
  reserve: parseEther('1000'),
  victimA: parseEther('100'),
  botA: parseEther('300'),
  swap: parseEther('10'),
  fee: parseEther('1'),
  /** The victim accepts 3 per cent below the quote, as a wallet's slippage setting would. */
  slippageBps: 300n,
  accountEth: parseEther('0.005'),
}
