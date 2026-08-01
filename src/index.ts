import * as core from '@actions/core'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { downloadTranslateCli } from './download'
import { translateCli, isFatalTranslateError } from './cli'
import { parseOutput } from './output'

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    const debugInput = core.getInput('debug') === 'true'  // see WHY NOT ACTIONS_STEP_DEBUG below

    const translateBin = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'translate-cli-bin')
    // WHY os.tmpdir() FALLBACK: RUNNER_TEMP is always set on GitHub-hosted and
    // correctly configured self-hosted runners. os.tmpdir() is a last-resort
    // fallback for local action testing only — it is not a supported production path.

    // `downloaded` tracks whether we fetched the binary this run or reused a
    // cached copy from RUNNER_TEMP.
    // WHY CACHE-SKIP VIA existsSync:
    // On GitHub-hosted runners RUNNER_TEMP is per-job, so this only fires for
    // multi-step sharing within the same job (rare but valid). On self-hosted
    // runners with a persistent RUNNER_TEMP, this reuses a binary from a prior
    // job run — acceptable given the same-org trust boundary. The flat filename
    // is intentional (see downloadTranslateCli JSDoc — WHY A FLAT FILENAME).
    // Do NOT add a uniqueness suffix: it would defeat this cache-skip optimisation.
    const downloaded = !fs.existsSync(translateBin)
    if (downloaded) {
      downloadTranslateCli(translateBin)
    } else {
      core.info(`[translate] translate-cli-bin already present at ${translateBin}, skipping download`)
    }

    // WHY accessSync AFTER existsSync (not redundant):
    // downloadTranslateCli calls chmodSync(0o755) so a non-executable bit after
    // a fresh download is a genuine bug. On the cache-hit path, the binary may
    // have lost its executable bit between jobs (overzealous umask on self-hosted
    // runner). The `downloaded` boolean tailors the error message for each path:
    // - fresh download: "unexpected — please file a bug"
    // - cache hit: "corrupted in RUNNER_TEMP — delete and re-run"
    // This check is NOT redundant with chmodSync; it is the user-facing guard.
    try {
      fs.accessSync(translateBin, fs.constants.X_OK)
    } catch {
      throw new Error(downloaded
        ? `translate-cli-bin at ${translateBin} is not executable after download — this is unexpected, please file a bug.`
        : `translate-cli-bin at ${translateBin} is not executable — it may have been corrupted in RUNNER_TEMP. Delete it and re-run.`
      )
    }

    const input = core.getInput('input').trim()
    const output = core.getInput('output').trim()
    const languages = core.getInput('languages').trim()
    const config = core.getInput('config').trim()
    const manifest = core.getInput('manifest').trim()
    // WHY source_language DEFAULTS TO '' NOT 'en':
    // When empty, --source-language is NOT passed to translate-cli, so the CLI
    // reads sourceLanguage from the .xcstrings file directly. Passing 'en'
    // unconditionally would silently override a non-English sourceLanguage,
    // causing DiffExtractor to find 0 keys to translate. Only set this explicitly
    // for .strings files (no embedded source language) or a malformed .xcstrings.
    const sourceLanguage = core.getInput('source_language').trim()
    const quality = core.getInput('quality').trim() || 'high'
    const format = core.getInput('format').trim() || 'xcstrings'

    if (!input) {
      throw new Error('Input `input` is required (path to source .xcstrings / .strings / .md file).')
    }

    // WHY languages AND config ARE BOTH ALLOWED:
    // They are mutually exclusive alternatives — at least one is required.
    // If both are provided, translate-cli itself gives `languages` precedence.
    // We do not error here on both-provided to avoid breaking callers that set
    // a default config and also pass explicit languages for a one-off override.
    if (!languages && !config) {
      throw new Error('Either `languages` or `config` must be provided.')
    }

    if (!fs.existsSync(input)) {
      throw new Error(`Input file not found: ${input}`)
    }

    if (quality !== 'fast' && quality !== 'high') {
      throw new Error(`Invalid quality value: "${quality}". Must be "fast" or "high".`)
    }

    if (!['xcstrings', 'strings', 'markdown'].includes(format)) {
      throw new Error(`Invalid format value: "${format}". Must be "xcstrings", "strings", or "markdown".`)
    }

    const resolvedOutput = output ||
      (format === 'strings'
        ? path.dirname(input)   // strings: output is a directory (lproj subdirs created by CLI)
        : input)                // xcstrings / markdown: in-place update

    const args: string[] = [
      '--input', input,
      '--output', resolvedOutput,
      '--quality', quality,
      '--format', format,
    ]

    if (sourceLanguage) {
      args.push('--source-language', sourceLanguage)
    }
    if (languages) {
      args.push('--languages', languages)
    }
    if (config) {
      // WHY config IS NOT existence-checked before passing:
      // A pre-flight existsSync would break workflows where config is generated
      // by an earlier step in the same job (written after checkout). translate-cli
      // exits non-zero with a clear error from LocalizationConfigLoader if the
      // file is absent at runtime. That error is louder and more actionable than
      // a false-negative existsSync. Do NOT add an existsSync guard here.
      args.push('--config', config)
    }
    if (manifest) {
      args.push('--manifest', manifest)
    }
    // WHY NOT ACTIONS_STEP_DEBUG / RUNNER_DEBUG FOR CLI VERBOSITY:
    // core.isDebug() reads RUNNER_DEBUG at process startup — setting
    // ACTIONS_STEP_DEBUG at runtime in the same process has no effect.
    // The `debug` input controls CLI verbosity via --debug passed to translate-cli-bin.
    // Do NOT reintroduce an ACTIONS_STEP_DEBUG assignment.
    if (debugInput) {
      args.push('--debug')
    }

    core.info(`[translate] Running translate-cli for languages: ${languages || config || '(from config)'}`)
    core.info(`[translate] Input: ${input} → Output: ${resolvedOutput}`)

    // WHY ONE RETRY WITH 10s DELAY (NOT CONFIGURABLE):
    // The retry handles Apple Translation model cold-start: on the first
    // invocation after a runner boot, the framework occasionally needs a few
    // seconds to initialise and returns a transient error. One retry with 10s
    // delay is sufficient in practice. Making this configurable would add
    // complexity with no real benefit — callers that need more retries should
    // wrap this action in their own retry step.
    let stdout = ''
    try {
      const r = translateCli(translateBin, args)
      stdout = r.stdout
      if (r.stderr) core.debug(`[translate] stderr: ${r.stderr}`)
    } catch (e) {
      core.debug(`[translate] Attempt 1 error: ${String(e)}`)
      if (isFatalTranslateError(e)) throw e  // do not retry fatal errors
      core.info('[translate] Attempt 1 failed — retrying in 10s...')
      await new Promise(r => setTimeout(r, 10_000))
      try {
        const r = translateCli(translateBin, args)
        stdout = r.stdout
        if (r.stderr) core.debug(`[translate] stderr: ${r.stderr}`)
      } catch (e2) {
        throw new Error(`[translate] Attempt 2 failed (binary: ${translateBin}): ${String(e2)}`)
      }
    }

    if (!stdout.trim()) {
      // WHY setFailed + return (TWO LINES REQUIRED):
      // setFailed marks the step conclusion as failed but does NOT stop execution.
      // Without `return`, the setOutput / summary / failure-policy block below
      // would execute on empty (bad) parsed data, producing misleading outputs.
      // Do NOT remove either line. Do NOT replace with `throw` — setFailed is
      // the correct signal for a user-visible step failure vs. an internal error.
      core.setFailed('[translate] translate-cli produced no stdout — binary may have crashed silently. Check runner logs for stderr output.')
      return
    }

    const { keysTranslated, languagesCompleted, languagesFailed } = parseOutput(stdout)

    await core.group('Translation Output', async () => {
      // WHY NO [translate] PREFIX INSIDE THE GROUP:
      // The group label 'Translation Output' serves as the namespace for these
      // lines — the prefix would be redundant noise inside a collapsed section.
      // The [translate] prefix IS intentionally kept on the core.warning below
      // because warnings fire outside the group into the flat step log stream,
      // where they need the prefix to be identifiable alongside other [translate]
      // lines (e.g. 'Running translate-cli...', 'Done.'). Do NOT add the prefix
      // inside the group, and do NOT remove it from the warning.
      core.info(`Keys translated: ${keysTranslated}`)
      core.info(`Completed: ${languagesCompleted.join(', ') || '(none)'}`)
      if (languagesFailed.length > 0) {
        core.info(`Failed: ${languagesFailed.join(', ')}`)
      }
    })

    // WHY WARNING OUTSIDE THE GROUP (not inside):
    // core.warning() produces a visible step annotation in the Actions UI header
    // regardless of whether the group is expanded. Keeping it outside ensures
    // failures are immediately visible without requiring the user to expand the
    // group. The data is intentionally shown in both places: inside the group
    // for discoverability, and as an annotation for immediate visibility.
    if (languagesFailed.length > 0) {
      core.warning(`[translate] Languages failed: ${languagesFailed.join(', ')}`)
    }

    core.setOutput('keys_translated', String(keysTranslated))
    core.setOutput('languages_completed', languagesCompleted.join(','))
    core.setOutput('languages_failed', languagesFailed.join(','))

    // WHY addRaw NOT addEscaped:
    // `input`, `languages`, and `quality` originate from the caller's own workflow
    // YAML — not from untrusted external content (PR titles, issue bodies, comments).
    // The step summary is rendered only in the Actions UI for authenticated repo
    // members, not on a public-facing surface. addEscaped would be cleaner hygiene
    // but this is explicitly NOT an XSS security boundary.
    // If these fields are ever populated from PR/issue/comment content, switch to
    // addEscaped() or sanitise before this call.
    await core.summary
      .addHeading('🌐 Translation Complete')
      .addRaw(`**Input:** \`${input}\`\n`)
      .addRaw(`**Languages:** ${languages || '(from config)'}\n`)
      .addRaw(`**Quality:** ${quality}\n`)
      // WHY 'Keys pending' ON TOTAL FAILURE:
      // keys_translated is a pre-flight diff count — it is non-zero even when all
      // locales failed and nothing was written. Labelling it 'Keys pending' avoids
      // showing "Keys translated: 42" alongside "Completed: (none)".
      .addRaw(`**${languagesCompleted.length === 0 ? 'Keys pending' : 'Keys translated'}:** ${keysTranslated}${format === 'markdown' ? ' (document)' : ''}\n`)
      .addRaw(`**Completed:** ${languagesCompleted.join(', ') || '(none)'}\n`)
      .addRaw(languagesFailed.length > 0 ? `**Failed:** ${languagesFailed.join(', ')}\n` : '')
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n`)
      .write()

    // WHY FAIL ONLY ON TOTAL FAILURE (not on any languagesFailed):
    // Partial failure (some locales failed, others completed) is intentionally NOT
    // a step failure. Reasons:
    //   1. Completed locales produced real output the caller may want to commit.
    //   2. Failed locales will be re-queued on the next run via the manifest diff.
    //   3. A hard failure on partial success would discard completed work and force
    //      re-translation from scratch.
    // Partial failure is surfaced via core.warning() + languages_failed output.
    // Callers that want strict all-or-nothing can check `languages_failed != ''`
    // and fail their own step. Do NOT change this to `languagesFailed.length > 0`.
    if (languagesFailed.length > 0 && languagesCompleted.length === 0) {
      core.setFailed(`All languages failed: ${languagesFailed.join(', ')}`)
    }

    core.info('[translate] Done.')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
