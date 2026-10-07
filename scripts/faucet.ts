// Claim 1 testnet ETH (limit: once per hour per address and per IP).
// usage: npm run faucet [-- 0xADDRESS | VAR_NAME]
import { type Address, formatEther, isAddress } from 'viem'
import { loadKey } from '../src/env.js'
import { claimFaucet, makeClient } from '../src/frametx/index.js'

const arg = process.argv[2]
const address = (arg && isAddress(arg) ? arg : loadKey(arg).address) as Address
console.log(`claiming for ${address}…`)
console.log(await claimFaucet(address))
const balance = await makeClient().getBalance({ address })
console.log(`balance now ${formatEther(balance)} ETH (the faucet transfer may take a slot to land)`)
