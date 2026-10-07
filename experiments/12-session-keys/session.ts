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
  expiryFrame,
  makeClient,
  maxCost,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signAll,
  verifyFrame,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

export const SESSION_ACCOUNT_CODE = compileYul('experiments/12-session-keys/SessionAccount.yul')

/** secp256k1 keys derived from PRIVATE_KEY, so each run gets the same accounts back. */
export function derive(label: string): { key: Hex; address: Address } {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/12/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

/** SessionAccount owned by `owner`, at a CREATE2 address, deployed by somebody else. */
export function sessionAccount(owner: Address, label: string) {
  const initcode = concatHex([SESSION_ACCOUNT_CODE, pad(owner)])
  const salt = saltOf(label)
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}

export type Policy = { target: Address; selector: Hex; validUntil: bigint; budget: bigint }

/** The owner's SENDER frame adding a session: three fresh slots. */
export const addSession = (account: Address, key: Address, p: Policy): Frame =>
  senderFrame({
    target: account,
    data: concatHex(['0x01', key, p.target, pad(p.selector, { size: 4 }), numberToHex(p.validUntil, { size: 8 }), numberToHex(p.budget, { size: 16 })]),
    execution: 80_000n,
    state: 3n * STORAGE_SET_STATE_GAS,
  })

/** The owner's SENDER frame revoking a session. */
export const revokeSession = (account: Address, key: Address): Frame =>
  senderFrame({ target: account, data: concatHex(['0x02', key]), execution: 40_000n })

/** What the account has stored for `key`. */
export async function readSession(account: Address, key: Address) {
  const base = BigInt(keccak256(pad(key)))
  const [policy, budget, spent] = await Promise.all(
    [0n, 1n, 2n].map((i) => client.getStorageAt({ address: account, slot: numberToHex(base + i, { size: 32 }) })),
  )
  const p = BigInt(policy ?? '0x0')
  return {
    active: p !== 0n,
    target: `0x${(p >> 96n).toString(16).padStart(40, '0')}` as Address,
    selector: numberToHex((p >> 64n) & 0xffffffffn, { size: 4 }),
    validUntil: p & 0xffffffffffffffffn,
    budget: BigInt(budget ?? '0x0'),
    spent: spent && BigInt(spent) > 0n ? BigInt(spent) - 1n : 0n,
  }
}

export type Call = { value?: bigint; data?: Hex; execution?: bigint }

/**
 * A session transaction: expiry, VERIFY, the spend record, then `calls` to `target`. The spend
 * amount covers the maximum cost plus the value sent, so it is computed after the fees are fixed.
 * `edit` changes the unsigned transaction before the amount is filled in.
 */
export async function sessionTx(
  account: Address,
  session: { key: Hex; address: Address },
  target: Address,
  calls: Call[],
  opts: { deadline: bigint; fees?: FrameTxFees; amount?: (computed: bigint) => bigint; edit?: (frames: Frame[]) => Frame[]; nonceKeys?: bigint[] },
): Promise<FrameTx> {
  const spend = (amount: bigint) => senderFrame({ target: account, data: concatHex(['0x03', session.address, numberToHex(amount, { size: 32 })]), execution: 30_000n })
  const callFrames = calls.map((c) => senderFrame({ target, value: c.value ?? 0n, data: c.data ?? '0x', execution: c.execution ?? 50_000n }))
  const build = (amount: bigint) => {
    const frames = [expiryFrame(opts.deadline), verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 60_000n }), spend(amount), ...callFrames]
    return opts.edit ? opts.edit(frames) : frames
  }
  const draft = await prepareFrameTx(client, {
    sender: account,
    frames: build(0n),
    signatures: [secp256k1Placeholder(session.address)],
    fees: opts.fees,
    nonceKeys: opts.nonceKeys,
  })
  // The maximum cost depends on calldata, including the amount's own bytes and the signature's,
  // neither known yet. Price both as all non-zero bytes: an upper bound, which the account
  // accepts because it only requires amount >= max cost + value.
  const value = draft.frames.reduce((acc, f, i) => (i >= 3 ? acc + f.value : acc), 0n)
  const worst = { ...draft, frames: build(2n ** 256n - 1n), signatures: draft.signatures.map((s) => ({ ...s, signature: `0x${'ff'.repeat(65)}` as Hex })) }
  let amount = maxCost(worst) + value
  if (opts.amount) amount = opts.amount(amount)
  return signAll({ ...draft, frames: build(amount) }, [session.key])
}

/** An owner transaction: VERIFY signed by the owner, then `frames`. */
export async function ownerTx(account: Address, owner: { key: Hex; address: Address }, frames: Frame[], opts: { fees?: FrameTxFees; nonceKeys?: bigint[]; verifyState?: bigint } = {}) {
  const tx = await prepareFrameTx(client, {
    sender: account,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n, state: opts.verifyState ?? 0n }), ...frames],
    signatures: [secp256k1Placeholder(owner.address)],
    fees: opts.fees,
    nonceKeys: opts.nonceKeys,
  })
  return signAll(tx, [owner.key])
}
