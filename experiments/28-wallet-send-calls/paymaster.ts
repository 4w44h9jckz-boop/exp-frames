// A paymaster web service in the shape of ERC-7677 (`pm_getPaymasterStubData`, `pm_getPaymasterData`),
// bound to frame transactions, in front of a canonical paymaster instance (experiment 09's runtime,
// EIPs#12041) whose signer it holds.
//
// The binding:
//   - the EntryPoint parameter is `0x...aa`, the frames entry point, which says "frames";
//   - the user-operation parameter is the unsigned frame transaction (`binding.ts`);
//   - `paymaster`, `paymasterData`, `paymasterVerificationGasLimit` are the pay frame's target, data
//     and execution budget; `paymasterPostOpGasLimit` a DEFAULT frame after the calls (0 here);
//   - two fields ERC-7677 does not have: `paymasterStateGasLimit`, the pay frame's EIP-8037 state
//     budget, and `paymasterSignatures`, the payer's signature entries. The canonical paymaster
//     reads its signer's entry at index 1, after the sender's.
//
// Its policy is the kind such services sell: a policy id names the contracts it pays for.
import { type Server, createServer } from 'node:http'
import { type Address, type Hex, concatHex, getAddress, hexToBigInt, keccak256, numberToHex, pad, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import {
  Approve,
  ENTRY_POINT,
  type FrameTx,
  Mode,
  NEW_ACCOUNT_STATE_GAS,
  STORAGE_SET_STATE_GAS,
  Scheme,
  frameSigHash,
  maxCost,
  secp256k1Sign,
} from '../../src/frametx/index.js'
import { type RpcFrameTx, frameTxFromRpc } from './binding.js'
import type { PaymasterResult } from './wallet.js'

const CANONICAL = compileYul('experiments/09-paymasters/CanonicalPaymaster.yul')

/** The service's signer and its canonical paymaster instance. */
export function paymasterInstance(funderKey: Hex) {
  const signerKey = keccak256(concatHex([funderKey, toHex('exp-frames/28/pm-signer')]))
  const signer = privateKeyToAddress(signerKey)
  const initcode = concatHex([CANONICAL, pad(signer)])
  const salt = saltOf('exp-frames/28/canonical-paymaster')
  return { signerKey, signer, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt, STORAGE_SET_STATE_GAS).frame }
}

export type Policy = { name: string; targets: Address[]; maxCost: bigint }

const PAY_EXECUTION = 15_000n
const STUB_SIGNATURE = `0x${'01'.repeat(65)}` as Hex

class Refusal extends Error {}

export function startPaymasterService(opts: {
  paymaster: Address
  signerKey: Hex
  chainId: bigint
  policies: Record<string, Policy>
  senderExists: (a: Address) => Promise<boolean>
  log?: (line: string) => void
}): Promise<{ url: string; server: Server; calls: string[] }> {
  const { paymaster, signerKey, chainId, policies } = opts
  const signer = privateKeyToAddress(signerKey)
  const log = opts.log ?? (() => {})
  const calls: string[] = []

  /** The pay frame and the signature list this service puts into a transaction. */
  async function quote(raw: RpcFrameTx, entryPoint: Address, chain: Hex, context: { policyId?: string }, final: boolean): Promise<PaymasterResult> {
    if (getAddress(entryPoint) !== getAddress(ENTRY_POINT)) throw new Refusal(`entry point ${entryPoint} is not the frames entry point`)
    if (hexToBigInt(chain) !== chainId) throw new Refusal(`chain ${chain} not served`)
    const policy = policies[context.policyId ?? '']
    if (!policy) throw new Refusal(`unknown policy ${context.policyId}`)
    const tx = frameTxFromRpc(raw)

    // What it pays for: the sender approves execution only, then calls on the policy's list.
    const [own, ...rest] = tx.frames
    if (own.mode !== Mode.VERIFY || own.target !== null || own.flags !== Approve.EXECUTION) throw new Refusal('frame 0 must be the sender approving execution only')
    for (const f of rest) {
      if (f.mode === Mode.VERIFY && f.target && getAddress(f.target) === paymaster) continue // its own pay frame, from the stub
      if (f.mode === Mode.DEFAULT && f.target && getAddress(f.target) === paymaster) continue
      if (f.mode !== Mode.SENDER) throw new Refusal(`frame of mode ${f.mode} not allowed`)
      if (!f.target || !policy.targets.some((t) => getAddress(t) === getAddress(f.target!))) throw new Refusal(`call to ${f.target} is outside policy ${policy.name}`)
      if (f.value !== 0n) throw new Refusal('calls with value are not sponsored')
    }

    const exists = await opts.senderExists(tx.sender)
    const payFrame = {
      mode: Mode.VERIFY,
      flags: Approve.PAYMENT,
      target: paymaster,
      // APPROVE on a sender that does not exist yet creates its account, and the pay frame pays for it.
      limits: { execution: PAY_EXECUTION, state: exists ? 0n : NEW_ACCOUNT_STATE_GAS },
      value: 0n,
      data: '0x' as Hex,
    }
    const calls = rest.filter((f) => f.mode === Mode.SENDER)
    const withPay: FrameTx = {
      ...tx,
      frames: [own, payFrame, ...calls],
      signatures: [tx.signatures[0], { scheme: Scheme.SECP256K1, signer, msg: '0x', signature: '0x' }],
    }
    const cost = maxCost(withPay)
    if (cost > policy.maxCost) throw new Refusal(`max cost ${cost} above the policy's ${policy.maxCost}`)

    // The canonical signature hash elides every empty-msg signature, the user's too, so the
    // service can sign before the user does, as an ERC-4337 paymaster does.
    const signature = final ? await secp256k1Sign(frameSigHash(withPay), signerKey) : STUB_SIGNATURE
    return {
      sponsor: { name: `exp-frames 28, policy ${policy.name}` },
      paymaster,
      paymasterData: '0x',
      paymasterVerificationGasLimit: numberToHex(PAY_EXECUTION),
      paymasterPostOpGasLimit: '0x0',
      paymasterStateGasLimit: numberToHex(payFrame.limits.state),
      paymasterSignatures: [{ scheme: numberToHex(Scheme.SECP256K1), signer, msg: '0x', signature }],
      isFinal: false,
    }
  }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: [RpcFrameTx, Address, Hex, { policyId?: string }] }
      calls.push(method)
      const reply = (o: object) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id, ...o }))
      }
      try {
        if (method !== 'pm_getPaymasterStubData' && method !== 'pm_getPaymasterData') return reply({ error: { code: -32601, message: `${method} not found` } })
        const result = await quote(...params, method === 'pm_getPaymasterData')
        log(`  paymaster service: ${method} for ${params[0].sender}: ok`)
        reply({ result })
      } catch (e) {
        log(`  paymaster service: ${method} for ${params[0]?.sender}: refused, ${(e as Error).message}`)
        reply({ error: { code: e instanceof Refusal ? -32000 : -32603, message: (e as Error).message } })
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${port}/`, server, calls })
    }),
  )
}
