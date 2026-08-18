#!/usr/bin/env node
import { sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const [sourceCommit, sourceVersion, bundleHash, url, size, sha256, output] = process.argv.slice(2)
const privateKey = process.env.DSH_RUNTIME_SIGNING_PRIVATE_KEY
if (!privateKey) throw new Error('DSH_RUNTIME_SIGNING_PRIVATE_KEY is required')
if (![sourceCommit, sourceVersion, bundleHash, url, size, sha256, output].every(Boolean)) {
  throw new Error('usage: create-runtime-index.mjs <commit> <version> <bundleHash> <url> <size> <sha256> <output>')
}

const payload = [
  'dsh-runtime-v1',
  sourceCommit,
  sourceVersion,
  bundleHash,
  url,
  size,
  sha256,
  '',
].join('\n')
const signature = sign(null, Buffer.from(payload), privateKey).toString('hex')
const index = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit,
  sourceVersion,
  bundleHash,
  artifact: { url, size: Number(size), sha256 },
  signature,
}
writeFileSync(output, JSON.stringify(index, null, 2) + '\n')
