import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  amendInvocations,
  commandsInContext,
  baseBranch,
  decide,
  effectiveCwd,
  explicitEntry,
  hasMessage,
  renumbersStack,
  stashInvocations,
  unresolvedTarget,
  type RepoStashState,
} from './check-stash-worktree.mjs'
import {
  SUBSTITUTED,
  inputRedirectTargets,
  shellCommandsWithDepth,
  shellSegments,
  shellSegmentsWithDepth,
  withoutLiteralHeredocs,
} from './shell-segments.mjs'

describe('shellSegments', () => {
  it('splits on unquoted separators and strips quotes', () => {
    expect(shellSegments('git add x && git commit -m "two words"')).toEqual([
      ['git', 'add', 'x'],
      ['git', 'commit', '-m', 'two words'],
    ])
  })

  it('keeps separators inside quoted spans in their token', () => {
    expect(shellSegments(`git commit -m "fix a; git stash pop | done"`)).toEqual([
      ['git', 'commit', '-m', 'fix a; git stash pop | done'],
    ])
  })

  it('does not let an apostrophe inside double quotes bridge spans', () => {
    expect(shellSegments(`git commit -m "don't stash; it's fine" && ls`)).toEqual([
      ['git', 'commit', '-m', "don't stash; it's fine"],
      ['ls'],
    ])
  })

  it('opens a segment for $(…) even inside double quotes (it executes there)', () => {
    expect(shellSegments('echo "$(git stash pop)"')).toContainEqual(['git', 'stash', 'pop'])
    expect(shellSegments('x=`git stash pop`')).toContainEqual(['git', 'stash', 'pop'])
  })

  it('honors backslash escapes outside single quotes', () => {
    expect(shellSegments('echo a\\;b')).toEqual([['echo', 'a;b']])
  })

  it('drops a backslash-newline as a line continuation', () => {
    expect(shellSegments('git \\\nstash pop')).toEqual([['git', 'stash', 'pop']])
  })

  it('returns heredoc bodies as data segments, not command positions', () => {
    expect(shellSegmentsWithDepth('cat <<EOF > f\ngit stash pop\nEOF\necho done')).toEqual([
      { tokens: ['cat'], depth: 0 },
      { tokens: ['git', 'stash', 'pop'], depth: 0, heredoc: true },
      { tokens: ['echo', 'done'], depth: 0 },
    ])
    // quoted and <<- dash forms; a tab-indented delimiter closes <<-
    expect(shellSegmentsWithDepth("cat <<'END'\nbody\nEND\nls")).toEqual([
      { tokens: ['cat'], depth: 0 },
      { tokens: ['body'], depth: 0, heredoc: true },
      { tokens: ['ls'], depth: 0 },
    ])
    expect(shellSegmentsWithDepth('cat <<-END\nbody\n\tEND\nls').at(-1)).toEqual({
      tokens: ['ls'],
      depth: 0,
    })
  })

  it('keeps a quoted here-string glued to its operator as a word, for the scanners that read words', () => {
    expect(shellSegments(`git commit -F - <<<"fix x"`).flat().some(t => t.includes('fix x'))).toBe(true)
  })

  it('drops redirections and their targets instead of splitting on them', () => {
    expect(shellSegments('git push origin 2>&1 | tail -5')).toEqual([['git', 'push', 'origin'], ['tail', '-5']])
    expect(shellSegments('git push origin > /tmp/log 2>&1; ls')).toEqual([['git', 'push', 'origin'], ['ls']])
    expect(shellSegments('git restore f 2>/dev/null >>log')).toEqual([['git', 'restore', 'f']])
    expect(shellSegments('git restore f >> log 2> err')).toEqual([['git', 'restore', 'f']])
    expect(shellSegments('make &> out.txt && ls')).toEqual([['make'], ['ls']])
    expect(shellSegments('echo x >| forced')).toEqual([['echo', 'x']])
    expect(shellSegments('cat <<< word')).toEqual([['cat']])
    expect(shellSegments(String.raw`echo ">" '2>&1' \>`)).toEqual([['echo', '>', '2>&1', '>']])
    expect(shellSegments('sleep 1 & ls')).toEqual([['sleep', '1'], ['ls']])
    expect(shellSegments('git &>/dev/null restore f')).toEqual([['git', 'restore', 'f']])
    expect(shellSegments('git &>> log restore f')).toEqual([['git', 'restore', 'f']])
    expect(shellSegments('echo x >& both.log; ls')).toEqual([['echo', 'x'], ['ls']])
    expect(shellSegments('a > ; b')).toEqual([['a'], ['b']]) // a dangling redirect eats nothing past its segment
    // as in bash, an unquoted `>` ends the word before it; digits alone are its fd
    expect(shellSegments('git restore f>/dev/null a2>err 2>x')).toEqual([['git', 'restore', 'f', 'a2']])
  })

  it('annotates each segment with its subshell depth, and a scope opened since the last with fresh', () => {
    expect(shellSegmentsWithDepth('(cd /x && true); ls')).toEqual([
      { tokens: ['cd', '/x'], depth: 1, fresh: 1 },
      { tokens: ['true'], depth: 1 },
      { tokens: ['ls'], depth: 0 },
    ])
    expect(shellSegmentsWithDepth('echo "$(cd /y && true)" && ls')).toEqual([
      { tokens: ['echo', ''], depth: 0 },
      { tokens: ['cd', '/y'], depth: 1, fresh: 1 },
      { tokens: ['true'], depth: 1 },
      { tokens: ['ls'], depth: 0 },
    ])
    // a list a lone & ends runs in a background subshell, its && and | included
    expect(shellCommandsWithDepth('a; cd /z && b | c & d; e &')).toEqual([
      { tokens: ['a'], depth: 0 },
      { tokens: ['cd', '/z'], depth: 1, fresh: 1 },
      { tokens: ['b'], depth: 1 },
      { tokens: ['c'], depth: 1 },
      { tokens: ['d'], depth: 0 },
      { tokens: ['e'], depth: 1, fresh: 1 },
    ])
    expect(shellCommandsWithDepth('a && b $(c) &')).toEqual([
      { tokens: ['a'], depth: 1, fresh: 1 },
      { tokens: ['c'], depth: 2, fresh: 2 },
      { tokens: ['b', SUBSTITUTED], depth: 1 },
    ])
  })
})

