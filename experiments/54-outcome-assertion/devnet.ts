// The public Hegota devnet's type 0x06 envelope, for amendment 2 of experiment 54.
//
//   0x06 || rlp([chain_id, nonce_keys, nonce_seq, sender, frames, signatures,
//                max_priority_fee, max_fee, max_blob_fee, blob_hashes, recent_root_references])
//
// The frames and signature entries are as on chain 8141 (`src/frametx/encode.ts`). The fees are
// three flat fields rather than a list, and EIP-8272's `recent_root_references` closes the list.
// The layout was read from forshtat/hegota-demo at 8095b894 (`frontend/src/frametx.ts`, a port of
// ethrex's `scripts/hegota-devnet/frametx.py`); nothing is copied from it. The signature hash is
// the same envelope with the signature bytes of every empty-msg entry elided.
import { type Address, type Hex, type PublicClient, concatHex, hexToBigInt, keccak256, numberToHex, toRlp } from 'viem'
import { sign } from 'viem/accounts'
import type { Frame, FrameSignature } from '../../src/frametx/index.js'

export const DEVNET_RPC = 'https://rpc1.hegota.ethrex.xyz'
export const DEVNET_CHAIN_ID = 3151908n
export const DEVNET_EXPLORER = 'https://dora.hegota.ethrex.xyz'
export const DEVNET_FAUCET = 'https://faucet.hegota.ethrex.xyz/api/claim'

export type DevnetTx = {
  chainId: bigint
  nonceKeys: bigint[]
  nonceSeq: bigint
  sender: Address
  frames: Frame[]
  signatures: FrameSignature[]
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
}

const int = (n: bigint | number): Hex => (BigInt(n) === 0n ? '0x' : numberToHex(BigInt(n)))
const addr = (a: Address | null): Hex => (a ? (a.toLowerCase() as Hex) : '0x')

function envelope(tx: DevnetTx, elide: boolean) {
  return [
    int(tx.chainId),
    tx.nonceKeys.map(int),
    int(tx.nonceSeq),
    addr(tx.sender),
    tx.frames.map((f) => [int(f.mode), int(f.flags), addr(f.target), [int(f.limits.execution), int(f.limits.state)], int(f.value), f.data]),
    tx.signatures.map((s) => [int(s.scheme), addr(s.signer), s.msg, elide && s.msg === '0x' ? '0x' : s.signature]),
    int(tx.maxPriorityFeePerGas),
    int(tx.maxFeePerGas),
    '0x',
    [],
    [],
  ] as Parameters<typeof toRlp>[0]
}

export const serialize = (tx: DevnetTx): Hex => concatHex(['0x06', toRlp(envelope(tx, false))])
export const sigHash = (tx: DevnetTx): Hex => keccak256(concatHex(['0x06', toRlp(envelope(tx, true))]))
export const txHash = (tx: DevnetTx): Hex => keccak256(serialize(tx))

/** Sign every empty-msg secp256k1 entry with `key` (one key per transaction here). */
export async function signDevnet(tx: DevnetTx, key: Hex): Promise<DevnetTx> {
  const h = sigHash(tx)
  const s = await sign({ hash: h, privateKey: key })
  const bytes = concatHex([numberToHex(s.yParity ?? 0, { size: 1 }), s.r, s.s])
  return { ...tx, signatures: tx.signatures.map((e) => (e.msg === '0x' ? { ...e, signature: bytes } : e)) }
}

async function rpc<T>(client: PublicClient, method: string, params: unknown[]): Promise<T> {
  return (await client.request({ method: method as never, params: params as never })) as T
}

export type DevnetSim = { valid: boolean; violation: string | null; frames: { gasUsed: Hex; succeeded: boolean }[] | null; executionError: string | null }
export const simulate = (client: PublicClient, tx: DevnetTx) => rpc<DevnetSim>(client, 'ethrex_simulateFrameTransaction', [serialize(tx), 'latest'])
export const send = (client: PublicClient, tx: DevnetTx) => rpc<Hex>(client, 'eth_sendRawTransaction', [serialize(tx)])

export type DevnetReceipt = {
  transactionHash: Hex
  blockNumber: Hex
  status: Hex
  gasUsed: Hex
  frameReceipts?: { status: Hex | number; gasUsed?: Hex; executionGasUsed?: Hex; stateGasUsed?: Hex }[]
}

export async function waitReceipt(client: PublicClient, hash: Hex, timeoutMs = 120_000): Promise<DevnetReceipt> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await rpc<DevnetReceipt | null>(client, 'eth_getTransactionReceipt', [hash])
    if (r) return r
    await new Promise((res) => setTimeout(res, 1_500))
  }
  throw new Error(`no receipt for ${hash} after ${timeoutMs} ms`)
}

export const frameStatus = (s: Hex | number) => (typeof s === 'number' ? s : Number(hexToBigInt(s)))

export async function claim(address: Address) {
  const res = await fetch(DEVNET_FAUCET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) })
  return { status: res.status, body: await res.text() }
}

