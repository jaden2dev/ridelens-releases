// Exercise the shipped update UI and installer in a disposable installation.
// Only the announcement/feed transport is redirected to the candidate artifacts.
import { _electron as electron } from 'playwright-core'
import asar from '@electron/asar'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

let [executable, artifactDirectory, outputDirectory] = process.argv.slice(2).map((p) => path.resolve(p))
const targetVersion = process.env.UPDATE_TARGET_VERSION || '0.3.4'
const isWindows = process.platform === 'win32'
const sameVersion = process.env.UPDATE_ALLOW_SAME_VERSION === '1'
const archive = isWindows
  ? path.join(path.dirname(executable), 'resources/app.asar')
  : path.resolve(executable, '../../Resources/app.asar')
const initialArchiveInode = fs.statSync(archive).ino
const installedVersion = () => {
  asar.uncache(archive)
  return JSON.parse(asar.extractFile(archive, 'package.json').toString()).version
}
if (!sameVersion) assert.notEqual(installedVersion(), targetVersion, 'The disposable app must begin at the previous version')
fs.mkdirSync(outputDirectory, { recursive: true })
const downloads = []
const server = http.createServer((req, res) => {
  const name = path.basename(decodeURIComponent(new URL(req.url, 'http://localhost').pathname))
  const file = path.join(artifactDirectory, name)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return }
  downloads.push({ name, size: fs.statSync(file).size })
  console.log(`Update transport: ${name}`)
  res.setHeader('Content-Length', fs.statSync(file).size)
  fs.createReadStream(file).pipe(res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const feed = `http://127.0.0.1:${server.address().port}/`
let app
const errors = []
const launch = async () => {
  const current = await electron.launch({
    executablePath: executable, args: [],
    env: { ...process.env, RIDELENS_E2E_USER_DATA: path.join(outputDirectory, 'user-data') },
  })
  const page = await current.firstWindow()
  await page.evaluate(() => {
    localStorage.setItem('lang', 'ko')
    localStorage.setItem('welcomeSeen', '1')
    localStorage.setItem('guideDoneV2', '1')
    localStorage.setItem('helpHintSeen', '1')
    localStorage.setItem('lowSpecNoticeV1', '1')
  })
  return { current, page }
}
async function announce(page, version) {
  await page.route('https://api.github.com/repos/jaden2dev/ridelens-releases/releases/latest', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tag_name: `v${version}`, html_url: 'https://github.com/jaden2dev/ridelens-releases', body: 'Update validation.' }),
  }))
  await page.reload()
  await page.getByRole('button', { name: /^(?:⚡ )?지금 업데이트$/, exact: false }).waitFor({ timeout: 20000 })
  assert.equal(await page.getByRole('button', { name: '📄 릴리스 노트', exact: true }).count(), 0)
}
try {
  const first = await launch()
  app = first.current
  const oldPid = app.process().pid
  const previousExecutable = executable
  await app.evaluate(async ({ app }, config) => {
    const { createRequire } = process.mainModule.require('node:module')
    const requireApp = createRequire(app.getAppPath() + '/package.json')
    if (config.isWindows) {
      const updater = requireApp('electron-updater').autoUpdater
      updater.setFeedURL({ provider: 'generic', url: config.feed })
      updater.disableDifferentialDownload = true
    } else {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, ...args) => originalFetch(
        (/\/releases\/latest\/download\/(?:RideLens|Ridy-Studio)-Free-mac-arm64\.zip$/).test(String(input))
          ? config.feed + String(input).split('/').pop() : input,
        ...args,
      )
    }
  }, { isWindows, feed })
  const announcement = targetVersion.split('.').map(Number)
  if (sameVersion) announcement[2]++
  await announce(first.page, announcement.join('.'))
  await first.page.screenshot({ path: path.join(outputDirectory, 'update-notice.png') })
  console.log('Verified free-build update notice; starting real download and installation')
  await first.page.getByRole('button', { name: /^(?:⚡ )?지금 업데이트$/, exact: false }).click()
  const deadline = Date.now() + 180000
  let updated = false
  while (Date.now() < deadline) {
    try { updated = installedVersion() === targetVersion && (!sameVersion || (downloads.length > 0 && fs.statSync(archive).ino !== initialArchiveInode)) } catch { /* installer swapping files */ }
    if (updated) break
    if (!first.page.isClosed()) {
      const text = await first.page.locator('.modal-back').allTextContents().catch(() => [])
      if (text.some((value) => value.includes('업데이트 실패'))) throw new Error(text.join('\n'))
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.equal(updated, true, 'Automatic installer did not replace the previous version')
  // Product branding can change the executable name while the installation directory stays stable.
  if (!isWindows) {
    const info = path.resolve(archive, '../../Info.plist')
    const binary = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', info], {encoding:'utf8'}).stdout.trim()
    assert(binary); executable = path.join(path.dirname(executable), binary)
  } else {
    const meta = JSON.parse(asar.extractFile(archive, 'package.json').toString())
    executable = path.join(path.dirname(executable), (meta.productName || 'Ridy Studio') + '.exe')
  }
  // Verify the actual relaunch, rather than manually starting the updated app.
  let relaunched = false
  let processes = ''
  const restartDeadline = Date.now() + 45000
  while (Date.now() < restartDeadline) {
    if (isWindows) {
      const escaped = executable.replace(/'/g, "''")
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-Process | Where-Object { $_.Path -eq '${escaped}' -and $_.Id -ne ${oldPid} -and $_.MainWindowHandle -ne 0 } | Select-Object Id,MainWindowTitle | ConvertTo-Json -Compress`], { encoding: 'utf8' })
      processes = result.stdout.trim()
      relaunched = processes.length > 0
    } else {
      const result = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      processes = result.stdout.split('\n').filter((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line)
        return match && Number(match[1]) !== oldPid &&
          [executable, previousExecutable].some(file => match[2] === file || match[2].startsWith(file + ' '))
      }).join('\n')
      relaunched = processes.length > 0
    }
    if (relaunched) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.equal(relaunched, true, 'Updated app did not automatically relaunch')
  const result = { platform: process.platform, version: installedVersion(), automaticallyRelaunched: relaunched, downloads, processes }
  fs.writeFileSync(path.join(outputDirectory, 'update-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  // Stop only this test's relaunched app, then verify the new build still offers auto-update.
  if (isWindows) {
    const escaped = executable.replace(/'/g, "''")
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process | Where-Object { $_.Path -eq '${escaped}' } | Stop-Process`])
  } else {
    for (const line of processes.split('\n')) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (pid > 0) { try { process.kill(pid, 'SIGTERM') } catch { /* already closed */ } }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const next = await launch()
  app = next.current
  const parts = targetVersion.split('.').map(Number)
  parts[2] += sameVersion ? 2 : 1
  await announce(next.page, parts.join('.'))
  await next.page.screenshot({ path: path.join(outputDirectory, 'new-build-update-gate.png') })
  console.log('Verified new packaged free build still offers automatic updates')
} catch (error) {
  errors.push(String(error.stack || error))
  fs.writeFileSync(path.join(outputDirectory, 'update-errors.json'), JSON.stringify(errors, null, 2))
  throw error
} finally {
  if (app) await app.close().catch(() => {})
  server.close()
}
