import { createRequire } from 'node:module'

/** Injected by the release bundler (esbuild --define); absent when running from source. */
declare const __VARA_VERSION__: string | undefined

/** Version: the release bundle carries it; from source/dist it comes from package.json. */
export const VERSION: string = (() => {
  if (typeof __VARA_VERSION__ !== 'undefined') return __VARA_VERSION__
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version
  } catch {
    return 'dev'
  }
})()
