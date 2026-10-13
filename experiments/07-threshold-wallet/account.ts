import { type Hex, concatHex, keccak256, numberToHex, toHex } from 'viem'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { type FrameSignature, type FrameTx, Mode, Scheme, frameSigHash } from '../../src/frametx/index.js'
import { type Group, dkg, encodeSignature, member, sign } from './frost.js'

export const FROST_ACCOUNT_CODE = compileYul('experiments/07-threshold-wallet/FrostAccount.yul')

export const NAMES = ['alice', 'bob', 'carol'] as const
export const ID = { alice: 1n, bob: 2n, carol: 3n } as const

/**
 * The 2-of-3 group alice, bob and carol run the DKG for. Each member's polynomial comes from its
 * own seed, derived from PRIVATE_KEY so that every run gets the same group key back; in a real
 * deployment each member draws its own and nobody, including this script, holds all three.
 */
export function group(base: Hex, label = 'v1'): Group {
  const members = NAMES.map((name) => member(ID[name], 2, keccak256(concatHex([base, toHex(`exp-frames/07/${label}/${name}`)]))))
  return dkg(members, 2)
}

/** FrostAccount for `g` at a CREATE2 address, and both ways of deploying it. */
export function frostAccount(g: Group, label: string) {
  const initcode = concatHex([FROST_ACCOUNT_CODE, numberToHex(g.px, { size: 32 }), numberToHex(g.parity, { size: 32 })])
  const salt = saltOf(label)
  const { frame } = deployFrame(initcode, salt)
  return {
    initcode,
    address: create2Address(initcode, salt),
    /** SENDER frame in someone else's transaction. */
    deployBySender: frame,
    /** DEFAULT frame at the head of the account's own transaction (Example 1b). */
    deployAtSender: { ...frame, mode: Mode.DEFAULT, limits: { ...frame.limits, execution: 80_000n } },
  }
}

/** The unsigned ARBITRARY entry FrostAccount reads. */
export const arbitraryEntry = (): FrameSignature => ({ scheme: Scheme.ARBITRARY, signer: null, msg: '0x', signature: '0x' })

/** Run FROST among `signers` over the sig hash and put the 52-byte signature in entry `index`. */
export function signFrost(tx: FrameTx, g: Group, signers: bigint[], index = 0): FrameTx {
  const signature = encodeSignature(sign(g, signers, frameSigHash(tx)))
  return { ...tx, signatures: tx.signatures.map((s, i) => (i === index ? { ...s, signature } : s)) }
}
