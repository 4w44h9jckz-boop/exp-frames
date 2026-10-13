// SubscriptionAccount: an owner key in code, and subscriptions a merchant collects by sending a
// transaction *from the account*, paid for by the merchant.
//
// Pull transaction (anyone may build one; only a subscribed merchant's succeeds in execution):
//
//   0  VERIFY -> sender (this)   scope EXECUTION only; entry 0 signed by the merchant m
//   1  VERIFY -> m               scope PAYMENT; m's default code checks entry 1 (m pays the fees)
//   2  SENDER -> sender          0x03 ‖ m, no value, no flags
//   nonce_keys = [m]             each merchant has its own nonce lane
//
// VERIFY checks only the shape, the signer and the nonce key, and reads no storage. That keeps
// pulls concurrent with the owner's transactions and with each other (ethrex lets transactions
// on disjoint nonce keys wait together only when the prefix reads no sender storage), and it
// costs the account nothing when a pull is refused in execution: the merchant pays for it.
//
// Storage, per merchant m at keccak256(m): amount (16) ‖ period (8) ‖ next due time (8).
//
// Operations, as SENDER frames the account sends to itself (caller == address()):
//   0x01 ‖ m (20) ‖ amount (16) ‖ period (8) ‖ first due (8)   subscribe
//   0x02 ‖ m (20)                                             cancel
//   0x03 ‖ m (20)    pull: if now >= due, send amount to m and move due on by one period
//
// initcode = <this object> ‖ owner (32)
object "SubscriptionAccount" {
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
                stop()
            }
            if eq(caller(), address()) { operate() }
            stop()

            function validate(frame) {
                if iszero(txparam(0x0b)) { fail() }
                if iszero(sigparam(0x01, 0)) { fail() }       // a protocol scheme
                if sigparam(0x02, 0) { fail() }               // msg empty
                let signer := sigparam(0x00, 0)
                if eq(signer, owner()) { approve(frameparam(0x06, frame)) }

                // a pull by `signer`, for `signer`, paid by `signer`
                if frame { fail() }
                if iszero(eq(frameparam(0x06, 0), 2)) { fail() }          // EXECUTION only
                if iszero(eq(txparam(0x09), 3)) { fail() }
                if iszero(eq(frameparam(0x02, 1), 1)) { fail() }          // VERIFY
                if iszero(eq(frameparam(0x00, 1), signer)) { fail() }
                if iszero(eq(frameparam(0x06, 1), 1)) { fail() }          // PAYMENT
                if iszero(eq(frameparam(0x02, 2), 2)) { fail() }          // SENDER
                if iszero(eq(frameparam(0x00, 2), address())) { fail() }
                if frameparam(0x03, 2) { fail() }
                if frameparam(0x08, 2) { fail() }
                if iszero(eq(frameparam(0x04, 2), 21)) { fail() }
                if iszero(eq(shr(248, framedataload(2, 0)), 3)) { fail() }
                if iszero(eq(shr(96, framedataload(2, 1)), signer)) { fail() }
                if iszero(eq(txparam(0x0e), 1)) { fail() }
                if iszero(eq(txparam(0x10), signer)) { fail() }
                approve(2)
            }

            function operate() {
                let m := shr(96, calldataload(1))
                let slot := slotOf(m)
                switch shr(248, calldataload(0))
                case 1 {
                    if iszero(eq(calldatasize(), 53)) { fail() }
                    sstore(slot, calldataload(21))
                }
                case 2 {
                    if iszero(eq(calldatasize(), 21)) { fail() }
                    sstore(slot, 0)
                }
                case 3 {
                    if iszero(eq(calldatasize(), 21)) { fail() }
                    let s := sload(slot)
                    let amount := shr(128, s)
                    let period := and(shr(64, s), 0xffffffffffffffff)
                    let due := and(s, 0xffffffffffffffff)
                    if iszero(amount) { fail() }
                    if lt(timestamp(), due) { fail() }
                    sstore(slot, or(and(s, not(0xffffffffffffffff)), add(due, period)))
                    if iszero(call(gas(), m, amount, 0, 0, 0, 0)) { fail() }
                }
                default { fail() }
            }

            function owner() -> o {
                codecopy(0, sub(codesize(), 32), 32)
                o := mload(0)
            }
            function slotOf(m) -> s {
                mstore(0, m)
                s := keccak256(0, 32)
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
