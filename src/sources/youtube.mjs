/**
 * Busca e baixa vídeos de canais do YouTube via yt-dlp.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import ffmpegStaticOriginal from 'ffmpeg-static'
import sharp from 'sharp'

const execAsync = promisify(exec)

// IMPORTANTE: ffmpeg-static retorna caminho dentro de app.asar (virtual).
// Executaveis nao rodam de dentro do asar — precisa apontar pra app.asar.unpacked
// (configurado em package.json > build.asarUnpack)
const ffmpegStatic = ffmpegStaticOriginal
  ? ffmpegStaticOriginal.replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/').replace(/\\/g, '/')
  : null
if (!ffmpegStatic) console.warn('[ffmpeg] binario nao encontrado no bundle')

// yt-dlp.exe bundlado em resources/bin (extraResources). Fallback: PATH do sistema.
function resolveBin(name) {
  try {
    const packaged = process.resourcesPath && path.join(process.resourcesPath, 'bin', name)
    if (packaged && fs.existsSync(packaged)) return packaged
  } catch {}
  // Dev: tenta pasta bin local
  const devBin = path.join(process.cwd(), 'bin', name)
  if (fs.existsSync(devBin)) return devBin
  // Próximo: relativo a este arquivo (caso cwd não bata)
  try {
    const here = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', 'bin', name)
    if (fs.existsSync(here)) return here
  } catch {}
  return null
}

function resolveYtDlp() {
  const p = resolveBin('yt-dlp.exe')
  return p ? `"${p}"` : 'yt-dlp'
}
const YTDLP = resolveYtDlp()

// Deno é necessário pelo yt-dlp pra resolver o "n challenge" do YouTube.
// Sem ele: "Only images are available for download". Bundled em bin/deno.exe.
function resolveJsRuntimesArg() {
  const denoPath = resolveBin('deno.exe')
  if (denoPath) return `--js-runtimes "deno:${denoPath}"`
  // Sem deno: yt-dlp tenta auto-descobrir (provavelmente falha em YT recente)
  return ''
}
const JS_RUNTIMES_ARG = resolveJsRuntimesArg()

// YouTube bot detection: 3 estrategias em ordem de prioridade
// 1. Conta YouTube logada no PostMaster (sessions/yt-cookies-*.txt) — recomendado
// 2. Cookies do Chrome do user (--cookies-from-browser) — fallback
// 3. Sem cookies (pode falhar com bot detection) — ultimo caso
let _cookiesArgCache = null
async function getYoutubeCookiesArg(log, dataDir) {
  if (_cookiesArgCache !== null) return _cookiesArgCache

  // 1. Procura cookies.txt salvos por login no PostMaster (Conta YouTube)
  if (dataDir) {
    try {
      const sessionsDir = path.join(dataDir, 'sessions')
      if (fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir).filter(f => f.startsWith('yt-cookies-') && f.endsWith('.txt'))
        if (files.length > 0) {
          const cookiePath = path.join(sessionsDir, files[0])
          _cookiesArgCache = `--cookies "${cookiePath}"`
          log?.(`🍪 Usando cookies da Conta YouTube logada (${files[0]})`)
          return _cookiesArgCache
        }
      }
    } catch {}
  }

  // 2. Fallback: cookies do browser do sistema
  const browsers = ['chrome', 'edge', 'firefox', 'brave', 'opera']
  for (const b of browsers) {
    try {
      const test = await execAsync(`${YTDLP} ${JS_RUNTIMES_ARG} --cookies-from-browser ${b} --print "%(id)s" --no-download "https://www.youtube.com/watch?v=dQw4w9WgXcQ"`, { timeout: 15000, windowsHide: true }).catch(() => null)
      if (test && test.stdout && test.stdout.trim()) {
        _cookiesArgCache = `--cookies-from-browser ${b}`
        log?.(`🍪 Usando cookies do ${b} (fallback — recomendamos logar conta YouTube no app)`)
        return _cookiesArgCache
      }
    } catch {}
  }

  _cookiesArgCache = ''
  log?.('⚠️ Sem cookies disponíveis — adicione conta YouTube em "Contas" pra evitar bot detection')
  return ''
}
const MIN_DUR = 30
const MAX_DUR = 300
const MAX_PLAYLIST = 20

export async function buscarVideoYoutube(urls, stateFile, log, filtros = {}, dataDir = null) {
  const {
    minDur        = MIN_DUR,
    maxDur        = MAX_DUR,
    maxVideos     = MAX_PLAYLIST,
    keywordInclude = '',
    keywordExclude = '',
    onlyNew        = true,
  } = filtros

  const state    = loadState(stateFile)
  const vistos   = onlyNew ? new Set([...(state.postados || []), ...(state.falhou || [])]) : new Set()
  const lista    = urls.split('\n').map(s => s.trim()).filter(Boolean)
  if (!lista.length) throw new Error('Nenhuma URL de canal configurada')

  const idx    = (state.ultimoCanal || 0) % lista.length
  const canal  = lista[idx]
  state.ultimoCanal = idx + 1
  saveState(stateFile, state)
  log(`📺 Canal: ${canal}`)

  // ATENÇÃO: NÃO passar --js-runtimes em Electron empacotado!
  // process.execPath aponta para PostMaster.exe (não node.exe), então o yt-dlp
  // tenta executar o app gráfico como Node — abre janelas em loop e download falha.
  const cookiesArg = await getYoutubeCookiesArg(log, dataDir)
  const { stdout } = await execAsync(
    `${YTDLP} ${JS_RUNTIMES_ARG} ${cookiesArg} --flat-playlist --playlist-end ${maxVideos} --match-filter "!is_upcoming & !is_live" --print "%(id)s\t%(duration)s\t%(title)s" "${canal}"`,
    { timeout: 60000, windowsHide: true }
  )

  const kwInclude = keywordInclude ? keywordInclude.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : []
  const kwExclude = keywordExclude ? keywordExclude.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : []

  const candidatos = stdout.split('\n').filter(l => l.trim())
    .map(l => { const p = l.split('\t'); return { id: p[0]?.trim(), duracao: parseFloat(p[1])||0, titulo: p[2]?.trim() || '' } })
    .filter(v => {
      if (!v.id) return false
      if (v.duracao < minDur || v.duracao > maxDur) return false
      if (vistos.has(v.id)) return false
      const tituloLow = v.titulo.toLowerCase()
      if (kwInclude.length && !kwInclude.some(k => tituloLow.includes(k))) return false
      if (kwExclude.length &&  kwExclude.some(k => tituloLow.includes(k))) return false
      return true
    })

  log(`   ${candidatos.length} candidatos (${minDur}s–${maxDur}s${kwInclude.length ? `, inclui: ${kwInclude.join(',')}` : ''}${kwExclude.length ? `, bloqueia: ${kwExclude.join(',')}` : ''})`)
  return candidatos
}

// Limites de duracao por plataforma (em segundos)
export const PLATFORM_LIMITS = {
  instagram: 90, // Reels max 90s
  tiktok: 600,   // 10min, mas pra viral o ideal eh ate 60s
}

export async function baixarVideoYoutube(video, downloadsDir, prefix, log, dataDir = null, cutRange = null) {
  fs.mkdirSync(downloadsDir, { recursive: true })

  // Limpa arquivos antigos
  const agora = Date.now()
  fs.readdirSync(downloadsDir).filter(f => f.startsWith(prefix + '_'))
    .forEach(f => { try { const fp = path.join(downloadsDir, f); if (agora - fs.statSync(fp).mtimeMs > 2*3600000) fs.unlinkSync(fp) } catch {} })

  const ts = Date.now()
  const out = path.join(downloadsDir, `${prefix}_${ts}.%(ext)s`)
  const ffmpegDir  = path.dirname(ffmpegStatic)

  // Range de corte: pode ser custom (smart cut) ou padrao (0-60s)
  const startSec = cutRange?.start ?? 0
  const endSec = cutRange?.end ?? 60
  const startStr = `${Math.floor(startSec/60)}:${String(startSec%60).padStart(2,'0')}`
  const endStr = `${Math.floor(endSec/60)}:${String(endSec%60).padStart(2,'0')}`
  const downloadSection = `*${startStr}-${endStr}`

  log(`⬇️ Baixando ${startStr}–${endStr}...`)
  await execAsync(
    `${YTDLP} ${JS_RUNTIMES_ARG} ${await getYoutubeCookiesArg(log, dataDir)} --ffmpeg-location "${ffmpegDir}" --download-sections "${downloadSection}" -f "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${out}" "https://www.youtube.com/watch?v=${video.id}"`,
    { timeout: 180000, windowsHide: true }
  )

  const files = fs.readdirSync(downloadsDir)
    .filter(f => f.startsWith(`${prefix}_${ts}`) && f.endsWith('.mp4'))
    .map(f => ({ f, t: fs.statSync(path.join(downloadsDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)

  if (!files.length) throw new Error('Nenhum MP4 após download')
  return path.resolve(path.join(downloadsDir, files[0].f))
}

export async function downloadThumbnail(videoId, destPath) {
  // Usa fetch nativo (Node 18+) — curl pode nao estar instalado em Windows do cliente
  for (const q of ['maxresdefault', 'hqdefault']) {
    try {
      const res = await fetch(`https://img.youtube.com/vi/${videoId}/${q}.jpg`)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 5000) continue
      fs.writeFileSync(destPath, buf)
      return destPath
    } catch {}
  }
  return null
}

// Calcula expressao x/y do ffmpeg overlay/drawtext baseado na posicao escolhida
// Apenas posicoes SEGURAS pra IG/TikTok (rodape eh coberto pelos botoes da plataforma)
// Posicoes: tl (top-left), tc (top-center), tr (top-right), c (center)
function watermarkPos(position, paddingPx = 30) {
  const map = {
    'tl': { x: `${paddingPx}`,         y: `${paddingPx}` },
    'tc': { x: `(W-w)/2`,              y: `${paddingPx}` },
    'tr': { x: `W-w-${paddingPx}`,     y: `${paddingPx}` },
    'c':  { x: `(W-w)/2`,              y: `(H-h)/2` },
    // Aceita 'bl' e 'br' por compat (jobs antigos), mas mapeia pra topo
    'bl': { x: `${paddingPx}`,         y: `${paddingPx}` },
    'br': { x: `W-w-${paddingPx}`,     y: `${paddingPx}` },
  }
  return map[position] || map['tr']
}

export async function converterParaReel(videoPath, thumbPath, log, opts = {}) {
  if (!ffmpegStatic) throw new Error('FFmpeg não encontrado — instalação corrompida?')
  const outputPath = videoPath.replace('.mp4', '_reel.mp4')
  const ffmpegPath = ffmpegStatic
  const inPath     = videoPath.replace(/\\/g, '/')
  const outPath    = outputPath.replace(/\\/g, '/')
  const VIDEO_H    = 608

  // Marca dagua (texto OU imagem)
  const wmType = opts.watermarkType || 'none' // 'none' | 'text' | 'image'
  const wmText = (opts.watermarkText || '').trim()
  const wmImage = (opts.watermarkImagePath || '').trim()
  const wmPos = opts.watermarkPosition || 'br' // tl/tr/bl/br/c
  const wmActive = (wmType === 'text' && wmText) || (wmType === 'image' && wmImage && fs.existsSync(wmImage))
  const wmPosCalc = watermarkPos(wmPos, 40)

  let filterParts = []
  let lastLabel
  let extraInputs = []

  // Estagio 1: scale + pad pra 9:16 (com ou sem thumb)
  if (thumbPath) {
    const tp = thumbPath.replace(/\\/g, '/')
    extraInputs.push(`-i "${tp}"`)
    let thumbH = 608
    try { const m = await sharp(thumbPath).metadata(); thumbH = Math.round(m.height * 1080 / m.width); if (thumbH % 2) thumbH++ } catch {}
    const blockH = thumbH + VIDEO_H
    const thumbY = Math.round((1920 - blockH) / 2)
    const videoY = thumbY + thumbH
    filterParts.push(`[0:v]scale=1080:${VIDEO_H},pad=1080:1920:0:${videoY}:black[padded]`)
    filterParts.push(`[1:v]scale=1080:${thumbH}[thumb]`)
    filterParts.push(`[padded][thumb]overlay=0:${thumbY}:eof_action=repeat[base]`)
    lastLabel = 'base'
  } else {
    const videoY = Math.round((1920 - VIDEO_H) / 2)
    filterParts.push(`[0:v]scale=1080:${VIDEO_H},pad=1080:1920:0:${videoY}:black[base]`)
    lastLabel = 'base'
  }

  // Estagio 2: marca dagua (se ativa)
  if (wmActive) {
    if (wmType === 'image' && fs.existsSync(wmImage)) {
      const imgPath = wmImage.replace(/\\/g, '/')
      const inputIdx = thumbPath ? 2 : 1
      extraInputs.push(`-i "${imgPath}"`)
      // Logo a 15% da largura do video (162px de 1080)
      filterParts.push(`[${inputIdx}:v]scale=162:-1[logo]`)
      filterParts.push(`[${lastLabel}][logo]overlay=${wmPosCalc.x}:${wmPosCalc.y}[out]`)
      lastLabel = 'out'
    } else if (wmType === 'text' && wmText) {
      // Escapa texto pra ffmpeg drawtext
      const safeText = wmText.replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/\\/g, '\\\\')
      filterParts.push(
        `[${lastLabel}]drawtext=text='${safeText}':fontcolor=white@0.85:fontsize=48:` +
        `borderw=3:bordercolor=black@0.6:` +
        `x=${wmPosCalc.x}:y=${wmPosCalc.y}[out]`
      )
      lastLabel = 'out'
    }
  } else {
    // Sem marca, renomeia base pra out
    filterParts[filterParts.length - 1] = filterParts[filterParts.length - 1].replace(/\[base\]$/, '[out]')
    lastLabel = 'out'
  }

  const filter = filterParts.join(';')
  const cmd = `"${ffmpegPath}" -y -i "${inPath}" ${extraInputs.join(' ')} -filter_complex "${filter}" -map "[${lastLabel}]" -map 0:a? -c:v libx264 -preset ultrafast -crf 28 -maxrate 1500k -bufsize 3000k -c:a aac -b:a 96k -movflags +faststart "${outPath}"`

  log(wmActive ? `🎨 Convertendo 9:16 + marca d'água (${wmType})...` : '🎨 Convertendo para 9:16...')
  await execAsync(cmd, { timeout: 300000, windowsHide: true })
  if (!fs.existsSync(outputPath)) throw new Error('ffmpeg não gerou o reel')
  log(`✅ Reel: ${Math.round(fs.statSync(outputPath).size / 1024)}KB`)
  return outputPath
}

// ── State helpers ──────────────────────────────────────────────────────────────

export function loadState(stateFile) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
    s.trechosUsados = s.trechosUsados || {} // { [videoId]: [{start,end}, ...] }
    s.duracoes      = s.duracoes      || {} // { [videoId]: number } — cache p/ calcular gaps sem refetch
    s.titulos       = s.titulos       || {} // { [videoId]: string }
    return s
  }
  catch { return { ultimoCanal: 0, postados: [], falhou: [], trechosUsados: {}, duracoes: {}, titulos: {} } }
}

export function saveState(stateFile, s) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2))
}

export function marcarPostado(stateFile, id) {
  const s = loadState(stateFile)
  const p = new Set(s.postados || [])
  p.add(id); s.postados = [...p].slice(-500)
  // Limpa metadata do vídeo esgotado pra não inflar o state
  delete s.trechosUsados[id]
  delete s.duracoes[id]
  delete s.titulos[id]
  saveState(stateFile, s)
}

export function marcarFalhou(stateFile, id) {
  const s = loadState(stateFile)
  const f = new Set(s.falhou || [])
  f.add(id); s.falhou = [...f].slice(-200); saveState(stateFile, s)
}

// ── Tracking de trechos usados (reaproveitamento de vídeo) ────────────────────
// Permite cortar trechos diferentes do MESMO vídeo em ciclos sucessivos,
// sem sobrepor, até esgotar o vídeo.

const MIN_GAP_KEEP = 30 // gap menor que isso não vale corte — vídeo considerado esgotado

export function marcarTrechoUsado(stateFile, videoId, range, totalDur, titulo) {
  const s = loadState(stateFile)
  const ranges = s.trechosUsados[videoId] || []
  ranges.push({ start: Math.floor(range.start), end: Math.ceil(range.end) })
  s.trechosUsados[videoId] = ranges
  if (totalDur) s.duracoes[videoId] = totalDur
  if (titulo)   s.titulos[videoId]  = titulo
  saveState(stateFile, s)
}

// Retorna os gaps (intervalos livres) de um vídeo, dado os ranges já usados.
// Ignora gaps menores que minSize (não vale a pena cortar).
export function calcGapsLivres(usedRanges, totalDur, minSize = MIN_GAP_KEEP) {
  if (!totalDur || totalDur <= 0) return []
  const ordered = [...(usedRanges || [])].sort((a, b) => a.start - b.start)
  const gaps = []
  let cursor = 0
  for (const r of ordered) {
    if (r.start > cursor) gaps.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
  }
  if (cursor < totalDur) gaps.push({ start: cursor, end: totalDur })
  return gaps.filter(g => (g.end - g.start) >= minSize)
}

// Tenta achar o próximo vídeo já parcialmente cortado que ainda tem espaço.
// Retorna { id, duracao, titulo, excludeRanges } ou null se nenhum elegível.
export function proximoVideoComEspaco(stateFile, minSize = MIN_GAP_KEEP) {
  const s = loadState(stateFile)
  const postadosSet = new Set(s.postados || [])
  for (const [videoId, ranges] of Object.entries(s.trechosUsados || {})) {
    if (postadosSet.has(videoId)) continue
    const dur = s.duracoes[videoId]
    if (!dur) continue
    const gaps = calcGapsLivres(ranges, dur, minSize)
    if (gaps.length) {
      return {
        id: videoId,
        duracao: dur,
        titulo: s.titulos[videoId] || '',
        excludeRanges: ranges,
      }
    }
  }
  return null
}
