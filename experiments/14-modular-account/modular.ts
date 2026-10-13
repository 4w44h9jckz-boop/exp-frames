import { type Address, type Hex, concatHex, keccak256, numberToHex, pad, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  type FrameTx,
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

export type Key = { key: Hex; address: Address }
export function derive(label: string): Key {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/14/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

const code = (name: string) => compileYul(`experiments/14-modular-account/${name}.yul`)

/** A module at its CREATE2 address; any number of accounts share it. */
function shared(name: string) {
  const initcode = code(name)
  const salt = saltOf(`exp-frames/14/${name}/v1`)
  return { name, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}
export const ownerValidator = shared('OwnerValidator')
export const externalOwnerValidator = shared('ExternalOwnerValidator')
export const countingValidator = shared('CountingValidator')
export const modules = [ownerValidator, externalOwnerValidator, countingValidator]

export const Kind = { DELEGATE: 1, CALL: 2 } as const

/** ModularAccount with `module` installed at construction (two fresh slots: kind, and the owner). */
export function modularAccount(module: Address, kind: number, owner: Address, label: string) {
  const initcode = concatHex([code('ModularAccount'), pad(module), numberToHex(kind, { size: 32 }), pad(owner)])
  const salt = saltOf(`exp-frames/14/${label}`)
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt, 2n * STORAGE_SET_STATE_GAS).frame }
}

/** SENDER frame installing `module`. `fresh` counts the new slots it writes, anywhere. */
export const install = (account: Address, module: Address, kind: number, init: Hex, fresh: bigint): Frame =>
  senderFrame({ target: account, data: concatHex(['0x01', module, numberToHex(kind, { size: 1 }), init]), execution: 80_000n, state: fresh * STORAGE_SET_STATE_GAS })

/** A transaction judged by `module`, signed by `signer`. */
export async function viaModule(account: Address, module: Address, signer: Key, frames: Frame[], moduleData: Hex = '0x'): Promise<FrameTx> {
  const tx = await prepareFrameTx(client, {
    sender: account,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 40_000n, data: concatHex([module, moduleData]) }), ...frames],
    signatures: [secp256k1Placeholder(signer.address)],
  })
  return signAll(tx, [signer.key])
}
