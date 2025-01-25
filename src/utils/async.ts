/**
 * Creates a Promise that resolves after a specified delay
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise<void>} A promise that resolves after the specified delay
 */
export const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))
