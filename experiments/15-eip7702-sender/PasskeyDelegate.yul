// PasskeyDelegate: code for an EOA to delegate to with EIP-7702. It keeps the EOA's own key and
// adds a P256 key (a device key, as in experiment 11) that the EOA registers in its own storage.
//
// VERIFY: entry 0, msg ∅, is either SECP256K1 signed by the EOA itself (address()) or P256 signed
// by the registered key. Under delegation the EOA no longer gets the default code, so the EOA key
// has to be checked here too or the EOA locks itself out.
//
// Operations, as SENDER frames the EOA sends to itself (caller == address()):
//   0x01 ‖ p256Address (20)   register a P256 key
//   0x02                      remove it
//
// The P256 key lives at keccak256("exp-frames.15.passkey"): an EOA can change its delegate, and
// the next delegate reads the same storage, so slots are namespaced as ERC-7201 would.
object "PasskeyDelegate" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            let keySlot := 0xb97aba0135d88839e2acc2c053c06647b5ea624a060e06161ef4ca1da63623d5
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame, keySlot) } // mode == VERIFY
                stop()
            }
            if eq(caller(), address()) {
                switch shr(248, calldataload(0))
                case 1 {
                    if iszero(eq(calldatasize(), 21)) { revert(0, 0) }
                    sstore(keySlot, shr(96, calldataload(1)))
                }
                case 2 {
                    if iszero(eq(calldatasize(), 1)) { revert(0, 0) }
                    sstore(keySlot, 0)
                }
                default { revert(0, 0) }
            }
            stop()

            function validate(frame, keySlotArg) {
                if iszero(txparam(0x0b)) { revert(0, 0) }
                if sigparam(0x02, 0) { revert(0, 0) }        // msg empty
                let scheme := sigparam(0x01, 0)
                if iszero(scheme) { revert(0, 0) }           // ARBITRARY has no resolved signer
                let signer := sigparam(0x00, 0)
                switch scheme
                case 1 { if iszero(eq(signer, address())) { revert(0, 0) } }
                case 2 {
                    let key := sload(keySlotArg)
                    if or(iszero(key), iszero(eq(signer, key))) { revert(0, 0) }
                }
                default { revert(0, 0) }
                approve(frameparam(0x06, frame))
            }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
