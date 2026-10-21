// Experiment 51's mined transactions (2026-10-21), checked from public data alone: neither the
// enclave's secret key nor the attestation key's private half is here, and no bid.
//
// - The outcome contract's initcode is EnclaveOutcome.yul with the verifier and the attestation
//   key's public half; both outputs are rebuilt by outcomeTx, byte for byte.
// - The attestation verifies under that key over the digest the contract rebuilds, with the
//   measurement equal to the SHA-256 of enclave.ts as committed here.
// - The proof verifies against build/enclave.vkey.json for the same statement.
// - The statement's ciphertexts are the two the board logged.
import { readFileSync } from 'node:fs'
import { p256 } from '@noble/curves/p256'
import * as snarkjs from 'snarkjs'
import { type Hex, decodeAbiParameters, decodeFunctionData, getAddress, hexToBytes, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameTxFromJson, frameTxHash } from '../../src/frametx/index.js'
import { board } from '../33-owned-state-swap/swap.js'
import { MEASUREMENT, Route, VKEY, attestationDigest, outcomeAbi, outcomeContract, outcomeTx, verifier } from './outcome.js'

const DEPLOY = '0x30941135e24ee0670dcfb2ba94d15343e6f7d484ba46b396e80969be08abcea5'
const POST = '0x72e0a5cae9fee044d02c319fa06eaf3b4d3d69cbd399c8ed213557df81ff1b8d'
const ATTESTED = '0xe294edcc0ea04cba5846032f6b70ee4fae4b0bb572b174028b4d7a34e4ed7cc2'
const PROVED = '0xd6a2834ce5e9ac8581672507586dc1776ff93b6d411a323ede79767c7a665540'

type Log = { address: Hex; topics: Hex[]; data: Hex }
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { frameReceipts: { logs: Log[] }[] }
  }

/** The attestation key's public half, read from the deployed outcome contract's initcode. */
function deployedOutcome() {
  const mined = frameTxFromJson(fixture(DEPLOY).tx)
  const deploys = mined.frames.filter((f) => f.mode === Mode.SENDER && f.data.length > 2).map((f) => f.data)
  const data = deploys.find((d) => d !== verifier.deploy.data)!
  const qx = slice(data, -64, -32)
  const qy = slice(data, -32)
  return { contract: outcomeContract({ qx, qy }), qx, qy, deploys }
}

function recorded(hash: Hex) {
  const mined = frameTxFromJson(fixture(hash).tx)
  const { args } = decodeFunctionData({ abi: outcomeAbi, data: mined.frames[1].data })
  const [route, measurement, statement, evidence] = args as unknown as [bigint, Hex, readonly bigint[], readonly bigint[]]
  return { mined, route, measurement, statement: [...statement], evidence: [...evidence] }
}

describe('experiment 51, a remote enclave simulated', () => {
  it('deployed the verifier and the outcome contract with an attestation key', () => {
    const { contract, deploys } = deployedOutcome()
    expect(deploys).toContain(verifier.deploy.data)
    expect(deploys).toContain(contract.deploy.data)
  })

  for (const hash of [ATTESTED, PROVED] as Hex[]) {
    it(`rebuilds ${hash.slice(0, 10)} byte for byte`, () => {
      const { contract } = deployedOutcome()
      const r = recorded(hash)
      const rebuilt = outcomeTx({ chainId: r.mined.chainId, contract, route: r.route, measurement: r.measurement, statement: r.statement, evidence: r.evidence })
      expect(frameTxHash(rebuilt)).toBe(hash)
      expect(r.mined.sender).toBe(contract.address)
    })
  }

  it("verifies the attestation under the contract's key, for this enclave.ts's measurement", () => {
    const { qx, qy } = deployedOutcome()
    const a = recorded(ATTESTED)
    expect(a.route).toBe(Route.ATTESTED)
    expect(a.measurement).toBe(MEASUREMENT)
    const [r, s] = a.evidence
    expect(s <= p256.CURVE.n / 2n).toBe(true)
    const pub = hexToBytes(`0x04${qx.slice(2)}${qy.slice(2)}`)
    expect(p256.verify({ r, s } as never, hexToBytes(attestationDigest(a.measurement, a.statement)), pub, { prehash: false })).toBe(true)
  })

  it('verifies the proof against the enclave circuit key, for the same statement', async () => {
    const a = recorded(ATTESTED)
    const b = recorded(PROVED)
    expect(b.route).toBe(Route.PROVED)
    expect(b.statement).toEqual(a.statement)
    expect(b.statement[8]).toBe(1n)
    const p = b.evidence.map(String)
    const proof = { pi_a: [p[0], p[1], '1'], pi_b: [[p[3], p[2]], [p[5], p[4]], ['1', '0']], pi_c: [p[6], p[7], '1'], protocol: 'groth16', curve: 'bn128' }
    expect(await snarkjs.groth16.verify(VKEY, b.statement.map(String), proof)).toBe(true)
    const flipped = [...b.statement.slice(0, 8), 0n].map(String)
    expect(await snarkjs.groth16.verify(VKEY, flipped, proof)).toBe(false)
  })

  it('took its ciphertexts from the two the board logged', () => {
    const { receipt } = fixture(POST)
    const posted = receipt.frameReceipts.flatMap((f) => f.logs).filter((l) => getAddress(l.address) === board.address)
    expect(posted).toHaveLength(2)
    const cts = posted.map((l) => {
      const [message] = decodeAbiParameters([{ type: 'bytes' }], l.data)
      return [...decodeAbiParameters([{ type: 'uint256[3]' }], message)[0]]
    })
    expect(recorded(PROVED).statement.slice(2, 8)).toEqual(cts.flat())
  })
})
