// SenderFramesAccount: EIP-8141's Security Considerations, "Execution Approval Authorizes All
// Subsequent Sender Frames", taken at its word. The section ends: "Custom validation contracts
// that grant APPROVE_EXECUTION should verify against the canonical signature hash, or otherwise
// constrain every subsequent SENDER frame, before approving." This account takes the second
// branch.
//
// VERIFY accepts entry 0 = SECP256K1 by the owner over an explicit 32-byte digest
//
//   D = keccak256("exp-frames/23 sender-frames" ‖ chainid ‖ sender ‖ nonce_keys_hash ‖ nonce_seq
//                 ‖ for each SENDER frame, in order:
//                     target ‖ flags ‖ limits.execution ‖ limits.state ‖ value ‖ keccak256(data))
//
// and approves whatever scope its frame allows. Every SENDER frame is constrained: its target,
// flags, budgets, value and data, their number and their order. Nothing else is: not the fees, not
// the DEFAULT frames, not where the SENDER frames sit among the others.
//
// initcode = <this object> ‖ owner (32)
object "SenderFramesAccount" {
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
                let msg := sigparam(0x02, 0)
                if iszero(msg) { fail() }                             // over an explicit digest
                if iszero(eq(msg, digest())) { fail() }
                approve(frameparam(0x06, frame))
            }

            function digest() -> d {
                mstore(0x00, "exp-frames/23 sender-frames")
                mstore(0x20, chainid())
                mstore(0x40, txparam(0x02))   // sender
                mstore(0x60, txparam(0x0f))   // nonce_keys_hash (EIP-8250)
                mstore(0x80, txparam(0x01))   // nonce_seq
                let p := 0xa0
                let n := txparam(0x09)
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    if eq(frameparam(0x02, i), 2) {                  // SENDER
                        mstore(p, frameparam(0x00, i))
                        mstore(add(p, 0x20), frameparam(0x03, i))
                        mstore(add(p, 0x40), frameparam(0x01, i))
                        mstore(add(p, 0x60), frameparam(0x09, i))
                        mstore(add(p, 0x80), frameparam(0x08, i))
                        let len := frameparam(0x04, i)
                        framedatacopy(add(p, 0xc0), 0, len, i)
                        mstore(add(p, 0xa0), keccak256(add(p, 0xc0), len))
                        p := add(p, 0xc0)
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
