/**
 * Corte inteligente pra YouTube LONGO.
 * Pega video de 30-60min e seleciona 8-12min "densos" (silencios curtos, muita fala
 * continua). Diferente do smartCut.mjs que pega 30-60s viral pra Shorts.
 *
 * Heuristica:
 *   - Detecta silencios
 *   - Pontua janelas de 1min por "densidade" (menos silencio + mais palavras se houver VTT)
 *   - Pega top-N janelas + concatena na ordem cronologica
 */
import { detectSilences, getVideoDuration } from './videoEditor.mjs'
import ffmpegStaticLib from 'ffmpeg-static'

const ffmpegPath = (ffmpegStaticLib || 'ffmpeg').replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/')

/**
 * @param {Object} opts
 * @param {string} opts.videoPath - mp4 input (assume video longo)
 * @param {number} [opts.targetMin=10] - duracao alvo do corte final em min
 * @param {function} [opts.log]
 * @returns {Promise<{ranges: Array<[number,number]>, dur: number}>}
 */
export async function selecionarTrechosDensos({ videoPath, targetMin = 10, log = () => {} }) {
  const dur = await getVideoDuration(ffmpegPath, videoPath)
  if (!dur) throw new Error('Duracao invalida')

  // Se ja eh menor que o alvo, devolve tudo
  const targetSec = targetMin * 60
  if (dur <= targetSec * 1.2) {
    return { ranges: [[0, dur]], dur }
  }

  log(`   🔍 Detectando silencios pra pontuar janelas (video ${(dur/60).toFixed(1)}min)...`)
  const silences = await detectSilences(ffmpegPath, videoPath, { threshold: -28, minSilence: 0.5 })

  // Pontua janelas de 60s
  const winSec = 60
  const numWin = Math.floor(dur / winSec)
  const scores = []
  for (let i = 0; i < numWin; i++) {
    const ws = i * winSec, we = ws + winSec
    const silenceInWin = silences
      .filter(s => s.start < we && s.end > ws)
      .reduce((sum, s) => sum + (Math.min(s.end, we) - Math.max(s.start, ws)), 0)
    const speechRatio = 1 - (silenceInWin / winSec)
    scores.push({ start: ws, end: we, score: speechRatio })
  }

  // Penaliza primeiros e ultimos 60s (intros/outros costumam ser baixa densidade ou copyright musical)
  if (scores.length > 0) scores[0].score *= 0.5
  if (scores.length > 1) scores[scores.length - 1].score *= 0.5

  // Pega top janelas ate atingir targetSec
  const sorted = [...scores].sort((a, b) => b.score - a.score)
  const picked = []
  let acc = 0
  for (const s of sorted) {
    if (acc >= targetSec) break
    picked.push(s)
    acc += winSec
  }

  // Ordena cronologicamente e mescla janelas adjacentes
  picked.sort((a, b) => a.start - b.start)
  const ranges = []
  for (const p of picked) {
    const last = ranges[ranges.length - 1]
    if (last && p.start - last[1] < 5) last[1] = p.end
    else ranges.push([p.start, p.end])
  }
  log(`   ✂️ Selecionou ${ranges.length} trecho(s), total ${(acc/60).toFixed(1)}min de ${(dur/60).toFixed(1)}min`)
  return { ranges, dur }
}

/**
 * Executa o corte (concat dos ranges) gerando MP4 novo.
 */
export async function aplicarCorteDenso({ videoPath, ranges, outputPath, log = () => {} }) {
  if (ranges.length === 0) return videoPath
  if (ranges.length === 1 && ranges[0][0] === 0) {
    // tudo
    return videoPath
  }
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)

  // Filter_complex: para cada range cria [vN]/[aN], depois concat
  let filter = ''
  const vMaps = []
  const aMaps = []
  ranges.forEach((r, i) => {
    filter += `[0:v]trim=${r[0].toFixed(2)}:${r[1].toFixed(2)},setpts=PTS-STARTPTS[v${i}];`
    filter += `[0:a]atrim=${r[0].toFixed(2)}:${r[1].toFixed(2)},asetpts=PTS-STARTPTS[a${i}];`
    vMaps.push(`[v${i}]`)
    aMaps.push(`[a${i}]`)
  })
  filter += `${vMaps.join('')}${aMaps.join('')}concat=n=${ranges.length}:v=1:a=1[v][a]`

  log('   ✂️ Concatenando trechos densos...')
  const cmd = `"${ffmpegPath}" -y -i "${videoPath}" -filter_complex "${filter}" -map "[v]" -map "[a]" -c:v libx264 -preset ultrafast -crf 22 -c:a aac -b:a 192k "${outputPath}"`
  await execAsync(cmd, { timeout: 1500000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 })
  return outputPath
}
