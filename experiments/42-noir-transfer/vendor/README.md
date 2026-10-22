# Vendored from Barretenberg

`poseidon2_params.hpp` is copied unmodified from AztecProtocol/aztec-packages at v5.2.1, commit
`20a398740d3716f09d36154f20e5968a37c05214`, path
`barretenberg/cpp/src/barretenberg/crypto/poseidon2/poseidon2_params.hpp` (Apache-2.0,
Copyright Aztec). Its own header credits the parameters to Markus Schofnegger, Horizen Labs.
`poseidon2-yul.ts` reads the round constants and the internal diagonal from it and writes
`Poseidon2.yul`; the permutation's order of operations follows
`poseidon2_permutation.hpp` at the same commit.
