// MultisigImpl: the k-of-n check of experiment 05, moved behind a proxy so that the per-account
// code is tiny and the owner set is a 32-byte commitment instead of n words of code.
//
// It runs only through a proxy's DELEGATECALL, so ADDRESS is the account and APPROVE works
// (EIP-8141: "code executed via DELEGATECALL from the resolved target may also execute APPROVE").
// The proxy appends the account's commitment to the calldata:
//
//     calldata = frame data ‖ commitment (32 bytes)
//
// VERIFY frame (caller ENTRY_POINT, mode VERIFY): the frame data is the owner set,
//     config = k (1 byte) ‖ owner_0 ‖ … ‖ owner_{n-1}   (20 bytes each)
// and keccak256(config) must equal the commitment. Then, as in experiment 05, count the distinct
// owners among the SECP256K1 and P256 entries that sign the sig hash, and APPROVE the frame's
// allowed scope if there are at least k.
//
// SENDER frame from the account to itself (caller == ADDRESS): op 0x01 ‖ new commitment writes
// slot 0. Only a proxy that reads its commitment from slot 0 (StorageProxy) is affected; a
// CodeProxy's commitment is immutable.
//
// Anything else (a plain ETH transfer) is a no-op.
object "MultisigImpl" {
    code {
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        return(0, n)
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) } // mode == VERIFY
                stop()
            }
            if eq(caller(), address()) {
                if iszero(eq(shr(248, calldataload(0)), 0x01)) { revert(0, 0) }
                let commitment := calldataload(1)
                if iszero(commitment) { revert(0, 0) }
                sstore(0, commitment)
                stop()
            }
            stop()

            function validate(frame) {
                if lt(calldatasize(), 53) { revert(0, 0) } // k, one owner, the commitment
                let len := sub(calldatasize(), 32)
                calldatacopy(0x80, 0, len)
                if iszero(eq(keccak256(0x80, len), calldataload(len))) { revert(0, 0) }
                let k := byte(0, mload(0x80))
                let n := div(sub(len, 1), 20)
                if or(iszero(k), gt(k, n)) { revert(0, 0) }
                if or(mod(sub(len, 1), 20), gt(n, 256)) { revert(0, 0) }

                let seen := 0
                let count := 0
                let sigs := txparam(0x0b)
                for { let i := 0 } lt(i, sigs) { i := add(i, 1) } {
                    let scheme := sigparam(0x01, i)
                    if and(or(eq(scheme, 1), eq(scheme, 2)), iszero(sigparam(0x02, i))) {
                        let signer := sigparam(0x00, i)
                        for { let j := 0 } lt(j, n) { j := add(j, 1) } {
                            if eq(shr(96, mload(add(0x81, mul(j, 20)))), signer) {
                                let bit := shl(j, 1)
                                if iszero(and(seen, bit)) {
                                    seen := or(seen, bit)
                                    count := add(count, 1)
                                }
                                break
                            }
                        }
                    }
                }
                if lt(count, k) { revert(0, 0) }
                approve(frameparam(0x06, frame))
            }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
