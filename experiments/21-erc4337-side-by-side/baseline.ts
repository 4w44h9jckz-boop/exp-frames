// Experiment 21, baseline: what a type-2 transaction's intrinsic cost is on this chain, so the
// ERC-20 transfer in side-by-side.ts can be split into intrinsic, calldata and execution. Two
// sends from the plain EOA to an existing account (the bundler): no value and no data, then one
// wei. With EIP-2780 live they cost 15,000 and 21,000; without it, 21,000 both.
//
// usage: npx tsx experiments/21-erc4337-side-by-side/baseline.ts
import { concatHex, createWalletClient, http, keccak256, parseGwei, toHex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { loadKey } from '../../src/env.js'
import { HEGOTA_RPC_URL, hegotaTestnet, makeClient } from '../../src/frametx/index.js'

const client = makeClient()
const { privateKey: funderKey } = loadKey()
const derive = (label: string) => keccak256(concatHex([funderKey, toHex(`exp-frames/21/${label}`)]))
const eoaPlain = derive('eoa-plain')
const bundler = privateKeyToAddress(derive('bundler'))
const w = createWalletClient({ account: privateKeyToAccount(eoaPlain), chain: hegotaTestnet, transport: http(HEGOTA_RPC_URL) })
const fees = { maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei('1') }

console.log('| Send | Tx | `gasUsed` |\n|---|---|---|')
for (const [what, value] of [['no value, no data', 0n], ['1 wei, no data', 1n]] as const) {
  const hash = await w.sendTransaction({ to: bundler, value, gas: 30_000n, ...fees })
  const r = await client.waitForTransactionReceipt({ hash })
  console.log(`| ${what} | [\`${hash.slice(0, 10)}…\`](https://dora.privacy.ethrex.xyz/tx/${hash}) | ${r.gasUsed} |`)
}
