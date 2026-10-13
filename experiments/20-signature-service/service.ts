// Experiment 20: keys, contracts and transaction builders shared by the scripts.
import { p256 } from '@noble/curves/p256'
import {
  type Abi,
  type Address,
  type Hex,
  bytesToHex,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBigInt,
  keccak256,
  numberToHex,
  toHex,
} from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  type FrameSignature,
  type FrameTx,
  type P256Key,
  type FrameTxReceiptJson,
  STORAGE_SET_STATE_GAS,
  Scheme,
  getFrameTxReceipt,
  makeClient,
  p256Address,
  p256Sign,
  prepareFrameTx,
  secp256k1Placeholder,
  secp256k1Sign,
  senderFrame,
  verifyFrame,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'

export const client = makeClient()
export const { privateKey: funderKey } = loadKey()

const derived = (label: string) => keccak256(concatHex([funderKey, toHex(`exp-frames/20/${label}`)]))
export const k1 = (label: string) => {
  const key = derived(label)
  return { key, address: privateKeyToAddress(key) }
}
export const p256Key = (label: string): { key: P256Key; address: Address } => {
  const d = hexToBigInt(derived(label)) % (p256.CURVE.n - 1n)
  const key: P256Key = { scheme: 'p256', privateKey: numberToHex(d + 1n, { size: 32 }) }
  return { key, address: p256Address(key) }
}

/** bob relays and takes orders, carol receives and front-runs; the two alices only sign. */
export const bob = k1('bob')
export const carol = k1('carol')
export const aliceK1 = k1('alice-k1')
export const aliceP256 = p256Key('alice-p256')

// ---- contracts ----

const SOL = 'experiments/20-signature-service/SigService.sol'
const readerInit = compileYul('experiments/20-signature-service/SigReader.yul')
const art = {
  token: compileSolidity(SOL, 'SigToken'),
  exchange: compileSolidity(SOL, 'Exchange'),
  quorum: compileSolidity(SOL, 'Quorum'),
}
export const tokenAbi = art.token.abi
export const exchangeAbi = art.exchange.abi
export const quorumAbi = art.quorum.abi

const contract = (label: string, bytecode: Hex, args: Hex = '0x', extraState = 0n) => {
  const initcode = concatHex([bytecode, args])
  const salt = saltOf(`exp-frames/20/${label}`)
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt, extraState).frame }
}
export const reader = contract('sig-reader/v1', readerInit)
const tokenArgs = (name: string, symbol: string) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'string' }, { type: 'string' }], [reader.address, name, symbol])
// The constructor writes name and symbol: two fresh slots each.
export const tka = contract('token-a/v1', art.token.bytecode, tokenArgs('Token A', 'TKA'), 2n * STORAGE_SET_STATE_GAS)
export const tkb = contract('token-b/v1', art.token.bytecode, tokenArgs('Token B', 'TKB'), 2n * STORAGE_SET_STATE_GAS)
const readerArg = encodeAbiParameters([{ type: 'address' }], [reader.address])
export const exchange = contract('exchange/v1', art.exchange.bytecode, readerArg)
export const quorum = contract('quorum/v1', art.quorum.bytecode, readerArg)

export const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  client.readContract({ address, abi, functionName, args }) as Promise<T>
export const call = (target: Address, abi: Abi, functionName: string, args: unknown[], execution = 80_000n, state = 2n * STORAGE_SET_STATE_GAS): Frame =>
  senderFrame({ target, data: encodeFunctionData({ abi, functionName, args }), execution, state })

// ---- signatures ----

/** A signed explicit-digest entry, ready to drop into any transaction's signature list. */
export async function signedEntry(signer: { key: Hex | P256Key; address: Address }, digest: Hex): Promise<FrameSignature> {
  if (typeof signer.key === 'string') {
    return { scheme: Scheme.SECP256K1, signer: signer.address, msg: digest, signature: await secp256k1Sign(digest, signer.key) }
  }
  return { scheme: Scheme.P256, signer: signer.address, msg: digest, signature: p256Sign(digest, signer.key) }
}

/** A transaction from `sender` (a code-less EOA): its own entry 0 first, then `entries`. */
export async function relayed(sender: Address, frames: Frame[], entries: FrameSignature[] = [], opts: { nonceSeq?: bigint } = {}): Promise<FrameTx> {
  return prepareFrameTx(client, {
    sender,
    nonceSeq: opts.nonceSeq,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), ...frames],
    signatures: [secp256k1Placeholder(), ...entries],
  })
}

/** v (1) ‖ r ‖ s, as the ecrecover path takes it, from a protocol-format SECP256K1 signature. */
export const vrs = (sig: Hex) => ({ v: Number(hexToBigInt(`0x${sig.slice(2, 4)}`)), r: `0x${sig.slice(4, 68)}` as Hex, s: `0x${sig.slice(68, 132)}` as Hex })
/** r, s, qx, qy from a protocol-format P256 signature. */
export const rsxy = (sig: Hex) => [0, 1, 2, 3].map((i) => `0x${sig.slice(2 + 64 * i, 66 + 64 * i)}` as Hex)

/**
 * A receipt, once a block has been built on top of it. Experiment 19: a receipt can come from a
 * block built for a slot that is then missed, and a transaction sent on the strength of it (the
 * same sender's next nonce) can be dropped. Waiting for one child block avoids that.
 */
export async function confirmed(hash: Hex): Promise<FrameTxReceiptJson> {
  const first = await waitForFrameTxReceipt(client, hash)
  while ((await client.getBlockNumber()) <= BigInt(first.blockNumber)) await new Promise((r) => setTimeout(r, 1000))
  const r = await getFrameTxReceipt(client, hash)
  if (!r) throw new Error(`${hash}: the receipt disappeared`)
  return r
}

export const short = (e: unknown) => {
  const lines = (e as Error).message.split('\n')
  return (lines.find((l) => l.startsWith('Details:')) ?? lines[0]).replace('Details: ', '').replace('Invalid params: ', '')
}
export const link = (hash: Hex) => `[\`${hash.slice(0, 10)}…\`](https://dora.privacy.ethrex.xyz/tx/${hash})`
export { bytesToHex }
