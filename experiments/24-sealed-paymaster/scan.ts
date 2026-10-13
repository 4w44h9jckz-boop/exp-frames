// Experiment 24, offline: the PR's whole-code scan and the amended one against real runtimes,
// and how often Solidity's metadata trailer alone fails a contract with no external call in it.
// Run: npx tsx experiments/24-sealed-paymaster/scan.ts   (no network, deterministic)
import { type Hex, bytesToHex, concatHex, hexToBytes, keccak256 } from 'viem'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { metadataTrailer, prScan, rng, sealedScan } from './egress.js'

/** Runtime of an object compiled from `initcode = object ‖ word`: what CREATE leaves behind. */
function runtimeOf(yul: string): Hex {
  // Both paymasters copy the runtime out of their initcode and patch one immutable. The
  // immutable's value does not change which opcodes are where (it sits inside a PUSH32), so the
  // scan of the zero-filled runtime is the scan of every instance.
  const init = hexToBytes(compileYul(yul))
  const sub = bytesToHex(init).indexOf('fe60aa33')
  if (sub < 0) throw new Error(`no runtime boundary in ${yul}`)
  return `0x${bytesToHex(init).slice(sub + 2)}` as Hex
}

const sealed = runtimeOf('experiments/24-sealed-paymaster/SealedPaymaster.yul')
const selfSending = runtimeOf('experiments/24-sealed-paymaster/SelfSendingPaymaster.yul')

// The canonical paymaster's runtime as the testnet pins it (ethereum/EIPs#12041; experiment 09
// deploys it byte for byte). Checked against the pinned code hash below.
const CANONICAL: Hex =
  '0x3461002e57366100355760016001b41561005a575f6001b45f54141561005a5760026001b461005a5760015f5faa5b3661005a57005b5f3560f81c8060011461005e57806002146100a557806003146100ec57600414610123575b5f5ffd5b50335f54146100875760016001b41561005a575f6001b45f54141561005a5760026001b461005a575b60025461005a57600135801561005a57600155426201518001600255005b50335f54146100ce5760016001b41561005a575f6001b45f54141561005a5760026001b461005a575b60025461005a57600135801561005a57600355426201518001600255005b50335f54146101155760016001b41561005a575f6001b45f54141561005a5760026001b461005a575b5f6001555f6002555f600355005b600254801561005a57421061005a576001548015610153575f6001555f6002555f5f5f5f845f545af11561005a57005b506003545f555f6003555f60025500'
if (keccak256(CANONICAL) !== '0xda42f0d11838c4c0c3129b8b8e93e9718127ad6b315e517e1088125707c4d45c') throw new Error('canonical runtime does not match its pinned hash')

const token = compileSolidity('contracts/TestToken.sol', 'TestToken').deployedBytecode
const delegation = (to: Hex): Hex => concatHex(['0xef0100', to])

const census: [string, Hex][] = [
  ['SealedPaymaster (this experiment)', sealed],
  ['SelfSendingPaymaster (this experiment)', selfSending],
  ['canonical paymaster (EIPs#12041, as pinned)', CANONICAL],
  ['no code (a code-less EOA sponsor, as in experiments 09 and 23)', '0x'],
  ['EIP-7702 delegation to a sealed paymaster (0x5620...6189)', delegation('0x56208581D049A396E81f6C3cea6DeCDe79006189')],
  ['TestToken: solc 0.8, no external calls, metadata as emitted', token],
]

console.log('| runtime | bytes | PR scan | amended scan | what the amended scan finds |')
console.log('|---|---:|---|---|---|')
for (const [name, code] of census) {
  const pr = prScan(code)
  const am = sealedScan(code)
  const prCell = pr.sealed ? 'sealed' : `not sealed (${pr.findings.map((f) => `${f.what}@${f.pc}`).join(', ')})`
  const amCell = am.sealed ? 'sealed' : 'not sealed'
  const why = am.findings.map((f) => `${f.what}${f.pc ? ` @${f.pc}` : ''}`).join('; ') || '-'
  console.log(`| ${name} | ${(code.length - 2) / 2} | ${prCell} | ${amCell} | ${why} |`)
}

// ---- Monte Carlo: the metadata trailer ----
//
// Solidity appends INVALID (0xfe) and then a CBOR map holding a 32-byte digest of the source.
// The digest is effectively random, and a linear scan reads its bytes as instructions. Swap in
// N digests from a seeded generator and count how many runtimes each scan still calls sealed.

const N = 100_000
const trials: [string, Uint8Array][] = [
  // SealedPaymaster as if solc had appended metadata (Yul objects do not, so this is the
  // counterfactual "same code, built by Solidity's default pipeline").
  ['SealedPaymaster + INVALID + trailer', Uint8Array.from([...hexToBytes(sealed), 0xfe])],
  // TestToken without its own trailer (the last 0x33 + 2 bytes), then a fresh one per trial.
  ['TestToken runtime + trailer', hexToBytes(token).slice(0, hexToBytes(token).length - 0x35)],
]
const next = rng(0x24n)
console.log(`\nMonte Carlo, N = ${N}, seed 0x24 (xorshift128+): share of runtimes each scan calls sealed`)
console.log('| code | PR scan | amended scan |')
console.log('|---|---:|---:|')
for (const [name, head] of trials) {
  // One buffer per code: head ‖ trailer, with the digest rewritten in place each trial.
  const code = Uint8Array.from([...head, ...metadataTrailer(new Uint8Array(32))])
  const at = head.length + 11 // a2 64 'ipfs' 58 22 12 20, then the digest
  let pr = 0
  let am = 0
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < 32; j++) code[at + j] = next()
    if (prScan(code).sealed) pr++
    if (sealedScan(code).sealed) am++
  }
  console.log(`| ${name} | ${((100 * pr) / N).toFixed(2)}% | ${((100 * am) / N).toFixed(2)}% |`)
}
