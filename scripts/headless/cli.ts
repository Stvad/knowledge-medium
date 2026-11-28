import {join} from 'node:path'
import {createInterface} from 'node:readline/promises'
import {acquirePidfile, releasePidfile} from '../../packages/agent-dispatch/src/pidfile'
import {setAuthStorage} from '@/services/authStorage'
import {DEVICE_STORAGE_FILENAME, PID_FILENAME, readConfig} from './config'

async function readStorageValue(): Promise<string> {
  const input = process.stdin
  const interactive = input.isTTY === true
  // Terminal mode disables kernel echo and keeps line editing. With no
  // output stream, readline has nowhere to display the typed characters.
  const prompt = createInterface({input, terminal: interactive, crlfDelay: Infinity})
  try {
    if (interactive) process.stderr.write('Storage value: ')
    for await (const line of prompt) return line
    throw new Error('No storage value received on stdin')
  } finally {
    prompt.close()
    if (interactive) process.stderr.write('\n')
  }
}

async function main() {
  const [action, file, option] = process.argv.slice(2)
  const config = await readConfig(file)
  const lock = {file: join(config.stateDir, PID_FILENAME), daemonName: 'headless'}
  await acquirePidfile(lock)
  try {
    if (!process.execArgv.includes(`--localstorage-file=${join(config.stateDir, DEVICE_STORAGE_FILENAME)}`)) {
      throw new Error('Start this host with pnpm headless to select its persistent device storage')
    }
    if (action === 'storage') {
      const value = await readStorageValue()
      localStorage.setItem(option, value)
      return
    }
    setAuthStorage(globalThis.localStorage)
    const {supabase, sessionUserToAppUser} = await import('@/services/supabase')
    if (!supabase) throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY')
    try {
      if (action === 'login') {
        const prompt = createInterface({input: process.stdin, output: process.stdout})
        try {
          const email = (await prompt.question('Member email: ')).trim()
          const sent = await supabase.auth.signInWithOtp({email})
          if (sent.error) throw sent.error
          const token = (await prompt.question('Emailed code: ')).trim()
          const verified = await supabase.auth.verifyOtp({email, token, type: 'email'})
          if (verified.error) throw verified.error
        } finally {
          prompt.close()
        }
        return
      }

      const controller = new AbortController()
      const terminate = () => controller.abort()
      const {data: {subscription}} = supabase.auth.onAuthStateChange(event => {
        if (event === 'SIGNED_OUT') controller.abort(new Error('Session ended. Run headless login.'))
      })
      process.once('SIGTERM', terminate)
      process.once('SIGINT', terminate)
      try {
        const {restoreHeadlessSession} = await import('./session')
        const session = await restoreHeadlessSession(supabase.auth)
        const {runHost} = await import('./host')
        await runHost(config, sessionUserToAppUser(session), controller.signal, supabase, option === '--release-stale-queue')
      } finally {
        process.off('SIGTERM', terminate)
        process.off('SIGINT', terminate)
        subscription.unsubscribe()
      }
    } finally {
      await supabase.auth.stopAutoRefresh()
    }
  } finally {
    await releasePidfile(lock)
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Headless host failed')
  process.exitCode = 1
}
// The PID lock and host resources are released before any extension-owned handles are discarded.
await Promise.all([process.stdout, process.stderr].map(stream =>
  new Promise<void>(resolve => { stream.write('', () => resolve()) }),
))
process.exit()
