// The JSON an unsigned frame transaction travels in between the wallet and a paymaster service.
//
// ERC-7677 passes an ERC-4337 user operation. A frame transaction has no agreed JSON yet: the four
// clients serve four different ones (experiment 22; execution-apis#860 and #907 are open). This is
// one choice, written down so both sides of this experiment agree on it.
import { type Address, type Hex, getAddress, hexToBigInt, numberToHex } from 'viem'
import type { FrameTx } from '../../src/frametx/index.js'

export type RpcFrame = { mode: Hex; flags: Hex; target: Address | null; executionGasLimit: Hex; stateGasLimit: Hex; value: Hex; data: Hex }
export type RpcSignature = { scheme: Hex; signer: Address | null; msg: Hex; signature: Hex }
export type RpcFrameTx = {
  chainId: Hex
  nonceKeys: Hex[]
  nonceSeq: Hex
  sender: Address
  frames: RpcFrame[]
  signatures: RpcSignature[]
  maxPriorityFeePerGas: Hex
  maxFeePerGas: Hex
  maxFeePerBlobGas: Hex
}

const q = (n: bigint | number) => numberToHex(n)

export function frameTxToRpc(tx: FrameTx): RpcFrameTx {
  return {
    chainId: q(tx.chainId),
    nonceKeys: tx.nonceKeys.map(q),
    nonceSeq: q(tx.nonceSeq),
    sender: tx.sender,
    frames: tx.frames.map((f) => ({
      mode: q(f.mode),
      flags: q(f.flags),
      target: f.target,
      executionGasLimit: q(f.limits.execution),
      stateGasLimit: q(f.limits.state),
      value: q(f.value),
      data: f.data,
    })),
    signatures: tx.signatures.map((s) => ({ scheme: q(s.scheme), signer: s.signer, msg: s.msg, signature: s.signature })),
    maxPriorityFeePerGas: q(tx.fees.maxPriorityFeePerGas),
    maxFeePerGas: q(tx.fees.maxFeePerGas),
    maxFeePerBlobGas: q(tx.fees.maxFeePerBlobGas),
  }
}

export function frameTxFromRpc(j: RpcFrameTx): FrameTx {
  const b = (h: Hex) => hexToBigInt(h)
  return {
    chainId: b(j.chainId),
    nonceKeys: j.nonceKeys.map(b),
    nonceSeq: b(j.nonceSeq),
    sender: getAddress(j.sender),
    frames: j.frames.map((f) => ({
      mode: Number(b(f.mode)),
      flags: Number(b(f.flags)),
      target: f.target ? getAddress(f.target) : null,
      limits: { execution: b(f.executionGasLimit), state: b(f.stateGasLimit) },
      value: b(f.value),
      data: f.data,
    })),
    signatures: j.signatures.map((s) => ({ scheme: Number(b(s.scheme)), signer: s.signer ? getAddress(s.signer) : null, msg: s.msg, signature: s.signature })),
    fees: { maxPriorityFeePerGas: b(j.maxPriorityFeePerGas), maxFeePerGas: b(j.maxFeePerGas), maxFeePerBlobGas: b(j.maxFeePerBlobGas) },
    blobVersionedHashes: [],
  }
}
