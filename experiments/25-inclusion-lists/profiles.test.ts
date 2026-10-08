import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  ATOMIC_BATCH_FLAG,
  Approve,
  type FrameTx,
  Mode,
  RECENT_ROOT,
  defaultFrame,
  expiryFrame,
  secp256k1Placeholder,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'
import { MAX_VERIFY_GAS_PER_TX, profile2Candidate, shape, verifyBudgetCost, verifyBudgetCostWithState } from './profiles.js'

const SENDER = '0x1111111111111111111111111111111111111111'
const PAYER = '0x2222222222222222222222222222222222222222'
const POOL = '0x3333333333333333333333333333333333333333'

const tx = (frames: FrameTx['frames'], blobs: `0x${string}`[] = [], sender: Address = SENDER): FrameTx => ({
  chainId: 8141n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender,
  frames,
  signatures: [secp256k1Placeholder()],
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: blobs,
})

const recentRoot = (execution: bigint) => verifyFrame({ scope: Approve.NONE, target: RECENT_ROOT, execution })
const body = senderFrame({ target: POOL, execution: 50_000n })

describe('Profile 2 candidacy', () => {
  it('reads the four prefixes, with the verifier frames named', () => {
    expect(shape(tx([verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 5_000n }), body]))).toBe('self_verify')
    expect(
      shape(tx([verifyFrame({ scope: Approve.EXECUTION, execution: 5_000n }), verifyFrame({ scope: Approve.PAYMENT, target: PAYER, execution: 5_000n }), body])),
    ).toBe('only_verify | pay')
    expect(shape(tx([expiryFrame(1n), recentRoot(20_000n), verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 5_000n }), body]))).toBe(
      'expiry_verify | recent_root_verify | self_verify',
    )
  })

  it('EIP-8369 as written skips only the expiry frame; EIP-8272 skips both verifier frames', () => {
    // Experiment 06's keyed withdrawal: the pool is the sender and verifies the proof itself.
    const withdrawal = tx([recentRoot(20_000n), verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 300_000n }), body], [], POOL)
    expect(profile2Candidate(withdrawal, 'eip8369')).toEqual({ ok: false, reason: 'shape recent_root_verify | self_verify' })
    expect(profile2Candidate(withdrawal, 'eip8272')).toEqual({ ok: true })
    const deadline = tx([expiryFrame(1n), verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 5_000n }), body])
    expect(profile2Candidate(deadline, 'eip8369')).toEqual({ ok: true })
  })

  it('a recent-root frame that is not first, or right behind the expiry frame, is a body frame', () => {
    const late = tx([verifyFrame({ scope: Approve.EXECUTION, execution: 5_000n }), recentRoot(20_000n), verifyFrame({ scope: Approve.PAYMENT, target: PAYER, execution: 5_000n }), body])
    expect(profile2Candidate(late, 'eip8272').ok).toBe(false)
  })

  it('refuses blobs, an atomic prefix, a VERIFY after the prefix, and a cost over the cap', () => {
    const v = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 5_000n })
    expect(profile2Candidate(tx([v, body], [`0x01${'00'.repeat(31)}`]), 'eip8272')).toEqual({ ok: false, reason: 'carries blobs' })
    expect(profile2Candidate(tx([{ ...v, flags: v.flags | ATOMIC_BATCH_FLAG }, body]), 'eip8272').ok).toBe(false)
    expect(profile2Candidate(tx([v, body, verifyFrame({ scope: Approve.NONE, execution: 1n })]), 'eip8272')).toEqual({
      ok: false,
      reason: 'VERIFY after the prefix',
    })
    const atCap = tx([verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: MAX_VERIFY_GAS_PER_TX - 2_800n }), body])
    expect(verifyBudgetCost(atCap)).toBe(MAX_VERIFY_GAS_PER_TX)
    expect(profile2Candidate(atCap, 'eip8272')).toEqual({ ok: true })
    const over = tx([verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: MAX_VERIFY_GAS_PER_TX - 2_799n }), body])
    expect(profile2Candidate(over, 'eip8272')).toEqual({ ok: false, reason: 'over MAX_VERIFY_GAS_PER_TX' })
  })
})

describe('VERIFY budget cost', () => {
  it('is signature gas plus the declared execution limits up to the payer frame, verifier frames included', () => {
    const t = tx([
      expiryFrame(1n, 5_000n),
      recentRoot(20_000n),
      verifyFrame({ scope: Approve.EXECUTION, execution: 7_000n, state: 1_000n }),
      verifyFrame({ scope: Approve.PAYMENT, target: PAYER, execution: 11_000n }),
      body,
    ])
    expect(verifyBudgetCost(t)).toBe(2_800n + 5_000n + 20_000n + 7_000n + 11_000n)
    expect(verifyBudgetCostWithState(t)).toBe(verifyBudgetCost(t) + 1_000n)
  })

  it('a deploy frame is part of the prefix and of the cost', () => {
    const t = tx([defaultFrame({ target: PAYER, execution: 70_000n }), verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 5_000n }), body])
    expect(t.frames[0].mode).toBe(Mode.DEFAULT)
    expect(shape(t)).toBe('deploy | self_verify')
    expect(verifyBudgetCost(t)).toBe(2_800n + 70_000n + 5_000n)
  })
})
