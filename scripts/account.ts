// Show the experiment account, creating a key in .env if there is none.
// usage: npm run account [-- VAR_NAME]   (default PRIVATE_KEY)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { formatEther } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { ENV_PATH, loadKey } from '../src/env.js'
import { HEGOTA_EXPLORER_URL, makeClient } from '../src/frametx/index.js'

const name = process.argv[2] ?? 'PRIVATE_KEY'

if (!process.env[name]) {
  const key = generatePrivateKey()
  if (!existsSync(ENV_PATH)) writeFileSync(ENV_PATH, readFileSync(new URL('../.env.example', import.meta.url)))
  const env = readFileSync(ENV_PATH, 'utf8')
  const line = new RegExp(`^${name}=.*$`, 'm')
  if (line.test(env)) writeFileSync(ENV_PATH, env.replace(line, `${name}=${key}`))
  else appendFileSync(ENV_PATH, `${env.endsWith('\n') ? '' : '\n'}${name}=${key}\n`)
  process.env[name] = key
  console.log(`generated a new key in .env as ${name}`)
}

const { address } = loadKey(name)
const client = makeClient()
const [balance, nonce] = await Promise.all([
  client.getBalance({ address }),
  client.getTransactionCount({ address }),
])
console.log(`${name}: ${address}`)
console.log(`balance ${formatEther(balance)} ETH, nonce ${nonce}`)
console.log(`${HEGOTA_EXPLORER_URL}/address/${address}`)
if (balance === 0n) console.log('unfunded: run `npm run faucet`')
