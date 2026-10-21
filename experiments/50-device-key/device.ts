// Experiment 50: notes owned by a P-256 key, the registry version 3 that checks the key's
// signature in VERIFY, and its control without the check. Experiment 32's tree, hash, verifier
// code and Balance application are reused; the kernel and its key are this experiment's.
//
// The owner keys are software P-256 keys derived from PRIVATE_KEY and a label. They stand in for
// keys held by a device's secure element: SIMULATED, nothing here is an enclave.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { p256 } from '@noble/curves/p256'
import * as snarkjs from 'snarkjs'
import {
  type Address,
  type Hex,
  concatHex,
  encodeFunctionData,
  hexToBigInt,
  hexToBytes,
  keccak256,
  numberToHex,
  pad,
  toHex,
} from 'viem'
import { REPO_ROOT, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import {
  Approve,
  type Frame,
  type FrameSignature,
  type FrameTx,
  type P256Key,
  NEW_ACCOUNT_STATE_GAS,
  STORAGE_SET_STATE_GAS,
  Scheme,
  frameSigHash,
  p256Address,
  p256PublicKey,
  p256Sign,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'
import { POOL_FEES, recentRootFrame, sourceIdOf } from '../06-privacy-pool/pool.js'
import { FIELD, H, HASHER, type Secrets, bindingOf, registryAbi, tagOf, treeOf, verifierInitcode } from '../32-owned-state/registry.js'

export const DIR = 'experiments/50-device-key'
const file = (f: string) => resolve(REPO_ROOT, DIR, f)
const word = (x: bigint | number | string) => numberToHex(BigInt(x), { size: 32 })

export { H, HASHER, registryAbi, treeOf }

// ---- contracts ----

type Vkey = Parameters<typeof verifierInitcode>[0]
/** This experiment's kernel key (README, "The proving key"). */
export const VKEY = JSON.parse(readFileSync(file('build/kernel.vkey.json'), 'utf8')) as Vkey

const fixed = (mixed: Hex, label: string) => {
  const initcode = mixed.toLowerCase() as Hex
  const salt = saltOf(`exp-frames/50/${label}`)
  return { label, initcode, salt, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}

export const verifier = fixed(verifierInitcode(VKEY), 'verifier')

function registryOf(label: string, keyed: boolean) {
  const salt = keccak256(toHex(`exp-frames/50/${label}`))
  const r = fixed(concatHex([compileYul(`${DIR}/OwnedStateRegistry.yul`), pad(HASHER), pad(verifier.address), salt, word(keyed ? 1 : 0)]), label)
  return { ...r, rootSalt: salt, sourceId: sourceIdOf(r.address, salt), keyed }
}
export type Registry = ReturnType<typeof registryOf>

/** Version 3: an update must carry its note's owner key's signature. */
export const keyed = registryOf('registry/v3', true)
/** The control: the same code with the owner check switched off. */
export const control = registryOf('registry/v3-control', false)

// ---- owner keys and notes ----

/** A software P-256 key from PRIVATE_KEY and a label, standing in for a device's enclave key. */
export function deviceKey(base: Hex, label: string): P256Key {
  const d = BigInt(keccak256(concatHex([base, toHex(`exp-frames/50/device-key/${label}`)]))) % (p256.CURVE.n - 1n)
  return { scheme: 'p256', privateKey: numberToHex(d + 1n, { size: 32 }) }
}

/** The note's owner: the key's address keccak256(qx || qy)[12:], as a number. */
export const ownerOf = (key: P256Key): bigint => hexToBigInt(p256Address(key))

export function secretsOf(base: Hex, label: string): Secrets {
  const f = (part: string) => hexToBigInt(keccak256(concatHex([base, toHex(`exp-frames/50/note/${label}/${part}`)]))) % FIELD
  return { nullifierSecret: f('nullifier'), secret: f('secret') }
}

/** inner = H(nullifierSecret, secret, owner). */
export const innerOf = (s: Secrets, owner: bigint) => H(s.nullifierSecret, s.secret, owner)
export const leafOf = (app: Address, inner: bigint, state: bigint) => H(tagOf(app), inner, state)
export const nullifierOf = (app: Address, s: Secrets) => H(tagOf(app), s.nullifierSecret)

export function depositFrame(r: Registry, app: Address, inner: bigint, value: bigint, first = false): Frame {
  return senderFrame({
    target: r.address,
    value,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'deposit', args: [app, word(inner)] }),
    execution: 1_200_000n,
    state: first ? 2_600_000n : 500_000n,
  })
}

// ---- proofs ----

export type Spend = {
  app: Address
  secrets: Secrets
  owner: bigint
  state: bigint
  index: number
  withdrawn: bigint
  /** The change note's inner, which names its own owner. None when nothing is left. */
  newInner?: bigint
  recipient: Address
  fee: bigint
}

export function kernelInput(s: Spend, leaves: bigint[]) {
  const tree = treeOf(leaves)
  const { pathElements, pathIndices } = tree.path(s.index)
  const tag = tagOf(s.app)
  const newState = s.state - s.withdrawn
  return {
    root: tree.root,
    nullifier: nullifierOf(s.app, s.secrets),
    newCommitment: s.newInner === undefined ? 0n : H(tag, s.newInner, newState),
    tag,
    withdrawn: s.withdrawn,
    binding: bindingOf(s.recipient, s.fee, s.owner),
    owner: s.owner,
    nullifierSecret: s.secrets.nullifierSecret,
    secret: s.secrets.secret,
    state: s.state,
    newInner: s.newInner ?? 0n,
    pathElements,
    pathIndices: pathIndices.map(BigInt),
  }
}
type KernelInput = ReturnType<typeof kernelInput>

const decimal = (x: Record<string, bigint | bigint[]>) =>
  Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]))

