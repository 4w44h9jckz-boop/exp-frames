import { type Address, type Hex, concatHex, keccak256, numberToHex, pad, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxFees,
  STORAGE_SET_STATE_GAS,
  getNonceSeq,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signAll,
  verifyFrame,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

export type Key = { key: Hex; address: Address }
export function derive(label: string): Key {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/16/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

/** SubscriptionAccount owned by `owner`, at a CREATE2 address, deployed by somebody else. */
export function subscriptionAccount(owner: Address, label: string) {
  const initcode = concatHex([compileYul('experiments/16-subscriptions/SubscriptionAccount.yul'), pad(owner)])
  const salt = saltOf(`exp-frames/16/${label}`)
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}

export type Plan = { amount: bigint; period: bigint; firstDue: bigint }
export const subscribe = (account: Address, m: Address, p: Plan): Frame =>
  senderFrame({
    target: account,
    data: concatHex(['0x01', m, numberToHex(p.amount, { size: 16 }), numberToHex(p.period, { size: 8 }), numberToHex(p.firstDue, { size: 8 })]),
    execution: 40_000n,
    state: STORAGE_SET_STATE_GAS,
  })
export const cancel = (account: Address, m: Address): Frame => senderFrame({ target: account, data: concatHex(['0x02', m]), execution: 40_000n })

/** The subscription as stored: amount, period, next due time. */
export async function readPlan(account: Address, m: Address) {
  const v = BigInt((await client.getStorageAt({ address: account, slot: keccak256(pad(m)) })) ?? '0x0')
  return { amount: v >> 128n, period: (v >> 64n) & 0xffffffffffffffffn, due: v & 0xffffffffffffffffn }
}

/** The merchant's own nonce lane in the account: nonce key = the merchant's address. */
export const laneOf = (m: Address) => BigInt(m)

/**
 * A pull: the account approves execution of `0x03 ‖ m` only, the merchant's own address
 * approves payment (its default code checks entry 1), and the merchant signs both entries.
 * The first pull on a lane writes the keyed nonce slot, charged to the payment frame.
 */
export async function pullTx(account: Address, m: Key, opts: { fees?: FrameTxFees; edit?: (frames: Frame[]) => Frame[]; nonceKeys?: bigint[]; scope?: number } = {}): Promise<FrameTx> {
  const nonceKeys = opts.nonceKeys ?? [laneOf(m.address)]
  const nonceSeq = await getNonceSeq(client, account, nonceKeys)
  let frames: Frame[] = [
    verifyFrame({ scope: opts.scope ?? Approve.EXECUTION, execution: 20_000n }),
    verifyFrame({ scope: Approve.PAYMENT, target: m.address, execution: 20_000n, state: nonceSeq === 0n && nonceKeys[0] !== 0n ? STORAGE_SET_STATE_GAS : 0n }),
    senderFrame({ target: account, data: concatHex(['0x03', m.address]), execution: 50_000n }),
  ]
  if (opts.edit) frames = opts.edit(frames)
  const tx = await prepareFrameTx(client, { sender: account, frames, signatures: [secp256k1Placeholder(m.address), secp256k1Placeholder(m.address)], nonceKeys, nonceSeq, fees: opts.fees })
  return signAll(tx, [m.key])
}

/** An owner transaction, on nonce key 0 unless `nonceKey` is given (a fresh key costs one slot). */
export async function ownerTx(account: Address, owner: Key, frames: Frame[], nonceKey = 0n): Promise<FrameTx> {
  const nonceSeq = await getNonceSeq(client, account, [nonceKey])
  const fresh = nonceKey !== 0n && nonceSeq === 0n
  const tx = await prepareFrameTx(client, {
    sender: account,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n, state: fresh ? STORAGE_SET_STATE_GAS : 0n }), ...frames],
    signatures: [secp256k1Placeholder(owner.address)],
    nonceKeys: [nonceKey],
    nonceSeq,
  })
  return signAll(tx, [owner.key])
}
