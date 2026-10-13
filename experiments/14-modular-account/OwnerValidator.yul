// OwnerValidator, run by DELEGATECALL: the owner lives in the account's storage, at a slot
// namespaced to this module (keccak256("exp-frames.14.ecdsa.owner")), as an ERC-7201 layout would.
//   0x01        validate: entry 0 is a protocol scheme, msg ∅, signed by the owner -> returns 1
//   0x02 ‖ owner (20)   install
object "OwnerValidator" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            let slot := 0xa255254051e2c8c518bad8fed7d68df69f4f0c5643b655b7909aa3d1cac57803
            switch shr(248, calldataload(0))
            case 1 {
                if iszero(sigparam(0x01, 0)) { revert(0, 0) }
                if sigparam(0x02, 0) { revert(0, 0) }
                mstore(0, eq(sigparam(0x00, 0), sload(slot)))
                return(0, 32)
            }
            case 2 { sstore(slot, shr(96, calldataload(1))) }
            default { revert(0, 0) }

            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
        }
    }
}
