// AskAnina on Mobile Safari in the iOS Simulator: sign in with a fresh test account, every onboarding
// step (Anina Cloud for "Where your data lives"), Today, a reload, Settings. Driven by Appium's
// XCUITest driver (Safari's web context). Fails on an error notice, an uncaught JS error or a step
// that does not move on in 20 s. Screenshots and logs go to ./out (uploaded by the workflow).
//
// Environment: APP_URL (the web app), API_BASE (its server), TEST_ACCOUNT_TOKEN (GitHub secret),
// SIM_UDID, SIM_NAME, SIM_VERSION (scripts/pick-simulator.mjs), APPIUM_PORT (default 4723).
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { remote } from 'webdriverio'

const STEP_MS = 20_000
const OUT = 'out'
mkdirSync(OUT, { recursive: true })

const env = (name, fallback = '') => (process.env[name] ?? fallback).trim()
const ALLOWED_HOSTS = /(^|\.)askanina\.com$/
function checkedUrl(raw, what) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.test(url.hostname)) throw new Error(`${what} must be an https address on askanina.com: ${raw}`)
  return url.href.replace(/\/+$/, '')
}
const APP_URL = checkedUrl(env('APP_URL') || 'https://app.askanina.com', 'APP_URL')
const API_BASE = checkedUrl(env('API_BASE') || 'https://askanina.com/v3', 'API_BASE')
const TOKEN = env('TEST_ACCOUNT_TOKEN')
const UDID = env('SIM_UDID')
const label = `${env('SIM_NAME', 'iPhone')} iOS ${env('SIM_VERSION', '?')}`

const steps = []
const consoleLines = []
const secrets = []
// The password also in the forms Appium's log may show it: whole, or as a list of characters.
const forms = (secret) => [secret, secret.split('').map((c) => JSON.stringify(c)).join(','), secret.split('').map((c) => JSON.stringify(c)).join(', ')]
const redact = (text) => secrets.flatMap(forms).reduce((out, secret) => out.split(secret).join('***'), String(text))
const say = (...parts) => console.log(redact(parts.join(' ')))
let shotNumber = 0
let driver
let reached = 'start'

function summary(ok, failure) {
  const lines = [
    `## ${ok ? 'PASS' : 'FAIL'}: AskAnina on Mobile Safari, ${label}`,
    '',
    `App: ${APP_URL}`,
    `Reached: **${reached}**`,
    failure ? `\nFailure: \`${redact(failure).slice(0, 600)}\`` : '',
    '',
    '| # | Step | Took | Note |',
    '|---|------|------|------|',
    ...steps.map((s, i) => `| ${i + 1} | ${s.name} | ${s.ms} ms | ${redact(s.note ?? '').replace(/\|/g, '/')} |`),
  ]
  const text = lines.join('\n') + '\n'
  writeFileSync(`${OUT}/summary.md`, text)
  writeFileSync(`${OUT}/steps.json`, redact(JSON.stringify({ ok, label, appUrl: APP_URL, reached, failure: failure ?? null, steps }, null, 2)))
  writeFileSync(`${OUT}/safari-console.json`, redact(JSON.stringify(consoleLines, null, 2)))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
}

async function newTestAccount() {
  if (!TOKEN) throw new Error('No TEST_ACCOUNT_TOKEN (the repository secret ASKANINA_TEST_TOKEN) is set')
  const response = await fetch(`${API_BASE}/deploy/test-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Account-Token': TOKEN },
    body: JSON.stringify({ locale: 'en' }),
  })
  if (!response.ok) throw new Error(`Test account: the server answered ${response.status} (deployed with POST /deploy/test-accounts? token right?)`)
  const account = await response.json()
  secrets.push(account.password)
  // GitHub hides it in the public log from here on.
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${account.password}`)
  say(`test account ${account.email} (deleted by the server after 24 h)`)
  return account
}

async function shot(name) {
  const file = `${OUT}/${String(++shotNumber).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/gi, '-')}.png`
  try {
    await driver.saveScreenshot(file)
  } catch {
    try {
      execFileSync('xcrun', ['simctl', 'io', UDID || 'booted', 'screenshot', file])
    } catch (error) {
      say('screenshot failed:', error.message)
    }
  }
}

const UNCAUGHT = /^(Uncaught|Unhandled|TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|Error:)/
async function readConsole() {
  let entries = []
  try {
    entries = await driver.getLogs('safariConsole')
  } catch {
    return []
  }
  const problems = []
  for (const entry of entries) {
    let message = entry.message
    try {
      message = typeof message === 'string' ? JSON.parse(message) : message
    } catch {
      // A plain line.
    }
    const level = String(message?.level ?? entry.level ?? '').toLowerCase()
    const text = String(message?.messageText ?? message?.text ?? (typeof message === 'string' ? message : JSON.stringify(message)))
    consoleLines.push({ at: new Date(entry.timestamp ?? Date.now()).toISOString(), level, text, url: message?.url, line: message?.line })
    if (level === 'error' && UNCAUGHT.test(text.trim())) problems.push(text)
  }
  return problems
}

