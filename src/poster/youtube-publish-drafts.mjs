// v1.3.20: drena rascunhos residuais do YT (videos que ficaram em rascunho pq
// upload-yt.ps1 nao conseguiu publicar — verificacao ainda rodando ou layout
// inesperado do modal). Roda em paralelo via cron 15min em main.js.

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveScriptDir() {
  const devDir = path.join(__dirname, '..', 'winControl')
  const sourceFiles = ['win32.ps1', 'upload-yt.ps1', 'publish-drafts.ps1']
  const devOk = sourceFiles.every(f => fs.existsSync(path.join(devDir, f)))
  if (devOk && !devDir.includes('app.asar')) return devDir
  const tmpDir = path.join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp', 'postmaster-winctl')
  fs.mkdirSync(tmpDir, { recursive: true })
  for (const f of sourceFiles) {
    const srcF = path.join(devDir, f)
    const dstF = path.join(tmpDir, f)
    try { fs.copyFileSync(srcF, dstF) } catch (e) { throw new Error(`Falha ao extrair ${f}: ${e.message}`) }
  }
  return tmpDir
}

/**
 * Roda publish-drafts.ps1 pra um canal e retorna {published: N, raw: stdout}.
 * Skipa silenciosamente se nao tiver channelId salvo, ou se lock do upload-yt
 * estiver ativo (o PS detecta sozinho).
 */
export async function publishDraftsForAccount({ account, dataDir, log, maxToPublish = 5, visibility = 'public' }) {
  if (!account || !dataDir) throw new Error('account e dataDir obrigatorios')

  const channelFile = path.join(dataDir, 'sessions', `yt-${account}.channelId`)
  if (!fs.existsSync(channelFile)) {
    log?.(`[drafts ${account}] sem .channelId salvo - skip`)
    return { published: 0, skipped: true, reason: 'no-channelid' }
  }
  const channelId = fs.readFileSync(channelFile, 'utf-8').trim()
  if (!/^UC[\w-]+$/.test(channelId)) {
    log?.(`[drafts ${account}] channelId invalido '${channelId}' - skip`)
    return { published: 0, skipped: true, reason: 'bad-channelid' }
  }

  const scriptDir = resolveScriptDir()
  const ps = path.join(scriptDir, 'publish-drafts.ps1')
  if (!fs.existsSync(ps)) {
    log?.(`[drafts ${account}] publish-drafts.ps1 nao encontrado em ${ps}`)
    return { published: 0, skipped: true, reason: 'no-script' }
  }

  log?.(`[drafts ${account}] iniciando drenagem (canal ${channelId}, max ${maxToPublish})`)

  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ps,
      '-ChannelId', channelId,
      '-MaxToPublish', String(maxToPublish),
      '-Visibility', visibility,
    ], { windowsHide: false })

    let output = ''
    proc.stdout.on('data', d => {
      const s = d.toString()
      output += s
      s.split(/\r?\n/).forEach(line => {
        const t = line.replace(/[\r\n]+$/, '')
        if (t) log?.(`   [drafts ${account}] ${t}`)
      })
    })
    proc.stderr.on('data', d => log?.(`   [drafts ${account}] ⚠️ ${d.toString().replace(/[\r\n]+/g, ' ')}`))

    proc.on('exit', (code) => {
      const m = output.match(/DRAFTS_PUBLISHED:(\d+)/)
      const published = m ? parseInt(m[1], 10) : 0
      log?.(`[drafts ${account}] fim (exit ${code}) - ${published} publicado(s)`)
      resolve({ published, skipped: false, exitCode: code })
    })
    proc.on('error', (e) => {
      log?.(`[drafts ${account}] erro spawn: ${e.message}`)
      resolve({ published: 0, skipped: true, reason: 'spawn-error', error: e.message })
    })
  })
}
