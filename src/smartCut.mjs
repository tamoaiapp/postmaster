/**
 * Smart Cut: usa legendas do YouTube + IA local Qwen pra escolher
 * o melhor trecho de 30-120s do video (gancho viral).
 *
 * Fluxo:
 * 1. yt-dlp baixa subtitles (.vtt) — pt > pt-BR > en > auto-gerado
 * 2. Parseia em segmentos com timestamps
 * 3. Manda transcript pra Qwen com prompt "escolha o melhor gancho viral"
 * 4. Parse resposta (formato: "INICIO-FIM" em segundos ou MM:SS)
 * 5. Valida que o range escolhido não sobrepõe com excludeRanges (trechos já usados)
 * 6. Se IA falhar/sobrepor, fallback: primeiro gap livre de tamanho >= target
 * 7. Retorna { start, end } pra usar em --download-sections
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

const execAsync = promisify(exec)

function resolveBin(name) {
  try {
    const packaged = process.resourcesPath && path.join(process.resourcesPath, 'bin', name)
    if (packaged && fs.existsSync(packaged)) return packaged
  } catch {}
  const devBin = path.join(process.cwd(), 'bin', name)
  if (fs.existsSync(devBin)) return devBin
  return null
}
function resolveYtDlp() {
  const p = resolveBin('yt-dlp.exe')
  return p ? `"${p}"` : 'yt-dlp'
}
const YTDLP = resolveYtDlp()
const DENO_PATH = resolveBin('deno.exe')
const JS_RUNTIMES_ARG = DENO_PATH ? `--js-runtimes "deno:${DENO_PATH}"` : ''

// Parse VTT em segmentos { start, end, text }
function parseVTT(vttContent) {
  const segments = []
  const lines = vttContent.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(/^(\d{2}):(\d{2}):(\d{2})\.\d{3}\s+-->\s+(\d{2}):(\d{2}):(\d{2})/)
    if (m) {
      const start = +m[1]*3600 + +m[2]*60 + +m[3]
      const end   = +m[4]*3600 + +m[5]*60 + +m[6]
      i++
      let text = ''
      while (i < lines.length && lines[i].trim() && !lines[i].match(/-->/)) {
        text += lines[i].replace(/<[^>]+>/g, '').trim() + ' '
        i++
      }
      if (text.trim()) segments.push({ start, end, text: text.trim() })
    }
    i++
  }
  return segments
}

// Formata segmentos como transcript com timestamps p/ enviar pra IA
function formatTranscriptForAI(segments) {
  return segments.map(s => `[${Math.floor(s.start)}s] ${s.text}`).join('\n')
}

// Baixa as subtitles via yt-dlp
async function downloadSubtitles(videoId, tmpDir, cookiesArg) {
  fs.mkdirSync(tmpDir, { recursive: true })
  const url = `https://www.youtube.com/watch?v=${videoId}`
  const outBase = path.join(tmpDir, `subs_${videoId}`)
  // Tenta pt manual, pt auto, en auto — em ordem
  const tries = [
    { args: '--write-subs --sub-langs "pt,pt-BR,en"', label: 'manuais' },
    { args: '--write-auto-subs --sub-langs "pt,pt-BR,en"', label: 'auto-geradas' },
  ]
  for (const t of tries) {
    try {
      await execAsync(
        `${YTDLP} ${JS_RUNTIMES_ARG} ${cookiesArg || ''} ${t.args} --skip-download --sub-format vtt -o "${outBase}.%(ext)s" "${url}"`,
        { timeout: 30000, windowsHide: true }
      )
      // Procura .vtt baixado
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(`subs_${videoId}`) && f.endsWith('.vtt'))
      if (files.length) return path.join(tmpDir, files[0])
    } catch {}
  }
  return null
}

// Overlap test entre dois ranges [a.start,a.end) e [b.start,b.end)
function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end
}

// Calcula gaps livres dado os ranges já usados.
// Retorna [{start,end}] com tamanho >= minSize, ordenado por preferência (maior primeiro).
function freeGaps(excludeRanges, totalDuration, minSize) {
  const ordered = [...(excludeRanges || [])].sort((a, b) => a.start - b.start)
  const gaps = []
  let cursor = 0
  for (const r of ordered) {
    if (r.start > cursor) gaps.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
  }
  if (cursor < totalDuration) gaps.push({ start: cursor, end: totalDuration })
  return gaps.filter(g => (g.end - g.start) >= minSize).sort((a, b) => (b.end - b.start) - (a.end - a.start))
}

// Recorta os segmentos do transcript que caem dentro dos gaps livres,
// re-base pra exibir só o que a IA pode escolher.
function filterTranscriptByGaps(segments, gaps) {
  if (!gaps.length) return []
  return segments.filter(s => gaps.some(g => s.start >= g.start && s.end <= g.end))
}

/**
 * Pede pra IA escolher o melhor segmento.
 * Retorna { start, end } em segundos.
 */
