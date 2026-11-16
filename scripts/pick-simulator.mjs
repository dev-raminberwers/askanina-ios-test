// Picks and boots an iPhone simulator on the GitHub macOS runner.
//   node scripts/pick-simulator.mjs newest   -> the newest iOS runtime installed
//   node scripts/pick-simulator.mjs older    -> an older major iOS version, else the oldest other runtime (none: udid empty)
// Prints `udid=`, `name=`, `version=` lines for $GITHUB_OUTPUT (udid empty: no such runtime here).
// Everything else goes to stderr.
import { execFileSync } from 'node:child_process'

const which = process.argv[2] === 'older' ? 'older' : 'newest'
const log = (...parts) => console.error('[simulator]', ...parts)
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const json = (...args) => JSON.parse(simctl(...args, '-j'))
const versionKey = (v) => v.split('.').map((n) => n.padStart(4, '0')).join('.')

const runtimes = json('list', 'runtimes', 'available').runtimes
  .filter((r) => r.isAvailable !== false && (r.platform === 'iOS' || /\.iOS-/.test(r.identifier)))
  .sort((a, b) => versionKey(b.version).localeCompare(versionKey(a.version)))
log('iOS runtimes:', runtimes.map((r) => r.version).join(', ') || 'none')

let runtime = runtimes[0]
if (which === 'older' && runtime) {
  const major = Number(runtime.version.split('.')[0])
  // An older major version when there is one, else the oldest other runtime (e.g. 26.2 beside 26.5).
  runtime = runtimes.find((r) => Number(r.version.split('.')[0]) < major) ?? (runtimes.length > 1 ? runtimes[runtimes.length - 1] : undefined)
}
if (!runtime) {
  log(`no ${which} iOS runtime on this runner`)
  console.log('udid=')
  process.exit(0)
}

// Plain current iPhones first (the common phone), then any iPhone.
const PREFERRED = [/^iPhone 16$/, /^iPhone 17$/, /^iPhone 15$/, /^iPhone 16e$/, /^iPhone \d+$/, /^iPhone \d+ Pro$/, /^iPhone/]
const devices = (json('list', 'devices', 'available').devices[runtime.identifier] ?? []).filter((d) => d.isAvailable !== false)
let device
for (const pattern of PREFERRED) {
  device = devices.find((d) => pattern.test(d.name))
  if (device) break
}
if (!device) {
  // No device for this runtime yet: make one from a supported iPhone type.
  const types = (runtime.supportedDeviceTypes ?? []).filter((t) => /iPhone/.test(t.name))
  let type
  for (const pattern of PREFERRED) {
    type = types.find((t) => pattern.test(t.name))
    if (type) break
  }
  if (!type) {
    log(`no iPhone device type for iOS ${runtime.version}`)
    console.log('udid=')
    process.exit(0)
  }
  const udid = simctl('create', `${type.name} (test)`, type.identifier, runtime.identifier).trim()
  device = { udid, name: type.name, state: 'Shutdown' }
  log('created', device.name, udid)
}

log(`using ${device.name} on iOS ${runtime.version} (${device.udid})`)
if (device.state !== 'Booted') {
  try {
    simctl('boot', device.udid)
  } catch (error) {
    log('boot:', error.message)
  }
}
simctl('bootstatus', device.udid, '-b')
// Safari's first start (its own set-up) before the test, so the test meets a warm browser.
try {
  simctl('launch', device.udid, 'com.apple.mobilesafari')
  execFileSync('sleep', ['15'])
  simctl('terminate', device.udid, 'com.apple.mobilesafari')
} catch (error) {
  log('Safari warm-up:', error.message)
}
console.log(`udid=${device.udid}`)
console.log(`name=${device.name}`)
console.log(`version=${runtime.version}`)
