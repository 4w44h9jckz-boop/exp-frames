import { type Address, type Hex, type PublicClient, concatHex, keccak256, parseEther, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  EXPIRY_VERIFIER,
  type Frame,
  type FrameTx,
  type FrameTxFees,
  Mode,
  NEW_ACCOUNT_STATE_GAS,
  makeClient,
  prepareFrameTx,
  rpc,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  signAll,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client: PublicClient = makeClient()

/** Accounts derived from PRIVATE_KEY, so each run reuses them and nothing new is stored. */
export function derive(label: string): { key: Hex; address: Address } {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/10/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

/** A derived account holding at least 0.005 ETH, topped up to 0.01 from the funder if not. */
export async function fundedAccount(label: string) {
  const account = derive(label)
  const balance = await client.getBalance({ address: account.address })
  if (balance < parseEther('0.005')) {
    const top = senderFrame({ target: account.address, value: parseEther('0.01') - balance, execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS })
    await sendFrames(client, privateKey, [top], { label: `setup: fund ${label} ${account.address}` })
  }
  return account
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const headTimestamp = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp

/** An expiry verifier frame with arbitrary fields, for the shape cases. */
export function rawExpiry(over: Partial<Frame> & { deadline?: bigint } = {}): Frame {
  const { deadline = 2n ** 64n - 1n, ...rest } = over
  return {
    mode: Mode.VERIFY,
    flags: 0,
    target: EXPIRY_VERIFIER,
    limits: { execution: 5_000n, state: 0n },
    value: 0n,
    data: `0x${deadline.toString(16).padStart(16, '0')}`,
    ...rest,
  }
}

export const selfVerify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n })
export const tip = (to: Address) => senderFrame({ target: to, value: parseEther('0.0001'), execution: 30_000n })

/** A self-paid EOA transaction with the given frames, signed. */
export async function eoaTx(key: Hex, frames: Frame[], fees?: FrameTxFees): Promise<FrameTx> {
  const tx = await prepareFrameTx(client, {
    sender: privateKeyToAddress(key),
    frames,
    signatures: [secp256k1Placeholder()],
    fees,
  })
  return signAll(tx, [key])
}

/** Simulate, then try eth_sendRawTransaction, and report both verdicts without waiting. */
export async function probe(label: string, tx: FrameTx, { send = true } = {}) {
  const sim = await simulateFrameTx(client, tx).catch((e: Error) => ({
    valid: 'error' as const,
    violation: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) ?? e.message.split('\n')[0],
  }))
  let sent: string
  let hash: Hex | undefined
  if (!send) sent = '(not sent)'
  else {
    try {
      hash = await rpc<Hex>(client, 'eth_sendRawTransaction', [serializeFrameTx(tx)])
      sent = `accepted ${hash}`
    } catch (e) {
      sent = `rejected: ${(e as Error).message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) ?? (e as Error).message.split('\n')[0]}`
    }
  }
  console.log(`- ${label}\n    simulate: valid=${sim.valid}${sim.violation ? ` (${sim.violation})` : ''}\n    send: ${sent}`)
  return { sim, hash }
}

/** Where a sent transaction is now: mined, still in the pool, or gone. */
export async function whereIs(hash: Hex): Promise<'mined' | 'pending' | 'gone'> {
  const tx = await rpc<{ blockNumber: Hex | null } | null>(client, 'eth_getTransactionByHash', [hash])
  if (!tx) return 'gone'
  return tx.blockNumber ? 'mined' : 'pending'
}

/** Poll a sent transaction until it is mined or gone, or `forMs` runs out; log each change. */
export async function follow(hash: Hex, forMs: number, deadline?: bigint) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < forMs) {
    const [where, block, pool] = await Promise.all([
      whereIs(hash),
      client.getBlock({ blockTag: 'latest' }),
      rpc<{ pending: Hex; queued: Hex }>(client, 'txpool_status', []),
    ])
    const line = `${where} (pool: ${BigInt(pool.pending)} pending, ${BigInt(pool.queued)} queued)`
    if (line !== last) {
      const rel = deadline === undefined ? '' : `, head - deadline = ${block.timestamp - deadline} s`
      console.log(`    t+${((Date.now() - start) / 1000).toFixed(0)}s block ${block.number}${rel}: ${line}`)
      last = line
    }
    if (where === 'mined' && deadline !== undefined) {
      const r = await rpc<{ blockNumber: Hex }>(client, 'eth_getTransactionReceipt', [hash])
      const b = await client.getBlock({ blockNumber: BigInt(r.blockNumber) })
      console.log(`    mined in block ${b.number}: block.timestamp - deadline = ${b.timestamp - deadline} s`)
    }
    if (where !== 'pending') return where
    await sleep(1_000)
  }
  return 'pending'
}
