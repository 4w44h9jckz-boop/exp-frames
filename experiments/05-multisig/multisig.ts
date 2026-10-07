import { type Address, type Hex, concatHex, keccak256, numberToHex, pad, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { p256 } from '@noble/curves/p256'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { type AnyKey, type Frame, Mode, type P256Key, p256Address } from '../../src/frametx/index.js'

export const MULTISIG_CODE = compileYul('experiments/05-multisig/Multisig.yul')

/** The address a key signs as: secp256k1 → its EOA address, P256 → keccak256(qx ‖ qy)[12:]. */
export const addressOf = (key: AnyKey): Address => (typeof key === 'string' ? privateKeyToAddress(key) : p256Address(key))

/** Counterfactual k-of-n multisig: initcode, address, and its deployment as a SENDER or DEFAULT frame. */
export function multisig(owners: Address[], k: number, label: string) {
  const words = [...owners.map((o) => pad(o)), numberToHex(owners.length, { size: 32 }), numberToHex(k, { size: 32 })]
  const initcode: Hex = concatHex([MULTISIG_CODE, ...words])
  const salt = saltOf(label)
  const { frame } = deployFrame(initcode, salt)
  return {
    owners,
    k,
    initcode,
    address: create2Address(initcode, salt),
    /** SENDER frame: someone else's transaction deploys it. */
    deployBySender: frame,
    /**
     * DEFAULT frame: Example 1b, the account deploys itself as `tx.sender`. It is part of the
     * validation prefix, so its execution budget is kept small (MAX_VERIFY_GAS counts limits).
     */
    deployAtSender: { ...frame, mode: Mode.DEFAULT, limits: { ...frame.limits, execution: 80_000n } } satisfies Frame,
  }
}

// Owner keys are derived from the main PRIVATE_KEY, so the same accounts come back on every run
// and nothing new has to be stored. They never leave this process.
export function deriveSecp256k1(base: Hex, label: string): Hex {
  return keccak256(concatHex([base, toHex(`exp-frames/05/${label}`)]))
}
export function deriveP256(base: Hex, label: string): P256Key {
  const d = BigInt(keccak256(concatHex([base, toHex(`exp-frames/05/p256/${label}`)]))) % (p256.CURVE.n - 1n)
  return { scheme: 'p256', privateKey: numberToHex(d + 1n, { size: 32 }) }
}
