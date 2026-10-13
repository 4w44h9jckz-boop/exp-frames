import { describe, expect, it } from 'vitest'
import { compileSolidity, compileYul } from '../src/contracts.js'

describe('contract compilation', () => {
  it('emits verbatim arguments so the first one is on top of the stack', () => {
    // PUSH1 0x33 PUSH1 0x22 PUSH1 0x11 APPROVE → offset=0x11, length=0x22, scope=0x33
    expect(compileYul('test/fixtures/yul/verbatim.yul').startsWith('0x603360226011aa')).toBe(true)
  })

  it('compiles the shared test token', () => {
    const token = compileSolidity('contracts/TestToken.sol', 'TestToken')
    expect(token.abi.some((x) => x.type === 'function' && x.name === 'transferFrom')).toBe(true)
    expect(token.bytecode.length).toBeGreaterThan(100)
  })
})
