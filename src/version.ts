import { createRequire } from 'node:module'

/** Version from package.json (src/ and dist/ both sit one level below the root). */
export const VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version
  } catch {
    return 'dev'
  }
})()
