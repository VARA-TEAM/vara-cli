import { getMasterKey } from '../../src/security/vault.js'

const { key } = await getMasterKey()
console.log(key.toString('hex'))
