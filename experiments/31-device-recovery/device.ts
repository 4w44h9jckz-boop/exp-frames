// Experiment 31's keys, accounts and transactions. Keys are derived from PRIVATE_KEY, so every
// run gets the same accounts back.
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

export const DEVICE_RECOVERY_CODE = compileYul('experiments/31-device-recovery/DeviceRecoveryAccount.yul')

/** Which rule says an early finish is too early. */
export type Rule = 'eip' | 'ethrex'
export const LOWER_BOUND: Record<Rule, bigint> = { eip: 0n, ethrex: 1n }

export type Key = { key: Hex; address: Address }

export function derive(label: string): Key {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/31/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

/** The owner's devices as the VERIFY frame reveals them: salt || m || devices. */
export type Devices = { salt: Hex; m: number; devices: Key[] }
export const reveal = (d: Devices): Hex => concatHex([d.salt, numberToHex(d.m, { size: 1 }), ...d.devices.map((x) => x.address)])
export const commitment = (d: Devices): Hex => keccak256(reveal(d))

/** DeviceRecoveryAccount at a CREATE2 address, deployed by somebody else; three slots. */
export function deviceRecoveryAccount(owner: Address, d: Devices, delay: bigint, rule: Rule, label: string) {
  const initcode = concatHex([DEVICE_RECOVERY_CODE, pad(owner), commitment(d), numberToHex(delay, { size: 32 }), numberToHex(LOWER_BOUND[rule], { size: 32 })])
  const salt = saltOf(`${label}/${rule}`)
  return { initcode, salt, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt, 3n * STORAGE_SET_STATE_GAS).frame }
}

export const Op = { START: '0x01', FINISH: '0x02', CANCEL: '0x03', SET_DEVICES: '0x04' } as const

/** SENDER frame the account sends to itself. */
export const op = (account: Address, data: Hex): Frame => senderFrame({ target: account, data, execution: 50_000n })
export const start = (account: Address, next: Address) => op(account, concatHex([Op.START, next]))

/** A transaction from the account, VERIFY first, signed by `signers` in ascending address order. */
export async function accountTx(account: Address, signers: Key[], frames: Frame[], opts: { verifyData?: Hex; fees?: FrameTxFees } = {}): Promise<FrameTx> {
  const ordered = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
  const tx = await prepareFrameTx(client, {
    sender: account,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 40_000n, data: opts.verifyData }), ...frames],
    signatures: ordered.map((s) => secp256k1Placeholder(s.address)),
    fees: opts.fees,
  })
  return signAll(tx, ordered.map((s) => s.key))
}

/** Owner, device commitment, pending owner and unlock time. */
export async function readState(account: Address) {
  const [owner, devices, recovery] = await Promise.all(
    [0, 1, 2].map(async (i) => BigInt((await client.getStorageAt({ address: account, slot: numberToHex(i, { size: 32 }) })) ?? '0x0')),
  )
  const addr = (v: bigint) => `0x${v.toString(16).padStart(40, '0')}` as Address
  const pending = recovery >> 96n
  return { owner: addr(owner), devices: numberToHex(devices, { size: 32 }), pending: addr(pending), unlock: pending ? recovery & ((1n << 96n) - 1n) : 0n }
}
