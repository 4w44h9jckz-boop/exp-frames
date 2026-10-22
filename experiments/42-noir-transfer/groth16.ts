// Experiment 42: the transfer's Groth16 verifier, on the testnet. The circuit is the same ACIR the
// UltraHonk verifiers check, compiled to R1CS and proved by Reilabs' Sunspot over gnark's Groth16
// on BN254; groth16tool/ exports gnark's Solidity verifier and the proof as it takes it
// (build/groth16/). Each call's gas is read by GasMeter.yul under eth_call.
//
// usage: npx tsx experiments/42-noir-transfer/groth16.ts [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Hex, concatHex, encodeFunctionData, hexToBigInt, numberToHex, parseAbi, slice } from 'viem'
import { REPO_ROOT, compileSolidity, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN } from '../../src/execute.js'
import { makeClient } from '../../src/frametx/index.js'

const DIR = 'experiments/42-noir-transfer'
const file = (f: string) => resolve(REPO_ROOT, DIR, f)
const word = (x: bigint | number) => numberToHex(BigInt(x), { size: 32 })
const abi = parseAbi(['function verifyProof(uint256[8] proof, uint256[2] commitments, uint256[2] commitmentPok, uint256[7] input) view'])

const client = makeClient()
const { privateKey } = loadKey()
const meter = compileYul(`${DIR}/GasMeter.yul`)
const { bytecode, deployedBytecode } = compileSolidity(`${DIR}/build/groth16/Verifier.sol`, 'Verifier')
const salt = saltOf('exp-frames/42/verifier/groth16')
const address = create2Address(bytecode, salt)
if (!(await client.getCode({ address }))) {
  const done = await sendFrames(client, privateKey, [deployFrame(bytecode, salt).frame], { label: "deploy gnark's Groth16 verifier" })
  if (DRY_RUN) process.exit(0)
  console.log('deployed in', done?.hash)
}

const c = JSON.parse(readFileSync(file('build/groth16/calldata.json'), 'utf8')) as {
  proof: Hex[]
  commitmentsWords: Hex[]
  commitmentPok: Hex[]
  inputs: Hex[]
}
const big = (xs: Hex[]) => xs.map((x) => hexToBigInt(x))
const call = (inputs: Hex[]) =>
  encodeFunctionData({
    abi,
    functionName: 'verifyProof',
    args: [big(c.proof), big(c.commitmentsWords), big(c.commitmentPok), big(inputs)] as never,
  })
const measure = async (data: Hex) => {
  const out = await client.call({ data: concatHex([meter, data, word((data.length - 2) / 2), word(hexToBigInt(address))]) })
  return { gas: Number(hexToBigInt(slice(out.data!, 0, 32))), ok: hexToBigInt(slice(out.data!, 32, 64)) === 1n }
}
const good = await measure(call(c.inputs))
const changed = [...c.inputs]
changed[0] = word(hexToBigInt(changed[0]) ^ 1n)
const refused = await measure(call(changed))
const record = {
  chainId: await client.getChainId(),
  block: Number(await client.getBlockNumber()),
  address,
  deployedBytes: (deployedBytecode.length - 2) / 2,
  publicInputs: c.inputs.length,
  proofBytes: 32 * (c.proof.length + c.commitmentsWords.length + c.commitmentPok.length),
  calldataBytes: (call(c.inputs).length - 2) / 2,
  verifyGas: good.gas,
  verifySucceeded: good.ok,
  changedInputSucceeded: refused.ok,
}
console.log(record)
if (!DRY_RUN) writeFileSync(file('groth16.json'), `${JSON.stringify(record, null, 2)}\n`)
