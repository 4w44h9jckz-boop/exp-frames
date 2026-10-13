// The contracts and notes of this experiment, derived deterministically so every script sees
// the same addresses: CREATE2 salts are labels, and notes come from PRIVATE_KEY.
import { type Address, type PublicClient, concatHex, keccak256, toHex, zeroHash } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN, execute } from '../../src/execute.js'
import { Approve, type Frame, prepareFrameTx, secp256k1Placeholder, verifyFrame } from '../../src/frametx/index.js'
import {
  HASHER_INITCODE,
  PATCHED_VERIFIER_INITCODE,
  POOL_FEES,
  PoolMode,
  VERIFIER_INITCODE,
  deriveNote,
  framePool,
  poolSponsor,
} from './pool.js'

export const { privateKey, address: funder } = loadKey()

const fixed = (initcode: `0x${string}`, label: string) => {
  const salt = saltOf(`exp-frames/06/${label}`)
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}

export const hasher = fixed(HASHER_INITCODE, 'hasher')
export const stockVerifier = fixed(VERIFIER_INITCODE, 'verifier-stock')
export const patchedVerifier = fixed(PATCHED_VERIFIER_INITCODE, 'verifier-patched')

const base = { hasher: hasher.address, salt: zeroHash, history: 0 }

/** Mode 0, every root kept: the three-gates design. */
export const storagePool = framePool({ ...base, verifier: patchedVerifier.address, mode: PoolMode.STORAGE, label: 'pool-storage/v1' })
/** Mode 0, the last two roots kept: Tornado's ring buffer, shortened so it rotates quickly. */
export const ringPool = framePool({ ...base, verifier: patchedVerifier.address, mode: PoolMode.STORAGE, history: 2, label: 'pool-ring2/v1' })
/** Mode 1: nullifiers as EIP-8250 nonce keys, roots through EIP-8272. VERIFY reads no storage. */
export const keyedPool = framePool({
  ...base,
  verifier: patchedVerifier.address,
  mode: PoolMode.KEYED,
  salt: keccak256(toHex('exp-frames/06/pool-keyed')),
  label: 'pool-keyed/v1',
})
/** Mode 0 with Tornado's verifier as shipped. */
export const stockPool = framePool({ ...base, verifier: stockVerifier.address, mode: PoolMode.STORAGE, label: 'pool-stock-verifier/v1' })

export const storageSponsor = poolSponsor(storagePool.address, funder, 'sponsor-storage/v1')
export const keyedSponsor = poolSponsor(keyedPool.address, funder, 'sponsor-keyed/v1')

/** Recipients are fresh addresses, so every payout creates an account, as a real one would. */
export function recipient(label: string): Address {
  return privateKeyToAddress(keccak256(concatHex([privateKey, toHex(`exp-frames/06/recipient/${label}`)])))
}

export const note = (label: string) => deriveNote(privateKey, label)

/**
 * The funder's SENDER frames behind its own VERIFY, at a 1 wei tip (the base fee is 7 wei).
 * Not sent unless every frame succeeds in simulation: a valid transaction can still revert.
 */
export async function sendFrames(client: PublicClient, frames: Frame[], label: string) {
  const tx = await prepareFrameTx(client, {
    sender: funder,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), ...frames],
    signatures: [secp256k1Placeholder()],
    fees: POOL_FEES,
  })
  const { sim } = await execute(client, tx, [privateKey], { label, dryRun: true })
  if (sim.executionStatus !== 'success') throw new Error(`${label}: a frame reverts in simulation (${sim.executionError})`)
  if (!DRY_RUN) return execute(client, tx, [privateKey])
}
