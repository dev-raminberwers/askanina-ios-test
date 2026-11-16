# AskAnina iOS Safari test

An automated check of the AskAnina web app on **Mobile Safari in the iOS Simulator**, on GitHub's
hosted macOS runners. It holds only the test runner and the workflow: no app source, no secrets.

What one run does, per iOS version (the newest runtime on the runner, plus an older one: an older
major version when one is preinstalled, else the oldest other runtime, e.g. 26.2 beside 26.5):

1. asks the AskAnina server for a fresh test account (pre-confirmed, not set up yet, deleted by the
   server after 24 hours), with the repository secret `ASKANINA_TEST_TOKEN`;
2. opens the web app in Safari, signs in, and goes through every sign-up step, choosing
   Anina Cloud at "Where your data lives";
3. checks that Today opens, reloads and checks it is still signed in and set up, then opens Settings.

It fails on an error notice in the app, an uncaught JavaScript error (from Safari's console, read
through the Web Inspector by Appium) or a step that does not move on within 20 seconds. Every step's
screenshot, the Safari console, Appium's log and a summary are uploaded as the run's artifacts.

## How it works

* `scripts/pick-simulator.mjs` chooses an iPhone simulator with `xcrun simctl` and boots it.
* [Appium](https://appium.io) with the XCUITest driver drives Safari (its web context).
* `run.mjs` is the test (WebdriverIO client).

## Running it

* Actions › *iOS Safari sign-up test* › Run workflow (optionally another `url`, askanina.com only), or
* `repository_dispatch` with the event type `ios-test` (optional `client_payload.url`).

## License

MIT
