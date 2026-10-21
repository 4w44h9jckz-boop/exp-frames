// The wallet's prover for experiment 42's transfer: reads a request on stdin and writes the proof
// to the file named on the command line, since the compiler and the prover log to stdout. The
// request names the tree by its leaves, so the root and the paths are computed here, and the two
// spent notes are ordered so that their nullifiers ascend, as the pool requires.
//
// usage: node prove.mjs <response.json> < request.json
//
// request: { nsk, spend: [{ index, value, randomness }] x2, outs: [{ owner, value, randomness }] x2,
//            fee, context, leaves: [hex], target: 'evm' | 'evm-no-zk' | 'groth16' }
// response: { root, nullifiers, outHashes, fee, context, proof, publicInputs, proveMs }
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compile_program, createFileManager } from '@noir-lang/noir_wasm'
import { Noir } from '@noir-lang/noir_js'
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js'

const DEPTH = 32
const [OWNER, NOTE, NULLIFIER, NODE] = [1n, 2n, 3n, 4n]
const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n
const fe = (x) => { const b = new Uint8Array(32); let v = ((x % P) + P) % P; for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n } return b }
const big = (b) => BigInt(`0x${Buffer.from(b).toString('hex')}`)
const hex = (x) => `0x${x.toString(16).padStart(64, '0')}`

const req = JSON.parse(readFileSync(0, 'utf8'))
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

const zeros = [0n]
for (let i = 0; i < DEPTH; i++) zeros.push(await H([NODE, zeros[i], zeros[i]]))
const layers = [req.leaves.map(BigInt)]
for (let l = 0; l < DEPTH; l++) {
  const below = layers[l], up = []
  for (let j = 0; j < below.length; j += 2) up.push(await H([NODE, below[j], below[j + 1] ?? zeros[l]]))
  layers.push(up)
}
const root = layers[DEPTH][0]
const path = (index) => { const out = []; for (let l = 0, i = index; l < DEPTH; l++, i >>= 1) out.push(layers[l][i ^ 1] ?? zeros[l]); return out }

const nsk = BigInt(req.nsk)
const owner = await H([OWNER, nsk])
const spend = []
for (const s of req.spend) {
  const note = await H([NOTE, owner, BigInt(s.value), BigInt(s.randomness)])
  if (note !== layers[0][s.index]) throw new Error(`leaf ${s.index} is not this note`)
  spend.push({ ...s, nullifier: await H([NULLIFIER, note, nsk]) })
}
spend.sort((a, b) => (a.nullifier < b.nullifier ? -1 : 1))
const outHashes = []
for (const o of req.outs) outHashes.push(await H([NOTE, BigInt(o.owner), BigInt(o.value), BigInt(o.randomness)]))

const fm = createFileManager(new URL('./transfer/', import.meta.url).pathname)
const { program } = await compile_program(fm)
const { witness } = await new Noir(program).execute({
  root: hex(root),
  nullifiers: spend.map((s) => hex(s.nullifier)),
  out_hashes: outHashes.map(hex),
  fee: BigInt(req.fee).toString(),
  context: hex(BigInt(req.context)),
  nsk: hex(nsk),
  in_values: spend.map((s) => BigInt(s.value).toString()),
  in_randomness: spend.map((s) => hex(BigInt(s.randomness))),
  in_index: spend.map((s) => s.index.toString()),
  in_paths: spend.map((s) => path(s.index).map(hex)),
  out_owners: req.outs.map((o) => hex(BigInt(o.owner))),
  out_values: req.outs.map((o) => BigInt(o.value).toString()),
  out_randomness: req.outs.map((o) => hex(BigInt(o.randomness))),
})
let proof
const t = Date.now()
if (req.target === 'groth16') {
  // Groth16 over BN254: Sunspot's R1CS, proving key and witness loader, through groth16tool
  // (G16_TOOL), which proves with the hash-to-field gnark's Solidity verifier checks. The keys
  // (transfer.ccs, transfer.pk, transfer.vk) are read from G16_KEYS, for example experiment 42's
  // build/groth16/; the witness and the proof are written to a scratch directory, removed after.
  // Resolved here: groth16tool runs in the scratch directory, where a relative path would miss.
  const keys = resolve(process.env.G16_KEYS ?? new URL('./g16/', import.meta.url).pathname)
  const tool = process.env.G16_TOOL ?? new URL('./g16tool/g16tool', import.meta.url).pathname
  const dir = mkdtempSync(join(tmpdir(), 'g16-'))
  const key = (f) => join(keys, f)
  writeFileSync(`${dir}/request.json`, JSON.stringify(program))
  writeFileSync(`${dir}/request.gz`, witness)
  const run = (args) => execFileSync(tool, args, { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  run(['prove', 'request.json', 'request.gz', key('transfer.ccs'), key('transfer.pk'), 'request.proof', 'request.pw'])
  run(['export', key('transfer.vk'), 'request.proof', 'request.pw', 'request.sol', 'request.calldata.json'])
  const c = JSON.parse(readFileSync(`${dir}/request.calldata.json`, 'utf8'))
  rmSync(dir, { recursive: true, force: true })
  proof = {
    proof: Buffer.from([...c.proof, ...c.commitmentsWords, ...c.commitmentPok].map((w) => w.slice(2)).join(''), 'hex'),
    publicInputs: c.inputs,
  }
} else {
  const backend = new UltraHonkBackend(program.bytecode, api)
  proof = await backend.generateProof(witness, { verifierTarget: req.target })
  if (!(await backend.verifyProof(proof, { verifierTarget: req.target }))) throw new Error('the proof does not verify')
}
const proveMs = Date.now() - t
await api.destroy()
writeFileSync(process.argv[2], `${JSON.stringify({
  root: hex(root),
  nullifiers: spend.map((s) => hex(s.nullifier)),
  outHashes: outHashes.map(hex),
  fee: BigInt(req.fee).toString(),
  context: hex(BigInt(req.context)),
  proof: `0x${Buffer.from(proof.proof).toString('hex')}`,
  publicInputs: proof.publicInputs,
  proveMs,
})}\n`)
