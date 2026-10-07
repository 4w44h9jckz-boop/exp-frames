import { type Address, type Hex, type PublicClient, concatHex, encodeAbiParameters, encodeFunctionData, parseEther } from 'viem'
import { compileSolidity } from '../../src/contracts.js'
import { deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { STORAGE_SET_STATE_GAS, senderFrame } from '../../src/frametx/index.js'

export const token = compileSolidity('contracts/TestToken.sol', 'TestToken')
export const dex = compileSolidity('experiments/03-atomic-batch/ToyDex.sol', 'ToyDex')

const tokenInit = (name: string, symbol: string): Hex =>
  concatHex([token.bytecode, encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [name, symbol])])

// The constructor stores name and symbol: two fresh slots.
const A = deployFrame(tokenInit('Token A', 'TKA'), saltOf('exp-frames/03/token-a/v1'), 2n * STORAGE_SET_STATE_GAS)
const B = deployFrame(tokenInit('Token B', 'TKB'), saltOf('exp-frames/03/token-b/v1'), 2n * STORAGE_SET_STATE_GAS)
const DEX = deployFrame(
  concatHex([dex.bytecode, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [A.address, B.address])]),
  saltOf('exp-frames/03/toy-dex/v1'),
)

export const TOKEN_A: Address = A.address
export const TOKEN_B: Address = B.address
export const TOY_DEX: Address = DEX.address

export const call = (abi: typeof token.abi, functionName: string, args: unknown[]): Hex =>
  encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0])

/** Mint frame: the first mint to an address creates its balance slot (and maybe totalSupply's). */
const mintFrame = (tokenAddress: Address, to: Address, amount: bigint) =>
  senderFrame({
    target: tokenAddress,
    data: call(token.abi, 'mint', [to, amount]),
    execution: 100_000n,
    state: 2n * STORAGE_SET_STATE_GAS,
  })

/**
 * One frame transaction that deploys both tokens and the DEX, then mints Token A to the
 * trader and Token B into the DEX's reserves. Five SENDER frames, one signature.
 */
export async function ensureSetup(client: PublicClient, privateKey: Hex, trader: Address) {
  return sendFrames(
    client,
    privateKey,
    [A.frame, B.frame, DEX.frame, mintFrame(TOKEN_A, trader, parseEther('1000')), mintFrame(TOKEN_B, TOY_DEX, parseEther('1000'))],
    { label: 'setup: deploy Token A, Token B, ToyDex; mint A to the trader and B to the DEX', expectCode: [TOKEN_A, TOKEN_B, TOY_DEX] },
  )
}

export async function balances(client: PublicClient, trader: Address) {
  const read = (address: Address, functionName: string, args: unknown[]) =>
    client.readContract({ address, abi: token.abi, functionName, args } as Parameters<typeof client.readContract>[0]) as Promise<bigint>
  const [a, b, allowance] = await Promise.all([
    read(TOKEN_A, 'balanceOf', [trader]),
    read(TOKEN_B, 'balanceOf', [trader]),
    read(TOKEN_A, 'allowance', [trader, TOY_DEX]),
  ])
  return { a, b, allowance }
}
