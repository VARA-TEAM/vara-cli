import { loadConfig } from '../config/config.js'
import { VERSION } from '../version.js'
import { packagedRoot, rollback, runUpdate } from './updater.js'

/** `vara update [--check] [--rollback] [--force]` */
export async function updateCommand(args: string[]): Promise<void> {
  if (args.includes('--rollback')) {
    const r = await rollback()
    console.log(`Rolled back to ${r.restored}. Run "vara update --rollback" again to return to the newer one.`)
    return
  }
  if (packagedRoot() === null) {
    console.log('This copy of VARA was not installed from a download, so it cannot update itself.')
    console.log('Update it the way you installed it (git pull / npm install), or reinstall from https://github.com/VARA-TEAM/vara-cli/releases')
    return
  }
  const checkOnly = args.includes('--check')
  const r = await runUpdate({ apply: !checkOnly, force: args.includes('--force') }, { log: (l) => console.log(l) })
  if (r.status === 'up-to-date') console.log(`VARA ${VERSION} is the latest version.`)
  else if (r.status === 'available') console.log(`VARA ${r.latest} is available (you have ${r.current}). Run: vara update`)
  else console.log(`Updated VARA ${r.current} → ${r.latest}. It takes effect the next time you start vara. Undo with: vara update --rollback`)
  if (checkOnly || r.status === 'up-to-date') {
    const cfg = await loadConfig().catch(() => null)
    if (cfg && !cfg.updates.check) console.log('(The automatic "update available" notice is off: /settings → Updates.)')
  }
}
