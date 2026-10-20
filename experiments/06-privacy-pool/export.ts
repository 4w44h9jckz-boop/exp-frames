// The CREATE2 deployment frames of the keyed pool and what it calls, as JSON, for a test that
// replays them on another chain: kohaku-rs's local-node test deploys them unchanged, so the
// contracts land at the addresses they have on the testnet. Offline; needs no key.
//
// usage: npx tsx experiments/06-privacy-pool/export.ts > deployments.json
import { execFileSync } from 'node:child_process'
import { keccak256, toHex } from 'viem'
import { deployFrame, saltOf } from '../../src/deploy.js'
import { HASHER_INITCODE, PATCHED_VERIFIER_INITCODE, PoolMode, framePool } from './pool.js'

const fixed = (initcode: `0x${string}`, label: string) => ({ label, ...deployFrame(initcode, saltOf(`exp-frames/06/${label}`)) })
const hasher = fixed(HASHER_INITCODE, 'hasher')
const verifier = fixed(PATCHED_VERIFIER_INITCODE, 'verifier-patched')
const pool = framePool({
  hasher: hasher.address,
  verifier: verifier.address,
  history: 0,
  mode: PoolMode.KEYED,
  salt: keccak256(toHex('exp-frames/06/pool-keyed')),
  label: 'pool-keyed/v1',
})
if (pool.address !== '0x73e47a8DA2C83Beb802708Fc473B5B7D094f3eE6') throw new Error(`keyed pool moved to ${pool.address}`)

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const entry = (label: string, d: { address: string; frame: { target: string | null; data: string; limits: { execution: bigint; state: bigint } } }) => ({
  label,
  address: d.address,
  target: d.frame.target,
  data: d.frame.data,
  execution: Number(d.frame.limits.execution),
  state: Number(d.frame.limits.state),
})
const out = {
  note: `exp-frames experiments/06-privacy-pool/export.ts at ${commit}: each entry is a SENDER frame to the CREATE2 deployer; send them in order`,
  contracts: [entry('hasher', hasher), entry('verifier-patched', verifier), entry('pool-keyed/v1', { address: pool.address, frame: pool.deploy })],
}
console.log(JSON.stringify(out, null, 2))
