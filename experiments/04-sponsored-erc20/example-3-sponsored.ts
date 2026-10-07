// EIP-8141 Example 3: a sponsored transaction, fee paid in an ERC-20.
//
// A fresh user with no ETH at all:
//   1. gets tUSD through a transaction sponsored by an EOA (default code as payer, two signatures):
//      | 0 | VERIFY | APPROVE_EXECUTION | Null (sender) | user's signature, index 0        |
//      | 1 | VERIFY | APPROVE_PAYMENT   | Sponsor EOA   | sponsor's signature, index 1     |
//      | 2 | SENDER | -                 | tUSD          | mint(user, 1000)                 |
//   2. sends 5 tUSD to a friend, paying the gas in tUSD to TokenSponsor (the EIP's table):
//      | 0 | VERIFY  | APPROVE_EXECUTION | Null (sender) | Empty                       |
//      | 1 | VERIFY  | APPROVE_PAYMENT   | TokenSponsor  | Empty                       |
//      | 2 | SENDER  | -                 | tUSD          | transfer(TokenSponsor, fee) |
//      | 3 | SENDER  | -                 | tUSD          | transfer(friend, 5)         |
//      | 4 | DEFAULT | -                 | TokenSponsor  | Empty (post-op: refund)     |
//
// usage: npx tsx experiments/04-sponsored-erc20/example-3-sponsored.ts [--dry-run]
import { formatEther, formatUnits, hexToBigInt, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { loadKey } from '../../src/env.js'
import { DRY_RUN, execute } from '../../src/execute.js'
import {
  Approve,
  NEW_ACCOUNT_STATE_GAS,
  STORAGE_SET_STATE_GAS,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'
import { RATE, TOKEN, call, ensureSetup, prepareSponsored, tokenBalance } from './sponsor.js'

const { privateKey: ownerKey, address: owner } = loadKey()
const client = makeClient()
const sponsor = await ensureSetup(client, ownerKey, owner)
if (DRY_RUN && !(await client.getCode({ address: sponsor }))) {
  console.log('(dry run: contracts not deployed yet, nothing more to simulate)')
  process.exit(0)
}

const userKey = generatePrivateKey()
const user = privateKeyToAddress(userKey)
const friend = privateKeyToAddress(generatePrivateKey())
console.log(`\nuser ${user} (fresh key, no ETH)  friend ${friend}`)

const show = async (label: string) => {
  const [ethUser, tUser, tSponsor, ethSponsor, tFriend] = await Promise.all([
    client.getBalance({ address: user }),
    tokenBalance(client, user),
    tokenBalance(client, sponsor),
    client.getBalance({ address: sponsor }),
    tokenBalance(client, friend),
  ])
  console.log(
    `${label}: user ${formatEther(ethUser)} ETH, ${formatUnits(tUser, 18)} tUSD | friend ${formatUnits(tFriend, 18)} tUSD | ` +
      `sponsor ${formatEther(ethSponsor)} ETH, ${formatUnits(tSponsor, 18)} tUSD`,
  )
  return { ethUser, tUser, tSponsor, ethSponsor }
}

// 1. EOA sponsor. APPROVE(PAYMENT) creates the user's account (nonce 0 → 1): 183,600 state gas
//    from the pay frame. The mint creates the user's balance slot and, the first time, totalSupply.
const warmup = await prepareFrameTx(client, {
  sender: user,
  frames: [
    verifyFrame({ scope: Approve.EXECUTION, execution: 10_000n }),
    verifyFrame({ scope: Approve.PAYMENT, target: owner, execution: 10_000n, state: NEW_ACCOUNT_STATE_GAS }),
    senderFrame({ target: TOKEN, data: call('mint', [user, parseEther('1000')]), execution: 60_000n, state: 2n * STORAGE_SET_STATE_GAS }),
  ],
  signatures: [secp256k1Placeholder(), secp256k1Placeholder(owner)],
})
await execute(client, warmup, [userKey, ownerKey], { label: '1. EOA-sponsored: the user mints 1000 tUSD, the owner EOA pays the gas' })
if (DRY_RUN) process.exit(0)
const before = await show('after 1')

// 2. Example 3.
const { tx, fee } = await prepareSponsored(client, {
  user,
  sponsor,
  calls: [senderFrame({ target: TOKEN, data: call('transfer', [friend, parseEther('5')]), execution: 50_000n, state: STORAGE_SET_STATE_GAS })],
})
console.log(`\nquote: fee ${formatUnits(fee, 18)} tUSD = ${RATE} × max_cost (with a worst-case signature)`)
const { sim, receipt } = await execute(client, tx, [userKey], { label: '2. Example 3: pay gas in tUSD, send 5 tUSD, post-op refund' })
console.log(`signed max_cost ${formatEther(hexToBigInt(sim.maxCost))} ETH × ${RATE} = ${formatUnits(hexToBigInt(sim.maxCost) * RATE, 18)} tUSD`)
const after = await show('after 2')

if (receipt) {
  const ethPaid = hexToBigInt(receipt.gasUsed) * hexToBigInt(receipt.effectiveGasPrice)
  const tokensKept = after.tSponsor - before.tSponsor
  const refund = fee - tokensKept
  console.log(
    `\nsponsor paid ${formatEther(ethPaid)} ETH (${hexToBigInt(receipt.gasUsed)} gas × ${hexToBigInt(receipt.effectiveGasPrice)} wei), ` +
      `kept ${formatUnits(tokensKept, 18)} tUSD = ${formatEther(tokensKept / RATE)} ETH at the rate; refunded ${formatUnits(refund, 18)} tUSD`,
  )
  console.log(`user spent ${formatUnits(before.tUser - after.tUser, 18)} tUSD (5 sent + ${formatUnits(tokensKept, 18)} gas), still ${formatEther(after.ethUser)} ETH`)
}