// Collects uncaught errors in the page itself too (what happens between console reads).
const COLLECTOR = () => {
  if (window.__iosTest) return
  window.__iosTest = []
  window.addEventListener('error', (e) => window.__iosTest.push(`Uncaught ${e.message} at ${e.filename}:${e.lineno}`))
  window.addEventListener('unhandledrejection', (e) => window.__iosTest.push(`Unhandled rejection: ${e.reason && (e.reason.stack || e.reason.message || e.reason)}`))
}

async function problems() {
  const found = []
  try {
    await driver.execute(COLLECTOR)
    const page = await driver.execute(() => ({
      errors: (window.__iosTest || []).splice(0),
      notices: [...document.querySelectorAll('.notice--error')].map((n) => n.textContent.trim().replace(/\s+/g, ' ')),
    }))
    found.push(...page.errors, ...page.notices.map((n) => `Error notice: ${n}`))
  } catch (error) {
    found.push(`Page not readable: ${error.message}`)
  }
  found.push(...(await readConsole()))
  return found
}

async function check(where) {
  const found = await problems()
  if (found.length) throw new Error(`${where}: ${found.join(' | ')}`)
}

const state = () =>
  driver.execute(() => {
    const q = (s) => document.querySelector(s)
    return {
      hash: location.hash,
      title: (q('.onboarding__title')?.textContent ?? '').trim(),
      count: (q('.onboarding__count')?.textContent ?? '').trim(),
      login: !!q('#login-email'),
      onboarding: !!q('.onboarding'),
      today: !!q('.today-content'),
      settings: !!q('section.settings'),
      busy: !!q('.onboarding__actions [disabled]'),
    }
  })

