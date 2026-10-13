import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { type Hex, bytesToHex, concatHex, hexToBytes, keccak256, numberToHex, pad, size, toBytes, toHex } from 'viem'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { type FrameSignature, type FrameTx, Mode, type P256Key, Scheme, frameSigHash, p256Address, p256PublicKey } from '../../src/frametx/index.js'

export const P256_ACCOUNT_CODE = compileYul('experiments/11-passkey/P256Account.yul')
export const WEBAUTHN_ACCOUNT_CODE = compileYul('experiments/11-passkey/WebAuthnAccount.yul')

/** P256 keys derived from PRIVATE_KEY, so each run gets the same accounts back. */
export function deriveP256(base: Hex, label: string): P256Key {
  const d = BigInt(keccak256(concatHex([base, toHex(`exp-frames/11/p256/${label}`)]))) % (p256.CURVE.n - 1n)
  return { scheme: 'p256', privateKey: numberToHex(d + 1n, { size: 32 }) }
}

/** A counterfactual account: initcode, CREATE2 address, and both ways of deploying it. */
function counterfactual(initcode: Hex, label: string) {
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

/** P256Account owned by `key`: the protocol checks the signature, the account checks the signer. */
export const p256Account = (key: P256Key, label: string) =>
  counterfactual(concatHex([P256_ACCOUNT_CODE, pad(p256Address(key))]), label)

/** WebAuthnAccount owned by `key`: the account checks a WebAuthn assertion itself. */
export const webauthnAccount = (key: P256Key, label: string) => {
  const { qx, qy } = p256PublicKey(key)
  return counterfactual(concatHex([WEBAUTHN_ACCOUNT_CODE, qx, qy]), label)
}

// ---- a software WebAuthn authenticator ----

export const RP_ID = 'exp-frames.test'
export const ORIGIN = `https://${RP_ID}`

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export type AssertionOptions = {
  /** authenticatorData flags: 0x01 user present, 0x04 user verified. Default 0x05. */
  flags?: number
  /** Overrides the challenge (default: the challenge asked for). */
  challenge?: Uint8Array
  type?: string
  /** Use the high-s form of the signature. */
  highS?: boolean
  /** Edit clientDataJSON after signing. */
  tamper?: (json: string) => string
}

/**
 * What `navigator.credentials.get()` returns for `challenge`, packed for WebAuthnAccount:
 * authLen (2) || challengeIndex (2) || typeIndex (2) || authenticatorData || clientDataJSON || r || s.
 */
export function webauthnAssertion(key: P256Key, challenge: Hex, opts: AssertionOptions = {}): Hex {
  const authenticatorData = new Uint8Array([...sha256(toBytes(RP_ID)), opts.flags ?? 0x05, 0, 0, 0, 1])
  const clientDataJSON = JSON.stringify({
    type: opts.type ?? 'webauthn.get',
    challenge: base64url(opts.challenge ?? hexToBytes(challenge)),
    origin: ORIGIN,
    crossOrigin: false,
  })
  const message = sha256(new Uint8Array([...authenticatorData, ...sha256(toBytes(clientDataJSON))]))
  const sig = p256.sign(message, hexToBytes(key.privateKey), { lowS: true })
  const s = opts.highS ? p256.CURVE.n - sig.s : sig.s
  const json = opts.tamper ? opts.tamper(clientDataJSON) : clientDataJSON
  const indexOf = (needle: string) => {
    const i = json.indexOf(needle)
    return i < 0 ? 0 : i
  }
  return concatHex([
    numberToHex(authenticatorData.length, { size: 2 }),
    numberToHex(indexOf('"challenge":"'), { size: 2 }),
    numberToHex(indexOf('"type":"'), { size: 2 }),
    bytesToHex(authenticatorData),
    toHex(json),
    numberToHex(sig.r, { size: 32 }),
    numberToHex(s, { size: 32 }),
  ])
}

/** The unsigned ARBITRARY entry WebAuthnAccount reads. */
export const arbitraryEntry = (): FrameSignature => ({ scheme: Scheme.ARBITRARY, signer: null, msg: '0x', signature: '0x' })

/** Fill ARBITRARY entry `index` with a WebAuthn assertion over the transaction's sig hash. */
export function signWebAuthn(tx: FrameTx, key: P256Key, index = 0, opts: AssertionOptions = {}): FrameTx {
  const signature = webauthnAssertion(key, frameSigHash(tx), opts)
  return { ...tx, signatures: tx.signatures.map((s, i) => (i === index ? { ...s, signature } : s)) }
}

export const assertionSize = (tx: FrameTx, index = 0) => size(tx.signatures[index].signature)
