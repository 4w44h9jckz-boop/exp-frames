// Experiment 51, the host's side: encryption to the enclave's key, the outcome contract and its
// transactions, and the call into the enclave process. The enclave itself is enclave.ts:
// SIMULATED, a process on this machine.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { buildBabyjub, buildMimcSponge } from 'circomlibjs'
import { type Hex, bytesToHex, concatHex, encodeAbiParameters, encodeFunctionData, hexToBytes, keccak256, numberToHex, parseAbi, toHex } from 'viem'
import { REPO_ROOT, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { Approve, type FrameTx, type P256Key, STORAGE_SET_STATE_GAS, p256PublicKey, senderFrame, verifyFrame } from '../../src/frametx/index.js'
import { POOL_FEES } from '../06-privacy-pool/pool.js'
import { verifierInitcode } from '../32-owned-state/registry.js'

export const DIR = 'experiments/51-remote-enclave'
const file = (f: string) => resolve(REPO_ROOT, DIR, f)
const word = (x: bigint | number) => numberToHex(BigInt(x), { size: 32 })

/** The measurement a real enclave's hardware would report: here, the SHA-256 of enclave.ts. */
export const MEASUREMENT: Hex = bytesToHex(sha256(readFileSync(file('enclave.ts'))))

// ---- encryption to the enclave ----

const babyjub = await buildBabyjub()
const mimc = await buildMimcSponge()
const F = babyjub.F
const big = (x: unknown) => F.toObject(x) as bigint
const H = (a: bigint, b: bigint): bigint => mimc.F.toObject(mimc.multiHash([a, b], 0n, 1))
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

export type Ciphertext = [bigint, bigint, bigint]

/** E = r * B8, c = x + H(r * pk), for a 64-bit bid x and a fresh r. */
export function encrypt(pk: [bigint, bigint], x: bigint, r: bigint): Ciphertext {
  if (x >= 1n << 64n) throw new Error('a bid is 64 bits')
  const e = babyjub.mulPointEscalar(babyjub.Base8, r)
  const s = babyjub.mulPointEscalar([F.e(pk[0]), F.e(pk[1])], r)
  return [big(e[0]), big(e[1]), (x + H(big(s[0]), big(s[1]))) % P]
}

export const SUB_ORDER: bigint = babyjub.subOrder

export const ciphertextBytes = (c: Ciphertext): Hex => encodeAbiParameters([{ type: 'uint256[3]' }], [c])

// ---- the enclave process ----

export type EnclaveRun = {
  measurement: Hex
  out: string
  statement: string[]
  attestation: [string, string]
  proof: string[]
}

/** Run `source` (enclave.ts, or a changed copy) as its own process with one command. */
export function callEnclave<T>(request: object, deviceSecret: Hex, source = file('enclave.ts')): T {
  const out = execFileSync('npx', ['tsx', source], {
    cwd: REPO_ROOT,
    input: JSON.stringify(request),
    env: { ...process.env, DEVICE_SECRET: deviceSecret, PRIVATE_KEY: '' },
    maxBuffer: 1 << 24,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return JSON.parse(out.toString()) as T
}

// ---- the outcome contract ----

type Vkey = Parameters<typeof verifierInitcode>[0]
export const VKEY = JSON.parse(readFileSync(file('build/enclave.vkey.json'), 'utf8')) as Vkey

const fixed = (initcode: Hex, label: string) => {
  const salt = saltOf(`exp-frames/51/${label}`)
  const lower = initcode.toLowerCase() as Hex
  return { label, initcode: lower, salt, address: create2Address(lower, salt), deploy: deployFrame(lower, salt).frame }
}

export const verifier = fixed(verifierInitcode(VKEY), 'verifier')

/** The outcome contract, with the attestation key's public half as its trusted root. */
export function outcomeContract(attestation: P256Key | { qx: Hex; qy: Hex }) {
  const { qx, qy } = 'privateKey' in attestation ? p256PublicKey(attestation) : attestation
  return fixed(concatHex([compileYul(`${DIR}/EnclaveOutcome.yul`), word(BigInt(verifier.address)), qx, qy]), 'outcome')
}

export const outcomeAbi = parseAbi([
  'function record(uint256 route, bytes32 measurement, uint256[9] statement, uint256[8] evidence)',
  'event Outcome(uint256 indexed route, uint256 out, bytes32 inputs, uint256 pkx, uint256 pky)',
])

export const Route = { ATTESTED: 1n, PROVED: 2n } as const

/** pk.x pk.y Ea.x Ea.y ca Eb.x Eb.y cb out */
export type Statement = bigint[]

export const inputsOf = (s: Statement): Hex => keccak256(concatHex(s.slice(2, 8).map(word)))

export const attestationDigest = (measurement: Hex, s: Statement): Hex =>
  keccak256(concatHex([toHex('exp-frames/51/attest'), measurement, word(s[0]), word(s[1]), inputsOf(s), word(s[8])]))

/** The nonce key: one output per route, enclave key and ciphertexts. */
export const nonceKeyOf = (route: bigint, s: Statement): bigint =>
  BigInt(keccak256(concatHex([word(route), word(s[0]), word(s[1]), inputsOf(s)])))

/** A P-256 signature over `digest` with low s, as (r, s). */
export function attest(key: P256Key, digest: Hex): [bigint, bigint] {
  const sig = p256.sign(hexToBytes(digest), hexToBytes(key.privateKey), { lowS: true, prehash: false })
  return [sig.r, sig.s]
}

/** VERIFY: the attestation is a few thousand gas, the proof a Groth16 check with nine inputs. */
export const VERIFY_EXECUTION = 300_000n
export const RECORD_EXECUTION = 30_000n

export function outcomeTx(o: {
  chainId: bigint
  contract: { address: Hex }
  route: bigint
  measurement: Hex
  statement: Statement
  evidence: bigint[]
}): FrameTx {
  return {
    chainId: o.chainId,
    nonceKeys: [nonceKeyOf(o.route, o.statement)],
    nonceSeq: 0n,
    sender: o.contract.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: VERIFY_EXECUTION, state: STORAGE_SET_STATE_GAS }),
      senderFrame({
        target: o.contract.address,
        data: encodeFunctionData({
          abi: outcomeAbi,
          functionName: 'record',
          args: [o.route, o.measurement, o.statement as never, o.evidence as never],
        }),
        execution: RECORD_EXECUTION,
      }),
    ],
    signatures: [],
    fees: POOL_FEES,
    blobVersionedHashes: [],
  }
}
