// The default path of pool.ts stays what experiment 42 recorded: --send only adds a mode.
import { describe, expect, it } from 'vitest'
import { parseArgs } from './args.js'

describe("experiment 42's command line", () => {
  it('keeps the recorded modes', () => {
    expect(parseArgs([])).toEqual({ mode: 'default' })
    expect(parseArgs(['--dry-run'])).toEqual({ mode: 'default' })
    expect(parseArgs(['--rust'])).toEqual({ mode: 'rust' })
    expect(parseArgs(['--groth16'])).toEqual({ mode: 'groth16' })
    expect(parseArgs(['--groth16', '--dry-run'])).toEqual({ mode: 'groth16' })
  })

  it('sends only with --groth16, to an http(s) URL', () => {
    expect(parseArgs(['--groth16', '--send', 'http://127.0.0.1:14337/rpc/'], () => 7)).toEqual({
      mode: 'groth16-send',
      url: 'http://127.0.0.1:14337/rpc/',
      label: 'groth16-send-7',
      out: null,
    })
    expect(parseArgs(['--groth16', '--send', 'https://n', '--label', 'x5', '--out', 'r.json'])).toEqual({
      mode: 'groth16-send',
      url: 'https://n',
      label: 'x5',
      out: 'r.json',
    })
    expect(() => parseArgs(['--send', 'http://n'])).toThrow(/with --groth16/)
    expect(() => parseArgs(['--rust', '--send', 'http://n'])).toThrow(/with --groth16/)
    expect(() => parseArgs(['--groth16', '--send'])).toThrow(/needs a value/)
    expect(() => parseArgs(['--groth16', '--send', 'n'])).toThrow(/not an http/)
  })
})
