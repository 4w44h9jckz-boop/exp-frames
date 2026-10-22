// Experiment 52, the chain's side: the SealedPair contract, its calls, and the settlement.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Address, type Hex, concatHex, encodeFunctionData, keccak256, numberToHex, pad, parseAbi, toHex } from 'viem'
import { REPO_ROOT, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { Approve, type Frame, type FrameTx, STORAGE_SET_STATE_GAS, expiryFrame, senderFrame, verifyFrame } from '../../src/frametx/index.js'
import { POOL_FEES } from '../06-privacy-pool/pool.js'
import { verifierInitcode } from '../32-owned-state/registry.js'
import type { Proof } from './joint.js'

export const DIR = 'experiments/52-joint-comparison'
const file = (f: string) => resolve(REPO_ROOT, DIR, f)

type Vkey = Parameters<typeof verifierInitcode>[0]
const VKEY = JSON.parse(readFileSync(file('build/joint.vkey.json'), 'utf8')) as Vkey

const fixed = (initcode: Hex, label: string) => {
  const salt = saltOf(`exp-frames/52/${label}`)
  const lower = initcode.toLowerCase() as Hex
  return { label, initcode: lower, salt, address: create2Address(lower, salt), deploy: deployFrame(lower, salt).frame }
}

export const verifier = fixed(verifierInitcode(VKEY), 'verifier')
export const pair = fixed(concatHex([compileYul(`${DIR}/SealedPair.yul`), pad(verifier.address)]), 'sealed-pair')

export const pairAbi = parseAbi([
  'function open(bytes32 session, uint256 Ca, address bob, uint64 deadline) payable',
  'function join(bytes32 session, uint256 Cb) payable',
  'function reveal(bytes32 session, uint256 x, uint256 y)',
  'function reclaim(bytes32 session)',
  'function settle(bytes32 session, uint256 out, uint256[8] proof)',
  'event Step(bytes32 indexed session, uint256 state, uint256 x, uint256 y)',
])

/** A session id below the scalar field, from a label: it is also the proof's `session` input. */
export const sessionOf = (label: string): bigint => BigInt(keccak256(toHex(`exp-frames/52/session/${label}`))) >> 8n

const word = (x: bigint) => numberToHex(x, { size: 32 })
const call = (data: Hex, value = 0n, state = 0n): Frame => senderFrame({ target: pair.address, value, data, execution: 120_000n, state })

export const openFrame = (session: bigint, Ca: bigint, bob: Address, deadline: bigint, bond: bigint) =>
  call(encodeFunctionData({ abi: pairAbi, functionName: 'open', args: [word(session), Ca, bob, deadline] }), bond, 6n * STORAGE_SET_STATE_GAS)
export const joinFrame = (session: bigint, Cb: bigint, bond: bigint) =>
  call(encodeFunctionData({ abi: pairAbi, functionName: 'join', args: [word(session), Cb] }), bond, STORAGE_SET_STATE_GAS)
export const revealFrame = (session: bigint, share: string[]) =>
  call(encodeFunctionData({ abi: pairAbi, functionName: 'reveal', args: [word(session), BigInt(share[0]), BigInt(share[1])] }))
export const reclaimFrame = (session: bigint) => call(encodeFunctionData({ abi: pairAbi, functionName: 'reclaim', args: [word(session)] }))

/** The proof's eight words, A.x A.y B.x1 B.x0 B.y1 B.y0 C.x C.y. */
export const proofWords = (p: Proof): bigint[] =>
  [p.pi_a[0], p.pi_a[1], p.pi_b[0][1], p.pi_b[0][0], p.pi_b[1][1], p.pi_b[1][0], p.pi_c[0], p.pi_c[1]].map(BigInt)

export const VERIFY_EXECUTION = 300_000n
export const SETTLE_EXECUTION = 150_000n

/** The settlement: expiry, the contract's VERIFY, settle. */
export function settleTx(o: { chainId: bigint; session: bigint; deadline: bigint; out: bigint; proof: bigint[] }): FrameTx {
  return {
    chainId: o.chainId,
    nonceKeys: [o.session],
    nonceSeq: 0n,
    sender: pair.address,
    frames: [
      expiryFrame(o.deadline),
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: VERIFY_EXECUTION, state: STORAGE_SET_STATE_GAS }),
      senderFrame({
        target: pair.address,
        data: encodeFunctionData({ abi: pairAbi, functionName: 'settle', args: [word(o.session), o.out, o.proof as never] }),
        execution: SETTLE_EXECUTION,
        state: STORAGE_SET_STATE_GAS,
      }),
    ],
    signatures: [],
    fees: POOL_FEES,
    blobVersionedHashes: [],
  }
}
