import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
    'cat {.env.example,.env.local}',
    'env -i cat .env.local',
    // after --, the first operand is still the pattern
    'grep -- -K .env.local',
    // a search whose pattern comes from a flag, so its first operand is a file
    'grep --regexp=K .env.local',
    'grep -eK .env.local',
    // a file an option reads
    'diff --from-file=.env.local x',
    'grep -f .env.local X src',
    `sed -e's/=.*//' .env.local`,
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
    `bash -c -- 'cat .env.local'`,
    `bash -c -o pipefail 'cat .env.local'`,
    `bash -c -O extglob 'cat .env.local'`,
    `bash -eoc pipefail 'cat .env.local'`,
    `eval 'cat .env.local'`,
    'if grep -q KEY .env.local; then echo set; fi',
    'for f in a; do cat .env.local; done',
    // input redirected from a secret file
    'cat < .env',
    `while read -r l; do echo "$l"; done < .env.local`,
    `cat <".env.local"`,
    `while read -r l; do :; done <'.env.local'`,
    `x=$(<".env.local")`,
    'cat <\\.env.local',
    // a read-write redirection reads too
    `cat <>".env.local"`,
    'cat <>.env.local',
    'wc 0<> .env.local',
    // unquoted heredoc data is expanded with its quotes and comments as text
    "cat <<EOF\n'$(cat .env.local)'\nEOF",
    'cat <<EOF\n# $(cat .env.local)\nEOF',
    // a read after a literal heredoc
    "cat > x.md <<'EOF'\nnote\nEOF\nls && cat .env.local",
    `gh pr create --body "$(cat <<'EOF'\nbody\nEOF\n)" && cat .env.local`,
    "cat > x.md <<'EOF'\nnote\nEOF\nwhile read l; do :; done < .env.local",
    "cat > q.sql <<'SQL'\nselect 1;\nSQL\nset -a; . ./.env.local; set +a",
    "cat <$'.env.local'",
    // an option this does not model is checked whole
    'sort --files0-from=.env.local',
    // a pattern read from a file leaves no positional pattern
    'grep -f pats .env.local',
    // an option whose value is optional or absent in some implementation takes no word
    'grep -C KEY .env.local',
    "sed -l 's/x/y/' .env.local",
    // a quoted here-string ahead of the command word is not the command
    '<<<"x" cat .env.local',
    'git --git-dir /tmp/g diff --no-index a .env.local',
    // a lone - is an operand, here the pattern
    'grep - .env.local',
    'rg - .env.local',
    // git's readers of files it does not track; a path outside the repo implies --no-index
    'git diff /dev/null .env.local',
    'git -c core.pager=cat diff --no-index a .env.local',
    'git diff --no-index .env.example .env.local',
    'git -C config diff --no-index a .env.production',
    // readers past the coreutils
    "gawk '{print}' .env.local",
    'zgrep KEY .env.local',
    'jq . .env.local',
    // jq's --rawfile and --slurpfile read the file they name
    "jq -n --rawfile s .env.local '$s'",
    "jq -n --slurpfile s .env.local --arg x y '$s'",
  ])('blocks %s', command => {
    expect(secretRead(command, templateOnly)).not.toBeNull()
  })

  it.each([
    // jq's --arg and --argjson take a name and a value, not a file
    "jq -n --arg config .env.local '{path: $config}'",
    "jq -n --argjson n 1 --arg f .env.local '$f'",
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
    `grep --files-with-matches ".env" src/`,
    `awk '/\\.env\\.local/' notes.txt`,
    // literal heredoc data nothing runs
    "git commit -F - <<'EOF'\ncat .env.local is blocked now\nEOF",
    "cat > x.md <<'EOF'\nnote\nEOF\ngrep -n 'cat .env.local' notes.md",
    "S=/tmp; cat > $S/notes.md <<'EOF'\ncat .env.local is blocked now\nEOF",
    'echo "a < .env.local"',
    // an option value that names it
    'diff -r --exclude=.env.local a b',
    'diff -r -x .env.local a b',
    'diff -r --exclude .env.local a b',
    `grep -rn -e '.env.local' src`,
    // an option's value is not the pattern, so the pattern is not read as a file
    `grep -rn -A 3 '.env.local' scripts`,
    `rg -A 3 '.env.local' docs`,
    `rg -t ts '\\.env' src`,
    `rg -g '*.ts' '.env.local' src`,
    `awk -F : '/\\.env\\.local/' notes.txt`,
    `awk -v n=1 '/\\.env/' f`,
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
      'grep --directories recurse FOO .',
      'grep -drecurse FOO .',
      'rg -uu FOO .',
      'rg --hidden --no-ignore FOO',
      'rg -u --hidden FOO .',
      'rg --unrestricted --unrestricted FOO .',
      'rg -. --no-ignore-vcs FOO .',
      'grep -rnA3 FOO .',
      'rg -uuC3 FOO .',
      `grep -r --include='*.local' FOO .`,
      "cat > x.md <<'EOF'\nnote\nEOF\ngrep -rn FOO .",
      "cat > x.md <<'EOF'\ncd src\nEOF\ngrep -rn FOO .",
      `grep -r --include='.env.loca?' FOO .`,
      // the last matching filter wins
      `grep -r --exclude='*' --include='.env.local' FOO .`,
      // a glob beyond * and ? is not modelled, so it filters nothing
      `grep -r --exclude='[.]env*' FOO .`,
      `grep -r --include='!*.ts' FOO .`,
      // --exclude-dir filters directories, not the files at the top
      `grep -r --exclude-dir='.env*' FOO .`,
      // with no operand naming a path, the search runs at .
      'grep -r -e FOO',
      'grep -r -e src',
      'grep -rA 3 FOO',
      'grep -r -f pats.txt',
      // which --no-ignore* drops the rule hiding a secret depends on where it lives
      'rg --hidden --no-ignore-parent FOO .',
      // an rg glob that admits a name reads it past the hidden and ignore rules
      `rg -n -g '.env*' FOO .`,
      `rg -g '*.local' FOO`,
      `rg --glob '.env*' FOO .`,
      `rg --iglob '.ENV*' FOO .`,
      `rg --glob-case-insensitive -g '.ENV*' FOO .`,
      // its --no- form may be the value of an option the hook does not model
      `rg --glob-case-insensitive --context-separator --no-glob-case-insensitive -g '.ENV*' FOO .`,
      `rg -g '{*.ts,.env*}' FOO .`,
      // rg's globs are paths from the search root, where **/ may match no directory
      `rg -g '**/.env*' FOO .`,
      `rg -g '/.env*' FOO .`,
      `rg -g '{src/**,.env*}' FOO .`,
      // ** spans directories only as a whole segment; a trailing / names directories
      `rg -uu -g '!.env.local**/' FOO .`,
      `rg -uu -g '!.env.lo**/cal' FOO .`,
      // a brace alternative starts a segment too
      `rg -g '{x,**/.env*}' FOO .`,
      `rg -uu -g '{**/.env*,x}' FOO .`,
      // a ! glob only excludes, so what it leaves follows the hidden and ignore rules
      `rg -uu -g '!*.ts' FOO .`,
      // an unbalanced brace is not modelled, so it filters nothing
      `rg -g '{.env*' FOO .`,
      'git grep --no-index FOO',
      'git grep --untracked --no-exclude-standard FOO',
      'ag -u FOO',
      'ag --hidden -U FOO .',
      // the last of --exclude-standard and --no-exclude-standard wins
      'git grep --no-index --exclude-standard --no-exclude-standard FOO',
      'ugrep -r FOO .',
      // grep's -NUM is a context length; flags after it still count
      'grep -2r FOO .',
      'grep -2R FOO .',
      // a long flag counts only as an option, not as another option's value
      'rg -e --files -uu FOO .',
      'rg --context-separator --files -uu FOO .',
      'rg --hyperlink-format --files -uu FOO .',
    ])('blocks %s over a directory holding a secret file', command => {
      expect(secretRead(command, withSecret)).toEqual({ file: expect.stringMatching(/\.env\.local$/), walked: true })
    })

    it('checks an explicit search root', () => {
      expect(secretRead(`grep -rn FOO ${withSecret}`, templateOnly)).not.toBeNull()
      expect(secretRead(`git -C ${withSecret} grep --no-index FOO`, templateOnly)).not.toBeNull()
      // an explicit work tree is what git grep searches
      expect(secretRead(`git --git-dir=${withSecret}/.git --work-tree=${withSecret} grep --untracked --no-exclude-standard FOO`, templateOnly)).not.toBeNull()
      expect(secretRead(`GIT_WORK_TREE=${withSecret} git grep --untracked --no-exclude-standard FOO`, templateOnly)).not.toBeNull()
      expect(secretRead(`env GIT_WORK_TREE=${withSecret} git grep --untracked --no-exclude-standard FOO`, templateOnly)).not.toBeNull()
      // --no-index searches the current directory, whatever the work tree
      expect(secretRead(`git --work-tree ${withSecret} grep --no-index FOO`, templateOnly)).toBeNull()
      expect(secretRead(`git --work-tree /tmp grep --no-index FOO`, withSecret)).not.toBeNull()
      vi.stubEnv('HOME', withSecret)
      onTestFinished(() => {
        vi.unstubAllEnvs()
      })
      expect(secretRead('GIT_WORK_TREE=~ git grep --untracked --no-exclude-standard FOO', templateOnly)).not.toBeNull()
      expect(secretRead('git --work-tree=~ grep --untracked --no-exclude-standard FOO', templateOnly)).not.toBeNull()
      // each -C is relative to the one before
      expect(secretRead(`git -C ${dirname(withSecret)} -C ${basename(withSecret)} grep --no-index FOO`, templateOnly)).not.toBeNull()
    })

    it('restores the scope a heredoc began in, stack entries included', () => {
      expect(secretRead(`(cd ${withSecret}; bash <<'EOF'\n(ls)\nls\nEOF\ngrep -rn FOO .)`, templateOnly)).not.toBeNull()
      // a heredoc nested in a script runs in a child of a child; its cd moves nothing outside
      expect(secretRead("bash <<'OUT'\nbash <<'INNER'\ncd src\nINNER\ngrep -rn FOO .\nOUT", withSecret)).not.toBeNull()
      // while inside it, its cd moves its own commands
      expect(secretRead(`bash <<'OUT'\nbash <<'INNER'\ncd ${withSecret}\ngrep -rn FOO .\nINNER\nOUT`, templateOnly)).not.toBeNull()
      // a quoted heredoc nested in a script is text, so its cd moves nothing
      expect(secretRead("bash <<'OUT'\ncat > /dev/null <<'INNER'\ncd src\nINNER\ngrep -rn FOO .\nOUT", withSecret)).not.toBeNull()
      // a second reading of the same data starts where the first did
      expect(secretRead("bash <<'EOF'\ncd src\n(\nls\n)\ngrep -rn FOO .\nEOF", withSecret)).toBeNull()
    })

    it('follows a leading cd to the directory searched', () => {
      expect(secretRead(`cd ${withSecret} && grep -rn FOO .`, templateOnly)).not.toBeNull()
      expect(secretRead(`(cd ${withSecret} && grep -rn FOO .)`, templateOnly)).not.toBeNull()
      expect(secretRead(`pushd ${withSecret} && grep -rn FOO .`, templateOnly)).not.toBeNull()
      vi.stubEnv('HOME', withSecret)
      onTestFinished(() => {
        vi.unstubAllEnvs()
      })
      expect(secretRead('cd ~ && grep -rn FOO .', templateOnly)).not.toBeNull()
      expect(secretRead('cd && grep -rn FOO .', templateOnly)).not.toBeNull()
      expect(secretRead('grep -rn FOO ~', templateOnly)).not.toBeNull()
    })

    it('follows a cd inside a script a shell reads from a heredoc, and only there', () => {
      expect(secretRead(`bash <<'EOF'\ncd ${withSecret}\ngrep -rn FOO .\nEOF`, templateOnly)).not.toBeNull()
      expect(secretRead("bash <<'EOF'\ncd src\nEOF\ngrep -rn FOO .", withSecret)).not.toBeNull()
      expect(secretRead("bash <<'EOF'\ncd src\nEOF\nbash <<'EOF'\ngrep -rn FOO .\nEOF", withSecret)).not.toBeNull()
      // a subshell inside the heredoc scopes its cd as one outside does
      expect(secretRead("bash <<'EOF'\n(cd src)\ngrep -rn FOO .\nEOF", withSecret)).not.toBeNull()
      expect(secretRead("bash <<'EOF'\ncd src\n(ls)\nEOF\ngrep -rn FOO .", withSecret)).not.toBeNull()
      // a script a shell reads is parsed whole, so a subshell spanning lines scopes its cd
      expect(secretRead("bash <<'EOF'\n(\ncd src\n)\ngrep -rn FOO .\nEOF", withSecret)).not.toBeNull()
      // a heredoc whose line closes a subshell: the next subshell starts outside it
      expect(secretRead("(cd src; cat <<EOF)\nx\nEOF\n(grep -rn FOO .)", withSecret)).not.toBeNull()
      // its subshells unwind with it, so leaving an enclosing one after it lands outside
      expect(secretRead("(bash <<'EOF'\ncd src\n(ls)\nEOF\n); grep -rn FOO .", withSecret)).not.toBeNull()
      // and a cd after the heredoc is the outer shell's again
      expect(secretRead(`bash <<'EOF'\nls\nEOF\ncd ${withSecret} && grep -rn FOO .`, templateOnly)).not.toBeNull()
    })

    it("runs an unquoted heredoc's substitutions where it began, before its reader runs any of it", () => {
      expect(secretRead('cat <<EOF\ncd src\n$(grep -rn FOO .)\nEOF', withSecret)).not.toBeNull()
      expect(secretRead('bash <<EOF\ncd src\n`grep -rn FOO .`\nEOF', withSecret)).not.toBeNull()
      expect(secretRead('bash <<EOF\n(cd src; echo $(grep -rn FOO .))\nEOF', withSecret)).not.toBeNull()
      // quoted data is expanded by its reader, after the reader's own cd
      expect(secretRead("bash <<'EOF'\ncd src\n$(grep -rn FOO .)\nEOF", withSecret)).toBeNull()
      // heredoc data has no process substitution: its reader runs that one
      expect(secretRead('bash <<EOF\ncd src\ncat <(grep -rn FOO .)\nEOF', withSecret)).toBeNull()
    })

    it('starts a sibling subshell or substitution from its parent directory', () => {
      expect(secretRead('(cd src); (grep -rn FOO .)', withSecret)).not.toBeNull()
      expect(secretRead('echo $(cd src) $(grep -rn FOO .)', withSecret)).not.toBeNull()
      expect(secretRead('(cd src && ls); ( (ls); grep -rn FOO . )', withSecret)).not.toBeNull()
      expect(secretRead("bash <<'EOF'\n(cd src); (grep -rn FOO .)\nEOF", withSecret)).not.toBeNull()
    })

    it("runs each of a pipeline's commands but its last in a subshell", () => {
      expect(secretRead('cd src | cat; grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('cd src && true | cat; grep -rn FOO .', withSecret)).toBeNull()
      expect(secretRead('(cd src) | cd src | cat\ngrep -rn FOO .', withSecret)).not.toBeNull()
      // a heredoc's data ends the command its line began
      expect(secretRead(`cd ${withSecret} <<EOF\nx\nEOF\ntrue | cat; grep -rn FOO .`, templateOnly)).not.toBeNull()
      // the last runs in the shell itself, as zsh runs it (bash runs it in a subshell too)
      expect(secretRead(`true | cd ${withSecret}; grep -rn FOO .`, templateOnly)).not.toBeNull()
    })

    it('runs a compound command a | or & takes in a subshell, whole', () => {
      expect(secretRead('{ cd src; true; } | cat; grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('{ cd src; true; } & wait; grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('for d in x; do cd src; done | sort; grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('if true; then cd src; fi & grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('true && while false; do cd src; done & grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('for d in x; do { cd src; true; } | cat; done; grep -rn FOO .', withSecret)).not.toBeNull()
      // a brace group alone is no subshell: its cd moves what follows it
      expect(secretRead('{ cd src; true; }; grep -rn FOO .', withSecret)).toBeNull()
      expect(secretRead(`{ cd ${withSecret}; }; grep -rn FOO .`, templateOnly)).not.toBeNull()
    })

    it('runs a list a lone & ends in a subshell of its own', () => {
      expect(secretRead('cd src && true & wait; grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('cd src & grep -rn FOO .', withSecret)).not.toBeNull()
      // the list holds its subshells and substitutions
      expect(secretRead('cd src && (true) & grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('cd src && echo $(true) & grep -rn FOO .', withSecret)).not.toBeNull()
      // inside the list its cd still moves what follows it
      expect(secretRead(`cd ${withSecret} && grep -rn FOO . &`, templateOnly)).not.toBeNull()
      // a newline after && or | goes on with the list, a heredoc's data in between too
      expect(secretRead('cd src &&\n true & grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('cd src && # a note\n true & grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('cd src && cat <<EOF &&\nx\nEOF\ntrue & grep -rn FOO .', withSecret)).not.toBeNull()
      // a ; ends the list before it, so its cd moves the commands after the &
      expect(secretRead('cd src; true & grep -rn FOO .', withSecret)).toBeNull()
      // a & inside a subshell ends the subshell's own list
      expect(secretRead(`cd ${withSecret} && (true & ls); grep -rn FOO .`, templateOnly)).not.toBeNull()
      // a heredoc's data ends the list its line began
      expect(secretRead(`cd ${withSecret} && cat <<EOF\nx\nEOF\ntrue &\ngrep -rn FOO .`, templateOnly)).not.toBeNull()
    })

    it('ignores a cd it cannot follow out of the shell it runs in', () => {
      expect(secretRead('(cd src && ls); grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('cd "$NOPE" && grep -rn FOO .', withSecret)).not.toBeNull()
      expect(secretRead('cd /nonexistent-dir; grep -rn FOO .', withSecret)).not.toBeNull()
      vi.stubEnv('HOME', templateOnly)
      onTestFinished(() => {
        vi.unstubAllEnvs()
      })
      expect(secretRead('cd - && grep -rn FOO .', withSecret)).not.toBeNull()
    })

    it.each([
      'grep -rn FOO src',
      'grep FOO .',
      'rg FOO .',
      'rg --hidden FOO .',
      'rg --no-ignore FOO .',
      `rg -r '$1' FOO .`,
      'git grep FOO',
      'grep -rn FOO src/*.ts',
      'grep -rn FOO "$DIR"',
      'grep -rn FOO $(git ls-files src)',
      `grep -r --include='*.ts' FOO .`,
      `grep -r --include '*.ts' FOO .`,
      `grep -r --exclude='.env*' FOO .`,
      `grep -r --exclude '.env*' FOO .`,
      // a glob's regex metacharacters are literal
      `grep -r --include='x).ts' FOO .`,
      // rg's globs: an include glob admits only what it matches, a ! glob excludes
      `rg -g '*.ts' FOO .`,
      `rg -g '*.{ts,tsx}' FOO .`,
      `rg -uu -g '!.env*' FOO .`,
      `rg -uu -g '*.ts' FOO .`,
      `rg -g 'src/**' FOO .`,
      // only as an option, not as another option's value
      `rg -e --glob-case-insensitive -g '.ENV*' FOO .`,
      'ag FOO .',
      'ag --hidden FOO .',
      'ag -U FOO .',
      `rg -uu -g '!{x,**/.env.local}' FOO .`,
      `rg -g '!node_modules' -n '.env' .`,
      // an -e pattern's letters are not flags
      'grep -eERROR',
      'git grep --no-index --exclude-standard FOO',
      // rg --files lists the names it would search and reads none
      'rg --files -uu',
      `rg --files -g '.env*' .`,
      'rg -e --hidden -u FOO .',
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

  it('honors READ_ENV_OK=1 only as the prefix', () => {
    expect(hook(payload('echo READ_ENV_OK=1 && cat .env.local')).status).toBe(2)
  })

  it('lets an unparseable payload through', () => {
    expect(hook('not json').status).toBe(0)
  })
})
