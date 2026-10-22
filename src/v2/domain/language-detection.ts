/**
 * Turning what a speech-recognition provider reports as the language of a speech into a BCP-47 tag, deterministically (ADR-160 F3).
 *
 * Whisper-family providers report the language they detected as the English name of the language ("portuguese", "english"), sometimes as a
 * code ("pt"). A name is resolved through the same data the platform carries for display names (`Intl.DisplayNames`, English, over the two
 * letter ISO 639-1 codes) plus the few names Whisper uses that the display data spells otherwise. What cannot be resolved is not guessed:
 * the result is `null`, and the transcript records the undetermined language (`und`).
 */
const WHISPER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  castilian: 'es', flemish: 'nl', moldavian: 'ro', moldovan: 'ro', valencian: 'ca', 'haitian creole': 'ht', haitian: 'ht',
  letzeburgesch: 'lb', panjabi: 'pa', pushto: 'ps', sinhalese: 'si', myanmar: 'my', burmese: 'my', 'norwegian nynorsk': 'nn',
})

let namesToCodes: ReadonlyMap<string, string> | undefined

function languageNames(): ReadonlyMap<string, string> {
  if (namesToCodes) return namesToCodes
  const display = new Intl.DisplayNames(['en'], { type: 'language' })
  const names = new Map<string, string>()
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  for (const first of letters) {
    for (const second of letters) {
      const code = `${first}${second}`
      let name: string | undefined
      try { name = display.of(code) } catch { name = undefined }
      if (name === undefined || name.toLowerCase() === code) continue
      const key = name.toLowerCase()
      if (!names.has(key)) names.set(key, code)
    }
  }
  namesToCodes = names
  return names
}

/** The BCP-47 tag a provider's language report stands for, or `null` when it cannot be resolved without guessing. */
export function normalizeDetectedLanguage(reported: unknown): string | null {
  if (typeof reported !== 'string') return null
  const text = reported.trim()
  if (text.length === 0 || text.length > 64) return null
  if (/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(text)) {
    try {
      const canonical = Intl.getCanonicalLocales(text.replace('_', '-'))[0]
      return canonical === undefined || canonical === 'und' ? null : canonical
    } catch { return null }
  }
  const key = text.toLowerCase().replace(/\s+/g, ' ')
  const code = WHISPER_ALIASES[key] ?? languageNames().get(key)
  return code ?? null
}

/** The primary language subtag of a tag, lower case (`pt-BR` -> `pt`). */
export function primaryLanguageSubtag(tag: string): string {
  return tag.trim().split(/[-_]/)[0]!.toLowerCase()
}
