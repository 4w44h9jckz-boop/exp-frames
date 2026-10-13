// The ERC-4337 v0.8 reference contracts, as eth-infinitism publishes them in the npm package
// @account-abstraction/contracts@0.8.0 (MIT). The tarball is fetched once, checked against
// the registry's sha512 integrity, and cached in the system temp directory; nothing of it is
// committed here.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Abi, Hex } from 'viem'

const TARBALL = 'https://registry.npmjs.org/@account-abstraction/contracts/-/contracts-0.8.0.tgz'
const INTEGRITY = 'sha512-8krPx/gpnoT+5xAroagVCbeA7FbUigMZWXFKKPm+oghyr29Dksssdx5sI7xGv9212i4JPaDDUGFk58dpuwVgHA=='
const DIR = join(tmpdir(), 'exp-frames-21')
const NAMES = ['EntryPoint', 'SimpleAccountFactory', 'SimpleAccount', 'Simple7702Account'] as const

/** The address Simple7702Account hard-codes as its EntryPoint: the canonical v0.8 deployment. */
export const CANONICAL_ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'

async function ensure() {
  if (NAMES.every((n) => existsSync(join(DIR, 'package', 'artifacts', `${n}.json`)))) return
  mkdirSync(DIR, { recursive: true })
  const res = await fetch(TARBALL)
  if (!res.ok) throw new Error(`${TARBALL}: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== INTEGRITY) throw new Error(`integrity mismatch: ${integrity}`)
  const tgz = join(DIR, 'contracts-0.8.0.tgz')
  writeFileSync(tgz, bytes)
  execFileSync('tar', ['-xzf', tgz, '-C', DIR, ...NAMES.map((n) => `package/artifacts/${n}.json`)])
}

export async function artifact(name: (typeof NAMES)[number]): Promise<{ abi: Abi; bytecode: Hex }> {
  await ensure()
  const a = JSON.parse(readFileSync(join(DIR, 'package', 'artifacts', `${name}.json`), 'utf8')) as { abi: Abi; bytecode: Hex }
  return { abi: a.abi, bytecode: a.bytecode }
}
