// A wallet that serves EIP-5792 (`wallet_getCapabilities`, `wallet_sendCalls`,
// `wallet_getCallsStatus`) and ERC-7677's `paymasterService` capability over EIP-8141 frame
// transactions, for an EOA with no code: the protocol's default code validates it.
//
// It is an EIP-1193 provider, so a dapp drives it through viem's stock wallet actions
// (`sendCalls`, `getCallsStatus`, `waitForCallsStatus`, `getCapabilities`) and nothing else.
//
// One batch is one frame transaction:
//   self-paid   [VERIFY sender, scope 3] [SENDER call 0] ... [SENDER call n-1]
//   sponsored   [VERIFY sender, scope 2] [VERIFY payer, scope 1] [SENDER call 0] ... [post-op DEFAULT]
// With `atomicRequired`, every call frame but the last carries the atomic-batch flag, so the calls
// commit or roll back together. Without it, the calls are independent frames of one transaction.
import { randomBytes } from 'node:crypto'
import { type Address, type Hex, type PublicClient, bytesToHex, getAddress, hexToBigInt, isAddressEqual, numberToHex, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import {
  ATOMIC_BATCH_FLAG,
  Approve,
  ENTRY_POINT,
  type Frame,
  type FrameSignature,
  type FrameTx,
  type FrameTxReceiptJson,
  FrameStatus,
  Mode,
  type SimulateResult,
  frameReceiptStatus,
  frameTxHash,
  getFrameTxReceipt,
  intrinsicGas,
  maxCost,
  prepareFrameTx,
  secp256k1Placeholder,
  sendFrameTx,
  senderFrame,
  signAll,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { type RpcSignature, frameTxToRpc } from './binding.js'

/** EIP-1193 error. viem maps the codes (5700, 5720, 5730, 4100, ...) to its own error classes. */
export class ProviderRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message)
  }
}

export type Call = { to?: Address; data?: Hex; value?: Hex; capabilities?: Record<string, { optional?: boolean }> }
type SendCallsParams = {
  version: string
  id?: string
  from?: Address
  chainId: Hex
  atomicRequired: boolean
  calls: Call[]
  capabilities?: Record<string, { optional?: boolean; url?: string; context?: Record<string, unknown> }>
}

/** What the wallet remembers about a batch: enough to answer `wallet_getCallsStatus`. */
export type Batch = {
  id: string
  chainId: bigint
  hash: Hex
  tx: FrameTx
  atomic: boolean
  /** Index of each call's frame in the transaction. */
  callFrames: number[]
  /** Every round trip and signature this batch cost, in order. */
  trace: string[]
  /** Gas limits before and after estimation. */
  estimate: { draftMaxCost: bigint; finalMaxCost: bigint; draftLimits: bigint; finalLimits: bigint }
}

/** Execution budget a call frame gets for the estimation run. */
const DRAFT_EXECUTION = 400_000n
/**
 * State budget a call frame gets, in the estimation run and after it. The node's simulation
 * reports execution gas per frame but not state gas, and the total it reports is net of
 * refunds, so the wallet cannot attribute state gas to a frame. Two fresh slots and one new
 * account cover the calls these dapps make; a frame that needs more fails and burns its
 * whole execution budget.
 */
const STATE_PER_CALL = 2n * 97_920n + 183_600n
const VERIFY_EXECUTION = 20_000n

/** Splice the payer's answer into the transaction: the pay frame, its post-op, its entries. */
export function withPayer(tx: FrameTx, p: PaymasterResult, address: Address): FrameTx {
  const payFrame: Frame = {
    mode: Mode.VERIFY,
    flags: Approve.PAYMENT,
    target: getAddress(p.paymaster),
    limits: { execution: hexToBigInt(p.paymasterVerificationGasLimit), state: hexToBigInt(p.paymasterStateGasLimit ?? '0x0') },
    value: 0n,
    data: p.paymasterData,
  }
  const calls = tx.frames.filter((f) => f.mode === Mode.SENDER)
  const postOp = hexToBigInt(p.paymasterPostOpGasLimit ?? '0x0')
  const frames = [
    tx.frames[0],
    payFrame,
    ...calls,
    ...(postOp > 0n ? [{ mode: Mode.DEFAULT, flags: 0, target: payFrame.target, limits: { execution: postOp, state: 0n }, value: 0n, data: '0x' as Hex }] : []),
  ]
  const own = tx.signatures.filter((s) => s.signer === null || isAddressEqual(s.signer, address))
  return { ...tx, frames, signatures: [...own, ...(p.paymasterSignatures ?? []).map(frameSignatureFromRpc)] }
}

