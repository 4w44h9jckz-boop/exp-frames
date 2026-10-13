import { type Address, type Hex, concatHex, getAddress, getContractAddress, hexToBigInt, keccak256, size, slice, toHex } from 'viem'
import { CREATE2_DEPLOYER } from '../../src/frametx/index.js'

// Probe: a 34-byte contract that records how it was called. Each call bumps a counter in
// slot 0 and emits LOG0(caller ‖ origin ‖ callvalue ‖ counter ‖ calldata).
const RUNTIME_OPS: Hex[] = [
  '0x33', '0x5f', '0x52', //           mstore(0x00, caller)
  '0x32', '0x6020', '0x52', //         mstore(0x20, origin)
  '0x34', '0x6040', '0x52', //         mstore(0x40, callvalue)
  '0x5f', '0x54', '0x6001', '0x01', // counter = sload(0) + 1
  '0x80', '0x5f', '0x55', //           sstore(0, counter)
  '0x6060', '0x52', //                 mstore(0x60, counter)
  '0x36', '0x5f', '0x6080', '0x37', // calldatacopy(0x80, 0, calldatasize)
  '0x36', '0x6080', '0x01', //         len = 0x80 + calldatasize
  '0x5f', '0xa0', //                   log0(0, len)
  '0x00', //                           stop
]
export const PROBE_RUNTIME = concatHex(RUNTIME_OPS)

/** PUSH1 len DUP1 PUSH1 9 PUSH0 CODECOPY PUSH0 RETURN ‖ runtime */
export const PROBE_INITCODE = concatHex([`0x60${size(PROBE_RUNTIME).toString(16).padStart(2, '0')}80`, '0x60095f395ff3', PROBE_RUNTIME])

export const PROBE_SALT = keccak256(toHex('exp-frames/probe/v1'))

/** Where the CREATE2 deployer puts the probe. */
export const PROBE_ADDRESS: Address = getContractAddress({
  opcode: 'CREATE2',
  from: CREATE2_DEPLOYER,
  salt: PROBE_SALT,
  bytecode: PROBE_INITCODE,
})

/** Calldata for the CREATE2 deployer: salt ‖ initcode. */
export const PROBE_DEPLOY_CALLDATA = concatHex([PROBE_SALT, PROBE_INITCODE])

export type ProbeLog = { caller: Address; origin: Address; callvalue: bigint; counter: bigint; calldata: Hex }

export function decodeProbeLog(data: Hex): ProbeLog {
  return {
    caller: getAddress(slice(data, 12, 32)),
    origin: getAddress(slice(data, 44, 64)),
    callvalue: hexToBigInt(slice(data, 64, 96)),
    counter: hexToBigInt(slice(data, 96, 128)),
    calldata: size(data) > 128 ? slice(data, 128) : '0x',
  }
}
