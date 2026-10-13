// Introspector: an account that reports everything the frame introspection opcodes return.
//
// VERIFY (caller ENTRY_POINT, mode VERIFY): entry 0 must be the owner's SECP256K1 signature over
// the sig hash. If entry 1 is a 32-byte ARBITRARY entry (msg ∅, so outside the sig hash), it
// holds keccak256 of the dump the script expects this frame to see, and VERIFY approves only if
// its own dump hashes to it. Then APPROVE(the frame's scope).
//
// Otherwise, from any caller (a SENDER frame, a DEFAULT frame, a nested call, or a call outside
// any frame transaction, where the opcodes must halt), the first byte of calldata picks. Nothing
// here moves value; empty calldata (a plain transfer in) does nothing.
//   0x00                     dump: LOG1(topic = current frame index, data = the dump)
//   0x01 ‖ op ‖ a(32) ‖ b(32) one opcode with the given operands, its result logged (or a halt)
//   0x02                     gas probes: LOG0 of what TXPARAM, FRAMEPARAM, SIGPARAM, FRAMEDATALOAD cost
//   0x03                     revert
//   0x04                     call itself with 0x00 (a dump from one call deeper)
//
// The dump, one word each:
//   TXPARAM 0x00..0x10
//   for each frame f: FRAMEPARAM 0x00-0x04, 0x06-0x09, FRAMEDATALOAD(f, 0);
//                     then, if f is before the current frame, FRAMEPARAM 0x05, 0x0A, 0x0B
//   for each signature s: SIGPARAM 0x01, 0x02, then 0x00 (protocol scheme) or 0x03 (ARBITRARY)
//
// initcode = <this object> ‖ owner (32)
object "Introspector" {
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
            if calldatasize() { dispatch() }
            stop()

            function validate(frame) {
                if iszero(txparam(0x0b)) { fail() }
                if iszero(eq(sigparam(0x01, 0), 1)) { fail() }
                if sigparam(0x02, 0) { fail() }
                if iszero(eq(sigparam(0x00, 0), owner())) { fail() }
                if gt(txparam(0x0b), 1) {
                    if iszero(sigparam(0x01, 1)) {
                        if eq(sigparam(0x03, 1), 32) {
                            sigdatacopy(0, 0, 32, 1)
                            let expected := mload(0)
                            let end := dump()
                            if iszero(eq(keccak256(0x100, sub(end, 0x100)), expected)) { fail() }
                        }
                    }
                }
                approve(frameparam(0x06, frame))
            }

            function dispatch() {
                switch shr(248, calldataload(0))
                case 0 {
                    let end := dump()
                    log1(0x100, sub(end, 0x100), txparam(0x0a))
                }
                case 1 { probe(byte(1, calldataload(0)), calldataload(2), calldataload(34)) }
                case 2 { gasProbe() }
                case 3 { fail() }
                case 4 {
                    mstore(0, 0)
                    if iszero(call(gas(), address(), 0, 0, 1, 0, 0)) { fail() }
                }
                default { fail() }
            }

            function dump() -> p {
                p := 0x100
                for { let i := 0 } lt(i, 0x11) { i := add(i, 1) } { p := put(p, txparam(i)) }
                let n := txparam(0x09)
                let current := txparam(0x0a)
                for { let f := 0 } lt(f, n) { f := add(f, 1) } {
                    for { let q := 0 } lt(q, 0x0a) { q := add(q, 1) } {
                        if iszero(eq(q, 5)) { p := put(p, frameparam(q, f)) }
                    }
                    p := put(p, framedataload(f, 0))
                    if lt(f, current) {
                        p := put(p, frameparam(0x05, f))
                        p := put(p, frameparam(0x0a, f))
                        p := put(p, frameparam(0x0b, f))
                    }
                }
                let s := txparam(0x0b)
                for { let i := 0 } lt(i, s) { i := add(i, 1) } {
                    let scheme := sigparam(0x01, i)
                    p := put(p, scheme)
                    p := put(p, sigparam(0x02, i))
                    switch scheme
                    case 0 { p := put(p, sigparam(0x03, i)) }
                    default { p := put(p, sigparam(0x00, i)) }
                }
            }
            function put(p, v) -> q {
                mstore(p, v)
                q := add(p, 32)
            }

            // One opcode, operands as given; a halt fails the frame, otherwise the result is logged.
            function probe(op, a, b) {
                let v := 0
                switch op
                case 0 { v := txparam(a) }
                case 1 { v := frameparam(a, b) }
                case 2 { v := sigparam(a, b) }
                case 3 { v := framedataload(b, a) }
                case 4 { sigdatacopy(0, 0, 32, b) v := mload(0) }
                case 5 { framedatacopy(0, a, 32, b) v := mload(0) }
                default { fail() }
                mstore(0, v)
                log0(0, 32)
            }

            // GAS, the operands, the opcode, POP, GAS, SWAP1, SUB: the difference less the
            // surrounding opcodes (PUSH1 3 each, POP 2, GAS 2) is the opcode's own cost.
            function gasProbe() {
                mstore(0x00, sub(verbatim_0i_1o(hex"5a6000b0505a9003"), 7))      // TXPARAM(0x00)
                mstore(0x20, sub(verbatim_0i_1o(hex"5a6008b0505a9003"), 7))      // TXPARAM(0x08), the sig hash
                mstore(0x40, sub(verbatim_0i_1o(hex"5a6006b0505a9003"), 7))      // TXPARAM(0x06), the max cost
                mstore(0x60, sub(verbatim_0i_1o(hex"5a60006000b3505a9003"), 10)) // FRAMEPARAM(0x00, 0)
                mstore(0x80, sub(verbatim_0i_1o(hex"5a60016000b4505a9003"), 10)) // SIGPARAM(0x01, 0)
                mstore(0xa0, sub(verbatim_0i_1o(hex"5a60006000b1505a9003"), 10)) // FRAMEDATALOAD(0, 0)
                log0(0, 0xc0)
            }

            function owner() -> o {
                codecopy(0, sub(codesize(), 32), 32)
                o := mload(0)
            }
            function fail() { revert(0, 0) }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function framedataload(frame, offset) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(mem, offset, length, frame) { verbatim_4i_0o(hex"b2", mem, offset, length, frame) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function sigdatacopy(mem, offset, length, index) { verbatim_4i_0o(hex"b5", mem, offset, length, index) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
