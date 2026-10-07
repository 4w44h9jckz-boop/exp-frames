// Helper: a contract the probes call from VERIFY. With empty calldata it returns SLOAD(0), which
// reads its own storage when called and the caller's when DELEGATECALLed; with any calldata it
// returns 1 without touching storage.
object "Helper" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            if iszero(calldatasize()) {
                mstore(0, sload(0))
                return(0, 32)
            }
            mstore(0, 1)
            return(0, 32)
        }
    }
}
