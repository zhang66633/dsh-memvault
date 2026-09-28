/**
 * Run the MemVault CLI — the one transport this plugin uses for *writes*.
 *
 * Both write paths go through it (turn extraction and panel block edits), for
 * the same reasons:
 *
 *   - REST (`POST /api/v1/...`) needs the FastAPI server alive on 8780; a write
 *     that silently stops because a second process is down is worse than a
 *     process spawn.
 *   - A direct SQLite write bypasses MemVault's own semantics (validation, the
 *     `block.updated` event, extraction + embeddings for memories) and produces
 *     rows the store cannot score.
 *
 * The cost is one Python process per call, which is why callers throttle.
 *
 * Two details are load-bearing and were both learned the hard way:
 *
 *   - the child's environment forces UTF-8 (`PYTHONUTF8`/`PYTHONIOENCODING`);
 *     without it the CLI decodes its stdin with the host locale codec (cp936
 *     here), a character GBK cannot represent becomes a lone surrogate, and
 *     httpx then dies with "surrogates not allowed";
 *   - on failure the **tail** of stderr is kept, because a Python traceback puts
 *     the actual exception last.
 */
import { spawn as nodeSpawn } from 'node:child_process'

/** argv for a `python -m memvault.cli …` call. */
export function buildCliInvocation({ pythonPath, projectDir, args = [] }) {
  return { command: pythonPath, args: ['-m', 'memvault.cli', ...args], cwd: projectDir }
}

/**
 * Spawn the CLI and resolve with its output. Never rejects: a write path is a
 * side channel and must not throw into whatever is driving it.
 *
 * @param options.config - `{ pythonPath, projectDir, timeoutMs, env }`.
 * @param options.args - CLI arguments after `memvault.cli`.
 * @param options.stdin - optional string written to the child's stdin.
 * @param options.spawn - injectable spawn (tests).
 * @returns {Promise<{ok: boolean, stdout?: string, stderr?: string, error?: string}>}
 */
export function runCli({ config, args, stdin = null, spawn = nodeSpawn }) {
  return new Promise((resolve) => {
    const { command, args: argv, cwd } = buildCliInvocation({ ...config, args })
    let child
    try {
      child = spawn(command, argv, {
        cwd,
        env: { ...process.env, ...(config.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, error: `spawn failed: ${error.message}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({ ok: false, error: `timed out after ${config.timeoutMs ?? 120_000}ms` })
    }, config.timeoutMs ?? 120_000)

    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, error: `exit ${code}: ${stderr.trim().slice(-700)}`, stdout, stderr })
        return
      }
      finish({ ok: true, stdout, stderr })
    })

    try {
      if (stdin === null) child.stdin?.end()
      else child.stdin?.end(stdin)
    } catch (error) {
      finish({ ok: false, error: `stdin failed: ${error.message}` })
    }
  })
}