describe('shellCommandsWithDepth', () => {
  it('keeps a command whole across a substitution, which comes back ahead of it', () => {
    expect(shellCommandsWithDepth(`git log $(git rev-parse "a)b") --oneline -1`)).toEqual([
      { tokens: ['git', 'rev-parse', 'a)b'], depth: 1, fresh: 1 },
      { tokens: ['git', 'log', SUBSTITUTED, '--oneline', '-1'], depth: 0 },
    ])
    expect(shellCommandsWithDepth('echo "a `date` b" x')).toEqual([
      { tokens: ['date'], depth: 1, fresh: 1 },
      { tokens: ['echo', `a ${SUBSTITUTED} b`, 'x'], depth: 0 },
    ])
    // nested, and one left unclosed
    expect(shellCommandsWithDepth('echo $(a $(b) c) d').map(s => s.tokens)).toEqual([['b'], ['a', SUBSTITUTED, 'c'], ['echo', SUBSTITUTED, 'd']])
    expect(shellCommandsWithDepth('echo x $(a').map(s => s.tokens)).toEqual([['a'], ['echo', 'x', SUBSTITUTED]])
  })

  it("skips a comment and reads $'…' as one span, so an apostrophe opens no quote", () => {
    expect(shellCommandsWithDepth("# it's done\nls -l # trailing -X GET\necho a#b").map(s => s.tokens)).toEqual([['ls', '-l'], ['echo', 'a#b']])
    // an escape it does not decode leaves a `$`, marking the word an expansion
    expect(shellCommandsWithDepth("x=$'don\\'t'; ls").map(s => s.tokens)).toEqual([["x=don$'t"], ['ls']])
    // shellSegmentsWithDepth reads both as before
    expect(shellSegments('ls # x')).toEqual([['ls', '#', 'x']])
  })

  it('cuts out the data of a quoted-delimiter heredoc only', () => {
    // an assignment on the line runs nothing, so it leaves the data literal
    expect(withoutLiteralHeredocs("S=/tmp; cat > $S/f <<'EOF'\nx\nEOF\nls")).toBe("S=/tmp; cat > $S/f <<'EOF'\nls")
    // unless its value substitutes: the data can land in the variable, and an eval runs it
    expect(withoutLiteralHeredocs("S=$(cat <<'EOF'\nx\nEOF\n)\neval \"$S\"")).toBe("S=$(cat <<'EOF'\nx\nEOF\n)\neval \"$S\"")
    expect(withoutLiteralHeredocs("S=$(date); cat > f <<'EOF'\nx\nEOF")).toBe("S=$(date); cat > f <<'EOF'\nx\nEOF")
    expect(withoutLiteralHeredocs("S=$(cat) <<'EOF'\nx\nEOF")).toBe("S=$(cat) <<'EOF'\nx\nEOF")
    expect(withoutLiteralHeredocs("A=1 S=$(cat <<'EOF'\nx\nEOF\n)")).toBe("A=1 S=$(cat <<'EOF'\nx\nEOF\n)")
    expect(withoutLiteralHeredocs("cat <<'EOF' > f\nliteral `x`\nEOF\ncat <<EOF\nruns `y`\nEOF\nls")).toBe('cat <<\'EOF\' > f\ncat <<EOF\nruns `y`\nEOF\nls')
    expect(withoutLiteralHeredocs('cat <<\\EOF\nx\nEOF\n')).toBe('cat <<\\EOF\n')
    // a shell reading it runs it, wherever it sits on the line
    expect(withoutLiteralHeredocs("bash <<'EOF'\nls\nEOF")).toBe("bash <<'EOF'\nls\nEOF")
    expect(withoutLiteralHeredocs("cat <<'EOF' | sh\nls\nEOF")).toBe("cat <<'EOF' | sh\nls\nEOF")
    // or a pipe or subshell still open at the newline, whose reader comes after the data
    for (const cmd of [
      "cat <<'EOF' |\nls\nEOF\nbash",
      "cat <<'EOF' | # then a shell\nls\nEOF\nbash",
      "cat <<'EOF' |&\nls\nEOF\nbash",
      "true && cat <<'EOF' ||\nls\nEOF\nbash",
      "(cat <<'EOF'\nls\nEOF\n) | bash",
    ])
      expect(withoutLiteralHeredocs(cmd), cmd).toBe(cmd)
    // a pipe that already has its reader, or a list that ended, leaves nothing pending
    expect(withoutLiteralHeredocs("printf x | cat <<'EOF'\nx\nEOF")).toBe("printf x | cat <<'EOF'\n")
    expect(withoutLiteralHeredocs("printf x & cat <<'EOF'\nx\nEOF")).toBe("printf x & cat <<'EOF'\n")
    // anything not known to only read text keeps it: a quoted or escaped shell,
    // an expanded command word, a wrapper, a redirection ahead of the command
    for (const cmd of [
      "cat <<'EOF' | \"ba\"sh\nls\nEOF",
      "cat <<'EOF' | \\bash\nls\nEOF",
      "cat <<'EOF' | $SHELL\nls\nEOF",
      "env $SH <<'EOF'\nls\nEOF",
      "> out $SH <<'EOF'\nls\nEOF",
      "xargs -0 <<'EOF'\nls\nEOF",
    ])
      expect(withoutLiteralHeredocs(cmd), cmd).toBe(cmd)
    // a known text reader, path-qualified, behind assignments or a leading redirection
    expect(withoutLiteralHeredocs("X=1 /usr/bin/python3 - <<'EOF'\nls\nEOF")).toBe("X=1 /usr/bin/python3 - <<'EOF'\n")
    expect(withoutLiteralHeredocs("> f cat <<'EOF'\nls\nEOF")).toBe("> f cat <<'EOF'\n")
    // an earlier line's shell reads nothing here, nor does an expanded argument
    expect(withoutLiteralHeredocs("bash x.sh\ncat > $OUT <<'EOF'\nls\nEOF")).toBe("bash x.sh\ncat > $OUT <<'EOF'\n")
  })

  it('gives heredoc data one segment per line, continued lines joined', () => {
    expect(shellCommandsWithDepth('bash <<EOF\na b \\\nc\nd\nEOF')).toEqual([
      { tokens: ['bash'], depth: 0 },
      { tokens: ['a', 'b', 'c'], depth: 0, heredoc: true },
      { tokens: ['d'], depth: 0, heredoc: true },
    ])
    // a line a shell reads is read as the commands it would be; text nothing runs is split into words
    expect(shellCommandsWithDepth("bash <<'EOF'\nx;gh api y # it's\nEOF").map(s => s.tokens)).toEqual([['bash'], ['x'], ['gh', 'api', 'y']])
    expect(shellCommandsWithDepth("cat <<'EOF'\nx;gh `api` y\nEOF").map(s => s.tokens)).toEqual([['cat'], ['x;gh', '`api`', 'y']])
    // unquoted data's substitutions first come back alone, as the supplying shell runs them
    expect(shellCommandsWithDepth('cat <<EOF\nsee `gh api y`\nEOF').map(s => s.tokens)).toEqual([['cat'], ['gh', 'api', 'y'], ['gh', 'api', 'y'], ['see', SUBSTITUTED]])
    expect(shellCommandsWithDepth('bash <<EOF\n$(x)\nEOF')).toEqual([
      { tokens: ['bash'], depth: 0 },
      { tokens: ['x'], depth: 1, heredoc: true, fresh: 1 },
      { tokens: ['x'], depth: 1, heredoc: true, fresh: 1, reread: true },
      { tokens: [SUBSTITUTED], depth: 0, heredoc: true },
    ])
    // data read whole and a line at a time differs here, so both come back:
    // whole first, where a subshell spans its lines
    expect(shellCommandsWithDepth("bash <<'EOF'\n(\ncd x\n)\nls\nEOF")).toEqual([
      { tokens: ['bash'], depth: 0 },
      { tokens: ['cd', 'x'], depth: 1, heredoc: true, fresh: 1 },
      { tokens: ['ls'], depth: 0, heredoc: true },
      { tokens: ['cd', 'x'], depth: 0, heredoc: true, reread: true },
      { tokens: ['ls'], depth: 0, heredoc: true },
    ])
    // only when the heredoc's own command is a shell reading its script from stdin
    expect(shellCommandsWithDepth("cat <<'EOF' | sh x.sh\nsay don't\ncat y\nEOF").map(s => s.tokens)).toContainEqual(['cat', 'y'])
    expect(shellCommandsWithDepth("bash -c 'cat' <<'EOF'\nsay don't\ncat y\nEOF").map(s => s.tokens)).toContainEqual(['cat', 'y'])
    expect(shellCommandsWithDepth("bash -c'cat' <<'EOF'\nsay don't\ncat y\nEOF").map(s => s.tokens)).toContainEqual(['cat', 'y'])
    expect(shellCommandsWithDepth("X=1 <<'EOF'\ncat y\nEOF").map(s => s.tokens)).toContainEqual(['cat', 'y'])
    expect(shellCommandsWithDepth("sh -s <<'EOF'\n(\ncd x\n)\nEOF").find(s => s.tokens[0] === 'cd')?.depth).toBe(1)
    // quoted data a reader of its own language takes is still read a line at a time
    expect(shellCommandsWithDepth("osascript <<'EOF'\nsay don't\ncat x\nEOF").map(s => s.tokens)).toContainEqual(['cat', 'x'])
    // unquoted data is expanded before the shell reads it, so an apostrophe
    // there cannot hide the next line's substitution
    expect(shellCommandsWithDepth("bash <<EOF\necho don't\n$(gh api y)\nEOF").map(s => s.tokens)).toContainEqual(['gh', 'api', 'y'])
    // data a text reader takes runs only its substitutions, a line at a time
    expect(shellCommandsWithDepth("cat <<EOF\ndon't\n$(gh api y)\nEOF").map(s => s.tokens)).toContainEqual(['gh', 'api', 'y'])
  })

  it('keeps a command whole across a process substitution', () => {
    expect(shellCommandsWithDepth('diff <(sort a) >(tee b) -u').map(s => s.tokens)).toEqual([
      ['sort', 'a'],
      ['tee', 'b'],
      ['diff', `<${SUBSTITUTED}`, `>${SUBSTITUTED}`, '-u'],
    ])
    // in the middle of a word too, as bash reads it (`x/dev/fd/63`)
    expect(shellCommandsWithDepth('diff x<(sort a) 2>(tee b)').map(s => s.tokens)).toEqual([
      ['sort', 'a'],
      ['tee', 'b'],
      ['diff', `x<${SUBSTITUTED}`, `2>${SUBSTITUTED}`],
    ])
    // a subshell is still a scope of its own
    expect(shellCommandsWithDepth('(cd x && ls) -u').map(s => s.tokens)).toEqual([['cd', 'x'], ['ls'], ['-u']])
  })

  it('drops a redirection with its target, not a separator', () => {
    expect(shellCommandsWithDepth('make 2>&1 -j4 &> out >| log -k && ls').map(s => s.tokens)).toEqual([
      ['make', '-j4', '-k'],
      ['ls'],
    ])
    // an attached target goes with its operator, and a flag-shaped one is no flag
    expect(shellCommandsWithDepth('a -f body=y> -XGET').map(s => s.tokens)).toEqual([['a', '-f', 'body=y']])
    // a substitution as the target goes too, and the command around it keeps its words
    expect(shellCommandsWithDepth('a > $(echo f) -k').map(s => s.tokens)).toEqual([['echo', 'f'], ['a', '-k']])
    // a quoted digit is no fd, and a quoted operator stays text across a substitution
    expect(shellCommandsWithDepth(`echo "2">f $'>' k ">"$(date) j`).map(s => s.tokens)).toEqual([
      ['date'],
      ['echo', '2', '>', 'k', `>${SUBSTITUTED}`, 'j'],
    ])
    // an escaped or quoted `>` is text: what follows it is an operator
    expect(shellCommandsWithDepth('echo a\\>|wc; echo b\\>&ls; echo ">"&ls').map(s => s.tokens)).toEqual([
      ['echo', 'a>'],
      ['wc'],
      ['echo', 'b>'],
      ['ls'],
      ['echo', '>'],
      ['ls'],
    ])
  })

  it('leaves shellSegmentsWithDepth splitting as before', () => {
    expect(shellSegments('git log $(git rev-parse x) --oneline')).toEqual([['git', 'log'], ['git', 'rev-parse', 'x'], ['--oneline']])
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
    ['cat <\\a', ['a']],
    ["cat <$'a'", ['a']],
    ['cat <>a', ['a']],
    ['exec 3<> a', ['a']],
    ['cat <>"a"', ['a']],
    // unquoted heredoc data is read again as its supplying shell expands it, where it is text
    ['cat <<EOF\n<a $(b)\nEOF', ['a']],
  ])('%s → %j', (cmd, targets) => {
    expect(inputRedirectTargets(cmd)).toEqual(targets)
  })
})

