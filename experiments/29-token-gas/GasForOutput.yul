// GasForOutput: pays the gas of any frame transaction that pays it back, in ETH, inside the same
// atomic batch as the calls it pays for. No storage, no signer, no oracle, no server.
//
// A user who holds only tokens swaps some of them for ETH and hands this contract the transaction's
// maximum cost out of the proceeds; the post-op refunds what the gas did not use. If any call in
// the batch fails, the batch rolls back, the repayment with it, and this contract has paid for the
// gas of a transaction that paid it nothing. That exposure is what the experiment measures.
//
// VERIFY (pay frame, allowed scope PAYMENT only):
//   - the transaction's maximum cost is at most CAP;
//   - every frame after this one up to the repayment is a SENDER frame with the atomic-batch flag,
//     so they and the repayment form one batch;
//   - the repayment is a SENDER frame to this contract, without the flag (it closes the batch),
//     with value >= the maximum cost (TXPARAM 0x06);
//   - optionally, the last frame is a DEFAULT frame to this contract (the post-op), with at least
//     POST_OP_GAS of execution budget.
//   When CHECK is set, it also reads the token's balanceOf(sender) and requires the amount of the
//   batch's first call, `approve(spender, amount)`, to be covered. That read is outside the
//   sender's storage, which the public mempool forbids: this variant exists to be refused.
//
// DEFAULT (post-op, last frame only): if the repayment succeeded, refund the sender the gas the
// earlier frames left unused, priced at max_fee_per_gas. The contract keeps the gap between the
// max fee and the effective price, and the post-op's own unused gas.
//
// Plain calls: ETH is accepted from anyone (the repayment); the owner, calling with no value,
// sweeps the balance.
//
// initcode = <this object> || abi.encode(cap, check, token, owner)
object "GasForOutput" {
    code {
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        codecopy(n, sub(codesize(), 128), 128)
        return(0, add(n, 128))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                switch frameparam(0x02, frame)
                case 1 { validate(frame) } // VERIFY
                case 0 { postOp(frame) }   // DEFAULT
                stop()
            }
            if callvalue() { stop() }
            if eq(caller(), owner()) {
                if iszero(call(gas(), owner(), selfbalance(), 0, 0, 0, 0)) { revert(0, 0) }
            }
            stop()

            function validate(frame) {
                if iszero(eq(frameparam(0x06, frame), 1)) { revert(0, 0) }   // allowed scope: PAYMENT
                let maxCost := txparam(0x06)
                if gt(maxCost, cap()) { revert(0, 0) }
                let last := sub(txparam(0x09), 1)
                let repay := last
                if iszero(frameparam(0x02, last)) {                          // a DEFAULT frame last: the post-op
                    if iszero(eq(frameparam(0x00, last), address())) { revert(0, 0) }
                    if lt(frameparam(0x01, last), 30000) { revert(0, 0) }
                    repay := sub(last, 1)
                }
                if iszero(gt(repay, add(frame, 1))) { revert(0, 0) }          // at least one call before the repayment
                for { let j := add(frame, 1) } lt(j, repay) { j := add(j, 1) } {
                    if iszero(eq(frameparam(0x02, j), 2)) { revert(0, 0) }  // SENDER
                    if iszero(frameparam(0x07, j)) { revert(0, 0) }         // in the batch
                }
                if iszero(eq(frameparam(0x02, repay), 2)) { revert(0, 0) }
                if frameparam(0x07, repay) { revert(0, 0) }                  // closes the batch
                if iszero(eq(frameparam(0x00, repay), address())) { revert(0, 0) }
                if lt(frameparam(0x08, repay), maxCost) { revert(0, 0) }     // value >= max cost
                if check() { checkBalance(add(frame, 1)) }
                approve(1)
            }

            // CHECK variant: the batch's first call must be approve(spender, amount) on the token,
            // and the sender must hold `amount`.
            function checkBalance(first) {
                if iszero(eq(frameparam(0x00, first), token())) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(first, 0)), 0x095ea7b3)) { revert(0, 0) } // approve(address,uint256)
                let amount := framedataload(first, 36)
                mstore(0, shl(224, 0x70a08231))                              // balanceOf(address)
                mstore(4, txparam(0x02))
                if iszero(staticcall(gas(), token(), 0, 36, 0, 32)) { revert(0, 0) }
                if lt(mload(0), amount) { revert(0, 0) }
            }

            function postOp(frame) {
                if iszero(eq(add(frame, 1), txparam(0x09))) { revert(0, 0) }  // last frame: refunds at most once
                let repay := sub(frame, 1)
                if iszero(eq(frameparam(0x05, repay), 1)) { stop() }          // the batch failed: nothing to refund
                let unused := 0
                for { let j := 0 } lt(j, frame) { j := add(j, 1) } {
                    unused := add(unused, sub(
                        add(frameparam(0x01, j), frameparam(0x09, j)),        // limits.execution + limits.state
                        add(frameparam(0x0a, j), frameparam(0x0b, j))         // gas_used.execution + gas_used.state
                    ))
                }
                let refund := mul(unused, txparam(0x04))
                if refund { pop(call(gas(), txparam(0x02), refund, 0, 0, 0, 0)) }
            }

            function cap() -> v { v := arg(128) }
            function check() -> v { v := arg(96) }
            function token() -> v { v := arg(64) }
            function owner() -> v { v := arg(32) }
            function arg(fromEnd) -> v {
                codecopy(0x80, sub(codesize(), fromEnd), 32)
                v := mload(0x80)
            }

            // EIP-8141 opcodes. verbatim puts its first argument on top of the stack.
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function framedataload(frame, offset) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
