import { type Hex, hexToBytes } from 'viem'

// Two decision procedures for "can ether leave this account other than as gas it approves?",
// both pure functions of runtime code, as ethereum/EIPs#12328 asks for.
//
// `prScan` is the PR's whole-code scan as written: a linear pass that skips PUSH immediates and
// rejects the code if any instruction position holds CALL, CALLCODE, DELEGATECALL, CREATE,
// CREATE2 or SELFDESTRUCT (or SETDELEGATE, EIP-7819, the opcode that re-points code where it is
// active). APPROVE is not looked at.
//
// `sealedScan` is the amendment this experiment argues for. Three changes:
//
// 1. An account with no code, or with an EIP-7702 delegation indicator, is not sealed. Empty
//    code runs the default code, which approves EXECUTION for a key; a delegated EOA has a key
//    that signs ordinary transactions. Either way ether leaves without any opcode in the code.
// 2. Every reachable APPROVE must be the four instructions PUSH1 0x01, PUSH0, PUSH0, APPROVE.
//    Jumps land only on JUMPDEST (0x5b), and none of the four is one, so the stack at that
//    APPROVE is always (offset 0, length 0, scope PAYMENT). An account that can approve
//    EXECUTION becomes a sender, and a SENDER frame carries `value` out of its balance.
// 3. Only reachable instruction positions count. Execution enters at 0 and at JUMPDESTs and
//    falls through until STOP, RETURN, REVERT, INVALID, JUMP, SELFDESTRUCT or APPROVE (which
//    exits the frame); bytes after one of those and before the next JUMPDEST cannot execute.
//    This is what lets data appended after the code (Solidity's CBOR metadata, constants) be
//    skipped without making the scan unsound.

export const EGRESS: Record<number, string> = {
  0xf0: 'CREATE',
  0xf1: 'CALL',
  0xf2: 'CALLCODE',
  0xf4: 'DELEGATECALL',
  0xf5: 'CREATE2',
  0xf6: 'SETDELEGATE',
  0xff: 'SELFDESTRUCT',
}
const APPROVE = 0xaa
const JUMPDEST = 0x5b
const PUSH0 = 0x5f
const PUSH1 = 0x60
/** Instructions after which the next byte is not reached by falling through. */
const TERMINATORS = new Set([0x00, 0x56, 0xf3, 0xfd, 0xfe, 0xff, APPROVE])

export type Instruction = { pc: number; op: number; imm: number[] }

/** Instruction positions, skipping PUSH immediates (the same pass as JUMPDEST analysis). */
export function instructions(code: Uint8Array): Instruction[] {
  const out: Instruction[] = []
  for (let pc = 0; pc < code.length; ) {
    const op = code[pc]
    const n = op >= 0x60 && op <= 0x7f ? op - 0x5f : 0
    out.push({ pc, op, imm: Array.from(code.slice(pc + 1, pc + 1 + n)) })
    pc += 1 + n
  }
  return out
}

export type Finding = { pc: number; what: string }
export type ScanResult = { sealed: boolean; findings: Finding[] }

const bytesOf = (code: Hex | Uint8Array) => (typeof code === 'string' ? hexToBytes(code) : code)

export function prScan(code: Hex | Uint8Array): ScanResult {
  const findings = instructions(bytesOf(code))
    .filter((i) => EGRESS[i.op])
    .map((i) => ({ pc: i.pc, what: EGRESS[i.op] }))
  return { sealed: findings.length === 0, findings }
}

/** Reachable instruction indexes: from 0 and from every JUMPDEST, up to a terminator. */
export function reachable(ins: Instruction[]): boolean[] {
  const live = ins.map(() => false)
  let on = true
  for (const [k, i] of ins.entries()) {
    if (i.op === JUMPDEST) on = true
    live[k] = on
    if (TERMINATORS.has(i.op)) on = false
  }
  return live
}

export function sealedScan(code: Hex | Uint8Array): ScanResult {
  const bytes = bytesOf(code)
  if (bytes.length === 0) return { sealed: false, findings: [{ pc: 0, what: 'no code: the default code approves EXECUTION for a key' }] }
  if (bytes.length === 23 && bytes[0] === 0xef && bytes[1] === 0x01 && bytes[2] === 0x00) {
    return { sealed: false, findings: [{ pc: 0, what: 'EIP-7702 delegation: the account has a key' }] }
  }
  const ins = instructions(bytes)
  const live = reachable(ins)
  const findings: Finding[] = []
  for (const [k, i] of ins.entries()) {
    if (!live[k]) continue
    if (EGRESS[i.op]) findings.push({ pc: i.pc, what: EGRESS[i.op] })
    if (i.op === APPROVE) {
      const [a, b, c] = [ins[k - 3], ins[k - 2], ins[k - 1]]
      const idiom = a?.op === PUSH1 && a.imm[0] === 0x01 && b?.op === PUSH0 && c?.op === PUSH0
      if (!idiom) findings.push({ pc: i.pc, what: 'APPROVE whose scope is not the constant PAYMENT' })
    }
  }
  return { sealed: findings.length === 0, findings }
}

// ---- Solidity's metadata trailer ----

/**
 * The CBOR trailer solc appends by default (bytecodeHash ipfs, appendCBOR true):
 * {"ipfs": <34-byte multihash 0x1220 ‖ sha256>, "solc": <3-byte version>} ‖ uint16 length.
 */
export function metadataTrailer(digest: Uint8Array, version: [number, number, number] = [0, 8, 30]): Uint8Array {
  const ipfs = [0x69, 0x70, 0x66, 0x73]
  const solc = [0x73, 0x6f, 0x6c, 0x63]
  const body = [0xa2, 0x64, ...ipfs, 0x58, 0x22, 0x12, 0x20, ...digest, 0x64, ...solc, 0x43, ...version]
  return Uint8Array.from([...body, body.length >> 8, body.length & 0xff])
}

/** xorshift128+, so the Monte Carlo below is reproducible from its seed. */
export function rng(seed: bigint) {
  let s0 = seed | 1n
  let s1 = (seed * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn
  const mask = 0xffffffffffffffffn
  return (): number => {
    let x = s0
    const y = s1
    s0 = y
    x ^= (x << 23n) & mask
    s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n)
    return Number(((s1 + y) & mask) >> 56n)
  }
}