describe('commandsInContext', () => {
  it('scopes a heredoc nested in a heredoc inside it, in the whole reading on its own', () => {
    const read = commandsInContext(shellCommandsWithDepth("bash <<'OUT'\nbash <<'INNER'\ncd /tmp/a\nls\nINNER\npwd\nOUT"))
    // the whole reading comes first; its first ls and pwd are the ones it scoped
    expect(read.find(c => c.words[0] === 'ls')?.cdPath).toBe('/tmp/a')
    expect(read.find(c => c.words[0] === 'pwd')?.cdPath).toBe(null)
  })

  it("starts a nested heredoc's second reading where its first began", () => {
    // the inner data reads differently whole and by line, so it comes back twice
    const read = commandsInContext(shellCommandsWithDepth("bash <<'OUT'\nbash <<'INNER'\ncd a\n(\nls\n)\nINNER\nOUT"))
    expect(read.filter(c => c.words[0] === 'ls').map(c => c.cdPath)).not.toContain('a/a')
  })

  it('reads a second reading with no first reading before it from where it is', () => {
    const read = commandsInContext([{ tokens: ['ls'], depth: 0, heredoc: true, reread: true }])
    expect(read.map(c => [c.words[0], c.cdPath])).toEqual([['ls', null]])
  })

  it('drops a cd in data three heredocs deep when that data ends', () => {
    // read a line at a time the nesting is not seen, so that reading keeps the cd
    const read = commandsInContext(shellCommandsWithDepth("bash <<'A'\nbash <<'B'\nbash <<'C'\ncd a\nC\nls\nB\nA"))
    expect(read.filter(c => c.words[0] === 'ls').map(c => c.cdPath)).toContain(null)
  })
})

