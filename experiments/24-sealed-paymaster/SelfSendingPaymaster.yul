// SelfSendingPaymaster: passes ethereum/EIPs#12328's whole-code scan, and its owner can still
// take every wei out in one transaction.
//
// The runtime contains no CALL, CALLCODE, DELEGATECALL, CREATE, CREATE2 or SELFDESTRUCT, and no
// appended data (the owner is an immutable). It is the canonical paymaster's admission rule with
// the timelocked withdrawal deleted:
//
// - As a pay frame (allowed scope PAYMENT), it approves PAYMENT when signature entry 1 is the
//   owner's SECP256K1 signature over the canonical sig hash.
// - As its own validation frame (it is tx.sender, allowed scope EXECUTION or both), it approves
//   that scope when signature entry 0 is the owner's SECP256K1 signature over the canonical sig
//   hash: the default code's rule.
//
// The second branch is the whole point. APPROVE(EXECUTION) makes this account a sender, and a
// SENDER frame carries `value` out of the sender's balance. No opcode in this code moves ether;
// the frame does. The PR's scan reads "APPROVE is not an egress instruction ... regardless of
// the approval scope", which holds for PAYMENT and not for EXECUTION.
//
// initcode = <this object> ‖ owner (32)
object "SelfSendingPaymaster" {
    code {
        codecopy(0, sub(codesize(), 32), 32)
        let owner := mload(0)
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        setimmutable(0, "owner", owner)
        return(0, n)
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) } // mode == VERIFY
            }
            stop()

            function validate(frame) {
                let scope := frameparam(0x06, frame)
                let entry := 0
                switch scope
                case 1 { entry := 1 }                                  // paying for someone
                default { if iszero(eq(txparam(0x02), address())) { fail() } } // it is the sender
                if iszero(gt(txparam(0x0b), entry)) { fail() }
                if iszero(eq(sigparam(0x01, entry), 1)) { fail() }      // SECP256K1
                if iszero(eq(sigparam(0x00, entry), loadimmutable("owner"))) { fail() }
                if sigparam(0x02, entry) { fail() }                     // the canonical sig hash
                approve(scope)
            }

            function fail() { revert(0, 0) }

            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
        }
    }
}
