// CodeProxy: an account whose owner-set commitment is part of its code, so its VERIFY reads no
// storage at all. That is what lets the mempool hold several of its transactions at once on
// disjoint nonce keys. The price: the owner set can never change at this address.
//
// Every call is forwarded to the implementation with the commitment appended.
//
// initcode = <this object> ‖ implementation (32) ‖ commitment (32)
object "CodeProxy" {
    code {
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        codecopy(n, sub(codesize(), 64), 64)
        return(0, add(n, 64))
    }
    object "runtime" {
        code {
            let size := calldatasize()
            calldatacopy(0, 0, size)
            codecopy(size, sub(codesize(), 64), 64) // implementation, then commitment
            let impl := mload(size)
            mstore(size, mload(add(size, 32)))
            let ok := delegatecall(gas(), impl, 0, add(size, 32), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
