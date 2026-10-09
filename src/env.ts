import { existsSync } from 'node:fs'
import type { Hex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'

export const ENV_PATH = new URL('../.env', import.meta.url)

if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH)

/** A key from the environment (default PRIVATE_KEY), with its address. */
export function loadKey(name = 'PRIVATE_KEY'): { privateKey: Hex; address: Hex } {
  const raw = process.env[name]
  if (!raw) throw new Error(`${name} is not set; run \`npm run account\` to create one in .env`)
  const privateKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
  return { privateKey, address: privateKeyToAddress(privateKey) }
}
