// kohaku-rs's Rust wallet (`crates/frame-wallet`, binary `frame-wallet`) as an EIP-1193 provider,
// so that dapp.ts can run against it unchanged: the same shape as wallet.ts's `framesWallet`
// (`request`, `address`, `batches`), with every request forwarded to the Rust process over HTTP.
//
// The key goes to the process in its environment, as WALLET_KEY, and is never printed.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { type Address, type Hex, getAddress, hexToBigInt } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import type { Batch } from './wallet.js'
import { ProviderRpcError } from './wallet.js'

type Reported = Pick<Batch, 'hash' | 'trace'> & { estimate: { draftMaxCost: bigint; finalMaxCost: bigint } }

export async function rustWallet(opts: { bin: string; key: Hex; rpcUrl?: string; sessionSalt?: Hex; log?: (line: string) => void }) {
  const env: NodeJS.ProcessEnv = { ...process.env, WALLET_KEY: opts.key, LISTEN: '127.0.0.1:0' }
  if (opts.rpcUrl) env.RPC_URL = opts.rpcUrl
  if (opts.sessionSalt) env.SESSION_ACCOUNT_SALT = opts.sessionSalt
  else delete env.SESSION_ACCOUNT_SALT
  const child = spawn(opts.bin, [], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  process.on('exit', () => child.kill())
  const url = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      const m = line.match(/^listening on (http:\/\/\S+)$/)
      if (m) resolve(m[1])
    })
    child.on('exit', (code) => reject(new Error(`frame-wallet exited with ${code}`)))
  })
  opts.log?.(`  rust wallet: ${opts.bin} serving on ${url}`)

  let id = 0
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } }
    if (body.error) throw new ProviderRpcError(body.error.code, body.error.message, body.error.data)
    return body.result as T
  }

  const batches = new Map<string, Reported>()
  async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const result = await call<unknown>(method, (params ?? []) as unknown[])
    if (method === 'wallet_sendCalls') {
      const { id: batchId } = result as { id: string }
      const b = await call<{ hash: Hex; trace: string[]; estimate: { draftMaxCost: Hex; finalMaxCost: Hex } }>('kohaku_getBatch', [batchId])
      batches.set(batchId, { hash: b.hash, trace: b.trace, estimate: { draftMaxCost: hexToBigInt(b.estimate.draftMaxCost), finalMaxCost: hexToBigInt(b.estimate.finalMaxCost) } })
      opts.log?.(`  rust wallet: sent ${b.hash}`)
    }
    return result
  }

  const [account] = await call<Address[]>('eth_accounts', [])
  if (!opts.sessionSalt && getAddress(account) !== privateKeyToAddress(opts.key)) throw new Error(`the Rust wallet serves ${account}, not the key's address`)
  return { request, address: getAddress(account), batches, call, close: () => child.kill() }
}
