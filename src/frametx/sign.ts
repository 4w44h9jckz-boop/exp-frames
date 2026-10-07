import { p256 } from '@noble/curves/p256'
import {
  type Address,
  type Hex,
  bytesToHex,
  concatHex,
  getAddress,
  hexToBytes,
  isAddressEqual,
  keccak256,
  numberToHex,
  pad,
  slice,
  toHex,
} from 'viem'
import { privateKeyToAddress, sign } from 'viem/accounts'
import { Scheme } from './constants.js'
import { frameSigHash } from './encode.js'
import type { FrameSignature, FrameTx } from './types.js'

/** yParity(1) || r(32) || s(32). v is the bare recovery id 0/1, not 27/28. */
export async function secp256k1Sign(digest: Hex, privateKey: Hex): Promise<Hex> {
  const sig = await sign({ hash: digest, privateKey })
  if (sig.yParity === undefined) throw new Error('signer returned no yParity')
  return concatHex([toHex(sig.yParity, { size: 1 }), pad(sig.r, { size: 32 }), pad(sig.s, { size: 32 })])
}

/** A SECP256K1 entry with an empty signature, to be filled by `signFrameTx`. */
export function secp256k1Placeholder(signer: FrameSignature['signer'] = null, msg: Hex = '0x'): FrameSignature {
  return { scheme: Scheme.SECP256K1, signer, msg, signature: '0x' }
}

/**
 * Fill every SECP256K1 entry whose resolved signer is this key's address.
 * Empty-`msg` entries sign the canonical sig hash; others sign their explicit digest.
 * Entries for other signers are left alone, so several keys can sign in turn.
 */
export async function signFrameTx(tx: FrameTx, privateKey: Hex): Promise<FrameTx> {
  const me = privateKeyToAddress(privateKey)
  // The sig hash elides every empty-msg signature, so it is stable while we fill them in.
  const sigHash = frameSigHash(tx)
  let matched = 0
  const signatures = await Promise.all(
    tx.signatures.map(async (s) => {
      if (s.scheme !== Scheme.SECP256K1) return s
      if (!isAddressEqual(s.signer ?? tx.sender, me)) return s
      matched++
      return { ...s, signature: await secp256k1Sign(s.msg === '0x' ? sigHash : s.msg, privateKey) }
    }),
  )
  if (matched === 0) throw new Error(`no SECP256K1 signature entry resolves to ${me}`)
  return { ...tx, signatures }
}

// ---- P256 (secp256r1, scheme 0x2) ----

/** A P256 private key, kept apart from secp256k1 keys so the two cannot be mixed up. */
export type P256Key = { scheme: 'p256'; privateKey: Hex }

export function generateP256Key(): P256Key {
  return { scheme: 'p256', privateKey: bytesToHex(p256.utils.randomPrivateKey()) }
}

/** The uncompressed public key coordinates. */
export function p256PublicKey(key: P256Key): { qx: Hex; qy: Hex } {
  const pub = p256.getPublicKey(hexToBytes(key.privateKey), false) // 0x04 ‖ qx ‖ qy
  return { qx: bytesToHex(pub.subarray(1, 33)), qy: bytesToHex(pub.subarray(33)) }
}

/** The P256 signer address: keccak256(qx ‖ qy)[12:]. */
export function p256Address(key: P256Key): Address {
  const { qx, qy } = p256PublicKey(key)
  return getAddress(slice(keccak256(concatHex([qx, qy])), 12))
}

/** r ‖ s ‖ qx ‖ qy, signing the 32-byte digest as is (no prehash) with low s, as the protocol requires. */
export function p256Sign(digest: Hex, key: P256Key): Hex {
  const sig = p256.sign(hexToBytes(digest), hexToBytes(key.privateKey), { lowS: true, prehash: false })
  const { qx, qy } = p256PublicKey(key)
  return concatHex([numberToHex(sig.r, { size: 32 }), numberToHex(sig.s, { size: 32 }), qx, qy])
}

/** A P256 entry with an empty signature, to be filled by `signFrameTx`. */
export function p256Placeholder(signer: FrameSignature['signer'], msg: Hex = '0x'): FrameSignature {
  return { scheme: Scheme.P256, signer, msg, signature: '0x' }
}

/** Fill every P256 entry whose resolved signer is this key's address. */
export function signFrameTxP256(tx: FrameTx, key: P256Key): FrameTx {
  const me = p256Address(key)
  const sigHash = frameSigHash(tx)
  let matched = 0
  const signatures = tx.signatures.map((s) => {
    if (s.scheme !== Scheme.P256 || !isAddressEqual(s.signer ?? tx.sender, me)) return s
    matched++
    return { ...s, signature: p256Sign(s.msg === '0x' ? sigHash : s.msg, key) }
  })
  if (matched === 0) throw new Error(`no P256 signature entry resolves to ${me}`)
  return { ...tx, signatures }
}

/** A secp256k1 private key (hex) or a P256 key. */
export type AnyKey = Hex | P256Key

/** Sign with either kind of key. */
export async function signWith(tx: FrameTx, key: AnyKey): Promise<FrameTx> {
  return typeof key === 'string' ? signFrameTx(tx, key) : signFrameTxP256(tx, key)
}
