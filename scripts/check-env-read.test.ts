import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { secretRead } from './check-env-read.mjs'
import { tempDirs } from './hook-test-support'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-env-read.mjs')
const tempDir = tempDirs()

// Two scratch projects: `withSecret` holds a (dummy) secret env file at its
// top level the way a checkout does; `templateOnly` holds only a template and
// a `.env/` directory (a python venv's usual name).
const mkProject = (prefix: string, files: Record<string, string>) => {
  const dir = tempDir(prefix)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}
const withSecret = mkProject('env-read-secret-', { '.env.local': 'DUMMY=1\n', '.env.example': 'DUMMY=\n', 'src/a.ts': 'x\n' })
const templateOnly = mkProject('env-read-template-', { '.env.example': 'DUMMY=\n', '.env/pyvenv.cfg': 'x\n', 'src/a.ts': 'x\n' })

describe('secretRead', () => {
  it.each([
    // a reader verb with a secret path argument
    `grep -c '^VAR=' .env.local`,
    `grep -E '^VITE_X=' .env.local`,
    `sed 's/=.*/=<redacted>/' .env.local`,
    `awk -F= '{print $1}' .env.local`,
    'cat .envrc',
    'cat .env',
    'head -5 ./config/.env.production',
    'cat .ENV.LOCAL',
    'cat .env.example.local',
    'cat .env.local.backup-1',
    'source .env.local && psql',
    '. ./.env',
    'diff .env.local .env.example',
    // a reader nested in shell syntax
    'echo $(cat .env)',
    'echo "$(cat .env.local)"',
    'echo `cat .env.local`',
    'diff <(cat .env.local) x',
    `awk -F= '{n=length($2); print $1"="n}' .env.local`,
    `bash -c 'cat .env.local'`,
    `sh -lc "grep KEY .env.local"`,
    `eval 'cat .env.local'`,
    'if grep -q KEY .env.local; then echo set; fi',
    'for f in a; do cat .env.local; done',
    // input redirected from a secret file
    'cat < .env',
    `while read -r l; do echo "$l"; done < .env.local`,
  ])('blocks %s', command => {
    expect(secretRead(command, templateOnly)).not.toBeNull()
  })

  it.each([
    'cat .env.example',
    'cat config/.env.sample',
    // commands that only name the file
    'git commit -m "fix .env loading"',
    'echo .env',
    'ls -la .env*',
    'test -f .env.local && echo yes',
    'cp .env.example .env.local',
    'node --env-file=.env.local script.mjs',
    // a search PATTERN that mentions it
    `grep -rn ".env" src/`,
    `awk '/\\.env\\.local/' notes.txt`,
    // literal heredoc data nothing runs
    "git commit -F - <<'EOF'\ncat .env.local is blocked now\nEOF",
    'echo "a < .env.local"',
  ])('allows %s', command => {
    expect(secretRead(command, templateOnly)).toBeNull()
  })

  describe('recursive search', () => {
    it.each([
      'grep -r FOO .',
      'grep -rn FOO',
      'grep -R --line-number FOO ./',
      'grep --recursive FOO .',
      'egrep -rl FOO .',
      `grep -d recurse FOO .`,
      'grep --dereference-recursive FOO .',
      'grep --directories=recurse FOO .',
      'rg -uu FOO .',
      'rg --hidden --no-ignore FOO',
      'rg -u --hidden FOO .',
      'rg --unrestricted --unrestricted FOO .',
      'rg -. --no-ignore-vcs FOO .',
    ])('blocks %s over a directory holding a secret file', command => {
      expect(secretRead(command, withSecret)).toEqual({ file: expect.stringMatching(/\.env\.local$/), walked: true })
    })

    it('checks an explicit search root', () => {
      expect(secretRead(`grep -rn FOO ${withSecret}`, templateOnly)).not.toBeNull()
    })

    it('follows a leading cd to the directory searched', () => {
      expect(secretRead(`cd ${withSecret} && grep -rn FOO .`, templateOnly)).not.toBeNull()
      vi.stubEnv('HOME', withSecret)
      onTestFinished(() => {
        vi.unstubAllEnvs()
      })
      expect(secretRead('cd ~ && grep -rn FOO .', templateOnly)).not.toBeNull()
      expect(secretRead('cd && grep -rn FOO .', templateOnly)).not.toBeNull()
    })

    it('ignores a cd it cannot follow out of the shell it runs in', () => {
      expect(secretRead('(cd src && ls); grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('cd "$NOPE" && grep -rn FOO .', withSecret)).not.toBeNull()
    })

    it.each([
      'grep -rn FOO src',
      'grep FOO .',
      'rg FOO .',
      'rg --hidden FOO .',
      'rg --no-ignore FOO .',
      `rg -r '$1' FOO .`,
      'git grep FOO',
    ])('allows %s', command => {
      expect(secretRead(command, withSecret)).toBeNull()
    })

    it('allows a recursive search where only a template sits', () => {
      expect(secretRead('grep -rn FOO .', templateOnly)).toBeNull()
    })
  })
})

describe('check-env-read hook', () => {
  const hook = (input: string) => spawnSync('node', [script], { cwd: withSecret, input, encoding: 'utf8' })
  const payload = (command: string) => JSON.stringify({ tool_name: 'Bash', cwd: withSecret, tool_input: { command } })

  it('blocks a read with exit 2, naming the file and the opt-out', () => {
    const r = hook(payload('cat .env.local'))
    expect(r.status, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/\.env\.local/)
    expect(r.stderr).toMatch(/READ_ENV_OK=1/)
  })

  it('lets a READ_ENV_OK=1 read through', () => {
    expect(hook(payload('READ_ENV_OK=1 cat .env.local')).status).toBe(0)
  })

  it('lets an unparseable payload through', () => {
    expect(hook('not json').status).toBe(0)
  })
})