export async function proveInput(input: KernelInput): Promise<bigint[]> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(decimal(input), file('build/kernel_js/kernel.wasm'), file('build/kernel.zkey'))
  if (!(await snarkjs.groth16.verify(VKEY, publicSignals, proof))) throw new Error('snarkjs produced a proof its own key refuses')
  const b = proof.pi_b
  return [proof.pi_a[0], proof.pi_a[1], b[0][1], b[0][0], b[1][1], b[1][0], proof.pi_c[0], proof.pi_c[1]].map(BigInt)
}

/** 0 nullifier 1 newCommitment 2 tag 3 withdrawn 4 recipient 5 fee 6 owner 7-14 proof */
export type Update = {
  nullifier: bigint
  newCommitment: bigint
  tag: bigint
  withdrawn: bigint
  recipient: Address
  fee: bigint
  owner: bigint
  proof: bigint[]
}

export async function prove(s: Spend, leaves: bigint[]): Promise<{ root: bigint; update: Update }> {
  const input = kernelInput(s, leaves)
  const proof = await proveInput(input)
  const { nullifier, newCommitment, tag, withdrawn, owner } = input
  return { root: input.root, update: { nullifier, newCommitment, tag, withdrawn, recipient: s.recipient, fee: s.fee, owner, proof } }
}

export const updateWords = (u: Update): bigint[] => [u.nullifier, u.newCommitment, u.tag, u.withdrawn, hexToBigInt(u.recipient), u.fee, u.owner, ...u.proof]

export function updateCalldata(root: bigint, u: Update): Hex {
  return encodeFunctionData({ abi: registryAbi, functionName: 'update', args: [word(root), [updateWords(u)] as never] })
}

/** VERIFY: experiment 32's 260,000 and room for the key check. */
export const VERIFY_EXECUTION = 280_000n
export const UPDATE_EXECUTION = 100_000n
export const INSERT_EXECUTION = 1_200_000n
export const INSERT_STATE = 2n * STORAGE_SET_STATE_GAS
export const FEE = 10n ** 10n

/** How the owner key's signature travels: checked by the registry, by the protocol, or absent. */
export type Route = 'arbitrary' | 'p256' | 'none'

export function placeholder(route: Route, owner: bigint): FrameSignature[] {
  if (route === 'arbitrary') return [{ scheme: Scheme.ARBITRARY, signer: null, msg: '0x', signature: '0x' }]
  if (route === 'p256') return [{ scheme: Scheme.P256, signer: numberToHex(owner, { size: 20 }), msg: '0x', signature: '0x' }]
  return []
}

export function updateTx(o: { chainId: bigint; r: Registry; root: bigint; slot: bigint; update: Update; route: Route }): FrameTx {
  const u = o.update
  const inserts = u.newCommitment !== 0n ? 1n : 0n
  const payouts = u.withdrawn > u.fee ? 1n : 0n
  return {
    chainId: o.chainId,
    nonceKeys: [u.nullifier],
    nonceSeq: 0n,
    sender: o.r.address,
    frames: [
      recentRootFrame(o.r.sourceId, o.slot, word(o.root)),
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: VERIFY_EXECUTION, state: STORAGE_SET_STATE_GAS }),
      senderFrame({
        target: o.r.address,
        data: updateCalldata(o.root, u),
        execution: UPDATE_EXECUTION + INSERT_EXECUTION * inserts,
        state: NEW_ACCOUNT_STATE_GAS * payouts + INSERT_STATE * inserts,
      }),
    ],
    signatures: placeholder(o.route, u.owner),
    fees: POOL_FEES,
    blobVersionedHashes: [],
  }
}

/** P-256's group order. */
export const N = p256.CURVE.n

/**
 * Sign entry 0 with `key`, over the signature hash. This is the one thing the device's secure
 * element is asked to do: sign a 32-byte digest it is handed, with no hashing of its own. `highS`
 * gives the other valid s, n - s, for the refusal that checks the low-s rule.
 */
export function signUpdate(tx: FrameTx, key: P256Key, highS = false): FrameTx {
  const digest = frameSigHash(tx)
  let sig = p256Sign(digest, key)
  if (highS) {
    const s = hexToBigInt(`0x${sig.slice(66, 130)}`)
    sig = concatHex([`0x${sig.slice(2, 66)}`, numberToHex(N - s, { size: 32 }), `0x${sig.slice(130)}`])
  }
  return { ...tx, signatures: [{ ...tx.signatures[0], signature: sig }] }
}

/** Checks a filled entry 0 offline, the way the registry does. */
export function checkSignature(tx: FrameTx, owner: bigint): boolean {
  const sig = tx.signatures[0].signature
  const [r, s, qx, qy] = [0, 1, 2, 3].map((i) => `0x${sig.slice(2 + 64 * i, 66 + 64 * i)}` as Hex)
  if (hexToBigInt(keccak256(concatHex([qx, qy]))) % (1n << 160n) !== owner) return false
  if (hexToBigInt(s) > N / 2n) return false
  const pub = hexToBytes(concatHex(['0x04', qx, qy]))
  return p256.verify(hexToBytes(concatHex([r, s])), hexToBytes(frameSigHash(tx)), pub, { prehash: false, lowS: true })
}

export { p256PublicKey }
