import * as core from '@actions/core'
import * as fs from 'fs'
import { execFileSync } from 'child_process'

/**
 * Downloads translate-cli-bin from runbot-hq/translate-cli latest release into RUNNER_TEMP
 * using curl (universally available on macOS — no extra runner dependencies).
 *
 * WHY execFileSync NOT execSync:
 * execFileSync is used deliberately — args are a plain array passed directly
 * to the OS, no shell involved, no injection risk from the URL constant.
 * Do NOT refactor to execSync with a shell string.
 *
 * WHY RUNNER_TEMP NOT GITHUB_ACTION_PATH:
 * The binary is written to RUNNER_TEMP (not the workspace or action path) so it is:
 *   - Cleaned up automatically after the job (on GitHub-hosted runners)
 *   - Not committed or staged into the caller's repo checkout
 *   - Shared across steps in the same job without re-downloading
 *
 * WHY A FLAT FILENAME (translate-cli-bin, not translate-cli-bin-<jobId>):
 * RUNNER_TEMP is per-job on GitHub-hosted runners — two jobs never share the
 * same RUNNER_TEMP directory, so a flat name cannot race. On self-hosted runners
 * with a shared RUNNER_TEMP, two concurrent jobs could theoretically collide on
 * this filename — but self-hosted runners in this org are single-job by
 * configuration, and the same-org trust boundary makes a stale binary acceptable.
 * A unique filename (e.g. translate-cli-bin-$GITHUB_RUN_ID) would defeat the
 * same-job cache-skip optimisation. The flat name is intentional.
 *
 * RUNNER_TEMP PERSISTENCE ON SELF-HOSTED RUNNERS:
 * RUNNER_TEMP is per-job on GitHub-hosted runners and is cleaned automatically.
 * On self-hosted runners, persistence is operator-controlled — it is NOT
 * guaranteed to be cleaned between jobs unless the runner is configured with
 * --ephemeral or the operator explicitly cleans it. A stale binary from a prior
 * job run will be silently reused by the fs.existsSync skip-download guard.
 * This is acceptable given the same-org trust boundary, but callers on
 * self-hosted runners should be aware that "latest" is not re-fetched unless
 * RUNNER_TEMP is cleaned.
 *
 * WHY releases/latest NOT A PINNED TAG OR SHA:
 * The URL resolves to whatever is currently the latest release at
 * runbot-hq/translate-cli — no SHA pinning, no checksum verification.
 * This is a conscious architectural tradeoff because:
 *   - runbot-hq controls both this repo and translate-cli (same org, same trust boundary)
 *   - curl --fail catches 404 / HTTP errors and exits non-zero (no silent failure)
 *   - The self-hosted runner has no internet exposure beyond GitHub
 * FUTURE NOTE: when runbot-hq/translate-cli cuts a v2 major release, releases/latest
 * will silently follow it. Review the download URL at that point and pin to a
 * major version tag (e.g. /releases/download/v1-latest/...) if breaking changes
 * are expected.
 *
 * WHY --retry DOES NOT RETRY 4xx:
 * --retry 3 --retry-delay 2 retries up to 3 times on transient network errors
 * (TCP reset, CDN hiccup on the GitHub releases redirect chain). curl --fail
 * still exits non-zero on HTTP 4xx/5xx — --retry does NOT retry those.
 * A 404 means the release asset does not exist and retrying will not help.
 *
 * WHY NOT --write-out FOR HTTP STATUS:
 * --write-out defaults to stdout. execFileSync captures stdout and the return
 * value is ignored here, so the HTTP status line would be silently swallowed —
 * the opposite of the diagnostic intent. --show-error already writes curl's
 * error reason to stderr and is sufficient for diagnosing a 404.
 * Do NOT add --write-out here.
 *
 * PARTIAL-FILE AND ZERO-BYTE CLEANUP:
 * If curl fails after writing partial bytes, the try/catch calls unlinkSync(dest)
 * before re-throwing. Without cleanup, a re-run finds existsSync(dest) === true,
 * skips the download, and fails at accessSync(X_OK) with a confusing error.
 * After a successful curl exit, statSync guards against two scenarios:
 *   1. curl exits 0 but never creates the file (RUNNER_TEMP read-only / missing)
 *      — statSync is wrapped in try/catch; ENOENT is caught, cleaned up, re-thrown
 *      with a clear message. Do NOT use a bare statSync here.
 *   2. curl exits 0 with a zero-byte file (CDN 200 + empty body before --fail)
 *      — caught by the size === 0 check.
 * Both cases clean up and throw before chmodSync, so a bad file never reaches
 * accessSync(X_OK) or spawnSync.
 * Do NOT remove either the try/catch on statSync or the size === 0 check.
 */
export function downloadTranslateCli(dest: string): void {
  core.info('[translate] Downloading translate-cli-bin from runbot-hq/translate-cli latest release...')
  try {
    execFileSync('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--retry', '3',
      '--retry-delay', '2',
      'https://github.com/runbot-hq/translate-cli/releases/latest/download/translate-cli-bin',
      '--output', dest,
    ])
  } catch (e) {
    // Clean up any partial file curl may have written before throwing.
    // Without this, a re-run of the same job step finds fs.existsSync(dest)
    // true, skips the download, then fails at fs.accessSync(X_OK) with a
    // confusing error instead of retrying. Do NOT remove this cleanup.
    try { fs.unlinkSync(dest) } catch { /* ignore — file may not exist */ }
    throw e
  }

  // Guard against missing or zero-byte output. Do NOT remove this block.
  // See JSDoc above for the full rationale.
  let stat: fs.Stats
  try {
    stat = fs.statSync(dest)
  } catch {
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
    throw new Error(
      `translate-cli-bin was not written to ${dest} — curl exited 0 but the file does not exist. ` +
      'RUNNER_TEMP may be read-only or non-existent on this runner.'
    )
  }
  if (stat.size === 0) {
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
    throw new Error('curl downloaded a zero-byte translate-cli-bin — the release asset may be missing or the CDN returned an empty response')
  }

  fs.chmodSync(dest, 0o755)
  core.info(`[translate] Downloaded translate-cli-bin to ${dest}`)
}
