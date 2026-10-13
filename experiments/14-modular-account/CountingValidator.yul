// CountingValidator, run by DELEGATECALL: OwnerValidator plus a use counter it increments while
// validating, as a 4337 validator may (ERC-7562 lets validation write the sender's storage).
// It shares OwnerValidator's owner slot, so installing it needs no init data of its own.
//   0x01        validate: the owner check, then counter += 1 -> returns 1
//   0x02 ‖ ...  install: nothing to do
object "CountingValidator" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            let owner := 0xa255254051e2c8c518bad8fed7d68df69f4f0c5643b655b7909aa3d1cac57803
            let counter := 0x8dfbabcfe900012036810639f4df6abe8ec1ac3de9f732f3cab5b85bb8a90eb4
            switch shr(248, calldataload(0))
            case 1 {
                if iszero(sigparam(0x01, 0)) { revert(0, 0) }
                if sigparam(0x02, 0) { revert(0, 0) }
                if iszero(eq(sigparam(0x00, 0), sload(owner))) { revert(0, 0) }
                sstore(counter, add(sload(counter), 1))
                mstore(0, 1)
                return(0, 32)
            }
            case 2 { }
            default { revert(0, 0) }

            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
        }
    }
}
