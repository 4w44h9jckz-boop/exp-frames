// Experiment 06's keyed pool, described without a key: the same CREATE2 labels and constructor
// words as experiment 06's deployment.ts, which also loads PRIVATE_KEY at import. The offline
// read-back uses this, so it runs on a checkout with no key.
import { keccak256, toHex } from 'viem'
import { create2Address, saltOf } from '../../src/deploy.js'
import { HASHER_INITCODE, PATCHED_VERIFIER_INITCODE, PoolMode, framePool } from '../06-privacy-pool/pool.js'

const at = (initcode: `0x${string}`, label: string) => create2Address(initcode, saltOf(`exp-frames/06/${label}`))

export const keyedPool = framePool({
  hasher: at(HASHER_INITCODE, 'hasher'),
  verifier: at(PATCHED_VERIFIER_INITCODE, 'verifier-patched'),
  history: 0,
  mode: PoolMode.KEYED,
  salt: keccak256(toHex('exp-frames/06/pool-keyed')),
  label: 'pool-keyed/v1',
})

