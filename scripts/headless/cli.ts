import {join} from 'node:path'
import {createInterface} from 'node:readline/promises'
import {acquirePidfile, releasePidfile} from '../../packages/agent-dispatch/src/pidfile'
import {setAuthStorage} from '@/services/authStorage'
import {readConfig} from './config'

async function main() {
  const [action, file] = process.argv.slice(2)
  const config = await readConfig(file)
  const lock = {file: join(config.stateDir, 'headless.pid'), daemonName: 'headless'}
  await acquirePidfile(lock)
  try {
    if (!process.execArgv.includes(`--localstorage-file=${join(config.stateDir, 'device.sqlite')}`)) {
      throw new Error('Start this host with pnpm headless to select its persistent device storage')
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
        await runHost(config, sessionUserToAppUser(session), controller.signal)
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
