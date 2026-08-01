/**
 * Parses translate-cli stdout for `key=value` output lines.
 *
 * translate-cli emits exactly three lines to stdout (and nothing else):
 *   keys_translated=42
 *   languages_completed=de,fr,ja
 *   languages_failed=zh-Hans
 *
 * WHY parseInt(val, 10) || 0:
 * Intentional NaN coercion, not a silent data-loss bug. parseInt returns NaN
 * only for fully non-numeric strings. parseInt("0", 10) returns 0 — `0 || 0`
 * is still 0, no false zero. translate-cli always emits a clean integer; the
 * || 0 guard exists only to prevent NaN propagating to setOutput/summary on a
 * hypothetical future malformed line. Do NOT replace with Number() — it is
 * less strict about leading-digit strings like "1abc".
 *
 * WHY rest.join('=') NOT rest[0]:
 * Handles the (unlikely) case where a value itself contains '=' characters.
 * Splitting on '=' and re-joining the tail is safer than assuming one '='.
 */
export function parseOutput(stdout: string): {
  keysTranslated: number
  languagesCompleted: string[]
  languagesFailed: string[]
} {
  const lines = stdout.split('\n')
  let keysTranslated = 0
  let languagesCompleted: string[] = []
  let languagesFailed: string[] = []

  for (const line of lines) {
    const [key, ...rest] = line.split('=')
    const val = rest.join('=').trim()
    switch (key?.trim()) {
      case 'keys_translated':
        keysTranslated = parseInt(val, 10) || 0
        break
      case 'languages_completed':
        languagesCompleted = val ? val.split(',').map(s => s.trim()).filter(Boolean) : []
        break
      case 'languages_failed':
        languagesFailed = val ? val.split(',').map(s => s.trim()).filter(Boolean) : []
        break
    }
  }

  return { keysTranslated, languagesCompleted, languagesFailed }
}
