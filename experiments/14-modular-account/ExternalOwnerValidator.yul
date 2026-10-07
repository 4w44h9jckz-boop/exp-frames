// ExternalOwnerValidator, run by CALL/STATICCALL: the owner lives in this module's storage, keyed
// by the account (storage[caller()]). This is how ERC-7579 validators usually keep their
// configuration, and ERC-7562 lets a 4337 bundler accept it as storage associated with the sender.
//   0x01        validate: entry 0 is a protocol scheme, msg ∅, signed by owner[caller] -> returns 1
//   0x02 ‖ owner (20)   install, for the calling account
object "ExternalOwnerValidator" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            switch shr(248, calldataload(0))
            case 1 {
                if iszero(sigparam(0x01, 0)) { revert(0, 0) }
                if sigparam(0x02, 0) { revert(0, 0) }
                mstore(0, eq(sigparam(0x00, 0), sload(caller())))
                return(0, 32)
            }
            case 2 { sstore(caller(), shr(96, calldataload(1))) }
            default { revert(0, 0) }

            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
        }
    }
}
