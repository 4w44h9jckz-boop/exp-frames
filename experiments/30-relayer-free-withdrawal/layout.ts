// The two withdrawal layouts experiment 30 prices, without the chain: refund.ts builds and sends
// them, and layout.test.ts rebuilds every mined one, including kohaku-rs's, from its fixture.
//
//   baseline   experiment 06's keyed pool, pool pays: [8272, P VERIFY, W]
//   refund     RefundPool: [8272, P VERIFY, W, R], R a DEFAULT frame that refunds the fee's surplus
import { type Hex, keccak256, toHex } from 'viem'
import { type FrameTx, type FrameTxFees, defaultFrame, maxCost } from '../../src/frametx/index.js'
import { type FramePoolInstance, type PoolProof, withdrawalTx } from '../06-privacy-pool/pool.js'

/** Both withdrawals were priced at a 0.1 gwei tip and a 0.2 gwei max fee. */
export const FEES: FrameTxFees = { maxPriorityFeePerGas: 100_000_000n, maxFeePerGas: 200_000_000n, maxFeePerBlobGas: 0n }
/** RefundPool refuses a refund frame with less execution gas than this. */
export const POST_OP_FLOOR = 25_000n
/** RefundPool files its roots under this EIP-8272 salt. */
export const REFUND_POOL_SALT = keccak256(toHex('exp-frames/30/refund-pool'))

/** The layout, with every frame's execution limit replaced by `limits` when given. */
export function layoutTx(o: { chainId: bigint; pool: FramePoolInstance; proof: PoolProof; slot: bigint; withRefund: boolean; limits?: bigint[]; fees?: FrameTxFees }): FrameTx {
  const tx = withdrawalTx({ chainId: o.chainId, pool: o.pool, proof: o.proof, slot: o.slot, fees: o.fees ?? FEES, verifyExecution: 400_000n })
  if (o.withRefund) tx.frames.push(defaultFrame({ target: o.pool.address, execution: 50_000n }))
  const limits = o.limits
  if (limits) tx.frames = tx.frames.map((f, i) => ({ ...f, limits: { ...f.limits, execution: limits[i] } }))
  return tx
}

/** The maximum cost of `tx` with every byte of every frame's data and of the nonce key non-zero. */
export function worstMaxCost(tx: FrameTx): bigint {
  const ff = (d: Hex) => (`0x${'ff'.repeat((d.length - 2) / 2)}`) as Hex
  return maxCost({ ...tx, nonceKeys: tx.nonceKeys.map(() => 2n ** 256n - 1n), frames: tx.frames.map((f) => ({ ...f, data: ff(f.data) })) })
}

/** The pool's floors on each frame's execution limit. */
export const floors = (withRefund: boolean) => [0n, 0n, 100_000n, ...(withRefund ? [POST_OP_FLOOR] : [])]

/** Limits as experiment 28's wallet sets them: 1.25 x used + 5,000, never below the floors. */
export function tighten(used: bigint[], withRefund: boolean): bigint[] {
  const fl = floors(withRefund)
  return used.map((u, i) => {
    const t = (u * 5n) / 4n + 5_000n
    return t > fl[i] ? t : fl[i]
  })
}
