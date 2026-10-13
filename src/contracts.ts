import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Abi, Hex } from 'viem'

// Compile contracts with solc-js. Solidity can't emit the EIP-8141 opcodes, so contracts that
// need them are written in Yul with `verbatim_<n>i_<m>o(hex"…", args…)`, where the first
// argument ends up on top of the stack, matching the EIP's stack tables. For example:
//
//   function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }   // offset, length, scope
//   function txparam(p) -> v { v := verbatim_1i_1o(hex"b0", p) }

const solc = createRequire(import.meta.url)('solc') as {
  compile(input: string, opts?: { import?: (path: string) => { contents: string } | { error: string } }): string
  version(): string
}

export const EVM_VERSION = 'osaka'
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type SolcError = { severity: 'error' | 'warning' | 'info'; formattedMessage: string }
type SolcContract = { abi?: Abi; evm: { bytecode: { object: string }; deployedBytecode?: { object: string } } }
type SolcOutput = { errors?: SolcError[]; contracts?: Record<string, Record<string, SolcContract>> }

function run(language: 'Solidity' | 'Yul', file: string, outputs: string[]): Record<string, SolcContract> {
  const abs = resolve(REPO_ROOT, file)
  const key = relative(REPO_ROOT, abs)
  const input = {
    language,
    sources: { [key]: { content: readFileSync(abs, 'utf8') } },
    settings: {
      evmVersion: EVM_VERSION,
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': outputs } },
    },
  }
  const findImports = (path: string) => {
    try {
      return { contents: readFileSync(resolve(REPO_ROOT, path), 'utf8') }
    } catch {
      return { error: `not found: ${path}` }
    }
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports })) as SolcOutput
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
  if (errors.length) throw new Error(`solc ${solc.version()} failed on ${key}:\n${errors.map((e) => e.formattedMessage).join('\n')}`)
  const contracts = out.contracts?.[key]
  if (!contracts) throw new Error(`solc produced no contracts for ${key}`)
  return contracts
}

/** Creation bytecode of the top-level object in a Yul file. */
export function compileYul(file: string): Hex {
  const [contract] = Object.values(run('Yul', file, ['evm.bytecode.object']))
  return `0x${contract.evm.bytecode.object}`
}

export type CompiledSolidity = { abi: Abi; bytecode: Hex; deployedBytecode: Hex }

export function compileSolidity(file: string, contractName: string): CompiledSolidity {
  const contracts = run('Solidity', file, ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'])
  const c = contracts[contractName]
  if (!c) throw new Error(`${contractName} not found in ${file} (have: ${Object.keys(contracts).join(', ')})`)
  return { abi: c.abi ?? [], bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode?.object ?? ''}` }
}
