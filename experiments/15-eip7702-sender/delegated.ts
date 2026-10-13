import { type Address, type Hex, concatHex, createWalletClient, http, keccak256, toHex, zeroAddress } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type AnyKey,
  type Frame,
  type FrameSignature,
  type FrameTx,
  HEGOTA_RPC_URL,
  STORAGE_SET_STATE_GAS,
  hegotaTestnet,
  makeClient,
  prepareFrameTx,
  senderFrame,
  signAll,
  verifyFrame,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

export type Key = { key: Hex; address: Address }
export function derive(label: string): Key {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/15/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

/** PasskeyDelegate, deployed once at a CREATE2 address; any EOA may delegate to it. */
const initcode = compileYul('experiments/15-eip7702-sender/PasskeyDelegate.yul')
const salt = saltOf('exp-frames/15/PasskeyDelegate/v1')
export const delegate = { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }

/** `0xef0100 ‖ address` when delegated, `undefined` when not. */
export const codeOf = (address: Address) => client.getCode({ address })

/**
 * A type-4 transaction from the funder carrying `eoa`'s authorization to delegate to `target`
 * (zeroAddress clears it). The funder pays; the EOA only signs the authorization.
 */
export async function setDelegation(eoa: Key, target: Address): Promise<Hex> {
  const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: hegotaTestnet, transport: http(HEGOTA_RPC_URL) })
  const authorization = await wallet.signAuthorization({ account: privateKeyToAccount(eoa.key), contractAddress: target })
  return wallet.sendTransaction({ authorizationList: [authorization], to: eoa.address, data: '0x' })
}
export const clearDelegation = (eoa: Key) => setDelegation(eoa, zeroAddress)

/** A frame transaction from `sender`: VERIFY first, then `frames`, signed by `key` into `entry`. */
export async function eoaTx(sender: Address, entry: FrameSignature, key: AnyKey, frames: Frame[]): Promise<FrameTx> {
  const tx = await prepareFrameTx(client, {
    sender,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 30_000n }), ...frames],
    signatures: [entry],
  })
  return signAll(tx, [key])
}

/** SENDER frame registering a P256 key: one fresh slot in the EOA's storage. */
export const registerPasskey = (eoa: Address, p256: Address): Frame =>
  senderFrame({ target: eoa, data: concatHex(['0x01', p256]), execution: 40_000n, state: STORAGE_SET_STATE_GAS })
