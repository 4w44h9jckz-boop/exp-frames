// PoolSponsor: pays the gas of a FramePool withdrawal and is paid back out of the note.
//
// Its VERIFY frame (scope PAYMENT) approves only a transaction whose sender is the pool and
// whose last frame is the pool's withdraw() naming this sponsor as `relayer`, with a `fee` that
// covers the transaction's maximum cost. The proof binds `relayer` and `fee`, so nobody can
// redirect the fee, and the pool's own VERIFY has already checked the proof, the root and the
// nullifier by the time this frame runs. The pool credits the fee (`owed`); anyone can
// `claim` it to this contract, and the owner sweeps.
//
// The VERIFY path reads no storage: the pool and the owner are in the code.
//
// initcode = <this object> || pool || owner (32-byte words, appended to the deployed code)
object "PoolSponsor" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 64), 64)
        return(0, add(size, 64))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
                stop()
            }
            // The owner sweeps the balance to the address in calldata. Anything else is a
            // payment (a claim from the pool) and is accepted.
            if and(eq(caller(), word(32)), eq(calldatasize(), 32)) {
                if iszero(call(gas(), calldataload(0), selfbalance(), 0, 0, 0, 0)) { revert(0, 0) }
            }
            stop()

            function validate(me) {
                let pool := word(64)
                if iszero(eq(frameparam(0x06, me), 1)) { revert(0, 0) }   // PAYMENT only
                if iszero(eq(txparam(0x02), pool)) { revert(0, 0) }        // tx.sender is the pool
                let w := sub(txparam(0x09), 1)
                if iszero(eq(frameparam(0x02, w), 2)) { revert(0, 0) }     // SENDER
                if iszero(eq(frameparam(0x00, w), pool)) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, w)), 0x21a0adb6)) { revert(0, 0) }
                if iszero(eq(framedataload(0x84, w), address())) { revert(0, 0) } // relayer
                if lt(framedataload(0xa4, w), txparam(0x06)) { revert(0, 0) }     // fee >= max cost
                approve(1)
            }

            // pool at 64, owner at 32, counted from the end of the code. Scratch at 0x60.
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