/** The sender's VERIFY, then one SENDER frame per call; every call frame but the last is atomic when `atomic`. */
export function batchFrames(calls: Call[], opts: { atomic: boolean; sponsored: boolean; execution: bigint[] }): Frame[] {
  const n = calls.length
  const own = verifyFrame({ scope: opts.sponsored ? Approve.EXECUTION : Approve.EXECUTION_AND_PAYMENT, execution: VERIFY_EXECUTION })
  const callFrame = (c: Call, i: number) =>
    senderFrame({ target: getAddress(c.to!), value: c.value ? hexToBigInt(c.value) : 0n, data: c.data ?? '0x', atomic: opts.atomic && i < n - 1, execution: opts.execution[i], state: STATE_PER_CALL })
  return [own, ...calls.map(callFrame)]
}

/** A call frame's execution budget from its use in the draft: a quarter over, plus 5,000. */
export const tightened = (used: bigint) => (used * 5n) / 4n + 5_000n

export function framesWallet(opts: { client: PublicClient; key: Hex; chainId: bigint; log?: (line: string) => void }) {
  const { client, key, chainId } = opts
  const address = privateKeyToAddress(key)
  const log = opts.log ?? (() => {})
  const batches = new Map<string, Batch>()

  async function pm(url: string, method: string, tx: FrameTx, context: Record<string, unknown> | undefined, trace: string[]) {
    trace.push(method)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [frameTxToRpc(tx), ENTRY_POINT, numberToHex(chainId), context ?? {}] }),
    })
    const body = (await res.json()) as { result?: PaymasterResult; error?: { code: number; message: string } }
    if (body.error) throw new ProviderRpcError(-32603, `paymaster service refused (${method}): ${body.error.message}`)
    return body.result!
  }

  async function simulate(tx: FrameTx, trace: string[], what: string): Promise<SimulateResult> {
    trace.push(`simulate (${what})`)
    const sim = await simulateFrameTx(client, tx)
    if (!sim.valid) throw new ProviderRpcError(-32603, `${what}: ${sim.violation}`)
    return sim
  }

  async function sign(tx: FrameTx, trace: string[], what: string) {
    trace.push(`user signs (${what})`)
    return signAll(tx, [key])
  }

  /** Tighten each call frame's execution budget to what the simulation used, plus a margin. */
  function tighten(tx: FrameTx, sim: SimulateResult, callFrames: number[]): FrameTx {
    const frames = tx.frames.map((f, i) => {
      if (!callFrames.includes(i)) return f
      const used = hexToBigInt(sim.frames![i].gasUsed)
      return { ...f, limits: { ...f.limits, execution: tightened(used) } }
    })
    return { ...tx, frames }
  }

  async function sendCalls(p: SendCallsParams): Promise<{ id: string; capabilities?: Record<string, unknown> }> {
    if (p.version !== '2.0.0') throw new ProviderRpcError(-32602, `unsupported version ${p.version}`)
    if (hexToBigInt(p.chainId) !== chainId) throw new ProviderRpcError(5710, `unsupported chain id ${p.chainId}`)
    if (p.from && !isAddressEqual(p.from, address)) throw new ProviderRpcError(4100, `${p.from} is not this wallet's account`)
    if (p.id && batches.has(p.id)) throw new ProviderRpcError(5720, `duplicate id ${p.id}`)
    const known = new Set(['paymasterService'])
    for (const [name, c] of Object.entries(p.capabilities ?? {})) {
      if (!known.has(name) && !c.optional) throw new ProviderRpcError(5700, `unsupported non-optional capability ${name}`)
    }
    for (const call of p.calls) {
      // A SENDER frame calls a target; a null target means the sender, not a creation.
      if (!call.to) throw new ProviderRpcError(-32602, 'a call without `to` (a deployment) has no frame equivalent; send it through a deployer')
      for (const [name, c] of Object.entries(call.capabilities ?? {})) {
        if (!c.optional) throw new ProviderRpcError(5700, `unsupported non-optional call capability ${name}`)
      }
    }
    const pmCap = p.capabilities?.paymasterService
    const sponsored = !!pmCap?.url
    const atomic = p.atomicRequired
    const trace: string[] = []

    const n = p.calls.length
    let tx = await prepareFrameTx(client, {
      sender: address,
      frames: batchFrames(p.calls, { atomic, sponsored, execution: Array(n).fill(DRAFT_EXECUTION) }),
      signatures: [secp256k1Placeholder()],
    })
    if (sponsored) tx = withPayer(tx, await pm(pmCap!.url!, 'pm_getPaymasterStubData', tx, pmCap!.context, trace), address)
    const callFrames = tx.frames.flatMap((f, i) => (f.mode === Mode.SENDER ? [i] : []))

    // Estimation. The node simulates only a transaction whose prefix approves, so the stub
    // cannot be simulated: the draft needs the payer's real signature and the user's.
    if (sponsored) tx = withPayer(tx, await pm(pmCap!.url!, 'pm_getPaymasterData', tx, pmCap!.context, trace), address)
    const draft = await sign(tx, trace, 'draft, for estimation')
    const sim = await simulate(draft, trace, 'draft')
    const draftMaxCost = maxCost(draft)
    const draftLimits = draft.frames.reduce((s, f) => s + f.limits.execution + f.limits.state, 0n)

    // The final transaction: execution budgets tightened, everything else as estimated.
    tx = tighten(tx, sim, callFrames)
    if (sponsored) tx = withPayer(tx, await pm(pmCap!.url!, 'pm_getPaymasterData', tx, pmCap!.context, trace), address)
    tx = await sign(tx, trace, 'final')
    const final = await simulate(tx, trace, 'final')
    trace.push('eth_sendRawTransaction')
    const hash = await sendFrameTx(client, tx)
    const id = p.id ?? bytesToHex(randomBytes(32))
    batches.set(id, {
      id,
      chainId,
      hash,
      tx,
      atomic,
      callFrames,
      trace,
      estimate: { draftMaxCost, finalMaxCost: maxCost(tx), draftLimits, finalLimits: tx.frames.reduce((s, f) => s + f.limits.execution + f.limits.state, 0n) },
    })
    log(`  wallet: ${n} call(s) -> ${tx.frames.length} frames, ${atomic ? 'atomic' : 'independent'}, ${sponsored ? 'sponsored' : 'self-paid'}; simulated ${final.executionStatus}; sent ${hash}`)
    return { id }
  }

  /** EIP-5792 status for a mined frame transaction, from its frame receipts. */
  function statusOf(b: Batch, r: FrameTxReceiptJson): number {
    const ok = b.callFrames.map((i) => frameReceiptStatus(r.frameReceipts[i]) === FrameStatus.SUCCESS)
    if (ok.every(Boolean)) return 200
    // An atomic batch either commits or rolls back. The frames before the failing one report
    // SUCCESS although their effects were undone (no receipt status says "rolled back"), so a
    // failure anywhere in the batch means nothing of it persisted.
    if (b.atomic) return 500
    return ok.some(Boolean) ? 600 : 500
  }

  async function getCallsStatus(id: string) {
    const b = batches.get(id)
    if (!b) throw new ProviderRpcError(5730, `unknown bundle id ${id}`)
    const r = await getFrameTxReceipt(client, b.hash)
    const base = { version: '2.0.0', id, chainId: numberToHex(b.chainId), atomic: b.atomic }
    if (!r) return { ...base, status: 100 }
    const status = statusOf(b, r)
    // Logs only from the calls' frames: not the payer's, not a post-op's.
    const logs = b.callFrames.flatMap((i) => r.frameReceipts[i].logs)
    return {
      ...base,
      status,
      receipts: [{ logs, status: status === 200 ? '0x1' : '0x0', blockHash: r.blockHash, blockNumber: r.blockNumber, gasUsed: r.gasUsed, transactionHash: r.transactionHash }],
      capabilities: { frames: { payer: r.payer, frameStatuses: r.frameReceipts.map((f) => frameReceiptStatus(f)) } },
    }
  }

  async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const args = (params ?? []) as unknown[]
    switch (method) {
      case 'eth_chainId':
        return numberToHex(chainId)
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [address]
      case 'wallet_getCapabilities': {
        const chains = (args[1] as Hex[] | undefined) ?? [numberToHex(chainId)]
        const caps: Record<string, unknown> = {}
        for (const c of chains) {
          // Every EOA can batch atomically through the default code: no upgrade, so `supported`
          // rather than `ready`.
          if (hexToBigInt(c) === chainId) caps[numberToHex(chainId)] = { atomic: { status: 'supported' }, paymasterService: { supported: true } }
        }
        return caps
      }
      case 'wallet_sendCalls':
        return sendCalls(args[0] as SendCallsParams)
      case 'wallet_getCallsStatus':
        return getCallsStatus(args[0] as string)
      case 'wallet_showCallsStatus':
        if (!batches.has(args[0] as string)) throw new ProviderRpcError(5730, 'unknown bundle id')
        return null
      default:
        return client.request({ method, params } as never)
    }
  }

  return { request, address, batches }
}

/** The frames binding of ERC-7677's result: its v0.7 fields, read as frame fields, plus two. */
export type PaymasterResult = {
  sponsor?: { name: string; icon?: string }
  /** The pay frame's target. */
  paymaster: Address
  /** The pay frame's data. */
  paymasterData: Hex
  /** The pay frame's execution budget. */
  paymasterVerificationGasLimit: Hex
  /** A DEFAULT frame after the calls, aimed at the paymaster; 0 means none. */
  paymasterPostOpGasLimit?: Hex
  /** Not in ERC-7677: the pay frame's EIP-8037 state budget. */
  paymasterStateGasLimit?: Hex
  /** Not in ERC-7677: the payer's signature entries, which follow the sender's. */
  paymasterSignatures?: RpcSignature[]
  isFinal?: boolean
}

function frameSignatureFromRpc(s: RpcSignature): FrameSignature {
  return { scheme: Number(hexToBigInt(s.scheme)), signer: s.signer ? getAddress(s.signer) : null, msg: s.msg, signature: s.signature }
}
