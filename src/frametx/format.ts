import { type Hex, formatEther, hexToBigInt } from 'viem'
import { ATOMIC_BATCH_FLAG, APPROVE_SCOPE_MASK } from './constants.js'
import { maxGas } from './gas.js'
import { HEGOTA_EXPLORER_URL, type FrameTxReceiptJson, type SimulateResult } from './rpc.js'
import type { Frame, FrameTx } from './types.js'

const MODE_NAMES = ['DEFAULT', 'VERIFY', 'SENDER']
const SCOPE_NAMES = ['NONE', 'PAYMENT', 'EXECUTION', 'EXECUTION_AND_PAYMENT']
const STATUS_NAMES: Record<string, string> = { '0x0': 'FAILURE', '0x1': 'SUCCESS', '0x2': 'SKIPPED' }

export function modeName(mode: number): string {
  return MODE_NAMES[mode] ?? `mode(${mode})`
}

export function flagsName(flags: number): string {
  const parts: string[] = []
  const scope = flags & APPROVE_SCOPE_MASK
  if (scope) parts.push(`APPROVE_${SCOPE_NAMES[scope]}`)
  if (flags & ATOMIC_BATCH_FLAG) parts.push('ATOMIC_BATCH')
  if (flags & ~(APPROVE_SCOPE_MASK | ATOMIC_BATCH_FLAG)) parts.push(`reserved(0x${flags.toString(16)})`)
  return parts.length ? parts.join('|') : '-'
}

function short(data: Hex): string {
  return data.length > 2 + 2 * 36 ? `${data.slice(0, 2 + 2 * 36)}…(${(data.length - 2) / 2}B)` : data
}

export function describeFrame(f: Frame, i: number): string {
  const target = f.target ?? '(sender)'
  const value = f.value ? ` value=${formatEther(f.value)}ETH` : ''
  return `  [${i}] ${modeName(f.mode).padEnd(7)} ${flagsName(f.flags).padEnd(30)} → ${target}${value} limits=${f.limits.execution}/${f.limits.state} data=${short(f.data)}`
}

export function describeTx(tx: FrameTx): string {
  return [
    `sender ${tx.sender}  nonce_keys=[${tx.nonceKeys.join(',')}] nonce_seq=${tx.nonceSeq}  max_gas=${maxGas(tx)}`,
    ...tx.frames.map(describeFrame),
  ].join('\n')
}

export function describeSimulation(sim: SimulateResult): string {
  const lines = [
    `simulate: valid=${sim.valid} shape=${sim.prefixShape} payer=${sim.payer} maxCost=${hexToBigInt(sim.maxCost)}`,
  ]
  if (sim.violation) lines.push(`  violation: ${sim.violation}`)
  if (sim.gasUsed) lines.push(`  gasUsed=${hexToBigInt(sim.gasUsed)} execution=${sim.executionStatus}`)
  if (sim.executionError) lines.push(`  executionError: ${sim.executionError}`)
  sim.frames?.forEach((f, i) => lines.push(`  [${i}] gasUsed=${hexToBigInt(f.gasUsed)} succeeded=${f.succeeded}`))
  return lines.join('\n')
}

export function describeReceipt(tx: FrameTx, r: FrameTxReceiptJson): string {
  const gasUsed = hexToBigInt(r.gasUsed)
  const price = hexToBigInt(r.effectiveGasPrice)
  const lines = [
    `mined in block ${hexToBigInt(r.blockNumber)}  payer=${r.payer}  gasUsed=${gasUsed} (max ${maxGas(tx)})  fee=${formatEther(gasUsed * price)}ETH`,
  ]
  r.frameReceipts.forEach((fr, i) => {
    const f = tx.frames[i]
    const status = STATUS_NAMES[fr.status] ?? fr.status
    lines.push(
      `  [${i}] ${modeName(f.mode).padEnd(7)} ${status.padEnd(8)} execution=${hexToBigInt(fr.gasUsed)}/${f.limits.execution} state=${hexToBigInt(fr.stateGasUsed)}/${f.limits.state} logs=${fr.logs.length}`,
    )
  })
  lines.push(`  ${HEGOTA_EXPLORER_URL}/tx/${r.transactionHash}`)
  return lines.join('\n')
}
