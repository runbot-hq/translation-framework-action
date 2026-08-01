import * as core from '@actions/core'
import { spawnSync } from 'child_process'

/**
 * Calls translate-cli-bin via spawnSync with an explicit argv array.
 *
 * WHY spawnSync NOT execSync:
 * spawnSync passes args directly to the OS as an argv array — no shell
 * metacharacter expansion. User-supplied values (language codes, file paths)
 * cannot escape as shell injection via spaces, semicolons, backticks, $(), etc.
 * Do NOT refactor to execSync with a shell string.
 *
 * WHY translate-cli-bin NOT translate-cli:
 * The binary is named translate-cli-bin (not translate-cli) to avoid a POSIX
 * name collision with the Swift source package directory of the same name if
 * the repos are ever co-located. Callers must use translate-cli-bin. Do NOT
 * rename it or add a symlink named translate-cli.
 *
 * WHY 300s TIMEOUT:
 * 5 minutes per attempt. With one retry this means up to ~10 min wall time
 * (5m attempt 1 + 10s delay + 5m attempt 2). Large repos with many locales
 * and long .xcstrings files legitimately take several minutes. This is
 * intentional — do NOT reduce the timeout without profiling against a large
 * real-world .xcstrings file. A timeout surfaces as result.error (ETIMEDOUT),
 * which is non-fatal and will be retried by the caller.
 *
 * WHY 10MB maxBuffer:
 * translate-cli stdout is three key=value lines (≤30 bytes total). The 10 MB
 * ceiling exists only to prevent a pathological binary crash from filling the
 * Node.js buffer and OOMing the runner process. It will never be reached in
 * normal operation.
 */
export function translateCli(bin: string, args: string[]): { stdout: string; stderr: string } {
  if (core.isDebug()) {
    core.debug(`[translate] spawnSync: ${bin} ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`translate-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Returns true if the error is fatal and a retry will not help.
 *
 * Fatal conditions (no point retrying):
 * - Language pack not installed — user must download via System Settings
 * - Unsupported language pair — Apple Translation does not support this pair at all
 * - macOS version too old — runner needs upgrading, not retrying
 * - Permission / MDM policy denied — infrastructure issue, not transient
 *
 * Non-fatal (retry may help): model cold-start, temporary framework crash, I/O blip.
 *
 * WHY SUBSTRING MATCHING NOT EXACT MATCHING:
 * Apple's error messages are not versioned or guaranteed stable. We match on
 * the most stable sub-phrase rather than the full string to avoid breaking on
 * minor Apple framework wording changes. The match table is verified:
 *   'translation framework requires macos 26+' → 'requires macos 26'  ✔
 *   'language pack not installed for ...'      → 'language pack not installed'  ✔
 *   'unsupported language pair: xx-YY'         → 'unsupported language pair'  ✔
 *   permission/sandbox errors                  → 'eacces' / 'not authorized'  ✔
 *
 * COUPLING NOTE — two matches are owned by THIS codebase, not by Apple:
 *   'unsupported language pair' → TranslationEngineError.unsupportedPair.description (TranslationEngine.swift)
 *   'requires macos 26'         → TranslationEngineError.requiresmacOS26.description  (TranslationEngine.swift)
 * If either Swift description string changes, the corresponding match here silently
 * stops firing: the error will be retried instead of immediately failed. Always
 * update both files together when changing these strings.
 *
 * macOS 26.0–26.3 caveat: LanguageAvailability preflight requires 26.4. On earlier
 * versions, a missing language pack throws an opaque Apple error that may NOT match
 * 'language pack not installed'. In that case this function returns false and the
 * error is retried once — harmless but inefficient. If you observe spurious retries
 * on 26.0–26.3 for missing packs, identify the opaque substring and add it here.
 */
export function isFatalTranslateError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('language pack not installed') ||
    msg.includes('unsupported language pair') ||
    msg.includes('requires macos 26') ||
    msg.includes('eacces') ||
    msg.includes('not authorized') ||
    msg.includes('mdm policy')
  )
}
