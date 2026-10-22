// Experiment 42: Groth16 for the transfer, with Reilabs' Sunspot and gnark, both unmodified.
//
//	g16tool prove <transfer.json> <transfer.gz> <transfer.ccs> <transfer.pk> <transfer.proof> <transfer.pw>
//	g16tool export <transfer.vk> <transfer.proof> <transfer.pw> <Verifier.sol> <calldata.json>
//
// prove is Sunspot's own `prove` (its ACIR loader and witness, gnark's prover) with one prover
// option added: gnark's Solidity verifier hashes the commitment to a field with Keccak256, and
// cannot check gnark's default, RFC 9380's hash-to-field, which Sunspot's CLI proves with.
// export writes gnark's Solidity verifier for the verifying key, and the proof and public inputs
// as that verifier takes them.
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/consensys/gnark-crypto/ecc"
	ecc_bn254 "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	groth16 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/backend"
	gnark_groth16 "github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/backend/solidity"
	"github.com/consensys/gnark/constraint"
	"github.com/reilabs/sunspot/go/acir"
	sunspot_bn254 "github.com/reilabs/sunspot/go/bn254"
	"github.com/consensys/gnark/backend/witness"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func word(b []byte) string { return "0x" + hex.EncodeToString(b) }

func main() {
	switch {
	case len(os.Args) == 8 && os.Args[1] == "prove":
		prove(os.Args[2:])
	case len(os.Args) == 7 && os.Args[1] == "export":
		export(os.Args[2:])
	default:
		fmt.Fprintln(os.Stderr, "usage: g16tool prove <acir.json> <witness.gz> <ccs> <pk> <proof> <pw>\n       g16tool export <vk> <proof> <pw> <Verifier.sol> <calldata.json>")
		os.Exit(2)
	}
}

func prove(args []string) {
	program, err := acir.LoadACIR[*sunspot_bn254.BN254Field, constraint.U64](args[0])
	must(err)
	full, err := program.GetWitness(args[1], ecc_bn254.ID.ScalarField())
	must(err)
	ccs := gnark_groth16.NewCS(ecc.BN254)
	f, err := os.Open(args[2])
	must(err)
	_, err = ccs.ReadFrom(f)
	must(err)
	pk := gnark_groth16.NewProvingKey(ecc.BN254)
	f, err = os.Open(args[3])
	must(err)
	_, err = pk.ReadFrom(f)
	must(err)
	proof, err := gnark_groth16.Prove(ccs, pk, full, solidity.WithProverTargetSolidityVerifier(backend.GROTH16))
	must(err)
	out, err := os.Create(args[4])
	must(err)
	_, err = proof.WriteRawTo(out)
	must(err)
	must(out.Close())
	public, err := full.Public()
	must(err)
	out, err = os.Create(args[5])
	must(err)
	_, err = public.WriteTo(out)
	must(err)
	must(out.Close())
}

func export(args []string) {
	var vk groth16.VerifyingKey
	f, err := os.Open(args[0])
	must(err)
	_, err = vk.ReadFrom(f)
	must(err)

	var proof groth16.Proof
	f, err = os.Open(args[1])
	must(err)
	_, err = proof.ReadFrom(f)
	must(err)

	pw, err := witness.New(ecc.BN254.ScalarField())
	must(err)
	f, err = os.Open(args[2])
	must(err)
	_, err = pw.ReadFrom(f)
	must(err)
	public := pw.Vector().(fr.Vector)

	// The proof must verify natively, with the hash the Solidity verifier uses.
	must(groth16.Verify(&proof, &vk, public, solidity.WithVerifierTargetSolidityVerifier(backend.GROTH16)))

	out, err := os.Create(args[3])
	must(err)
	must(vk.ExportSolidity(out))
	must(out.Close())

	// MarshalSolidity: Ar | Bs | Krs (8 words), then a 4-byte count, the commitments and their
	// proof of knowledge, two words each, as gnark's own Solidity tests read it.
	raw := proof.MarshalSolidity()
	words := func(b []byte) []string {
		var ws []string
		for i := 0; i+32 <= len(b); i += 32 {
			ws = append(ws, word(b[i:i+32]))
		}
		return ws
	}
	result := map[string]any{
		"proof":       words(raw[:256]),
		"commitments": len(proof.Commitments),
		"inputs":      []string{},
	}
	if len(proof.Commitments) > 0 {
		result["commitmentsWords"] = words(raw[260 : 260+64*len(proof.Commitments)])
		result["commitmentPok"] = words(raw[260+64*len(proof.Commitments):])
	}
	var inputs []string
	for _, x := range public {
		b := x.Bytes()
		inputs = append(inputs, word(b[:]))
	}
	result["inputs"] = inputs
	j, err := json.MarshalIndent(result, "", "  ")
	must(err)
	must(os.WriteFile(args[4], append(j, '\n'), 0o644))
}
