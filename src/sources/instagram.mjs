/**
 * Fonte Instagram: usa Playwright (com session IG logada) pra listar Reels do perfil,
 * depois yt-dlp pra baixar cada Reel individualmente (yt-dlp baixa Reel/post OK,
 * só o listing de perfil que está quebrado em 2026).
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'
import ffmpegStaticOriginal from 'ffmpeg-static'
import { getCookiesForPlatform } from './cookies.mjs'
import { getChromiumExe } from '../playwrightExe.mjs'

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

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) }
  catch { return { ultimoCanal: 0, postados: [], falhou: [] } }
}
function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2))
}

// Encontra a primeira session IG logada
function getInstagramSessionFile(dataDir) {
  const sessionsDir = path.join(dataDir, 'sessions')
  if (!fs.existsSync(sessionsDir)) return null
  const files = fs.readdirSync(sessionsDir).filter(f => f.startsWith('ig-') && f.endsWith('.json') && !f.includes('cookies'))
  return files.length ? path.join(sessionsDir, files[0]) : null
}

export async function buscarVideoInstagram(handles, stateFile, log, filtros = {}, dataDir = null, jobId = null) {
  const { maxVideos = 10, keywordInclude = '', keywordExclude = '', onlyNew = true } = filtros

  // v1.2.1: aceita URL completa (instagram.com/handle/), com @, ou so o handle.
  // Antes: split -> trim -> remove @ inicial. Se user colava URL completa o handle ficava
  // "https://www.instagram.com/exhumia.ai/" e o GET batia em /reels/reels/ = 404.
  const lista = handles.split(/[,\n]/).map(h => {
    let s = h.trim()
    if (!s) return ''
    // Tira protocolo + dominio se for URL completa
    s = s.replace(/^https?:\/\/(www\.)?(instagram\.com|m\.instagram\.com)\//i, '')
    // Tira @ inicial
    s = s.replace(/^@/, '')
    // Pega so a primeira parte antes de / ou ? (descarta /reels/, /reel/xyz, ?query)
    s = s.split(/[\/?#]/)[0]
    return s
  }).filter(Boolean)
  if (!lista.length) throw new Error('Nenhum perfil de Instagram configurado')

  const sessionFile = dataDir ? getInstagramSessionFile(dataDir) : null
  if (!sessionFile) throw new Error('Conta Instagram nao logada — adicione em "Contas" antes de usar IG como fonte')

  const state = onlyNew ? loadState(stateFile) : { postados: [], falhou: [] }
  const vistos = new Set([...(state.postados || []), ...(state.falhou || [])])

  const idx = (state.ultimoCanal || 0) % lista.length
  const handle = lista[idx]
  state.ultimoCanal = idx + 1
  saveState(stateFile, state)

  const url = `https://www.instagram.com/${handle}/reels/`
  log(`📷 Perfil Instagram: @${handle} (raspando via session logada)`)

  // Abre o perfil via Playwright com session do usuario
  const browser = await chromium.launch({
    headless: true,
    executablePath: getChromiumExe() || undefined,
    args: ['--no-sandbox'],
  })
  const ctx = await browser.newContext({
    storageState: sessionFile,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  // Plug no Live View pra mostrar o perfil sendo raspado em tempo real
  if (jobId) {
    try {
      const liveView = await import('../liveView.mjs')
      liveView.attachPage(jobId, page)
    } catch {}
  }

  let shortcodes = []
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000)
    // Scroll pra carregar mais Reels (lazy loading)
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800))
      await page.waitForTimeout(1500)
    }
    // Extrai shortcodes dos links /reel/CODE/ e /p/CODE/
    shortcodes = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]')]
      const codes = new Set()
      for (const a of links) {
        const m = a.getAttribute('href')?.match(/\/(reel|p)\/([A-Za-z0-9_-]{5,15})\//)
        if (m) codes.add(m[2])
      }
      return [...codes]
    })
  } catch (e) {
    log(`   ⚠️ Falha ao raspar: ${e.message.split('\n')[0]}`)
  } finally {
    await browser.close()
  }

  if (!shortcodes.length) {
    log('   ⚠️ Nenhum Reel encontrado no perfil (verificar se esta logado / se perfil eh publico)')
    return []
  }

  log(`   ${shortcodes.length} Reels encontrados na pagina`)

  const kwInclude = keywordInclude ? keywordInclude.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : []
  const kwExclude = keywordExclude ? keywordExclude.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : []

  const candidatos = shortcodes.slice(0, maxVideos)
    .filter(id => !vistos.has(id))
    .filter(id => {
      const t = id.toLowerCase()
      if (kwInclude.length && !kwInclude.some(k => t.includes(k))) return false
      if (kwExclude.length &&  kwExclude.some(k => t.includes(k))) return false
      return true
    })
    .map(id => ({ id, duracao: 0, titulo: '', sourceHandle: handle }))

  log(`   ${candidatos.length} candidatos novos`)
  return candidatos
}

export async function baixarVideoInstagram(video, downloadsDir, prefix, log, dataDir = null) {
  fs.mkdirSync(downloadsDir, { recursive: true })
  const ts = Date.now()
  const out = path.join(downloadsDir, `${prefix}_${ts}.%(ext)s`)
  const ffmpegDir = ffmpegStatic ? path.dirname(ffmpegStatic) : ''
  const ffmpegArg = ffmpegDir ? `--ffmpeg-location "${ffmpegDir}"` : ''

  const cookies = dataDir ? getCookiesForPlatform('instagram', dataDir) : null
  if (!cookies) throw new Error('Cookies do Instagram nao disponiveis')

  // Tenta /reel/ primeiro, fallback /p/
  const urls = [
    `https://www.instagram.com/reel/${video.id}/`,
    `https://www.instagram.com/p/${video.id}/`,
  ]

  log('⬇️ Baixando do Instagram...')
  let lastErr
  for (const url of urls) {
    try {
      await execAsync(
        `${YTDLP} --cookies "${cookies}" ${ffmpegArg} -f "best[ext=mp4]/best" -o "${out}" "${url}"`,
        { timeout: 180000, windowsHide: true }
      )
      const files = fs.readdirSync(downloadsDir).filter(f => f.startsWith(`${prefix}_${ts}`) && f.endsWith('.mp4'))
      if (files.length) return path.resolve(path.join(downloadsDir, files[0]))
    } catch (e) { lastErr = e }
  }
  throw new Error(`Nao baixou: ${lastErr?.message?.slice(0, 100) || 'unknown'}`)
}

export function marcarPostadoIg(stateFile, id) {
  const s = loadState(stateFile)
  if (!s.postados.includes(id)) s.postados.push(id)
  saveState(stateFile, s)
}
export function marcarFalhouIg(stateFile, id) {
  const s = loadState(stateFile)
  if (!s.falhou.includes(id)) s.falhou.push(id)
  saveState(stateFile, s)
}
