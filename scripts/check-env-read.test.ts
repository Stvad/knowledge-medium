import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { inputRedirectTargets } from './shell-segments.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-env-read.mjs')

// Two scratch projects: `withSecret` holds a (dummy) secret env file at its
// top level the way a checkout does; `templateOnly` holds only a template and
// a `.env/` directory (a python venv's usual name).
const mkProject = (name: string, files: Record<string, string>) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}
const withSecret = mkProject('env-read-secret-', { '.env.local': 'DUMMY=1\n', '.env.example': 'DUMMY=\n', 'src/a.ts': 'x\n' })
const templateOnly = mkProject('env-read-template-', { '.env.example': 'DUMMY=\n', '.env/pyvenv.cfg': 'x\n', 'src/a.ts': 'x\n' })
afterAll(() => {
  rmSync(withSecret, { recursive: true, force: true })
  rmSync(templateOnly, { recursive: true, force: true })
})

const hook = (command: string, cwd = templateOnly, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync('node', [script], {
    cwd,
    env,
    input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
    encoding: 'utf8',
  })

describe('check-env-read hook', () => {
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
    'cat<.env.local',
    'x=$(<.env.local)',
    `while read -r l; do echo "$l"; done < .env.local`,
  ])('blocks %s', command => {
    const r = hook(command)
    expect(r.status, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/READ_ENV_OK=1/)
  })

  it.each([
    'READ_ENV_OK=1 cat .env.local',
    `READ_ENV_OK=1 grep -c '^VAR=' .env.local`,
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
    const r = hook(command)
    expect(r.status, r.stderr).toBe(0)
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
      'grep -drecurse FOO .',
      'rg -uu FOO .',
      'rg --hidden --no-ignore FOO',
      'rg -u --hidden FOO .',
      'rg --unrestricted --unrestricted FOO .',
      'rg -. --no-ignore-vcs FOO .',
    ])('blocks %s over a directory holding a secret file', command => {
      const r = hook(command, withSecret)
      expect(r.status, r.stderr).toBe(2)
      expect(r.stderr).toMatch(/\.env\.local/)
    })

    it('follows a leading cd to the directory searched', () => {
      expect(hook(`cd ${withSecret} && grep -rn FOO .`).status).toBe(2)
      expect(hook(`grep -rn FOO ${withSecret}`).status).toBe(2)
      const home = { ...process.env, HOME: withSecret }
      expect(hook('cd ~ && grep -rn FOO .', templateOnly, home).status).toBe(2)
      expect(hook('cd && grep -rn FOO .', templateOnly, home).status).toBe(2)
    })

    it('ignores a cd it cannot follow out of the shell it runs in', () => {
      expect(hook('(cd src && ls); grep -rn FOO .', withSecret).status).toBe(2)
      expect(hook('cd "$NOPE" && grep -rn FOO .', withSecret).status).toBe(2)
    })

    it.each([
      'grep -rn FOO src',
      'grep FOO .',
      'rg FOO .',
      'rg --hidden FOO .',
      'rg --no-ignore FOO .',
      `rg -r '$1' FOO .`,
      'git grep FOO',
      'READ_ENV_OK=1 grep -rn FOO .',
    ])('allows %s', command => {
      const r = hook(command, withSecret)
      expect(r.status, r.stderr).toBe(0)
    })

    it('allows a recursive search where only a template sits', () => {
      expect(hook('grep -rn FOO .', templateOnly).status).toBe(0)
    })
  })

  it('lets an unparseable payload through', () => {
    expect(spawnSync('node', [script], { input: 'not json', encoding: 'utf8' }).status).toBe(0)
  })
})

describe('inputRedirectTargets', () => {
  it.each([
    ['cat < a', ['a']],
    ['cat<a', ['a']],
    ['sort 0< a', ['a']],
    ['x=$(<a)', ['a']],
    ['make 2>&1 < in > out', ['in']],
    ["bash <<'EOF'\nsort < a\nEOF", ['a']],
    ['echo "a < b"', []],
    ['cat <<< word', []],
    ['cat <<EOF\nx\nEOF', []],
    ["cat <<'EOF'\nsort < a\nEOF", []],
    ['cat <&3', []],
    ['echo x >out 2>err', []],
  ])('%s → %j', (cmd, targets) => {
    expect(inputRedirectTargets(cmd)).toEqual(targets)
  })
})
