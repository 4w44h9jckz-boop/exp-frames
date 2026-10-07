import { type Hex, concatHex, isAddressEqual, pad, toHex } from 'viem'
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
