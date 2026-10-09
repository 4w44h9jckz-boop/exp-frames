import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  keccak256,
  http,
} from 'viem'
import { NONCE_MANAGER } from './constants.js'
import { frameTxHash, serializeFrameTx } from './encode.js'
import type { Frame, FrameSignature, FrameTx, FrameTxFees } from './types.js'

export const HEGOTA_RPC_URL = 'https://rpc1.privacy.ethrex.xyz'
export const HEGOTA_FAUCET_URL = 'https://faucet.privacy.ethrex.xyz'
export const HEGOTA_EXPLORER_URL = 'https://dora.privacy.ethrex.xyz'

export const hegotaTestnet = defineChain({
  id: 8141,
  name: 'ethrex Hegotá testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [HEGOTA_RPC_URL] } },
  blockExplorers: { default: { name: 'Dora', url: HEGOTA_EXPLORER_URL } },
  testnet: true,
})

export function makeClient(rpcUrl = process.env.RPC_URL || HEGOTA_RPC_URL): PublicClient {
  return createPublicClient({ chain: hegotaTestnet, transport: http(rpcUrl) })
}

/** Untyped JSON-RPC call, for methods viem does not know (or would reformat). */
export async function rpc<T>(client: PublicClient, method: string, params: unknown[]): Promise<T> {
  const request = client.request as unknown as (args: { method: string; params: unknown[] }) => Promise<T>
  return request({ method, params })
}

// ---- JSON shapes served by ethrex ----

export type FrameReceiptJson = {
  status: Hex
  gasUsed: Hex
  stateGasUsed: Hex
  logs: { address: Address; topics: Hex[]; data: Hex }[]
}

export type FrameTxReceiptJson = {
  transactionHash: Hex
  blockHash: Hex
  blockNumber: Hex
  transactionIndex: Hex
  type: Hex
  status: Hex
  from: Address
  payer: Address
  gasUsed: Hex
  cumulativeGasUsed: Hex
  effectiveGasPrice: Hex
  frameReceipts: FrameReceiptJson[]
  logs: unknown[]
}

export type FrameTxJson = {
  hash: Hex
  type: Hex
  chainId: Hex
  nonceKeys: Hex[]
  nonceSeq: Hex
  sender: Address
  frames: { mode: Hex; flags: Hex; to: Address | null; gasLimit: Hex; stateGasLimit: Hex; value: Hex; data: Hex }[]
  signatures: { scheme: Hex; signer: Address | null; msg: Hex; signature: Hex }[]
  maxPriorityFeePerGas: Hex
  maxFeePerGas: Hex
  maxFeePerBlobGas: Hex
  blobVersionedHashes: Hex[]
  blockNumber: Hex | null
}

export type SimulateResult = {
  /** All frame-specific admission gates passed (necessary, not sufficient, for mempool admission). */
  valid: boolean
  prefixShape: 'SelfVerify' | 'DeploySelfVerify' | 'OnlyVerifyPay' | 'DeployOnlyVerifyPay' | null
  payer: Address | null
  maxCost: Hex
  violation: string | null
  gasUsed: Hex | null
  frames: { gasUsed: Hex; succeeded: boolean }[] | null
  executionStatus: 'success' | 'reverted' | null
  executionError: string | null
}

/** Rebuild a FrameTx from the node's JSON. Check `frameTxHash(tx) === json.hash` before trusting it. */
export function frameTxFromJson(j: FrameTxJson): FrameTx {
  const big = (h: Hex) => hexToBigInt(h)
  return {
    chainId: big(j.chainId),
    nonceKeys: j.nonceKeys.map(big),
    nonceSeq: big(j.nonceSeq),
    sender: getAddress(j.sender),
    frames: j.frames.map(
      (f): Frame => ({
        mode: Number(big(f.mode)),
        flags: Number(big(f.flags)),
        target: f.to ? getAddress(f.to) : null,
        limits: { execution: big(f.gasLimit), state: big(f.stateGasLimit) },
        value: big(f.value),
        data: f.data,
      }),
    ),
    signatures: j.signatures.map(
      (s): FrameSignature => ({
        scheme: Number(big(s.scheme)),
        signer: s.signer ? getAddress(s.signer) : null,
        msg: s.msg,
        signature: s.signature,
      }),
    ),
    fees: {
      maxPriorityFeePerGas: big(j.maxPriorityFeePerGas),
      maxFeePerGas: big(j.maxFeePerGas),
      maxFeePerBlobGas: big(j.maxFeePerBlobGas),
    },
    blobVersionedHashes: j.blobVersionedHashes,
  }
}

