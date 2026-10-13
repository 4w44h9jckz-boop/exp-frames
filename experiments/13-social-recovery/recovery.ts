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
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signAll,
  verifyFrame,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

/** v2 packs the recovery into one slot that never returns to zero; v1 is what the first run used. */
export type Version = 'v1' | 'v2'
export const VERSION: Version = process.argv.includes('--v1') ? 'v1' : 'v2'
const CODE: Record<Version, Hex> = {
  v1: compileYul('experiments/13-social-recovery/RecoveryAccountV1.yul'),
  v2: compileYul('experiments/13-social-recovery/RecoveryAccount.yul'),
}
/** Fresh slots the constructor writes, and the ones each recovery's start writes. */
const FRESH = { v1: { deploy: 2n, initiate: 2n }, v2: { deploy: 3n, initiate: 0n } }

export type Key = { key: Hex; address: Address }

/** secp256k1 keys derived from PRIVATE_KEY, so each run gets the same accounts back. */
export function derive(label: string): Key {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/13/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

/** The guardian set as the VERIFY frame reveals it: salt ‖ m ‖ guardians. */
export type Guardians = { salt: Hex; m: number; guardians: Key[] }
export const reveal = (g: Guardians): Hex => concatHex([g.salt, numberToHex(g.m, { size: 1 }), ...g.guardians.map((x) => x.address)])
export const commitment = (g: Guardians): Hex => keccak256(reveal(g))

/** RecoveryAccount at a CREATE2 address, deployed by somebody else. */
export function recoveryAccount(owner: Address, g: Guardians, delay: bigint, label: string, version: Version = VERSION) {
  const initcode = concatHex([CODE[version], pad(owner), commitment(g), numberToHex(delay, { size: 32 })])
  const salt = saltOf(`${label}/${version}`)
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt, FRESH[version].deploy * STORAGE_SET_STATE_GAS).frame }
}

export const Op = { INITIATE: '0x01', FINALIZE: '0x02', CANCEL: '0x03', SET_GUARDIANS: '0x04' } as const

/** SENDER frame the account sends to itself. */
export const op = (account: Address, data: Hex, state = 0n): Frame => senderFrame({ target: account, data, execution: 50_000n, state })
export const initiate = (account: Address, next: Address, version: Version = VERSION) =>
  op(account, concatHex([Op.INITIATE, next]), FRESH[version].initiate * STORAGE_SET_STATE_GAS)

/** A transaction from the account, VERIFY first, signed by `signers` in ascending address order. */
export async function accountTx(account: Address, signers: Key[], frames: Frame[], opts: { verifyData?: Hex; fees?: FrameTxFees; sort?: boolean } = {}): Promise<FrameTx> {
  const ordered = opts.sort === false ? signers : [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
  const tx = await prepareFrameTx(client, {
    sender: account,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 40_000n, data: opts.verifyData }), ...frames],
    signatures: ordered.map((s) => secp256k1Placeholder(s.address)),
    fees: opts.fees,
  })
  return signAll(tx, ordered.map((s) => s.key))
}

/** Owner, guardian commitment, pending owner and unlock time, from either version's layout. */
export async function readState(account: Address, version: Version = VERSION) {
  const [owner, guardians, s2, s3] = await Promise.all(
    [0, 1, 2, 3].map(async (i) => BigInt((await client.getStorageAt({ address: account, slot: numberToHex(i, { size: 32 }) })) ?? '0x0')),
  )
  const addr = (v: bigint) => `0x${v.toString(16).padStart(40, '0')}` as Address
  const [pending, unlock] = version === 'v1' ? [s2, s3] : [s2 >> 96n, s2 & ((1n << 96n) - 1n)]
  return { owner: addr(owner), guardians: numberToHex(guardians, { size: 32 }), pending: addr(pending), unlock: pending ? unlock : 0n }
}
