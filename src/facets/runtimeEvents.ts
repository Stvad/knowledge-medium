export const appRuntimeUpdateEvent = 'app-runtime-update'

export const refreshAppRuntime = () => {
  // eslint-disable-next-line no-restricted-syntax -- genuine broadcast: fan-out to every mounted runtime subscriber, not a dialog/toggle
  window.dispatchEvent(new CustomEvent(appRuntimeUpdateEvent, {
    detail: new Date().toISOString(),
  }))
}
