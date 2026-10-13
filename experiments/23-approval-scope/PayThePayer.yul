// PayThePayer: lets a user pay a fee in a token to whoever pays the gas, without knowing who
// that will be when they sign.
//
// Called from a SENDER frame with data = token (32) ‖ amount (32). It finds the transaction's pay
// frame (a VERIFY frame whose allowed scope is PAYMENT alone), takes its resolved target as the
// payer, and moves `amount` of `token` from the caller (the sender) to the payer with
// transferFrom, so the sender needs to have approved this contract. With no pay frame the sender
// pays its own gas and there is no one to pay: it reverts.
object "PayThePayer" {
    code {
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        return(0, n)
    }
    object "runtime" {
        code {
            if lt(calldatasize(), 64) { revert(0, 0) }
            let token := calldataload(0)
            let amount := calldataload(32)

            let payer := 0
            let n := txparam(0x09)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                if and(eq(frameparam(0x02, i), 1), eq(frameparam(0x06, i), 1)) {
                    payer := frameparam(0x00, i)
                    break
                }
            }
            if iszero(payer) { revert(0, 0) }

            // transferFrom(caller, payer, amount)
            mstore(0x00, shl(224, 0x23b872dd))
            mstore(0x04, caller())
            mstore(0x24, payer)
            mstore(0x44, amount)
            if iszero(call(gas(), token, 0, 0, 0x64, 0, 0x20)) { revert(0, 0) }
            if iszero(mload(0)) { revert(0, 0) }
            mstore(0, payer)
            return(0, 32)

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
        }
    }
}
