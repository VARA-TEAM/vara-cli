import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Must run before any test module imports src/**: path resolution in
// src/config/paths.ts reads VARA_HOME at import time. Without this, tests
// would write sessions and vault data into the real ~/.vara.
process.env['VARA_HOME'] = mkdtempSync(join(tmpdir(), 'vara-test-'))
