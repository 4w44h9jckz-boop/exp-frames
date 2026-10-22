// Compile the transfer, build a witness, prove for each of Barretenberg's EVM targets, verify,
// and write each target's proof, public inputs and Solidity verifier to out/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { compile_program, createFileManager } from '@noir-lang/noir_wasm'
import { Noir } from '@noir-lang/noir_js'
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js'

const DEPTH = 32
const [OWNER, NOTE, NULLIFIER, NODE] = [1n, 2n, 3n, 4n]
const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n
const fe = (x) => { const b = new Uint8Array(32); let v = ((x % P) + P) % P; for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n } return b }
const big = (b) => BigInt(`0x${Buffer.from(b).toString('hex')}`)
const hex = (x) => `0x${x.toString(16).padStart(64, '0')}`

const api = await Barretenberg.new({ threads: 8 })
const perm = async (s) => (await api.poseidon2Permutation({ inputs: s.map(fe) })).outputs.map(big)
async function H(inputs) {
  let state = [0n, 0n, 0n, BigInt(inputs.length) * (1n << 64n)]
  for (let c = 0; c < Math.ceil(inputs.length / 3); c++) {
    for (let j = 0; j < 3; j++) { const k = c * 3 + j; if (k < inputs.length) state[j] = (state[j] + inputs[k]) % P }
    state = await perm(state)
  }
  return state[0]
}

// The tree: zero subtrees, then four notes, of which 0 and 2 are the sender's and are spent.
const zeros = [0n]
for (let i = 0; i < DEPTH; i++) zeros.push(await H([NODE, zeros[i], zeros[i]]))
const nsk = 0x1234567890abcdefn
const owner = await H([OWNER, nsk])
const other = await H([OWNER, 0xfeedn])
const notes = [
  { owner, value: 700n, randomness: 11n },
  { owner: other, value: 5n, randomness: 12n },
  { owner, value: 400n, randomness: 13n },
  { owner: other, value: 9n, randomness: 14n },
]
const leaves = []
for (const n of notes) leaves.push(await H([NOTE, n.owner, n.value, n.randomness]))
const layers = [leaves]
for (let l = 0; l < DEPTH; l++) {
  const below = layers[l], up = []
  for (let j = 0; j < below.length; j += 2) up.push(await H([NODE, below[j], below[j + 1] ?? zeros[l]]))
  layers.push(up)
}
const root = layers[DEPTH][0]
const path = (index) => { const out = []; for (let l = 0, i = index; l < DEPTH; l++, i >>= 1) out.push(layers[l][i ^ 1] ?? zeros[l]); return out }

const spent = [0, 2]
const nullifiers = []
for (const i of spent) nullifiers.push(await H([NULLIFIER, leaves[i], nsk]))
const fee = 1n
const outs = [{ owner: other, value: 600n, randomness: 21n }, { owner, value: 499n, randomness: 22n }]
const outHashes = []
for (const o of outs) outHashes.push(await H([NOTE, o.owner, o.value, o.randomness]))
const context = 0xc0ffeen

const fm = createFileManager(new URL('./transfer/', import.meta.url).pathname)
const t0 = Date.now()
const { program } = await compile_program(fm)
const compileMs = Date.now() - t0
const noir = new Noir(program)
const inputs = {
  root: hex(root),
  nullifiers: nullifiers.map(hex),
  out_hashes: outHashes.map(hex),
  fee: fee.toString(),
  context: hex(context),
  nsk: hex(nsk),
  in_values: spent.map((i) => notes[i].value.toString()),
  in_randomness: spent.map((i) => hex(notes[i].randomness)),
  in_index: spent.map((i) => i.toString()),
  in_paths: spent.map((i) => path(i).map(hex)),
  out_owners: outs.map((o) => hex(o.owner)),
  out_values: outs.map((o) => o.value.toString()),
  out_randomness: outs.map((o) => hex(o.randomness)),
}
const t1 = Date.now()
const { witness } = await noir.execute(inputs)
const witnessMs = Date.now() - t1
// Nargo's artefacts, for proving systems driven from them: the program and the compressed witness.
mkdirSync('out', { recursive: true })
writeFileSync('out/transfer.json', JSON.stringify(program))
writeFileSync('out/transfer.gz', witness)
if (process.env.ARTEFACTS_ONLY) { await api.destroy(); process.exit(0) }

mkdirSync('out', { recursive: true })
const backend = new UltraHonkBackend(program.bytecode, api)
const summary = { depth: DEPTH, compileMs, witnessMs, root: hex(root), nullifiers: nullifiers.map(hex), outHashes: outHashes.map(hex), fee: fee.toString(), context: hex(context), targets: {} }
for (const target of ['evm', 'evm-no-zk']) {
  const t = Date.now()
  const proof = await backend.generateProof(witness, { verifierTarget: target })
  const proveMs = Date.now() - t
  const ok = await backend.verifyProof(proof, { verifierTarget: target })
  const vk = await backend.getVerificationKey({ verifierTarget: target })
  const sol = await backend.getSolidityVerifier(vk, { verifierTarget: target })
  writeFileSync(`out/${target}.sol`, sol)
  writeFileSync(`out/${target}.proof`, `0x${Buffer.from(proof.proof).toString('hex')}\n`)
  writeFileSync(`out/${target}.public.json`, JSON.stringify(proof.publicInputs))
  summary.targets[target] = { proveMs, verifiedNatively: ok, proofBytes: proof.proof.length, publicInputs: proof.publicInputs.length, verifierSolBytes: sol.length }
  console.log(target, summary.targets[target])
}
writeFileSync('out/summary.json', `${JSON.stringify(summary, null, 2)}\n`)
await api.destroy()
