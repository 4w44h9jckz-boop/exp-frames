// Experiment 25: the FOCIL eligibility rules for frame transactions, as three documents state them.
//
// - EIP-8369 (Informational, master 2026-10-08), Profile 2 candidacy: shape matching ignores the
//   optional expiry verifier frame and nothing else.
// - EIP-8272 (master 2026-10-08), public mempool: "clients MUST skip both optional leading
//   protocol verifier frames" when matching EIP-8141's four prefixes. ethrex's enforcing
//   extension (docs/eip-focil-frametx.md on lambdaclass/ethrex@hegota-testnet), which the testnet
//   runs, does the same for Profile 2.
// - This repository's proposal (the post's suggestion 5): a frame transaction whose validation
//   prefix is made only of the frames EIP-8141 calls directly evaluable, default code and the
//   expiry verifier, is judged like a Profile 1 transaction, by account fields alone.
//
// Everything here is decided from the transaction and, for the last rule, its mined receipt.
import { type Address, isAddressEqual } from 'viem'
import {
  APPROVE_SCOPE_MASK,
  ATOMIC_BATCH_FLAG,
  Approve,
  EXPIRY_VERIFIER,
  type FrameTx,
  type FrameTxReceiptJson,
  Mode,
  RECENT_ROOT,
  frameReceiptGas,
  signatureVerificationGas,
} from '../../src/frametx/index.js'

/** EIP-8369's candidate value; ethrex runs it per payload, EIP-8369 per committee member's list. */
export const MAX_VERIFY_GAS_PER_IL = 1n << 20n
export const MAX_VERIFY_GAS_PER_TX = MAX_VERIFY_GAS_PER_IL
/** EIP-7805. */
export const IL_COMMITTEE_SIZE = 16
export const MAX_BYTES_PER_INCLUSION_LIST = 8192

export type Kind =
  | 'expiry_verify'
  | 'recent_root_verify'
  | 'self_verify'
  | 'only_verify'
  | 'pay'
  | 'deploy'
  | 'verify_other'
  | 'user_op'
  | 'post_op'

const resolves = (tx: FrameTx, target: Address | null) => target ?? tx.sender

/** EIP-8141's mode subclassification, plus EIP-8272's verifier frame. */
export function kindOf(tx: FrameTx, i: number, prefixEnd: number): Kind {
  const f = tx.frames[i]
  const toSender = isAddressEqual(resolves(tx, f.target), tx.sender)
  if (f.mode === Mode.VERIFY) {
    if (f.flags === 0 && f.target && isAddressEqual(f.target, EXPIRY_VERIFIER)) return 'expiry_verify'
    if (f.flags === 0 && f.target && isAddressEqual(f.target, RECENT_ROOT)) return 'recent_root_verify'
    const scope = f.flags & APPROVE_SCOPE_MASK
    if (scope === Approve.EXECUTION_AND_PAYMENT && toSender) return 'self_verify'
    if (scope === Approve.EXECUTION && toSender) return 'only_verify'
    if (scope === Approve.PAYMENT) return 'pay'
    return 'verify_other'
  }
  if (f.mode === Mode.DEFAULT) return i < prefixEnd && f.flags === 0 ? 'deploy' : 'post_op'
  return 'user_op'
}

/** Index of the frame that sets `payer`: the first VERIFY frame allowed to approve payment. */
export function prefixEnd(tx: FrameTx): number {
  const i = tx.frames.findIndex((f) => f.mode === Mode.VERIFY && (f.flags & Approve.PAYMENT) !== 0)
  if (i < 0) throw new Error('no frame can approve payment')
  return i
}

export function kinds(tx: FrameTx): Kind[] {
  const end = prefixEnd(tx)
  return tx.frames.map((_, i) => kindOf(tx, i, end))
}

/** The shape string, verifier frames included, as `a | b | c`. */
export function shape(tx: FrameTx): string {
  return kinds(tx)
    .slice(0, prefixEnd(tx) + 1)
    .join(' | ')
}

const ADMITTED = ['self_verify', 'deploy | self_verify', 'only_verify | pay', 'deploy | only_verify | pay']

export type Rule = 'eip8369' | 'eip8272'
export type Verdict = { ok: true } | { ok: false; reason: string }

/**
 * Profile 2 candidacy from the transaction alone. `eip8369` skips a leading expiry frame for
 * shape matching; `eip8272` also skips a recent-root frame first or right behind it.
 */
