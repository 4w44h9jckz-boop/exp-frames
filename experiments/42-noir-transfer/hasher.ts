// Experiment 42: the Poseidon2 hasher the note tree needs on L1, deployed on the testnet and
// checked against Barretenberg's own outputs (build/poseidon2.vectors.json, from build/vectors.mjs),
// with the gas of each call read by GasMeter.yul.
//
// usage: npx tsx experiments/42-noir-transfer/hasher.ts [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Hex, concatHex, hexToBigInt, numberToHex, slice } from 'viem'
import { REPO_ROOT, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN } from '../../src/execute.js'
import { makeClient } from '../../src/frametx/index.js'

const DIR = 'experiments/42-noir-transfer'
const file = (f: string) => resolve(REPO_ROOT, DIR, f)
const word = (x: bigint | number) => numberToHex(BigInt(x), { size: 32 })

export const HASHER_INITCODE = compileYul(`${DIR}/Poseidon2.yul`)
export const HASHER_SALT = saltOf('exp-frames/42/poseidon2')
export const HASHER = create2Address(HASHER_INITCODE, HASHER_SALT)

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = makeClient()
  const { privateKey } = loadKey()
  if (!(await client.getCode({ address: HASHER }))) {
    const done = await sendFrames(client, privateKey, [deployFrame(HASHER_INITCODE, HASHER_SALT).frame], { label: 'deploy the Poseidon2 hasher' })
    if (DRY_RUN) process.exit(0)
    console.log('deployed in', done?.hash)
  }
  const meter = compileYul(`${DIR}/GasMeter.yul`)
  const vectors = JSON.parse(readFileSync(file('build/poseidon2.vectors.json'), 'utf8')) as { sponge: { inputs: Hex[]; hash: Hex }[] }
  const results = []
  for (const v of vectors.sponge) {
    const data = concatHex(v.inputs)
    const out = (await client.call({ to: HASHER, data })).data
    const metered = (await client.call({ data: concatHex([meter, data, word((data.length - 2) / 2), word(hexToBigInt(HASHER))]) })).data!
    results.push({ inputs: v.inputs.length, matches: out === v.hash, gas: Number(hexToBigInt(slice(metered, 0, 32))) })
    console.log(results.at(-1))
  }
  const record = { chainId: await client.getChainId(), block: Number(await client.getBlockNumber()), hasher: HASHER, results }
  if (!DRY_RUN) writeFileSync(file('hasher.json'), `${JSON.stringify(record, null, 2)}\n`)
}
