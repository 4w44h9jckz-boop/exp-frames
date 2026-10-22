// Experiment 42: Barretenberg's two EVM verifiers for the transfer, deployed on the testnet, and
// each one's gas on the real proof. The gas is read by GasMeter.yul's initcode under eth_call:
// the STATICCALL to the verifier and nothing else.
//
// usage: npx tsx experiments/42-noir-transfer/verifiers.ts [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Hex, concatHex, encodeFunctionData, hexToBigInt, numberToHex, parseAbi, slice } from 'viem'
import { REPO_ROOT, compileSolidity, compileYul, linkBytecode } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN } from '../../src/execute.js'
import { makeClient } from '../../src/frametx/index.js'

const DIR = 'experiments/42-noir-transfer'
const TARGETS = ['evm', 'evm-no-zk'] as const
const abi = parseAbi(['function verify(bytes proof, bytes32[] publicInputs) view returns (bool)'])
const word = (x: bigint | number) => numberToHex(BigInt(x), { size: 32 })
const file = (f: string) => resolve(REPO_ROOT, DIR, f)

const client = makeClient()
const { privateKey } = loadKey()
const meter = compileYul(`${DIR}/GasMeter.yul`)

// Barretenberg keeps each verifier under the contract size limit by putting its largest functions
// in external libraries, called by DELEGATECALL. Each library is deployed first, at its own CREATE2
// address, and its address linked into the verifier.
const bytes = (code: Hex) => (code.length - 2) / 2
const verifiers = TARGETS.map((target) => {
  const sol = `${DIR}/build/${target}.sol`
  const { bytecode, deployedBytecode, linkReferences } = compileSolidity(sol, 'HonkVerifier')
  const libraries = Object.values(linkReferences).flatMap((libs) =>
    Object.keys(libs).map((name) => {
      const lib = compileSolidity(sol, name)
      const salt = saltOf(`exp-frames/42/verifier/${target}/${name}`)
      return { name, bytecode: lib.bytecode, deployedBytes: bytes(lib.deployedBytecode), salt, address: create2Address(lib.bytecode, salt) }
    }),
  )
  const linked = linkBytecode(bytecode, linkReferences, Object.fromEntries(libraries.map((l) => [l.name, l.address])))
  const salt = saltOf(`exp-frames/42/verifier/${target}`)
  return { target, bytecode: linked, deployedBytes: bytes(deployedBytecode), libraries, salt, address: create2Address(linked, salt) }
})
const missing = []
for (const c of verifiers.flatMap((v) => [...v.libraries, v]))
  if (!(await client.getCode({ address: c.address }))) missing.push(deployFrame(c.bytecode, c.salt).frame)
if (missing.length) {
  const done = await sendFrames(client, privateKey, missing, { label: "deploy Barretenberg's EVM verifiers and their libraries" })
  if (DRY_RUN) process.exit(0)
  console.log('deployed in', done?.hash)
}

const results = []
for (const v of verifiers) {
  const proof = readFileSync(file(`build/${v.target}.proof`), 'utf8').trim() as Hex
  const publicInputs = JSON.parse(readFileSync(file(`build/${v.target}.public.json`), 'utf8')) as Hex[]
  const call = encodeFunctionData({ abi, functionName: 'verify', args: [proof, publicInputs] })
  const measure = async (data: Hex) => {
    const len = (data.length - 2) / 2
    const out = await client.call({ data: concatHex([meter, data, word(len), word(hexToBigInt(v.address))]) })
    return { gas: Number(hexToBigInt(slice(out.data!, 0, 32))), ok: hexToBigInt(slice(out.data!, 32, 64)) === 1n }
  }
  // A proof with one public input changed: the verifier must refuse it.
  const changed = [...publicInputs]
  changed[0] = word(hexToBigInt(changed[0]) ^ 1n)
  const bad = encodeFunctionData({ abi, functionName: 'verify', args: [proof, changed] })
  const good = await measure(call)
  const refused = await measure(bad)
  const returned = await client.call({ to: v.address, data: call }).then((r) => r.data, () => 'reverted')
  results.push({
    target: v.target,
    address: v.address,
    deployedBytes: v.deployedBytes,
    libraries: v.libraries.map(({ name, address, deployedBytes }) => ({ name, address, deployedBytes })),
    proofBytes: (proof.length - 2) / 2,
    publicInputs: publicInputs.length,
    calldataBytes: (call.length - 2) / 2,
    verifyGas: good.gas,
    verifySucceeded: good.ok,
    returned,
    changedInputSucceeded: refused.ok,
  })
  console.log(results.at(-1))
}
const record = { chainId: await client.getChainId(), block: Number(await client.getBlockNumber()), results }
if (!DRY_RUN) writeFileSync(file('verifiers.json'), `${JSON.stringify(record, null, 2)}\n`)
