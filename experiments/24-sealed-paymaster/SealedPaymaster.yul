// SealedPaymaster: a paymaster whose ether can leave only as gas it approves, with a policy its
// sponsor publishes as an EIP-8272 recent root instead of a key that signs every transaction.
//
// It is the construction ethereum/EIPs#12328 ("egress-decidable paymaster") sketches, built so
// that both the PR's whole-code scan and a stricter one pass it:
//
// - No CALL, CALLCODE, DELEGATECALL, CREATE, CREATE2, SELFDESTRUCT anywhere in the runtime.
// - Every APPROVE is the fixed sequence PUSH1 1, PUSH0, PUSH0, APPROVE: scope PAYMENT is a
//   constant, so this account can never approve EXECUTION and never become a transaction's
//   sender. (The canonical paymaster's runtime uses the same four instructions.)
// - No appended data: the sponsor's source id is an immutable, which lives inside a PUSH32 of
//   the runtime, so an opcode scan never reads it as instructions.
// - It reads no storage and no balance. Everything it decides on is in the transaction.
//
// Layout it pays for (k = 4):
//
//   0 expiry verifier      VERIFY, target EXPIRY_VERIFIER, data = deadline (uint64, 8 bytes)
//   1 EIP-8272 verifier    VERIFY, target 0x8272, data = tuples (source_id ‖ slot ‖ root), 72 bytes each
//   2 only_verify          VERIFY by the sender, scope EXECUTION
//   3 pay                  VERIFY, target this, scope PAYMENT, data below
//   4 op                   SENDER
//
// Pay-frame data, 32-byte words: t ‖ cap ‖ notAfter ‖ index ‖ depth ‖ sibling[0..depth)
//
//   leaf = keccak256(target ‖ selector ‖ cap ‖ notAfter)        (target and selector of frame 4)
//   node = keccak256(left ‖ right), bit i of `index` set means the running hash is the right child
//
// It approves PAYMENT when tuple t of frame 1 names this sponsor's source id, the path folds the
// leaf to that tuple's root, the transaction's max cost is at most `cap`, and the expiry
// deadline is at most `notAfter`. The protocol has already checked frame 1's tuple against the
// predeploy and frame 0's deadline against the block, or the transaction would be invalid. The
// deadline is what bounds a policy's life: EIP-8272 keeps every root referenceable for 8191
// slots, so a published policy cannot be withdrawn, only outlived.
//
// Plain transfers are deposits. There is no withdrawal: the float can leave only as gas.
//
// initcode = <this object> ‖ source_id (32)
object "SealedPaymaster" {
    code {
        codecopy(0, sub(codesize(), 32), 32)
        let source := mload(0)
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        setimmutable(0, "source", source)
        return(0, n)
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) } // mode == VERIFY
            }
            stop()

            function validate(me) {
                if iszero(eq(frameparam(0x06, me), 1)) { fail() }     // a pay frame, nothing else
                if iszero(eq(txparam(0x09), 5)) { fail() }
                if iszero(eq(me, 3)) { fail() }

                // Frame 0: the expiry verifier. The testnet's pinned EIP puts it at 0x8141.
                if iszero(eq(frameparam(0x00, 0), 0x8141)) { fail() }
                if iszero(eq(frameparam(0x02, 0), 1)) { fail() }
                if iszero(eq(frameparam(0x04, 0), 8)) { fail() }
                let deadline := shr(192, framedataload(0, 0))

                // Frame 1: the EIP-8272 verifier, tuple t.
                if iszero(eq(frameparam(0x00, 1), 0x8272)) { fail() }
                if iszero(eq(frameparam(0x02, 1), 1)) { fail() }
                let t := framedataload(0x00, me)
                if gt(mul(add(t, 1), 72), frameparam(0x04, 1)) { fail() }
                if iszero(eq(framedataload(mul(t, 72), 1), loadimmutable("source"))) { fail() }
                let root := framedataload(add(mul(t, 72), 40), 1)

                // Frame 2 validates the sender; frame 4 is the one operation paid for.
                if iszero(eq(frameparam(0x02, 2), 1)) { fail() }
                if iszero(eq(frameparam(0x02, 4), 2)) { fail() }

                let cap := framedataload(0x20, me)
                let notAfter := framedataload(0x40, me)
                if gt(txparam(0x06), cap) { fail() }
                if gt(deadline, notAfter) { fail() }

                let index := framedataload(0x60, me)
                let depth := framedataload(0x80, me)
                if gt(depth, 32) { fail() }
                if shr(depth, index) { fail() }
                if iszero(eq(frameparam(0x04, me), add(0xa0, mul(depth, 32)))) { fail() }

                mstore(0x00, frameparam(0x00, 4))                      // target
                mstore(0x20, shr(224, framedataload(0, 4)))            // selector
                mstore(0x40, cap)
                mstore(0x60, notAfter)
                let h := keccak256(0x00, 0x80)
                for { let i := 0 } lt(i, depth) { i := add(i, 1) } {
                    let sibling := framedataload(add(0xa0, mul(i, 32)), me)
                    switch and(shr(i, index), 1)
                    case 0 { mstore(0x00, h) mstore(0x20, sibling) }
                    default { mstore(0x00, sibling) mstore(0x20, h) }
                    h := keccak256(0x00, 0x40)
                }
                if iszero(eq(h, root)) { fail() }
                approvePayment()
            }

            function fail() { revert(0, 0) }

            // PUSH1 1, PUSH0, PUSH0, APPROVE: APPROVE(offset 0, length 0, scope PAYMENT).
            function approvePayment() { verbatim_0i_0o(hex"60015f5faa") }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
        }
    }
}
