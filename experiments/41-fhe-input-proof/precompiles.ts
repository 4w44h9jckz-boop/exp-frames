// Experiment 41: what the testnet charges for the two EIP-2537 calls every EVM verifier of
// tfhe-zk-pok's proof must make: a 128-point G2 MSM, and a pairing check of eight pairs. Each is
// measured by GasMeter.yul's initcode under eth_call, so nothing is deployed and no ether is spent.
//
// usage: npx tsx experiments/41-fhe-input-proof/precompiles.ts
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Hex, concatHex, hexToBigInt, numberToHex, slice } from 'viem'
import { REPO_ROOT, compileYul } from '../../src/contracts.js'
import { makeClient } from '../../src/frametx/index.js'
import { g2Eip2537 } from '../36-blind-tickets/tickets.js'

const DIR = 'experiments/41-fhe-input-proof'
const G2MSM = '0x000000000000000000000000000000000000000e'
const PAIRING = '0x000000000000000000000000000000000000000f'

const client = makeClient()
const meter = compileYul(`${DIR}/GasMeter.yul`)
const word = (x: bigint | number) => numberToHex(BigInt(x), { size: 32 })
const g1Eip2537 = (p: InstanceType<typeof bls.G1.ProjectivePoint>): Hex => {
  const { x, y } = p.toAffine()
  return concatHex([numberToHex(x, { size: 64 }), numberToHex(y, { size: 64 })])
}
// Fixed, valid points: multiples of each generator, with scalars below the group order.
const scalar = (i: number) => (BigInt(i) * 0x9e3779b97f4a7c15n + 0x1234567n) % bls.params.r
const g2 = (i: number) => bls.G2.ProjectivePoint.BASE.multiply(scalar(i + 1000))
const g1 = (i: number) => bls.G1.ProjectivePoint.BASE.multiply(scalar(i + 2000))

async function measure(target: Hex, input: Hex) {
  const len = (input.length - 2) / 2
  const data = concatHex([meter, input, word(len), word(BigInt(target))])
  const out = await client.call({ data })
  if (!out.data) throw new Error('no return data')
  return { gas: hexToBigInt(slice(out.data, 0, 32)), ok: hexToBigInt(slice(out.data, 32, 64)) === 1n, inputBytes: len }
}

const g2MsmInput = concatHex(Array.from({ length: 128 }, (_, i) => concatHex([g2Eip2537(g2(i)), word(scalar(i))])))
const pairingInput = concatHex(Array.from({ length: 8 }, (_, i) => concatHex([g1Eip2537(g1(i)), g2Eip2537(g2(i))])))

const block = await client.getBlockNumber()
const msm = await measure(G2MSM, g2MsmInput)
const pairing = await measure(PAIRING, pairingInput)
const record = {
  chainId: await client.getChainId(),
  block: Number(block),
  g2Msm128: { ...msm, gas: Number(msm.gas), schedule: Math.floor((128 * 22500 * 524) / 1000) },
  pairing8: { ...pairing, gas: Number(pairing.gas), schedule: 32600 * 8 + 37700 },
}
console.log(JSON.stringify(record, null, 2))
writeFileSync(resolve(REPO_ROOT, DIR, 'precompiles.json'), `${JSON.stringify(record, null, 2)}\n`)
