// The derivation of experiment 45, a second implementation beside kohaku-rs's
// `kohaku-frame-secrets`: one BIP-39 seed, owner keys on BIP-44's path, and every other secret
// HKDF-SHA256(seed, salt = "kohaku-seed-v1", info = label).
import { hash_to_field } from '@noble/curves/abstract/hash-to-curve'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { secp256k1 } from '@noble/curves/secp256k1'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { type Address, type Hex, bytesToHex, hexToBigInt, toHex } from 'viem'
import { mnemonicToAccount, privateKeyToAddress } from 'viem/accounts'

export const SALT = 'kohaku-seed-v1'
export const BLINDING_DST = 'kohaku-seed-v1/ticket-blinding'
/** BN254's scalar field. */
export const BN254_P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

export type Seed = { mnemonic: string; bytes: Uint8Array }

export function seedOf(mnemonic: string): Seed {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('not a BIP-39 English mnemonic')
  return { mnemonic, bytes: mnemonicToSeedSync(mnemonic) }
}

/** K(label). */
export const key = (seed: Seed, label: string): Hex =>
  bytesToHex(hkdf(sha256, seed.bytes, new TextEncoder().encode(SALT), new TextEncoder().encode(label), 32))

/** Owner i, at m/44'/60'/0'/0/i. */
export const owner = (seed: Seed, i: number): Address => mnemonicToAccount(seed.mnemonic, { addressIndex: i }).address

/** K(label) as a secp256k1 key's address. */
export const secpAddress = (seed: Seed, label: string): Address => privateKeyToAddress(key(seed, label))

/** The viewing key's compressed public key. */
export const viewPublic = (seed: Seed): Hex => bytesToHex(secp256k1.getPublicKey(key(seed, 'view').slice(2), true))

/** The j-th registry note's secrets in `vault`, each K(label) mod p. */
export function custody(seed: Seed, vault: Address, j: number) {
  const part = (p: string) => hexToBigInt(key(seed, `custody/${vault.toLowerCase()}/${j}/${p}`)) % BN254_P
  return { nullifierSecret: part('nullifier'), secret: part('secret') }
}

/** The k-th ticket's blinding factor: RFC 9380's hash_to_field of K(label) into BLS12-381's Fr. */
export function blinding(seed: Seed, k: number): bigint {
  const [[r]] = hash_to_field(Buffer.from(key(seed, `ticket/${k}/blinding`).slice(2), 'hex'), 1, {
    DST: BLINDING_DST,
    p: bls.fields.Fr.ORDER,
    m: 1,
    k: 128,
    expand: 'xmd',
    hash: sha256,
  })
  return r
}

export const word = (x: bigint): Hex => toHex(x, { size: 32 })