describe('stashInvocations', () => {
  it('finds bare, subcommand, and wrapped invocations', () => {
    expect(stashInvocations('git stash')).toEqual([
      { sub: null, args: [], cArgs: [], cdPath: null, optOut: false },
    ])
    expect(stashInvocations('cd /wt && env git stash pop stash@{2}')).toEqual([
      { sub: 'pop', args: ['stash@{2}'], cArgs: [], cdPath: '/wt', optOut: false },
    ])
    expect(stashInvocations('git -C /repo stash drop 1')).toEqual([
      { sub: 'drop', args: ['1'], cArgs: ['-C', '/repo'], cdPath: null, optOut: false },
    ])
  })

  it('treats a flags-only tail as an implicit push', () => {
    expect(stashInvocations('git stash -u')).toEqual([
      { sub: null, args: ['-u'], cArgs: [], cdPath: null, optOut: false },
    ])
  })

  it('sees through wrapper flags (env -i)', () => {
    expect(stashInvocations('env -i git stash pop')).toHaveLength(1)
  })

  it('recognizes cd behind a reserved-word prefix', () => {
    expect(stashInvocations('{ cd /wt && git stash pop stash@{0}; }')[0].cdPath).toBe('/wt')
    // segments keep comments, so a & there is not read as one that runs the list in the background
    expect(stashInvocations('cd /wt # notes & more\ngit stash pop stash@{0}')[0].cdPath).toBe('/wt')
  })

  it('accumulates consecutive relative cds, and an absolute one resets', () => {
    expect(stashInvocations('cd packages && cd app && git stash pop')[0].cdPath).toBe('packages/app')
    expect(stashInvocations('cd /a && cd b && git stash pop')[0].cdPath).toBe('/a/b')
    expect(stashInvocations('cd a && cd /b && git stash pop')[0].cdPath).toBe('/b')
    expect(stashInvocations('cd a && cd ~/b && git stash pop')[0].cdPath).toBe(join(homedir(), 'b'))
    expect(stashInvocations('cd ~ && cd b && git stash pop')[0].cdPath).toBe(join(homedir(), 'b'))
    expect(stashInvocations('cd a && (cd b && true); git stash pop')[0].cdPath).toBe('a')
    expect(stashInvocations('exec git stash pop')).toHaveLength(1)
    expect(stashInvocations('<<<"x" git stash pop')).toHaveLength(1)
    expect(stashInvocations('git --git-dir /r/.git stash pop')[0].cArgs).toEqual(['--git-dir', '/r/.git'])
    expect(stashInvocations('git --namespace n stash pop')).toHaveLength(1)
    expect(stashInvocations('git --config-env a=B --attr-source t --super-prefix p stash pop')).toHaveLength(1)
    expect(stashInvocations('builtin cd /tmp/a && git stash pop')[0].cdPath).toBe('/tmp/a')
    // a sibling subshell starts from its parent's directory
    expect(stashInvocations('(cd /tmp/a); (git stash pop)')[0].cdPath).toBe(null)
    expect(stashInvocations('cd /tmp/b; (cd /tmp/a)(git stash pop)')[0].cdPath).toBe('/tmp/b')
    // a heredoc whose line closes a subshell: the cd in that subshell dies with it
    expect(stashInvocations('(cd /tmp/a; cat <<EOF)\nbody\nEOF\n(git stash pop)')[0].cdPath).toBe(null)
    expect(stashInvocations('cd /tmp/a; (cd /tmp/b; cat <<EOF)\nbody\nEOF\n(git stash pop)')[0].cdPath).toBe('/tmp/a')
    expect(stashInvocations('(cd /tmp/a; (cd /tmp/b; cat <<EOF)\nbody\nEOF\ngit stash pop)')[0].cdPath).toBe('/tmp/a')
    expect(stashInvocations('cd "$S" && cd .. && git stash pop')[0].cdPath).toBe('$S/..')
  })

  it('expands a leading tilde in -C, --git-dir and --work-tree values', () => {
    expect(stashInvocations('git -C ~/repo stash list')[0].cArgs).toEqual(['-C', join(homedir(), 'repo')])
    expect(stashInvocations('git --work-tree ~ stash list')[0].cArgs).toEqual(['--work-tree', homedir()])
  })

  it('follows only named directories; other cd, pushd and popd forms stay unknown', () => {
    const cdPath = (cmd: string) => stashInvocations(`${cmd} && git stash list`)[0].cdPath
    expect(cdPath('cd')).toBe(homedir())
    expect(cdPath('cd -P /wt')).toBe('/wt')
    expect(cdPath('cd -')).toBe('$OLDPWD')
    expect(cdPath('cd - && cd sub')).toBe('$OLDPWD/sub')
    expect(cdPath('pushd /wt')).toBe('/wt')
    expect(cdPath('pushd')).toBe('$DIRSTACK')
    expect(cdPath('pushd +1')).toBe('$DIRSTACK')
    expect(cdPath('pushd /wt && popd')).toBe('$DIRSTACK')
  })

  it('keeps the starting directory when a cd target cannot be entered', () => {
    const start = realpathSync(tmpdir())
    expect(effectiveCwd(start, '/no/such/dir/anywhere')).toEqual({ cwd: start, exact: true })
    expect(effectiveCwd(start, fileURLToPath(import.meta.url))).toEqual({ cwd: start, exact: true })
    const loop = join(mkdtempSync(join(tmpdir(), 'cd-loop-')), 'loop')
    symlinkSync(loop, loop) // statSync throws ELOOP rather than reporting it missing
    expect(effectiveCwd(start, loop)).toEqual({ cwd: start, exact: true })
    expect(effectiveCwd('/', start)).toEqual({ cwd: start, exact: true })
  })

  it('names the cd or -C target a static reading cannot resolve', () => {
    const target = (cmd: string) => unresolvedTarget(stashInvocations(cmd)[0])
    expect(target('cd "$WT" && git stash list')).toBe('$WT')
    expect(target('git -C "$WT" stash list')).toBe('$WT')
    expect(target('git --git-dir=$G stash list')).toBe('--git-dir=$G')
    expect(target('cd /wt && git -C sub stash list')).toBeNull()
  })

  it('scopes a subshell cd to its subshell', () => {
    expect(stashInvocations('(cd /wt && true); git stash pop stash@{0}')).toEqual([
      { sub: 'pop', args: ['stash@{0}'], cArgs: [], cdPath: null, optOut: false },
    ])
    expect(stashInvocations('(cd /wt && git stash pop stash@{0})')[0].cdPath).toBe('/wt')
    expect(stashInvocations('echo "$(cd /wt && true)"; git stash drop 0')[0].cdPath).toBeNull()
  })

  it('records the opt-out only as the invocation own prefix, not quoted prose', () => {
    expect(stashInvocations('STASH_OK=1 git stash pop')[0].optOut).toBe(true)
    expect(stashInvocations('echo "STASH_OK=1 skips" ; git stash pop')[0].optOut).toBe(false)
  })

  it('sees through shell reserved-word prefixes', () => {
    expect(stashInvocations('if git stash pop; then echo popped; fi')).toHaveLength(1)
    expect(stashInvocations('{ git stash pop; }')).toHaveLength(1)
    expect(stashInvocations('! git stash pop')).toHaveLength(1)
  })

  it('ignores commands that merely mention stash', () => {
    expect(stashInvocations('echo git stash pop')).toEqual([])
    expect(stashInvocations('ls my-stash-dir | grep stash')).toEqual([])
    expect(stashInvocations('git commit -m "later: git stash pop; cleanup"')).toEqual([])
    expect(stashInvocations('git stashx pop')).toEqual([])
    expect(stashInvocations('git stash bogus-subcommand')).toEqual([]) // git rejects it itself
  })
})

