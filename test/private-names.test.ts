// The owner's private repositories are not named here: scripts/check_private_names.py holds the
// names only as SHA-256 hashes and fails on a match.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('names no private repository', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  expect(() => execFileSync('python3', ['scripts/check_private_names.py'], { cwd: root, stdio: 'pipe' })).not.toThrow()
})
