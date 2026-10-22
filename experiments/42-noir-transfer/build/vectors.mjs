// Poseidon2 vectors from Barretenberg, for the on-chain hasher: the bare permutation, and the
// sponge transfer.nr hashes with at one to seven inputs.
import { writeFileSync } from 'node:fs'
import { Barretenberg } from '@aztec/bb.js'

const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n
const fe = (x) => { const b = new Uint8Array(32); let v = ((x % P) + P) % P; for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n } return b }
const big = (b) => BigInt(`0x${Buffer.from(b).toString('hex')}`)
const hex = (x) => `0x${x.toString(16).padStart(64, '0')}`
const api = await Barretenberg.new({ threads: 1 })
const perm = async (s) => (await api.poseidon2Permutation({ inputs: s.map(fe) })).outputs.map(big)
async function H(inputs) {
  let state = [0n, 0n, 0n, BigInt(inputs.length) * (1n << 64n)]
  for (let c = 0; c < Math.ceil(inputs.length / 3); c++) {
    for (let j = 0; j < 3; j++) { const k = c * 3 + j; if (k < inputs.length) state[j] = (state[j] + inputs[k]) % P }
    state = await perm(state)
  }
  return state[0]
}
const permutation = { input: [0n, 1n, 2n, 3n].map(hex), output: (await perm([0n, 1n, 2n, 3n])).map(hex) }
const sponge = []
for (let n = 1; n <= 7; n++) {
  const inputs = Array.from({ length: n }, (_, i) => (BigInt(i + 1) * 0x9e3779b97f4a7c15n) ** 3n % P)
  sponge.push({ inputs: inputs.map(hex), hash: hex(await H(inputs)) })
}
writeFileSync('out/poseidon2.vectors.json', `${JSON.stringify({ permutation, sponge }, null, 2)}\n`)
await api.destroy()
