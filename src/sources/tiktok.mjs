/**
 * Fonte TikTok: lista e baixa videos de um perfil publico via yt-dlp.
 * Perfis publicos do TikTok funcionam SEM precisar de login.
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import ffmpegStaticOriginal from 'ffmpeg-static'
import { getCookiesForPlatform } from './cookies.mjs'

const execAsync = promisify(exec)

const ffmpegStatic = ffmpegStaticOriginal
  ? ffmpegStaticOriginal.replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/').replace(/\\/g, '/')
  : null

function resolveYtDlp() {
  try {
    if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'bin', 'yt-dlp.exe')))
      return `"${path.join(process.resourcesPath, 'bin', 'yt-dlp.exe')}"`
  } catch {}
  const devBin = path.join(process.cwd(), 'bin', 'yt-dlp.exe')
  if (fs.existsSync(devBin)) return `"${devBin}"`
  return 'yt-dlp'
}
const YTDLP = resolveYtDlp()

async function execYtDlpWithRetry(cmd, opts, log, tries = 3) {
  let last
  for (let i = 1; i <= tries; i++) {
    try {
      return await execAsync(cmd, opts)
    } catch (e) {
      last = e
      const msg = String(e?.message || e).split('\n')[0].slice(0, 120)
      log?.(`   yt-dlp TikTok tentativa ${i}/${tries} falhou: ${msg}`)
      if (i < tries) await new Promise(r => setTimeout(r, 1500 * i))
    }
  }
  throw last
}

function loadState(file) {
  try {
    let raw = fs.readFileSync(file, 'utf-8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)  // v1.3.28: strip BOM
    return JSON.parse(raw)
  }
  catch (e) {
    try { console.error('[tt loadState] FALHA:', e?.message, file) } catch {}
    return { ultimoCanal: 0, postados: [], falhou: [] }
  }
}
function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2))
}

export async function buscarVideoTiktok(handles, stateFile, log, filtros = {}, dataDir = null, jobId = null) {
  const { minDur = 5, maxDur = 600, maxVideos = 10, keywordInclude = '', keywordExclude = '', onlyNew = true } = filtros

  // v1.2.1: aceita URL completa (tiktok.com/@handle), com @, ou so o handle
  const lista = handles.split(/[,\n]/).map(h => {
    let s = h.trim()
    if (!s) return ''
    s = s.replace(/^https?:\/\/(www\.)?(vm\.|m\.)?tiktok\.com\//i, '')
    s = s.replace(/^@/, '')
    s = s.split(/[\/?#]/)[0]
    return s
  }).filter(Boolean)
  if (!lista.length) throw new Error('Nenhum perfil de TikTok configurado')

  const state = onlyNew ? loadState(stateFile) : { postados: [], falhou: [] }
  const vistos = new Set([...(state.postados || []), ...(state.falhou || [])])

  const idx = (state.ultimoCanal || 0) % lista.length
  const handle = lista[idx]
  state.ultimoCanal = idx + 1
  saveState(stateFile, state)

  const url = `https://www.tiktok.com/@${handle}`
  log(`📱 Perfil TikTok: @${handle}`)

  // Cookies opcionais (TikTok publico funciona sem, mas tendo ajuda contra rate-limit)
  const cookies = dataDir ? getCookiesForPlatform('tiktok', dataDir) : null
  const cookiesArg = cookies ? `--cookies "${cookies}"` : ''
  // v1.3.31: sem Referer o Akamai devolve pagina de ~1.4KB e o yt-dlp cai
  // com "Unexpected response from webpage request" / "universal data for rehydration".
  const refererArg = '--referer "https://www.tiktok.com/"'

  const { stdout } = await execYtDlpWithRetry(
    `${YTDLP} ${cookiesArg} ${refererArg} --flat-playlist --playlist-end ${maxVideos} --print "%(id)s\t%(duration)s\t%(title)s" "${url}"`,
    { timeout: 60000, windowsHide: true },
    log,
  )

  const kwInclude = keywordInclude ? keywordInclude.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : []
  const kwExclude = keywordExclude ? keywordExclude.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : []

  const candidatos = stdout.split('\n').filter(l => l.trim())
    .map(l => { const p = l.split('\t'); return { id: p[0]?.trim(), duracao: parseFloat(p[1])||0, titulo: p[2]?.trim() || '', sourceHandle: handle } })
    .filter(v => {
      if (!v.id) return false
      if (v.duracao && (v.duracao < minDur || v.duracao > maxDur)) return false
      if (vistos.has(v.id)) return false
      const t = v.titulo.toLowerCase()
      if (kwInclude.length && !kwInclude.some(k => t.includes(k))) return false
      if (kwExclude.length &&  kwExclude.some(k => t.includes(k))) return false
      return true
    })

  log(`   ${candidatos.length} candidatos`)
  return candidatos
}

export async function baixarVideoTiktok(video, downloadsDir, prefix, log, dataDir = null) {
  fs.mkdirSync(downloadsDir, { recursive: true })
  const ts = Date.now()
  const out = path.join(downloadsDir, `${prefix}_${ts}.%(ext)s`)
  const ffmpegDir = ffmpegStatic ? path.dirname(ffmpegStatic) : ''
  const ffmpegArg = ffmpegDir ? `--ffmpeg-location "${ffmpegDir}"` : ''
  const cookies = dataDir ? getCookiesForPlatform('tiktok', dataDir) : null
  const cookiesArg = cookies ? `--cookies "${cookies}"` : ''
  const url = `https://www.tiktok.com/@${video.sourceHandle}/video/${video.id}`

  log('⬇️ Baixando do TikTok...')
  const refererArg = '--referer "https://www.tiktok.com/"'
  await execYtDlpWithRetry(
    `${YTDLP} ${cookiesArg} ${ffmpegArg} ${refererArg} -f "best[ext=mp4]/best/bv*+ba/b" --merge-output-format mp4 -o "${out}" "${url}"`,
    { timeout: 180000, windowsHide: true },
    log,
  )

  const files = fs.readdirSync(downloadsDir)
    .filter(f => f.startsWith(`${prefix}_${ts}`) && f.endsWith('.mp4'))
  if (!files.length) throw new Error('MP4 nao encontrado apos download')
  return path.resolve(path.join(downloadsDir, files[0]))
}

export function marcarPostadoTk(stateFile, id) {
  const s = loadState(stateFile)
  if (!s.postados.includes(id)) s.postados.push(id)
  saveState(stateFile, s)
}
export function marcarFalhouTk(stateFile, id) {
  const s = loadState(stateFile)
  if (!s.falhou.includes(id)) s.falhou.push(id)
  saveState(stateFile, s)
}
