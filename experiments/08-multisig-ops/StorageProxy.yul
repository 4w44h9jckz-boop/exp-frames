// StorageProxy: an account whose owner-set commitment lives in slot 0, so the owners can rotate
// it (MultisigImpl op 0x01, from a SENDER frame the current owners approved). The price: its
// VERIFY reads sender storage, and the mempool then holds one of its transactions at a time.
//
// The constructor writes slot 0. A deploy frame may write tx.sender's storage, so the account can
// still deploy itself in its first transaction.
//
// initcode = <this object> ‖ implementation (32) ‖ commitment (32)
object "StorageProxy" {
    code {
        codecopy(0, sub(codesize(), 32), 32)
        sstore(0, mload(0))
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        codecopy(n, sub(codesize(), 64), 32)
        return(0, add(n, 32))
    }
    object "runtime" {
        code {
            let size := calldatasize()
            calldatacopy(0, 0, size)
            codecopy(size, sub(codesize(), 32), 32) // implementation
            let impl := mload(size)
            mstore(size, sload(0))
            let ok := delegatecall(gas(), impl, 0, add(size, 32), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