describe('amendInvocations', () => {
  it('finds only commit invocations carrying --amend', () => {
    expect(amendInvocations('git commit --amend -m x')).toHaveLength(1)
    expect(amendInvocations('git commit -m x')).toEqual([])
    expect(amendInvocations('git stash pop stash@{0}')).toEqual([])
    expect(amendInvocations('echo "git commit --amend"')).toEqual([])
  })

  it('does not read a -m message value as a pathspec', () => {
    expect(amendInvocations('git commit --amend -m "fix things"')[0].paths).toEqual([])
    expect(amendInvocations('git commit --amend --message "fix things"')[0].paths).toEqual([])
    expect(amendInvocations('git commit --amend -am "fix things"')[0]).toMatchObject({
      all: true,
      paths: [],
    })
  })

  it('collects explicit pathspecs, before and after --', () => {
    expect(amendInvocations('git commit --amend -m x f.txt')[0].paths).toEqual(['f.txt'])
    expect(amendInvocations('git commit --amend -m x -- a.txt b.txt')[0].paths).toEqual([
      'a.txt',
      'b.txt',
    ])
  })

  it('marks include-mode, in long, short, and clustered spellings', () => {
    expect(amendInvocations('git commit --amend --include f.txt')[0].include).toBe(true)
    expect(amendInvocations('git commit --amend -i f.txt')[0].include).toBe(true)
    expect(amendInvocations('git commit --amend -im "x" f.txt')[0].include).toBe(true)
    expect(amendInvocations('git commit --amend -m x f.txt')[0].include).toBe(false)
  })

  it('treats patch/interactive as add-to-index modes too', () => {
    expect(amendInvocations('git commit --amend --patch f.txt')[0].include).toBe(true)
    expect(amendInvocations('git commit --amend -p f.txt')[0].include).toBe(true)
    expect(amendInvocations('git commit --amend --interactive f.txt')[0].include).toBe(true)
  })

  it('records the AMEND_OK=1 opt-out only as the invocation prefix', () => {
    expect(amendInvocations('AMEND_OK=1 git commit --amend -m x')[0].optOut).toBe(true)
    expect(amendInvocations('echo "AMEND_OK=1"; git commit --amend -m x')[0].optOut).toBe(false)
  })
})

describe('explicitEntry / hasMessage / mutatesStack / baseBranch', () => {
  it('recognizes stash@{N} and bare-index entries, skipping flags', () => {
    expect(explicitEntry(['--index', 'stash@{3}'])).toBe('stash@{3}')
    expect(explicitEntry(['2'])).toBe('2')
    expect(explicitEntry(['--quiet'])).toBeNull()
    expect(explicitEntry([])).toBeNull()
  })

  it('detects push/save messages in their forms', () => {
    expect(hasMessage('push', ['-m', 'wip'])).toBe(true)
    expect(hasMessage('push', ['--message=wip'])).toBe(true)
    expect(hasMessage(null, ['-um', 'wip'])).toBe(true)
    expect(hasMessage(null, ['-mWIP'])).toBe(true)
    expect(hasMessage('push', ['-u'])).toBe(false)
    expect(hasMessage('save', ['my', 'message'])).toBe(true)
    expect(hasMessage('save', ['-u'])).toBe(false)
  })

  it('stops option scanning at the pathspec delimiter', () => {
    expect(hasMessage('push', ['--', '-m'])).toBe(false) // -m here is a pathspec
    expect(hasMessage('push', ['-m', 'x', '--', 'f.txt'])).toBe(true)
  })

  it('classifies renumbering by subcommand — apply reads without renumbering', () => {
    expect(renumbersStack({ sub: null })).toBe(true)
    expect(renumbersStack({ sub: 'pop' })).toBe(true)
    expect(renumbersStack({ sub: 'push' })).toBe(true)
    expect(renumbersStack({ sub: 'apply' })).toBe(false)
    expect(renumbersStack({ sub: 'list' })).toBe(false)
    expect(renumbersStack({ sub: 'show' })).toBe(false)
  })

  it('parses the base branch from both stash subject shapes', () => {
    expect(baseBranch('WIP on master: 9fe9b70c Hide search headers')).toBe('master')
    expect(baseBranch('On feat/x: restored: propertyRegistrationAudit WIP')).toBe('feat/x')
    expect(baseBranch('custom label with no branch')).toBeNull()
  })
})