async function waitFor(what, test) {
  const started = Date.now()
  let last
  while (Date.now() - started < STEP_MS) {
    try {
      last = await state()
      if (test(last)) return last
    } catch (error) {
      last = { error: error.message }
    }
    const found = await problems()
    if (found.length) throw new Error(`${what}: ${found.join(' | ')}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${what}: nothing happened in ${STEP_MS / 1000} s (last: ${JSON.stringify(last)})`)
}

async function step(name, run) {
  const started = Date.now()
  reached = name
  say(`- ${name}`)
  const note = await run()
  steps.push({ name, ms: Date.now() - started, note: note ?? '' })
  await shot(name)
}

/** Clicks the element a script marked (Safari's web context clicks it like a tap). */
async function clickMarked(mark) {
  const element = await driver.$(`[data-ios-test="${mark}"]`)
  await element.waitForExist({ timeout: STEP_MS })
  await element.click()
}

async function main() {
  driver = await remote({
    hostname: '127.0.0.1',
    port: Number(env('APPIUM_PORT', '4723')),
    path: '/',
    logLevel: 'warn',
    connectionRetryTimeout: 15 * 60_000,
    connectionRetryCount: 1,
    capabilities: {
      platformName: 'iOS',
      browserName: 'Safari',
      'appium:automationName': 'XCUITest',
      ...(UDID ? { 'appium:udid': UDID } : {}),
      ...(env('SIM_VERSION') ? { 'appium:platformVersion': env('SIM_VERSION') } : {}),
      ...(env('SIM_NAME') ? { 'appium:deviceName': env('SIM_NAME') } : {}),
      'appium:showSafariConsoleLog': true,
      'appium:newCommandTimeout': 600,
      'appium:wdaLaunchTimeout': 10 * 60_000,
      'appium:wdaConnectionTimeout': 10 * 60_000,
      'appium:simulatorStartupTimeout': 5 * 60_000,
      'appium:webviewConnectTimeout': 60_000,
      'appium:safariInitialUrl': `${APP_URL}/`,
    },
  })
  say('Safari session ready on', label)

  await step('open', async () => {
    await driver.url(`${APP_URL}/#/login`)
    await driver.execute(COLLECTOR)
    await waitFor('the sign-in page', (s) => s.login)
  })

  // Only now the account: Safari and the app are checked first, also without the server's token.
  const account = await newTestAccount()

  await step('sign-in', async () => {
    const email = await driver.$('#login-email')
    await email.setValue(account.email)
    const password = await driver.$('#login-password')
    await password.setValue(account.password)
    await shot('sign-in-filled')
    await driver.execute(() => document.querySelector('form button[type="submit"]')?.setAttribute('data-ios-test', 'submit'))
    await clickMarked('submit')
    const s = await waitFor('signing in', (x) => x.onboarding && !!x.title)
    return s.hash
  })

  // Like a real user who confirms the e-mail in the Mail app (2026-11-17, the first iPhone user got stuck
  // right after this): Safari goes to the background for a while and comes back. iOS may close the
  // page's IndexedDB connections meanwhile; everything after this must still work.
  const appSwitch = async (why) => {
    await step(`app-switch-${why}`, async () => {
      await driver.execute('mobile: backgroundApp', { seconds: 15 })
      await driver.pause(2000)
      await check(`after switching apps (${why})`)
      return 'Safari 15 s in the background and back'
    })
  }
  await appSwitch('after-sign-in')

  // Every step of the sign up: "Next" is the last button of the footer (Start free on the plans, Start at the end).
  const seen = new Set()
  for (let round = 0; round < 20; round++) {
    const s = await state()
    if (!s.onboarding) break
    const name = new URLSearchParams(s.hash.split('?')[1] ?? '').get('step') ?? 'welcome'
    if (seen.has(s.hash + s.title)) throw new Error(`Onboarding came back to ${name}`)
    seen.add(s.hash + s.title)
    await step(`onboarding-${name}`, async () => {
      await check(`onboarding ${name}`)
      let note = `${s.count}: ${s.title}`
      // "Where your data lives": the first card is Anina Cloud.
      const storage = await driver.execute(() => {
        const cards = [...document.querySelectorAll('section.onboarding__panel .onboarding__choices .onboarding__choice')]
        if (!cards.length) return null
        cards[0].setAttribute('data-ios-test', 'cloud')
        return cards.map((c) => c.querySelector('strong')?.textContent?.trim())
      })
      if (storage) {
        if (!/anina cloud/i.test(storage[0] ?? '')) throw new Error(`The first storage card is not Anina Cloud: ${storage.join(', ')}`)
        // Away once more right on this step, where the first iPhone user got stuck.
        await driver.execute('mobile: backgroundApp', { seconds: 15 })
        await driver.pause(2000)
        note += ' / back from 15 s in the background'
        await clickMarked('cloud')
        await waitFor('choosing Anina Cloud', () => true)
        const chosen = await driver.execute(() => document.querySelector('[data-ios-test="cloud"]')?.getAttribute('aria-checked'))
        if (chosen !== 'true') throw new Error('Anina Cloud could not be selected (locked in the plan?)')
        await shot('storage-anina-cloud')
        note += ' / Anina Cloud chosen'
      }
      await waitFor(`${name}: the buttons are ready`, (x) => !x.busy)
      const button = await driver.execute(() => {
        const buttons = [...document.querySelectorAll('.onboarding__actions button')].filter((b) => !b.disabled)
        const last = buttons[buttons.length - 1]
        last?.setAttribute('data-ios-test', 'next')
        return last?.textContent?.trim() ?? null
      })
      if (!button) throw new Error(`${name}: no button to go on`)
      await clickMarked('next')
      await waitFor(`${name} → next step (tapped "${button}")`, (x) => !x.onboarding || x.hash + x.title !== s.hash + s.title)
      return `${note} / tapped "${button}"`
    })
  }

  await step('today', async () => {
    const s = await waitFor('Today after the sign up', (x) => x.today && !x.onboarding && !x.login)
    await check('Today')
    return s.hash
  })

  await step('reload', async () => {
    await driver.execute(() => location.reload())
    await new Promise((r) => setTimeout(r, 2000))
    const s = await waitFor('Today after a reload (still signed in and onboarded)', (x) => x.today || x.login || x.onboarding)
    if (s.login) throw new Error('After the reload the app asks to sign in again')
    if (s.onboarding) throw new Error('After the reload the app shows the sign up again')
    await driver.execute(COLLECTOR)
    await check('after the reload')
    return s.hash
  })

  await step('settings', async () => {
    await driver.execute(() => {
      location.hash = '#/settings'
    })
    const s = await waitFor('Settings', (x) => x.settings)
    await check('Settings')
    return s.hash
  })
  reached = 'settings (all steps passed)'
}

let failure
try {
  await main()
} catch (error) {
  failure = error?.message ?? String(error)
  say('FAILED:', failure)
  if (driver) await shot('failure')
} finally {
  if (driver) {
    try {
      await readConsole()
    } catch {
      // The session is gone.
    }
  }
  summary(!failure, failure)
  if (driver) await driver.deleteSession().catch(() => {})
  // The logs are public artifacts: no password in them.
  for (const file of [`${OUT}/appium.log`]) {
    if (existsSync(file)) writeFileSync(file, redact(readFileSync(file, 'utf8')))
  }
}
say(failure ? `FAIL (${label}), reached: ${reached}` : `PASS (${label})`)
process.exit(failure ? 1 : 0)
