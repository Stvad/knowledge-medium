/**
 * Whether a process with this pid exists. EPERM means it exists but may not
 * be signalled from here (another user's, or outside a sandbox that limits
 * signals to its own), so it counts as alive: only "no such process" is gone.
 */
export const pidAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
