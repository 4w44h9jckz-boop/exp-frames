// ProbeAccount: an account whose VERIFY frame does one thing the mempool rules talk about, then
// approves. Entry 0 must be the owner's SECP256K1 signature over the sig hash. The VERIFY frame's
// data picks the probe: id (1) ‖ argument (an address, 20 bytes, or a deadline, 8 bytes).
//
// Banned-opcode probes are emitted with verbatim, opcode then POP, so the optimizer cannot drop
// them; the calls check their results.
//
// initcode = <this object> ‖ owner (32)
object "ProbeAccount" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 32), 32)
        return(0, add(size, 32))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
            }
            stop()

            function validate(frame) {
                if iszero(eq(sigparam(0x01, 0), 1)) { fail() }
                if sigparam(0x02, 0) { fail() }
                codecopy(0, sub(codesize(), 32), 32)
                if iszero(eq(sigparam(0x00, 0), mload(0))) { fail() }
                if frameparam(0x04, frame) {
                    let arg := framedataload(frame, 1)
                    probe(shr(248, framedataload(frame, 0)), shr(96, arg), shr(192, arg))
                }
                approve(frameparam(0x06, frame))
            }

            function probe(id, a, deadline) {
                switch id
                case 1 { verbatim_0i_0o(hex"3a50") }                        // GASPRICE
                case 2 { verbatim_0i_0o(hex"60004050") }                    // BLOCKHASH(0)
                case 3 { verbatim_0i_0o(hex"4150") }                        // COINBASE
                case 4 { verbatim_0i_0o(hex"4250") }                        // TIMESTAMP
                case 5 { verbatim_0i_0o(hex"4350") }                        // NUMBER
                case 6 { verbatim_0i_0o(hex"4450") }                        // PREVRANDAO
                case 7 { verbatim_0i_0o(hex"4550") }                        // GASLIMIT
                case 8 { verbatim_0i_0o(hex"4850") }                        // BASEFEE
                case 9 { verbatim_0i_0o(hex"4a50") }                        // BLOBBASEFEE
                case 10 { verbatim_0i_0o(hex"4b50") }                       // SLOTNUM
                case 11 { verbatim_0i_0o(hex"5a50") }                       // GAS, then POP
                case 12 { verbatim_0i_0o(hex"600060006000600060045afa50") } // GAS, then STATICCALL(identity)
                case 13 { verbatim_0i_0o(hex"303150") }                     // BALANCE(self)
                case 14 { verbatim_0i_0o(hex"4750") }                       // SELFBALANCE
                case 15 { verbatim_0i_0o(hex"60005450") }                   // SLOAD(0), own storage
                case 16 { if iszero(staticcall(30000, a, 0, 0, 0, 32)) { fail() } }           // helper reads its storage
                case 17 { if iszero(staticcall(30000, a, 0, 1, 0, 32)) { fail() } }           // helper, no storage
                case 18 { if iszero(delegatecall(30000, a, 0, 0, 0, 32)) { fail() } }         // helper reads ours
                case 19 { if iszero(staticcall(30000, a, 0, 1, 0, 0)) { fail() } }            // an address with no code
                case 20 { mstore(0, extcodesize(a)) if eq(mload(0), 12345) { fail() } }      // EXTCODESIZE, no code
                case 21 { mstore(0, extcodehash(a)) if eq(mload(0), 12345) { fail() } }      // EXTCODEHASH, a contract
                case 22 { if iszero(staticcall(30000, a, 0, 1, 0, 0)) { fail() } }            // a 7702-delegated EOA
                case 23 { verbatim_0i_0o(hex"fe") }                         // INVALID
                case 24 { verbatim_0i_0o(hex"60005c50") }                   // TLOAD(0)
                case 25 { verbatim_0i_0o(hex"3250") }                       // ORIGIN
                case 26 { verbatim_0i_0o(hex"600db050") }                   // TXPARAM(0x0D), legacy nonce
                case 27 { verbatim_0i_0o(hex"600060006000f050") }           // CREATE (static context)
                case 28 { verbatim_0i_0o(hex"60043b50") }                   // EXTCODESIZE(identity precompile)
                case 29 {                                                   // the expiry verifier, called rather than framed
                    mstore(0, not(0))
                    if iszero(staticcall(30000, 0x8141, 0, 8, 0, 0)) { fail() }
                }
                case 30 {                                                   // "not before": the verifier must refuse the deadline,
                    mstore(0, shl(192, deadline))                           // so only block.timestamp > deadline passes
                    if staticcall(30000, 0x8141, 0, 8, 0, 0) { fail() }
                }
                default { }
            }

            function fail() { revert(0, 0) }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function framedataload(frame, offset) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
