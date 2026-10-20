// Experiment 33: the version-2 registry, a second asset, the board, and a swap's two updates.
// The kernel, its verifier, the hasher and the first asset (experiment 32's Balance) are reused.
import { type Address, type Hex, concatHex, encodeFunctionData, hexToBigInt, keccak256, numberToHex, pad, toHex } from 'viem'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { Approve, type FrameTx, NEW_ACCOUNT_STATE_GAS, STORAGE_SET_STATE_GAS, expiryFrame, senderFrame, verifyFrame } from '../../src/frametx/index.js'
import { POOL_FEES, recentRootFrame, sourceIdOf } from '../06-privacy-pool/pool.js'
import {
  CAP,
  FEE,
  H,
  HASHER,
  INSERT_EXECUTION,
  INSERT_STATE,
  type Secrets,
  type Spend,
  UPDATE_EXECUTION,
  type Update,
  VERIFY_EXECUTION,
  balance,
  innerOf,
  nullifierOf,
  registryAbi,
  tagOf,
  updateCalldata,
  verifier,
} from '../32-owned-state/registry.js'
import { boardAbi } from './announce.js'

export const DIR = 'experiments/33-owned-state-swap'
const word = (x: bigint) => numberToHex(x, { size: 32 })

const fixed = (mixed: Hex, label: string) => {
  const initcode = mixed.toLowerCase() as Hex
  const salt = saltOf(`exp-frames/33/${label}`)
  return { label, initcode, salt, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}

export const ROOT_SALT = keccak256(toHex('exp-frames/33/registry'))
export const registry = fixed(
  concatHex([compileYul(`${DIR}/OwnedStateRegistry.yul`), pad(HASHER), pad(verifier.address), ROOT_SALT]),
  'registry/v2',
)
export const SOURCE_ID = sourceIdOf(registry.address, ROOT_SALT)

/** Asset A is experiment 32's Balance; asset B is the same rule deployed again, another tag. */
export const assetA = balance
export const assetB = fixed(concatHex([compileYul('experiments/32-owned-state/Balance.yul'), word(CAP)]), 'app/balance-b')
export const board = fixed(compileYul(`${DIR}/Board.yul`), 'board')

export const postFrame = (message: Hex) =>
  senderFrame({ target: board.address, data: encodeFunctionData({ abi: boardAbi, functionName: 'post', args: [message] }), execution: 40_000n })

export function depositFrame(app: Address, inner: bigint, value: bigint, first = false) {
  return senderFrame({
    target: registry.address,
    value,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'deposit', args: [app, word(inner)] }),
    execution: 1_200_000n,
    state: first ? 2_600_000n : 500_000n,
  })
}

/** What a pair's update names of the other: keccak256(nullifier || newCommitment). */
export const pairLink = (nullifier: bigint, newCommitment: bigint): bigint => hexToBigInt(keccak256(concatHex([word(nullifier), word(newCommitment)])))

/**
 * One side of a swap: its note goes, whole less the fee, to the other side's inner, and its
 * proof names the other side's update, which it can compute from the offer and the answer.
 */
export function swapSpend(mine: { app: Address; secrets: Secrets; state: bigint; index: number }, theirs: { app: Address; nullifier: bigint; state: bigint }, theirInner: bigint, myReceiveInner: bigint, deadline: bigint): Spend {
  const theirChange = H(tagOf(theirs.app), myReceiveInner, theirs.state - FEE)
  return {
    app: mine.app,
    secrets: mine.secrets,
    state: mine.state,
    index: mine.index,
    withdrawn: FEE,
    newInner: theirInner,
    recipient: '0x0000000000000000000000000000000000000000',
    fee: FEE,
    link: pairLink(theirs.nullifier, theirChange),
    deadline,
  }
}

/** The owner's own update of a note: everything out to `recipient`, no change. */
export const soloSpend = (mine: { app: Address; secrets: Secrets; state: bigint; index: number }, recipient: Address, deadline: bigint): Spend => ({
  ...mine,
  withdrawn: mine.state,
  recipient,
  fee: FEE,
  deadline,
})

/** VERIFY for a pair: two Groth16 checks. Frames 0 to 2 must fit the testnet's 500,000. */
export const PAIR_VERIFY_EXECUTION = 480_000n
export const EXPIRY_EXECUTION = 5_000n
export const RECENT_ROOT_EXECUTION = 6_000n

/** The version-2 update: [expiry, 8272, VERIFY, SENDER], no signature, nullifiers as keys. */
export function updateTx(o: { chainId: bigint; root: bigint; slot: bigint; deadline: bigint; updates: Update[]; verifyExecution?: bigint }): FrameTx {
  const k = BigInt(o.updates.length)
  const inserts = BigInt(o.updates.filter((u) => u.newCommitment !== 0n).length)
  const payouts = BigInt(o.updates.filter((u) => u.withdrawn > u.fee).length)
  const keys = o.updates.map((u) => u.nullifier)
  if (keys.some((x, i) => i > 0 && x <= keys[i - 1])) throw new Error('updates must be in ascending nullifier order')
  return {
    chainId: o.chainId,
    nonceKeys: keys,
    nonceSeq: 0n,
    sender: registry.address,
    frames: [
      expiryFrame(o.deadline, EXPIRY_EXECUTION),
      recentRootFrame(SOURCE_ID, o.slot, word(o.root), RECENT_ROOT_EXECUTION),
      verifyFrame({
        scope: Approve.EXECUTION_AND_PAYMENT,
        target: null,
        execution: o.verifyExecution ?? (k === 1n ? VERIFY_EXECUTION : PAIR_VERIFY_EXECUTION),
        state: STORAGE_SET_STATE_GAS * k,
      }),
      senderFrame({
        target: registry.address,
        data: updateCalldata(o.root, o.updates),
        execution: UPDATE_EXECUTION * k + INSERT_EXECUTION * inserts,
        state: NEW_ACCOUNT_STATE_GAS * payouts + INSERT_STATE * inserts,
      }),
    ],
    signatures: [],
    fees: POOL_FEES,
    blobVersionedHashes: [],
  }
}

/** A note as its owner keeps it. */
export type Held = { app: Address; secrets: Secrets; state: bigint; index: number }
export const nullifierOfHeld = (n: Held) => nullifierOf(n.app, n.secrets)
export const innerOfHeld = (n: Held) => innerOf(n.secrets)
