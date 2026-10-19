import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { encodeSubtitleSidecar } from '../../src/v2/domain/subtitle-sidecar.ts'

test('W69 real Chromium native getCueAsHTML preserves literal <b>&amp; without a B node', { timeout: 45000 }, async () => {
  const { chromium } = await import('playwright-core')
  const executablePath = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find((path) => path && existsSync(path))
  assert.ok(executablePath, 'native cue proof requires an actual Chromium executable')
  const literal = '<b>&amp; <00:00:00.100> &lt; >'
  const encoded = encodeSubtitleSidecar({ format: 'vtt', locale: 'pt-BR', cues: [{
    cueId: 'literal-1', startFrame: 0, endFrame: 30, startMs: 0, endMs: 1000, text: literal,
  }] })
  let browser
  try {
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20000 })
    const page = await browser.newPage()
    // Local native HTMLTrackElement loads the actual encoded bytes; no private
    // runtime hooks, parser mocks or fake browser stand in for WebVTT parsing.
    await page.goto('data:text/html,<video></video>')
    const result = await page.evaluate(async (bytes) => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'text/vtt' }))
      const track = document.createElement('track')
      let timer
      try {
        const loaded = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('native track load timeout')), 5000)
          track.addEventListener('load', resolve, { once: true })
          track.addEventListener('error', () => reject(new Error('native track load failed')), { once: true })
        })
        track.kind = 'subtitles'
        track.src = url
        document.querySelector('video').append(track)
        track.track.mode = 'hidden'
        await loaded
        const cue = track.track.cues[0]
        const fragment = cue.getCueAsHTML()
        return { count: track.track.cues.length, text: fragment.textContent,
          elementCount: fragment.querySelectorAll('*').length,
          boldCount: fragment.querySelectorAll('b').length, start: cue.startTime, end: cue.endTime }
      } finally {
        clearTimeout(timer)
        track.remove()
        URL.revokeObjectURL(url)
      }
    }, [...encoded.bytes])
    assert.deepEqual(result, { count: 1, text: literal, elementCount: 0, boldCount: 0, start: 0, end: 1 })
  } finally {
    await browser?.close()
  }
})