export function profile2Candidate(tx: FrameTx, rule: Rule): Verdict {
  if (tx.blobVersionedHashes.length > 0) return { ok: false, reason: 'carries blobs' }
  const k = kinds(tx)
  const end = prefixEnd(tx)
  const skip = new Set<number>()
  if (k[0] === 'expiry_verify') skip.add(0)
  if (rule === 'eip8272') {
    const at = k[0] === 'expiry_verify' ? 1 : 0
    if (k[at] === 'recent_root_verify') skip.add(at)
  }
  const prefix = k.slice(0, end + 1).filter((_, i) => !skip.has(i))
  const s = prefix.join(' | ')
  if (!ADMITTED.includes(s)) return { ok: false, reason: `shape ${s}` }
  for (let i = 0; i <= end; i++) {
    if (tx.frames[i].flags & ATOMIC_BATCH_FLAG) return { ok: false, reason: 'atomic flag in the prefix' }
  }
  for (let i = end + 1; i < tx.frames.length; i++) {
    if (tx.frames[i].mode === Mode.VERIFY) return { ok: false, reason: 'VERIFY after the prefix' }
  }
  if (verifyBudgetCost(tx) > MAX_VERIFY_GAS_PER_TX) return { ok: false, reason: 'over MAX_VERIFY_GAS_PER_TX' }
  return { ok: true }
}

/**
 * EIP-8369's static VERIFY budget cost: signature verification plus the declared execution limits
 * of every frame up to the one that sets `payer`, verifier frames included (EIP-8272 and ethrex
 * count them; the expiry frame is named by EIP-8369 itself).
 */
export function verifyBudgetCost(tx: FrameTx): bigint {
  const end = prefixEnd(tx)
  let cost = signatureVerificationGas(tx)
  for (let i = 0; i <= end; i++) cost += tx.frames[i].limits.execution
  return cost
}

/** The other reading of "the declared gas limits": both dimensions. */
export function verifyBudgetCostWithState(tx: FrameTx): bigint {
  const end = prefixEnd(tx)
  let cost = verifyBudgetCost(tx)
  for (let i = 0; i <= end; i++) cost += tx.frames[i].limits.state
  return cost
}

/** What the same prefix would cost had every frame declared exactly the execution gas it used. */
export function usedBudgetCost(tx: FrameTx, receipt: FrameTxReceiptJson): bigint {
  const end = prefixEnd(tx)
  let cost = signatureVerificationGas(tx)
  for (let i = 0; i <= end; i++) cost += frameReceiptGas(receipt.frameReceipts[i]).execution
  return cost
}

/**
 * Cold account access on the chain the fixture came from: 3,000 under EIP-8038's Amsterdam
 * values (the Hegota testnet), 2,600 under EIP-2929. A sender is warm from the start.
 */
export function coldAccess(tx: FrameTx): bigint {
  return tx.chainId === 8141n ? 3_000n : 2_600n
}

/**
 * Did this mined VERIFY frame run default code? EIP-8141: "The default code draws no execution
 * gas of its own: the frame's only execution charge is the resolved target's access". Any code
 * that reaches APPROVE pushes its three operands first, so code costs at least the access charge
 * plus six; default code costs exactly the access charge.
 */
export function ranDefaultCode(tx: FrameTx, receipt: FrameTxReceiptJson, i: number): boolean {
  const f = tx.frames[i]
  if (f.mode !== Mode.VERIFY) return false
  const access = isAddressEqual(resolves(tx, f.target), tx.sender) ? 100n : coldAccess(tx)
  return frameReceiptGas(receipt.frameReceipts[i]).execution === access
}

/**
 * The proposed Profile 1 for frame transactions: every frame up to the one that sets `payer` is
 * an expiry verifier frame or runs default code, and nothing after it is VERIFY. Its validity at
 * any state is then a function of the sender's nonce, balance and code flag, the payer's balance
 * and code flag, the deadline, and the block's base fee: EIP-8141's own "complete state
 * dependency set" for directly evaluable prefixes.
 */
export function profile1Frames(tx: FrameTx, receipt: FrameTxReceiptJson): Verdict {
  if (tx.blobVersionedHashes.length > 0) return { ok: false, reason: 'carries blobs' }
  const k = kinds(tx)
  const end = prefixEnd(tx)
  for (let i = 0; i <= end; i++) {
    if (k[i] === 'expiry_verify') continue
    if (k[i] === 'recent_root_verify') return { ok: false, reason: 'recent-root frame (EIP-8272 state)' }
    if (k[i] === 'deploy') return { ok: false, reason: 'deploy frame (runs factory code)' }
    if (!ranDefaultCode(tx, receipt, i)) return { ok: false, reason: `${k[i]} runs account code` }
  }
  for (let i = end + 1; i < tx.frames.length; i++) {
    if (tx.frames[i].mode === Mode.VERIFY) return { ok: false, reason: 'VERIFY after the prefix' }
  }
  return { ok: true }
}
