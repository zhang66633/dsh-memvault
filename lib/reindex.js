/**
 * Ask MemVault to re-embed, or to report what that would cost.
 *
 * Dry run is the default and the caller has to opt in to writing: switching embedders spends
 * one API call per changed row and sends memory text off the machine, so the number comes
 * first. The CLI is the same one the rest of the write half drives, and it prints one JSON
 * object, which is what this returns.
 */
import { spawnSync } from 'node:child_process'

export function runReindex({ pythonPath, projectDir, env, apply = false, timeoutMs = 15 * 60 * 1000 } = {}) {
  if (!pythonPath || !projectDir) return { ok: false, error: 'MemVault python/project not configured' }
  const args = ['-m', 'memvault.cli', 'reindex']
  if (apply) args.push('--apply')
  const result = spawnSync(pythonPath, args, {
    cwd: projectDir,
    env: { ...env, PYTHONUTF8: '1' },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error) return { ok: false, error: String(result.error.message ?? result.error) }
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || '').trim().split(String.fromCharCode(10)).slice(-3).join(' | ')
    return { ok: false, error: tail || ('exit ' + String(result.status)) }
  }
  try {
    return { ok: true, report: JSON.parse(result.stdout) }
  } catch {
    return { ok: false, error: 'the CLI did not print one JSON object' }
  }
}