async function pickBestSegmentWithAI(transcript, totalDuration, targetSec, aiManager, excludeRanges = []) {
  if (!aiManager?.gerarCaption) return null
  const target = Math.min(targetSec, totalDuration - 5)

  // Trunca transcript se muito longo (Qwen 0.5B tem context limitado)
  const maxChars = 1500
  const truncated = transcript.length > maxChars
    ? transcript.slice(0, maxChars) + '...'
    : transcript

  const excludeHint = (excludeRanges || []).length
    ? `\n\nINTERVALOS JA USADOS (NAO escolha estes): ${excludeRanges.map(r => `${r.start}-${r.end}s`).join(', ')}`
    : ''

  const prompt = `Voce eh especialista em corte viral de Reels. Analise o transcript com timestamps abaixo e escolha o MELHOR segmento de exatamente ${target} segundos pra viralizar (gancho forte, polemica, emocional, curiosidade).${excludeHint}

TRANSCRIPT:
${truncated}

Responda APENAS no formato: "X-Y" onde X eh o segundo de inicio e Y eh o de fim. Exemplo: "45-${45+target}". Sem explicacao.`

  try {
    const resp = await aiManager.gerarCaption(prompt, 'corte-video')
    const m = resp.match(/(\d+)\s*[-–]\s*(\d+)/)
    if (!m) return null
    const start = parseInt(m[1])
    const end = parseInt(m[2])
    if (end - start < 10 || end - start > 180) return null // sanity
    if (end > totalDuration) return null
    // Rejeita se sobrepor com algum range já usado
    for (const r of (excludeRanges || [])) {
      if (rangesOverlap({ start, end }, r)) return null
    }
    return { start, end }
  } catch (e) {
    return null
  }
}

/**
 * API publica: dado um videoId do YouTube, retorna { start, end } do melhor trecho.
 * Se nao conseguir (sem subs / IA falhou), retorna null e o caller usa o default 0-targetSec.
 *
 * @param {Array<{start,end}>} excludeRanges — trechos ja cortados em ciclos anteriores
 *   (pra evitar repetir o mesmo gancho em posts diferentes do mesmo video)
 */
export async function smartCutYouTube({ videoId, durationSec, targetCutSec = 120, dataDir, cookiesArg, log, aiManager, excludeRanges = [], keepVtt = false }) {
  const tmpDir = path.join(dataDir || 'c:/tmp', 'smart-cut-tmp')

  // Antes mesmo de baixar legendas: confere se sobra algum gap util
  const gaps = freeGaps(excludeRanges, durationSec, Math.min(30, targetCutSec))
  if (!gaps.length) { log?.('   ⚠️ Video esgotado (sem espaço pra novo trecho)'); return null }

  log?.('🧠 Buscando legendas pra smart cut...')
  const vttPath = await downloadSubtitles(videoId, tmpDir, cookiesArg)
  if (!vttPath) {
    log?.('   ⚠️ Sem legendas — usando primeiro gap livre')
    const cut = fallbackToFirstGap(gaps, targetCutSec)
    return cut ? { ...cut, vttPath: null } : null
  }

  // Parse word-level (mesmo parser usado pelo autoEditor depois)
  const vtt = fs.readFileSync(vttPath, 'utf-8')
  const { parseVTTWordLevel, pickBestViralWindow } = await import('./videoEditor.mjs')
  const words = parseVTTWordLevel(vtt)
  if (!words.length) {
    if (!keepVtt) try { fs.unlinkSync(vttPath) } catch {}
    log?.('   ⚠️ Legendas vazias — usando primeiro gap livre')
    const cut = fallbackToFirstGap(gaps, targetCutSec)
    return cut ? { ...cut, vttPath: keepVtt ? vttPath : null } : null
  }
  log?.(`   ${words.length} palavras (word-level) extraídas da VTT`)

  // Heurística viral: varre janelas, score por hooks/emotivas, respeita excludeRanges.
  // Por padrão limita aos primeiros 5min — adequado pra maioria dos vídeos.
  // Se vídeo for muito longo, pode-se aumentar searchUntilSec via env.
  const searchUntilSec = parseFloat(process.env.PM_SMART_CUT_LIMIT || '300')
  log?.('🤖 Heurística escolhendo melhor gancho viral (hooks + emotivas)...')
  const best = pickBestViralWindow(words, {
    windowSec: targetCutSec,
    stepSec: 15,
    searchFromSec: 20,
    searchUntilSec,
    excludeRanges,
  })

  if (!keepVtt) try { fs.unlinkSync(vttPath) } catch {}

  if (!best) {
    log?.('   ⚠️ Heurística falhou (sem janela válida) — usando primeiro gap livre')
    const fb = fallbackToFirstGap(gaps, targetCutSec)
    return fb ? { ...fb, vttPath: keepVtt ? vttPath : null } : null
  }

  log?.(`   ✂️ Cortando ${best.start}s → ${best.end}s (score ${best.score.toFixed(1)} · ${best.hooks} hooks · ${best.emotives} emotivas)`)
  return { start: best.start, end: best.end, vttPath: keepVtt ? vttPath : null }
}

// Fallback determinístico: pega o maior gap livre e corta os primeiros targetCutSec dele
function fallbackToFirstGap(gaps, targetCutSec) {
  if (!gaps.length) return null
  const g = gaps[0] // já vem ordenado por tamanho desc
  const dur = Math.min(targetCutSec, g.end - g.start)
  return { start: g.start, end: g.start + dur }
}