describe('decide', () => {
  const state = (over: Partial<RepoStashState> = {}): RepoStashState => ({
    worktrees: 3,
    branch: 'mine',
    stashes: [
      { ref: 'stash@{0}', subject: 'WIP on other: 123 x' },
      { ref: 'stash@{1}', subject: 'On mine: labelled' },
    ],
    ...over,
  })
  const inv = (sub: string | null, args: string[] = []) => ({ sub, args })

  it('allows everything in a single-worktree repo or without repo state', () => {
    expect(decide(inv('pop'), state({ worktrees: 1 }))).toBeNull()
    expect(decide(inv('pop'), null)).toBeNull()
  })

  it('allows pop/apply/drop against an empty stack (git errors on its own)', () => {
    expect(decide(inv('pop'), state({ stashes: [] }))).toBeNull()
  })

  it('blocks pop/apply/drop/branch naming no explicit entry', () => {
    for (const sub of ['pop', 'apply', 'drop', 'branch']) {
      expect(decide(inv(sub, sub === 'branch' ? ['newb'] : []), state())).toMatch(/names no entry/)
    }
  })

  it('does not read a numeric branch name as a stash selector', () => {
    // `git stash branch 1` names branch "1"; git itself would use stash@{0}.
    expect(decide(inv('branch', ['1']), state())).toMatch(/names no entry/)
    expect(decide(inv('branch', ['newb', '1']), state())).toBeNull()
  })

  it('allows an explicit entry based on the current branch, either spelling', () => {
    expect(decide(inv('pop', ['stash@{1}']), state())).toBeNull()
    expect(decide(inv('apply', ['1']), state())).toBeNull()
  })

  it('blocks an explicit entry stashed on a different branch, naming both', () => {
    const msg = decide(inv('pop', ['stash@{0}']), state())
    expect(msg).toMatch(/'other'/)
    expect(msg).toMatch(/'mine'/)
    expect(decide(inv('drop', ['0']), state())).toMatch(/another session's work/)
  })

  it('allows an out-of-range index but blocks unverifiable selectors', () => {
    expect(decide(inv('pop', ['stash@{9}']), state())).toBeNull()
    expect(decide(inv('pop', ['stash@{2.hours.ago}']), state())).toMatch(/cannot resolve/)
  })

  it('fails closed when the stash list cannot be read', () => {
    expect(decide(inv('pop', ['stash@{0}']), state({ stashes: null }))).toMatch(/could not read/)
    expect(decide(inv('clear'), state({ stashes: null }))).toMatch(/could not read/)
  })

  it('blocks when the entry subject records no branch or the worktree branch is unknown', () => {
    expect(
      decide(inv('pop', ['stash@{0}']), state({ stashes: [{ ref: 'stash@{0}', subject: 'custom' }] })),
    ).toMatch(/does not record its base branch/)
    expect(decide(inv('pop', ['stash@{0}']), state({ branch: null }))).toMatch(/not a literal path/)
  })

  it('skips the branch match for `stash branch` (it checks out the entry base)', () => {
    expect(decide(inv('branch', ['newb', 'stash@{0}']), state())).toBeNull()
  })

  it('blocks an unlabeled push in every spelling, allows labelled ones', () => {
    expect(decide(inv(null), state())).toMatch(/unlabeled/)
    expect(decide(inv('push', ['-u']), state())).toMatch(/unlabeled/)
    expect(decide(inv('save'), state())).toMatch(/unlabeled/)
    expect(decide(inv('push', ['-m', 'wip']), state())).toBeNull()
    expect(decide(inv('save', ['msg']), state())).toBeNull()
  })

  it('blocks an unlabeled push even when the stack is empty — the entry outlives that', () => {
    expect(decide(inv(null), state({ stashes: [] }))).toMatch(/unlabeled/)
  })

  it('blocks clear on a non-empty shared stack only', () => {
    expect(decide(inv('clear'), state())).toMatch(/deletes all 2 entries/)
    expect(decide(inv('clear'), state({ stashes: [] }))).toBeNull()
  })

  it('leaves read-only subcommands alone', () => {
    expect(decide(inv('list'), state())).toBeNull()
    expect(decide(inv('show', []), state())).toBeNull()
  })
})

// Fixture repos are built once and never mutated: the hook only DECIDES (exit
// code + stderr), it never runs the stash command itself.
describe('hook end-to-end', { timeout: 30_000 }, () => {
  const script = fileURLToPath(new URL('./check-stash-worktree.mjs', import.meta.url))
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0)
    return r.stdout.trim()
  }
  const hook = (command: string, cwd: string, input?: string) => {
    const payload = input ?? JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } })
    return spawnSync('node', [script], { cwd, input: payload, encoding: 'utf8' })
  }
  const makeRepo = (name: string) => {
    // realpath: on macOS tmpdir is a /var → /private/var symlink, and git
    // worktree paths come back resolved.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), name)))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@example.com'])
    git(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    return repo
  }

  const single = makeRepo('stash-guard-single-')

  // Multi-worktree repo: one stash from each side, wt2's stashed last (stash@{0}).
  const multi = makeRepo('stash-guard-multi-')
  const wt2 = join(multi, 'wt2')
  git(multi, ['worktree', 'add', '-q', wt2, '-b', 'wt2branch'])
  writeFileSync(join(multi, 'f.txt'), 'main change\n')
  git(multi, ['stash', 'push', '-qm', 'main work'])
  writeFileSync(join(wt2, 'f.txt'), 'wt2 change\n')
  git(wt2, ['stash', 'push', '-qm', 'wt2 work'])
  // ⇒ stash@{0} on wt2branch, stash@{1} on main

  const emptyStack = makeRepo('stash-guard-empty-')
  git(emptyStack, ['worktree', 'add', '-q', join(emptyStack, 'wt2'), '-b', 'other'])

  // The real incident shape: an entry re-stashed via `git stash store -m
  // "restored: …"` carries a custom REFLOG message, but the stash commit's own
  // subject still records the base branch.
  const restored = makeRepo('stash-guard-restored-')
  const rwt = join(restored, 'wt2')
  git(restored, ['worktree', 'add', '-q', rwt, '-b', 'other'])
  writeFileSync(join(rwt, 'f.txt'), 'change\n')
  git(rwt, ['stash', 'push', '-qm', 'orig'])
  const restoredSha = git(rwt, ['rev-parse', 'stash@{0}'])
  git(rwt, ['stash', 'drop', '-q', 'stash@{0}'])
  git(rwt, ['stash', 'store', '-m', 'restored: orig — accidentally popped elsewhere', restoredSha])

  it('still blocks when the hook script is reached through a symlinked directory', () => {
    const linked = join(realpathSync(mkdtempSync(join(tmpdir(), 'stash-guard-link-'))), 'scripts')
    symlinkSync(dirname(script), linked)
    const payload = JSON.stringify({ tool_name: 'Bash', cwd: multi, tool_input: { command: 'git stash pop' } })
    const r = spawnSync('node', [join(linked, 'check-stash-worktree.mjs')], { cwd: multi, input: payload, encoding: 'utf8' })
    expect(r.status).toBe(2)
  })

  it('is a no-op in a single-worktree repo', () => {
    expect(hook('git stash pop', single).status).toBe(0)
    expect(hook('git stash', single).status).toBe(0)
  })

  it('blocks a bare pop in a multi-worktree repo', () => {
    const r = hook('git stash pop', multi)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('names no entry')
    expect(r.stderr).toContain('2 worktrees')
  })

  it('allows an explicit entry stashed on the current branch', () => {
    expect(hook('git stash pop stash@{1}', multi).status).toBe(0)
    expect(hook('git stash apply 0', wt2).status).toBe(0)
  })

  it('blocks an explicit entry stashed on a different branch, naming both branches', () => {
    const r = hook('git stash pop stash@{0}', multi)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'wt2branch'")
    expect(r.stderr).toContain("'main'")
  })

  it('judges a brace-grouped cd-chained pop from the target worktree', () => {
    // Pre-fix, the '{' prefix hid the cd: the pop was judged from wt2, where
    // stash@{0}'s base branch matches, and wrongly allowed.
    const r = hook(`{ cd ${multi} && git stash pop stash@{0}; }`, wt2)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'wt2branch'")
  })

  it('does not block heredoc bodies that mention stash, but still guards after them', () => {
    // the body line must put git in verb position — that is the shape that
    // would parse as a real invocation if bodies were not skipped
    expect(hook(`cat > /dev/null <<'DOC'\ngit stash pop\nDOC\necho ok`, multi).status).toBe(0)
    expect(hook(`cat > /dev/null <<'DOC'\nprose\nDOC\ngit stash pop`, multi).status).toBe(2)
  })

  it('judges a cd-chained pop from the target worktree', () => {
    const r = hook(`cd ${multi} && git stash pop stash@{0}`, wt2)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'wt2branch'")
    const ok = hook(`cd ${multi} && git stash pop stash@{1}`, wt2)
    expect(ok.status).toBe(0)
  })

  it('judges a -C pop from the target worktree', () => {
    expect(hook(`git -C ${multi} stash pop stash@{0}`, wt2).status).toBe(2)
    expect(hook(`git -C ${multi} stash pop stash@{1}`, wt2).status).toBe(0)
  })

  it('does not let a subshell cd relocate a later pop', () => {
    // The subshell's cd does not survive its close-paren: the pop runs in wt2
    // (on wt2branch), so popping main's stash@{1} must still be blocked.
    const r = hook(`(cd ${multi} && true); git stash pop stash@{1}`, wt2)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'main'")
    // …and the mirror direction stays allowed.
    expect(hook(`(cd ${wt2} && true); git stash pop stash@{1}`, multi).status).toBe(0)
  })

  it('blocks an unlabeled push but allows -m / save with message', () => {
    expect(hook('git stash', multi).status).toBe(2)
    expect(hook('git stash', multi).stderr).toContain('unlabeled')
    expect(hook('git stash push -m "wip: thing"', multi).status).toBe(0)
    expect(hook('git stash save "wip thing"', multi).status).toBe(0)
    expect(hook('git stash save', multi).status).toBe(2)
  })

  it('blocks a selector that follows a renumbering stash operation', () => {
    const r = hook('git stash push -m mine && git stash pop stash@{1}', multi)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('separate commands')
    expect(hook('git stash push -m mine && git stash pop stash@{1}', single).status).toBe(0)
    expect(hook('git stash list && git stash pop stash@{1}', multi).status).toBe(0)
  })

  it('allows apply-then-drop of the same explicit entry (apply does not renumber)', () => {
    expect(hook('git stash apply stash@{1} && git stash drop stash@{1}', multi).status).toBe(0)
  })

  it('sees through a backslash-newline line continuation', () => {
    expect(hook('git \\\nstash pop', multi).status).toBe(2)
  })

  it('counts an opted-out mutation in the compound rule', () => {
    // The blessed push still renumbers what the unblessed pop names.
    const r = hook('true && STASH_OK=1 git stash push -m mine && git stash pop stash@{1}', multi)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('separate commands')
    // …but a compound where every mutation is blessed passes.
    expect(
      hook('true && STASH_OK=1 git stash push -m a && STASH_OK=1 git stash pop stash@{1}', multi)
        .status,
    ).toBe(0)
  })

  it('blocks clear while the shared stack has entries', () => {
    expect(hook('git stash clear', multi).status).toBe(2)
    expect(hook('git stash clear', emptyStack).status).toBe(0)
  })

  it('allows pop/apply/drop against an empty stack, still blocks unlabeled push', () => {
    expect(hook('git stash pop', emptyStack).status).toBe(0)
    expect(hook('git stash', emptyStack).status).toBe(2)
  })

  it('honors the STASH_OK=1 opt-out as a command or invocation prefix', () => {
    expect(hook('STASH_OK=1 git stash pop', multi).status).toBe(0)
    expect(hook('git fetch && STASH_OK=1 git stash pop', multi).status).toBe(0)
  })

  it('ignores STASH_OK=1 inside quoted prose', () => {
    expect(hook('echo "re-run with STASH_OK=1 prefixed" && git stash pop', multi).status).toBe(2)
  })

  it('guards an invocation behind a reserved-word prefix', () => {
    expect(hook('if git stash pop; then true; fi', multi).status).toBe(2)
  })

  it('guards an invocation behind wrapper flags', () => {
    expect(hook('env -i git stash pop', multi).status).toBe(2)
  })

  it('lets non-stash commands mentioning stash through', () => {
    expect(hook('echo "git stash pop"', multi).status).toBe(0)
    expect(hook('ls my-stash-dir | grep stash', multi).status).toBe(0)
    expect(hook('git commit -m "note: run git stash pop later; then clean"', multi).status).toBe(0)
  })

  it('still catches a stash inside a command substitution', () => {
    expect(hook('echo "$(git stash pop)"', multi).status).toBe(2)
  })

  it('allows read-only stash subcommands', () => {
    expect(hook('git stash list', multi).status).toBe(0)
    expect(hook('git stash show stash@{0}', multi).status).toBe(0)
  })

  it('reads the base branch from the commit subject when the reflog message was overridden', () => {
    const r = hook('git stash pop stash@{0}', restored) // main worktree is on 'main'
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'other'")
    expect(hook('git stash pop stash@{0}', rwt).status).toBe(0)
  })

  // Amend-rule fixtures. The hazard is same-DIRECTORY concurrency (one index,
  // many agents), so unlike the stash rules these repos are single-worktree on
  // purpose: the rule must apply there too.
  const amendGrow = makeRepo('amend-guard-grow-') // HEAD: base commit (f.txt)
  writeFileSync(join(amendGrow, 'f2.txt'), 'x\n')
  git(amendGrow, ['add', 'f2.txt'])
  git(amendGrow, ['commit', '-qm', 'second']) // commit being amended touches only f2.txt
  writeFileSync(join(amendGrow, 'foreign.txt'), 'y\n')
  git(amendGrow, ['add', 'foreign.txt']) // another session's staged work

  const amendSame = makeRepo('amend-guard-same-')
  writeFileSync(join(amendSame, 'f2.txt'), 'x\n')
  git(amendSame, ['add', 'f2.txt'])
  git(amendSame, ['commit', '-qm', 'second'])
  writeFileSync(join(amendSame, 'f2.txt'), 'x2\n')
  git(amendSame, ['add', 'f2.txt']) // re-staged file already in the commit

  const amendAll = makeRepo('amend-guard-all-')
  writeFileSync(join(amendAll, 'f2.txt'), 'x\n')
  git(amendAll, ['add', 'f2.txt'])
  git(amendAll, ['commit', '-qm', 'second'])
  writeFileSync(join(amendAll, 'f.txt'), 'drift\n') // tracked, modified, UNSTAGED

  it('blocks an amend that grows the file set beyond the amended commit', () => {
    const r = hook('git commit --amend -m reworded', amendGrow)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('foreign.txt')
  })

  it('allows an amend whose staged files are all in the amended commit', () => {
    expect(hook('git commit --amend -m reworded', amendSame).status).toBe(0)
    expect(hook('git commit --amend --no-edit', single).status).toBe(0) // nothing staged
  })

  it('includes unstaged tracked changes when the amend uses -a', () => {
    expect(hook('git commit --amend -m reworded', amendAll).status).toBe(0)
    const r = hook('git commit --amend -am reworded', amendAll)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('f.txt')
  })

  it('still compares the index for include-mode amends, sparing the named files', () => {
    const r = hook('git commit --amend -i -m x f2.txt', amendGrow)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('foreign.txt')
    expect(r.stderr).not.toContain('f2.txt')
    // patch mode with a pathspec keeps the index in the commit as well
    expect(hook('git commit --amend --patch f2.txt', amendGrow).status).toBe(2)
  })

  it('spares an include-named file that is already staged and new to the commit', () => {
    const repo = makeRepo('amend-guard-include-')
    writeFileSync(join(repo, 'f2.txt'), 'x\n')
    git(repo, ['add', 'f2.txt'])
    git(repo, ['commit', '-qm', 'second'])
    writeFileSync(join(repo, 'brandnew.txt'), 'y\n')
    git(repo, ['add', 'brandnew.txt']) // staged, outside the commit being amended
    // naming it via -i is deliberate scope for THAT file…
    expect(hook('git commit --amend -i -m x brandnew.txt', repo).status).toBe(0)
    // …but an unnamed amend still counts it as growth.
    expect(hook('git commit --amend -m x', repo).status).toBe(2)
  })

  it('blocks an amend behind an unresolvable cd target, allows a resolvable one', () => {
    const r = hook('cd "$WT" && git commit --amend --no-edit', amendGrow)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('not a literal path')
    // the -C spelling of the same escape hatch fails closed too
    const rc = hook('git -C "$WT" commit --amend --no-edit', amendGrow)
    expect(rc.status).toBe(2)
    expect(rc.stderr).toContain('not a literal path')
    // resolvable cd: judged from the clean target repo, not the dirty cwd
    expect(hook(`cd ${amendSame} && git commit --amend -m x`, amendGrow).status).toBe(0)
  })

  it('measures a merge commit by its first-parent delta', () => {
    const merged = makeRepo('amend-guard-merge-')
    git(merged, ['checkout', '-qb', 'feat'])
    writeFileSync(join(merged, 'm.txt'), 'feature\n')
    git(merged, ['add', 'm.txt'])
    git(merged, ['commit', '-qm', 'feat work'])
    git(merged, ['checkout', '-q', 'main'])
    git(merged, ['merge', '-q', '--no-ff', '--no-edit', 'feat'])
    // m.txt is in the merge's first-parent delta: re-staging it is not growth…
    writeFileSync(join(merged, 'm.txt'), 'feature v2\n')
    git(merged, ['add', 'm.txt'])
    expect(hook('git commit --amend -m reworded', merged).status).toBe(0)
    // …but a file outside the merge's scope still is.
    writeFileSync(join(merged, 'other.txt'), 'y\n')
    git(merged, ['add', 'other.txt'])
    const r = hook('git commit --amend -m reworded', merged)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('other.txt')
  })

  it('lets an explicit pathspec or AMEND_OK=1 through, and plain commits alone', () => {
    expect(hook('git commit --amend -m x -- f2.txt', amendGrow).status).toBe(0)
    expect(hook('AMEND_OK=1 git commit --amend -m x', amendGrow).status).toBe(0)
    // …in both spellings: whole-command prefix and invocation-local prefix.
    expect(hook('AMEND_OK=1 true; git commit --amend -m x', amendGrow).status).toBe(0)
    expect(hook('true && AMEND_OK=1 git commit --amend -m x', amendGrow).status).toBe(0)
    expect(hook('git commit -m "new commit"', amendGrow).status).toBe(0)
  })

  it('stays out of the way outside a repo or on a garbled payload', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stash-guard-norepo-')))
    expect(hook('git stash pop', outside).status).toBe(0)
    expect(hook('', multi, 'not json').status).toBe(0)
  })
})
