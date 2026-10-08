// ScopedAccount: the owner signs what the account approves, no more and no less.
//
// - Approving EXECUTION and PAYMENT (scope 3), the account pays, so the fees and every frame are
//   its business: entry 0 must be the owner's SECP256K1 signature over the canonical sig hash
//   (empty msg), which the protocol has already checked. That is the default code's rule.
// - Approving EXECUTION only (scope 2), someone else pays. Entry 0 must then be the owner's
//   SECP256K1 signature over an explicit digest of everything except the payer's part:
//
//   E = keccak256("exp-frames/23 execution scope" ‖ chainid ‖ sender ‖ nonce_keys_hash ‖ nonce_seq
//                 ‖ len(frames)
//                 ‖ for each frame i:
//                     i ‖ PAY                                          if it is a pay frame
//                     i ‖ mode ‖ flags ‖ target ‖ limits.execution ‖ limits.state ‖ value
//                       ‖ keccak256(data)                              otherwise)
//
//   where a pay frame is a VERIFY frame whose allowed scope is PAYMENT alone. Its target, data
//   and budgets, the fees and the other signature entries are left to the payer: they decide who
//   pays and how much, and nothing the account does. Every other frame is pinned, with its
//   position, and so is the number of frames, so nothing can be inserted, appended or moved.
//
// initcode = <this object> ‖ owner (32)
object "ScopedAccount" {
    code {
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        codecopy(n, sub(codesize(), 32), 32)
        return(0, add(n, 32))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) } // mode == VERIFY
            }
            stop()

            function validate(frame) {
                codecopy(0, sub(codesize(), 32), 32)
                let owner := mload(0)
                if iszero(txparam(0x0b)) { fail() }
                if iszero(eq(sigparam(0x01, 0), 1)) { fail() }       // SECP256K1
                if iszero(eq(sigparam(0x00, 0), owner)) { fail() }   // signed by the owner
                let scope := frameparam(0x06, frame)
                let msg := sigparam(0x02, 0)
                switch scope
                case 2 { if iszero(eq(msg, executionDigest())) { fail() } }
                case 3 { if msg { fail() } }                          // the canonical sig hash
                default { fail() }
                approve(scope)
            }

            function executionDigest() -> d {
                mstore(0x00, "exp-frames/23 execution scope")
                mstore(0x20, chainid())
                mstore(0x40, txparam(0x02))   // sender
                mstore(0x60, txparam(0x0f))   // nonce_keys_hash (EIP-8250)
                mstore(0x80, txparam(0x01))   // nonce_seq
                let n := txparam(0x09)
                mstore(0xa0, n)
                let p := 0xc0
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let mode := frameparam(0x02, i)
                    mstore(p, i)
                    switch and(eq(mode, 1), eq(frameparam(0x06, i), 1))
                    case 1 {                                          // the payer's frame
                        mstore(add(p, 0x20), not(0))
                        p := add(p, 0x40)
                    }
                    default {
                        mstore(add(p, 0x20), mode)
                        mstore(add(p, 0x40), frameparam(0x03, i))
                        mstore(add(p, 0x60), frameparam(0x00, i))
                        mstore(add(p, 0x80), frameparam(0x01, i))
                        mstore(add(p, 0xa0), frameparam(0x09, i))
                        mstore(add(p, 0xc0), frameparam(0x08, i))
                        let len := frameparam(0x04, i)
                        framedatacopy(add(p, 0x100), 0, len, i)
                        mstore(add(p, 0xe0), keccak256(add(p, 0x100), len))
                        p := add(p, 0x100)
                    }
                }
                d := keccak256(0, p)
            }

            function fail() { revert(0, 0) }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
