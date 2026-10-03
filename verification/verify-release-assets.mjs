import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const directory = path.resolve(process.argv[2])
const feed = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'))
assert.equal(feed.version, process.env.UPDATE_TARGET_VERSION || '0.3.4')
const file = feed.files.find((entry) => entry.url.endsWith('.exe'))
assert(file)
assert.equal(file.url, path.basename(file.url))
const data = fs.readFileSync(path.join(directory, file.url))
assert.equal(data.subarray(0, 2).toString(), 'MZ')
const sha512 = crypto.createHash('sha512').update(data).digest('base64')
assert.equal(file.size, data.length)
assert.equal(file.sha512, sha512)
assert.equal(feed.path, file.url)
assert.equal(feed.sha512, sha512)
assert(fs.statSync(path.join(directory, file.url + '.blockmap')).size > 0)
console.log(JSON.stringify({ version: feed.version, file: file.url, size: data.length, sha512, sha256: crypto.createHash('sha256').update(data).digest('hex') }, null, 2))
