// ModularAccount: an account that keeps no validation logic of its own. Validators are modules,
// in the shape of ERC-7579, and a transaction names the one that should judge it.
//
//   VERIFY frame data = module (20) ‖ module data
//   storage[module]   = 1 (run by DELEGATECALL: the module's code, the account's storage)
//                       2 (run by STATICCALL: the module's code and the module's storage)
//
// VERIFY calls the module with 0x01 ‖ module data and APPROVEs the frame's scope if it returns
// the word 1. The module reads the signature list itself; SIGPARAM is transaction-scoped and works
// at any call depth.
//
// Operations, as SENDER frames the account sends to itself:
//   0x01 ‖ module (20) ‖ kind (1) ‖ init data   install; the module gets 0x02 ‖ init data
//   0x02 ‖ module (20)                          uninstall
//
// initcode = <this object> ‖ module (32) ‖ kind (32) ‖ init data (32, the owner)
object "ModularAccount" {
    code {
        let args := sub(codesize(), 96)
        codecopy(0, args, 96)
        let module := mload(0)
        let kind := mload(32)
        sstore(module, kind)
        // 0x02 ‖ owner (20)
        mstore8(0, 2)
        mstore(1, shl(96, mload(64)))
        let ok := 0
        switch kind
        case 1 { ok := delegatecall(gas(), module, 0, 21, 0, 0) }
        default { ok := call(gas(), module, 0, 0, 21, 0, 0) }
        if iszero(ok) { revert(0, 0) }
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
            if eq(caller(), address()) { operate() }
            stop()

            function validate(frame) {
                let len := frameparam(0x04, frame)
                if lt(len, 20) { fail() }
                let module := shr(96, framedataload(frame, 0))
                let kind := sload(module)
                mstore8(0, 1)
                framedatacopy(1, 20, sub(len, 20), frame)
                let ok := 0
                switch kind
                case 1 { ok := delegatecall(gas(), module, 0, sub(len, 19), 0, 32) }
                case 2 { ok := staticcall(gas(), module, 0, sub(len, 19), 0, 32) }
                default { fail() }
                if iszero(ok) { fail() }
                if iszero(eq(returndatasize(), 32)) { fail() }
                if iszero(eq(mload(0), 1)) { fail() }
                approve(frameparam(0x06, frame))
            }

            function operate() {
                switch shr(248, calldataload(0))
                case 1 {
                    let module := shr(96, calldataload(1))
                    let kind := byte(0, calldataload(21))
                    if or(iszero(kind), gt(kind, 2)) { fail() }
                    sstore(module, kind)
                    let n := sub(calldatasize(), 22)
                    mstore8(0, 2)
                    calldatacopy(1, 22, n)
                    let ok := 0
                    switch kind
                    case 1 { ok := delegatecall(gas(), module, 0, add(n, 1), 0, 0) }
                    default { ok := call(gas(), module, 0, 0, add(n, 1), 0, 0) }
                    if iszero(ok) { fail() }
                }
                case 2 {
                    if iszero(eq(calldatasize(), 21)) { fail() }
                    sstore(shr(96, calldataload(1)), 0)
                }
                default { fail() }
            }

            function fail() { revert(0, 0) }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function framedataload(frame, offset) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
