// Experiment 50's addendum: the passkey arm. Registry version 4 and a software WebAuthn
// authenticator (SIMULATED: it produces what `navigator.credentials.get()` returns), with the
// knobs the negative cases need.
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { type Hex, bytesToHex, concatHex, hexToBytes, keccak256, numberToHex, pad, toBytes, toHex } from 'viem'
import { compileYul } from '../../src/contracts.js'
import { type FrameTx, type P256Key, frameSigHash, p256PublicKey } from '../../src/frametx/index.js'
import { sourceIdOf } from '../06-privacy-pool/pool.js'
import { HASHER } from '../32-owned-state/registry.js'
import { DIR, type Registry, verifier } from './device.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'

const word = (x: bigint) => numberToHex(x, { size: 32 })

/** Version 4: the WebAuthn arm. */
export const v4: Registry = (() => {
  const label = 'registry/v4'
  const salt = keccak256(toHex(`exp-frames/50/${label}`))
  const initcode = concatHex([compileYul(`${DIR}/OwnedStateRegistryV4.yul`), pad(HASHER), pad(verifier.address), salt, word(1n)]).toLowerCase() as Hex
  const cs = saltOf(`exp-frames/50/${label}`)
  const address = create2Address(initcode, cs)
  return { label, initcode, salt: cs, address, deploy: deployFrame(initcode, cs).frame, rootSalt: salt, sourceId: sourceIdOf(address, salt), keyed: true }
})()

export const RP_ID = 'exp-frames.test'
export const ORIGIN = `https://${RP_ID}`

export type AssertionOptions = {
  /** authenticatorData flags: 0x01 user present, 0x04 user verified. Default 0x05. */
  flags?: number
  /** The relying party whose hash starts authenticatorData. */
  rpId?: string
  /** The 32 bytes the challenge encodes (default: the transaction's signature hash). */
  challenge?: Hex
  /** One more field in clientDataJSON, as a browser may add. */
  extra?: Record<string, string>
  highS?: boolean
  /** Bytes appended after qy, beyond what the header declares. */
  trailing?: Hex
}

/** The parts of an assertion, kept for the record. */
export type Assertion = { entry: Hex; authenticatorData: Hex; clientDataJSON: string; message: Hex }

/**
 * The ARBITRARY entry registry version 4 reads:
 * authLen (2) || clientLen (2) || challengeIndex (2) || typeIndex (2) || authenticatorData
 * || clientDataJSON || r || s || qx || qy.
 */
export function assertion(key: P256Key, sigHash: Hex, o: AssertionOptions = {}): Assertion {
  const authenticatorData = new Uint8Array([...sha256(toBytes(o.rpId ?? RP_ID)), o.flags ?? 0x05, 0, 0, 0, 1])
  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge: Buffer.from(hexToBytes(o.challenge ?? sigHash)).toString('base64url'),
    origin: ORIGIN,
    crossOrigin: false,
    ...o.extra,
  })
  const client = toBytes(clientDataJSON)
  const message = sha256(new Uint8Array([...authenticatorData, ...sha256(client)]))
  const sig = p256.sign(message, hexToBytes(key.privateKey), { lowS: true })
  const s = o.highS ? p256.CURVE.n - sig.s : sig.s
  const { qx, qy } = p256PublicKey(key)
  const entry = concatHex([
    numberToHex(authenticatorData.length, { size: 2 }),
    numberToHex(client.length, { size: 2 }),
    numberToHex(clientDataJSON.indexOf('"challenge":"'), { size: 2 }),
    numberToHex(clientDataJSON.indexOf('"type":"'), { size: 2 }),
    bytesToHex(authenticatorData),
    bytesToHex(client),
    numberToHex(sig.r, { size: 32 }),
    numberToHex(s, { size: 32 }),
    qx,
    qy,
    o.trailing ?? '0x',
  ])
  return { entry, authenticatorData: bytesToHex(authenticatorData), clientDataJSON, message: bytesToHex(message) }
}

/** Fill entry 0 of an update with a passkey assertion over its signature hash. */
export function signPasskey(tx: FrameTx, key: P256Key, o: AssertionOptions = {}): { tx: FrameTx; assertion: Assertion } {
  const a = assertion(key, frameSigHash(tx), o)
  return { tx: { ...tx, signatures: [{ ...tx.signatures[0], signature: a.entry }] }, assertion: a }
}
