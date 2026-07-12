import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { createPublicContractSnapshot } from '../src/v2/public-api/contract-snapshot.ts'

const baselinePath = 'contracts/v1/public-contract-baseline.json'
mkdirSync(dirname(baselinePath), { recursive: true })
writeFileSync(baselinePath, `${JSON.stringify(createPublicContractSnapshot(), null, 2)}\n`, 'utf8')
process.stdout.write(`Updated ${baselinePath}\n`)
