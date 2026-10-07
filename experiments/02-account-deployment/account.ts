import { type Address, type Hex, concatHex, encodeAbiParameters } from 'viem'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { type Frame, Mode } from '../../src/frametx/index.js'

export const ACCOUNT_CODE = compileYul('experiments/02-account-deployment/SimpleAccount.yul')

/** Counterfactual SimpleAccount for `owner`: initcode, address and the DEFAULT deploy frame. */
export function simpleAccount(owner: Address, label = 'exp-frames/simple-account/v1') {
  const initcode: Hex = concatHex([ACCOUNT_CODE, encodeAbiParameters([{ type: 'address' }], [owner])])
  const salt = saltOf(label)
  const { frame } = deployFrame(initcode, salt)
  // Example 1b runs the deployment in a DEFAULT frame (caller = ENTRY_POINT), before
  // the sender is authenticated. The execution budget is kept small so the validation
  // prefix (deploy + verify + signature) fits the spec's MAX_VERIFY_GAS of 100,000.
  const deploy: Frame = { ...frame, mode: Mode.DEFAULT, limits: { execution: 80_000n, state: frame.limits.state } }
  return { initcode, salt, address: create2Address(initcode, salt), deploy }
}