// ---- nonces & fees ----

/** NONCE_MANAGER storage slot for a non-zero key: keccak256(pad32(sender) || uint256(key)). */
export function keyedNonceSlot(sender: Address, key: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [sender, key]))
}

/** Current `nonce_seq` for a key set; every key must sit at the same sequence. */
export async function getNonceSeq(client: PublicClient, sender: Address, nonceKeys: bigint[] = [0n]): Promise<bigint> {
  const seqs = await Promise.all(
    nonceKeys.map(async (key) => {
      if (key === 0n) return BigInt(await client.getTransactionCount({ address: sender, blockTag: 'latest' }))
      const v = await client.getStorageAt({ address: NONCE_MANAGER, slot: keyedNonceSlot(sender, key) })
      return v ? hexToBigInt(v) : 0n
    }),
  )
  if (seqs.some((s) => s !== seqs[0])) throw new Error(`nonce keys sit at different sequences: ${seqs.join(', ')}`)
  return seqs[0]
}

/** 2 × base fee + tip, like the ethrex reference submitters. */
export async function suggestFees(client: PublicClient, tip = 1_000_000_000n): Promise<FrameTxFees> {
  const block = await client.getBlock({ blockTag: 'latest' })
  const base = block.baseFeePerGas ?? 0n
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, maxFeePerBlobGas: 0n }
}

/** Fill chain id, nonce sequence and fees around a frame list. Signatures still need signing. */
export async function prepareFrameTx(
  client: PublicClient,
  opts: {
    sender: Address
    frames: Frame[]
    signatures: FrameSignature[]
    nonceKeys?: bigint[]
    nonceSeq?: bigint
    fees?: FrameTxFees
  },
): Promise<FrameTx> {
  const nonceKeys = opts.nonceKeys ?? [0n]
  const [chainId, nonceSeq, fees] = await Promise.all([
    client.getChainId(),
    opts.nonceSeq ?? getNonceSeq(client, opts.sender, nonceKeys),
    opts.fees ?? suggestFees(client),
  ])
  return {
    chainId: BigInt(chainId),
    nonceKeys,
    nonceSeq,
    sender: getAddress(opts.sender),
    frames: opts.frames,
    signatures: opts.signatures,
    fees,
    blobVersionedHashes: [],
  }
}

// ---- submit / observe ----

export async function simulateFrameTx(client: PublicClient, tx: FrameTx, block: string = 'latest'): Promise<SimulateResult> {
  return rpc<SimulateResult>(client, 'ethrex_simulateFrameTransaction', [serializeFrameTx(tx), block])
}

export async function sendFrameTx(client: PublicClient, tx: FrameTx): Promise<Hex> {
  const raw = serializeFrameTx(tx)
  const hash = await rpc<Hex>(client, 'eth_sendRawTransaction', [raw])
  const expected = frameTxHash(tx)
  if (hash.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`node returned hash ${hash}, expected keccak256(raw) = ${expected}`)
  }
  return hash
}

export async function getFrameTxReceipt(client: PublicClient, hash: Hex): Promise<FrameTxReceiptJson | null> {
  return rpc<FrameTxReceiptJson | null>(client, 'eth_getTransactionReceipt', [hash])
}

export async function getFrameTxJson(client: PublicClient, hash: Hex): Promise<FrameTxJson | null> {
  return rpc<FrameTxJson | null>(client, 'eth_getTransactionByHash', [hash])
}

export async function waitForFrameTxReceipt(
  client: PublicClient,
  hash: Hex,
  { timeoutMs = 90_000, pollMs = 2_000 } = {},
): Promise<FrameTxReceiptJson> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await getFrameTxReceipt(client, hash)
    if (r) return r
    await new Promise((res) => setTimeout(res, pollMs))
  }
  throw new Error(`no receipt for ${hash} after ${timeoutMs} ms`)
}

/** Ask the testnet faucet for 1 ETH. */
export async function claimFaucet(address: Address, faucetUrl = HEGOTA_FAUCET_URL): Promise<unknown> {
  const res = await fetch(`${faucetUrl}/api/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`faucet ${res.status}: ${body}`)
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}
