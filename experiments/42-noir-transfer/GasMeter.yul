// GasMeter: initcode run by `eth_call` without a target, so nothing is deployed. It calls a
// precompile once with the input appended to it, and returns the gas the call took and whether
// it succeeded: (gas used, success), two words.
//
// The gas used includes the STATICCALL's own cost (a precompile is warm, 100 gas) and the two GAS
// readings around it.
//
// initcode = <this object> || input || len(input) (32) || target (32)
object "GasMeter" {
    code {
        let target := word(32)
        let len := word(64)
        let start := sub(sub(codesize(), 64), len)
        codecopy(0x40, start, len)
        let before := gas()
        let ok := staticcall(gas(), target, 0x40, len, 0x40, 0x20)
        let after := gas()
        mstore(0, sub(before, after))
        mstore(0x20, ok)
        return(0, 0x40)

        function word(fromEnd) -> v {
            codecopy(0, sub(codesize(), fromEnd), 32)
            v := mload(0)
        }
    }
}
