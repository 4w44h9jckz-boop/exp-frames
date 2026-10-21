// Experiment 51's enclave, SIMULATED: a process that stands in for an enclave on someone else's
// machine. It is "a function with encrypted input and signature for attestation" that "can also
// generate" a zero-knowledge proof for integrity.
//
// Its measurement is the SHA-256 of this file. Its keys live in a sealed file, AES-256-GCM under
// HKDF-SHA256(device secret, measurement), so only this exact source, given the device secret,
// opens it. The device secret stands in for a key fused into the processor; here the host passes
// it in the environment as DEVICE_SECRET, which is exactly what a real enclave would not allow.
//
// Commands, one JSON object on stdin, one on stdout:
//   {"cmd":"provision","sealed":path,"attestationKey":hex}
//       makes a fresh Baby Jubjub key, seals it with the attestation key; answers pk, measurement
//   {"cmd":"run","sealed":path,"ciphertexts":[[Ex,Ey,c],[Ex,Ey,c]]}
//       opens the seal, decrypts both bids, compares, and answers the output, the attestation
//       and the proof. It never answers a bid.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { buildBabyjub, buildMimcSponge } from 'circomlibjs'
import * as snarkjs from 'snarkjs'
import { type Hex, bytesToHex, concatHex, hexToBytes, keccak256, numberToHex, toHex } from 'viem'

const SELF = fileURLToPath(import.meta.url)
const DIR = resolve(SELF, '..')
const MEASUREMENT = bytesToHex(sha256(readFileSync(SELF)))

const babyjub = await buildBabyjub()
const mimc = await buildMimcSponge()
const F = babyjub.F
const big = (x: unknown) => F.toObject(x) as bigint
const H = (a: bigint, b: bigint): bigint => mimc.F.toObject(mimc.multiHash([a, b], 0n, 1))
const word = (x: bigint) => numberToHex(x, { size: 32 })

type Sealed = { sk: string; attestationKey: Hex }

function sealingKey(): Buffer {
  const secret = process.env.DEVICE_SECRET
  if (!secret) throw new Error('no DEVICE_SECRET')
  return Buffer.from(hkdfSync('sha256', hexToBytes(secret as Hex), hexToBytes(MEASUREMENT), 'exp-frames/51/seal', 32))
}

function seal(path: string, s: Sealed) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', sealingKey(), iv)
  const body = Buffer.concat([c.update(JSON.stringify(s)), c.final()])
  writeFileSync(path, JSON.stringify({ iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), body: body.toString('hex') }))
}

function unseal(path: string): Sealed {
  const f = JSON.parse(readFileSync(path, 'utf8'))
  const d = createDecipheriv('aes-256-gcm', sealingKey(), Buffer.from(f.iv, 'hex'))
  d.setAuthTag(Buffer.from(f.tag, 'hex'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(f.body, 'hex')), d.final()]).toString())
}

const pkOf = (sk: bigint): [bigint, bigint] => {
  const p = babyjub.mulPointEscalar(babyjub.Base8, sk)
  return [big(p[0]), big(p[1])]
}

function decrypt(sk: bigint, [ex, ey, c]: bigint[]): bigint {
  const s = babyjub.mulPointEscalar([F.e(ex), F.e(ey)], sk)
  const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
  return (((c - H(big(s[0]), big(s[1]))) % p) + p) % p
}

async function main() {
  const req = JSON.parse(readFileSync(0, 'utf8'))
  if (req.cmd === 'provision') {
    // A Baby Jubjub secret below the subgroup order, from the process's own randomness.
    const sk = BigInt(bytesToHex(randomBytes(32))) % babyjub.subOrder
    seal(req.sealed, { sk: sk.toString(), attestationKey: req.attestationKey })
    const [x, y] = pkOf(sk)
    process.stdout.write(JSON.stringify({ measurement: MEASUREMENT, pk: [x.toString(), y.toString()] }))
    return
  }
  if (req.cmd !== 'run') throw new Error(`unknown command ${req.cmd}`)
  const s = unseal(req.sealed)
  const sk = BigInt(s.sk)
  const pk = pkOf(sk)
  const cts: bigint[][] = req.ciphertexts.map((c: string[]) => c.map(BigInt))
  const [a, b] = cts.map((c) => decrypt(sk, c))
  if (a >= 1n << 64n || b >= 1n << 64n) throw new Error('a ciphertext does not hold a 64-bit bid')
  const out = a > b ? 1n : 0n

  // The attestation: the attestation key's P-256 signature over what the outcome contract
  // rebuilds, keccak256("exp-frames/51/attest" || measurement || pk || inputs || out).
  const inputs = keccak256(concatHex(cts.flat().map(word)))
  const digest = keccak256(concatHex([toHex('exp-frames/51/attest'), MEASUREMENT, word(pk[0]), word(pk[1]), inputs, word(out)]))
  const sig = p256.sign(hexToBytes(digest), hexToBytes(s.attestationKey), { lowS: true, prehash: false })

  // The proof: the same output, from the ciphertexts and sk.
  const input = {
    pk: pk.map(String),
    Ea: [cts[0][0], cts[0][1]].map(String),
    ca: String(cts[0][2]),
    Eb: [cts[1][0], cts[1][1]].map(String),
    cb: String(cts[1][2]),
    out: String(out),
    sk: String(sk),
  }
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, resolve(DIR, 'build/enclave_js/enclave.wasm'), resolve(DIR, 'build/enclave.zkey'))
  const bw = proof.pi_b
  process.stdout.write(
    JSON.stringify({
      measurement: MEASUREMENT,
      out: out.toString(),
      statement: publicSignals,
      attestation: [sig.r.toString(), sig.s.toString()],
      proof: [proof.pi_a[0], proof.pi_a[1], bw[0][1], bw[0][0], bw[1][1], bw[1][0], proof.pi_c[0], proof.pi_c[1]],
    }),
  )
}

await main()
process.exit(0)
