/**
 * Demo CLI: pega URL YouTube + range [from,to] e gera reel editado.
 *
 * Uso:
 *   node tools/edit-demo.mjs <URL> [fromSec] [toSec] [outputPath]
 *
 * Pipeline:
 *  1. yt-dlp baixa o trecho [fromSec, toSec] (default 30-150s)
 *  2. yt-dlp baixa VTT pt auto-gerada (word-level timestamps)
 *  3. ffmpeg silencedetect → silêncios
 *  4. Calcula keep ranges (remove silêncios)
 *  5. ffmpeg #1: corta silêncios + faz 1080×608 (mantém 16:9 do original)
 *  6. Remapeia timestamps de words pro tempo encurtado
 *  7. Marca palavras-chave (heurística)
 *  8. Gera arquivo .ass karaokê
 *  9. ffmpeg #2: pad pra 1080×1920 + queima legenda + (opcional) zoom subtle
 * 10. Salva MP4 final, abre no explorer
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { promisify } from 'util'
import ffmpegStaticOriginal from 'ffmpeg-static'
import {
  parseVTTWordLevel, rebaseWordsToRange,
  detectSilences, buildKeepRanges, remapTime, totalKeptDuration,
  pickKeyWords, buildKaraokeASS, buildSubtleKenBurnsFilter,
  buildKeepRangesFilter, getVideoDuration, pickBestViralWindow,
} from '../src/videoEditor.mjs'
import {
  setModelPath, buildFaceTimeline,
  buildFaceCropFilter, getVideoDimensions,
} from '../src/faceTrack.mjs'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.dirname(__dirname)
const FFMPEG = ffmpegStaticOriginal // em dev, aponta direto pro binário
const YTDLP  = path.join(PROJECT_ROOT, 'bin', 'yt-dlp.exe')
const FACE_MODEL = path.join(PROJECT_ROOT, 'models', 'face-detector.onnx')
setModelPath(FACE_MODEL)

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }

async function main() {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.error('Uso: node tools/edit-demo.mjs <URL> [outputPath] [fromSec toSec]')
    console.error('     Sem fromSec/toSec, o smart cut escolhe o melhor trecho viral')
    process.exit(1)
  }
  const url     = args[0]
  const outPath = args[1] || path.join(process.env.USERPROFILE || process.cwd(), 'Desktop', 'postmaster-demo.mp4')
  const overrideFrom = args[2] ? parseFloat(args[2]) : null
  const overrideTo   = args[3] ? parseFloat(args[3]) : null
  const tmpDir  = path.join(process.env.TEMP || 'C:/tmp', 'pm-edit-demo')
  fs.mkdirSync(tmpDir, { recursive: true })

  const videoId = (url.match(/[?&]v=([\w-]{6,15})/) || url.match(/youtu\.be\/([\w-]{6,15})/) || [])[1] || 'unknown'

  // 1️⃣ Baixa VTT inteira (necessário pro smart cut)
  log('1/10 Baixando VTT pt auto-gerada (vídeo todo)...')
  const vttBase = path.join(tmpDir, `subs_${videoId}`)
  for (const f of fs.readdirSync(tmpDir)) {
    if (f.startsWith(`subs_${videoId}`) || f.startsWith(`vid_${videoId}`)) {
      try { fs.unlinkSync(path.join(tmpDir, f)) } catch {}
    }
  }
  await runCmd(`"${YTDLP}" --no-warnings --write-auto-subs --sub-langs "pt" --sub-format vtt --skip-download -o "${vttBase}.%(ext)s" "${url}"`)
  const vttPath = fs.readdirSync(tmpDir).map(f => path.join(tmpDir, f)).find(p => p.startsWith(vttBase) && p.endsWith('.vtt'))
  if (!vttPath) throw new Error('Nenhuma VTT pt encontrada — vídeo sem legenda?')
  log(`   VTT: ${path.basename(vttPath)} (${Math.round(fs.statSync(vttPath).size / 1024)} KB)`)

  // 2️⃣ Smart cut: escolhe melhor janela de 120s.
  // SEARCH_RANGE env var permite mudar (default: 300-600s = 5min-10min, próxima fatia).
  const SEARCH_FROM = parseFloat(process.env.SEARCH_FROM || '300')
  const SEARCH_UNTIL = parseFloat(process.env.SEARCH_UNTIL || '600')
  log(`2/10 Smart cut: melhor janela viral de 120s entre ${SEARCH_FROM}s-${SEARCH_UNTIL}s...`)
  const vttContent = fs.readFileSync(vttPath, 'utf-8')
  const allWords = parseVTTWordLevel(vttContent)
  log(`   Total palavras na VTT: ${allWords.length}`)

  let fromSec, toSec
  if (overrideFrom !== null && overrideTo !== null) {
    fromSec = overrideFrom; toSec = overrideTo
    log(`   ↳ override manual: ${fromSec}-${toSec}s`)
  } else {
    const best = pickBestViralWindow(allWords, {
      windowSec: 120, stepSec: 15,
      searchFromSec: SEARCH_FROM, searchUntilSec: SEARCH_UNTIL,
    })
    if (!best) throw new Error('Smart cut falhou')
    fromSec = best.start; toSec = best.end
    log(`   ↳ ESCOLHEU: ${fromSec.toFixed(0)}-${toSec.toFixed(0)}s (score ${best.score.toFixed(1)})`)
    log(`     density: ${best.density} palavras | hooks: ${best.hooks} | emotivas: ${best.emotives}`)
    // Preview do que tem nesse trecho
    const preview = allWords.filter(w => w.start >= fromSec && w.end <= fromSec + 8).map(w => w.word).join(' ')
    log(`     começa com: "${preview.slice(0, 90)}..."`)
  }

  log('3/10 Baixando trecho escolhido...')
  const videoPath = path.join(tmpDir, `vid_${videoId}.mp4`)
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath)
  const startStr = formatTs(fromSec)
  const endStr   = formatTs(toSec)
  const ffmpegDir = path.dirname(FFMPEG)
  await runCmd(`"${YTDLP}" --no-warnings --ffmpeg-location "${ffmpegDir}" --download-sections "*${startStr}-${endStr}" -f "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${videoPath}" "${url}"`)
  const actualDur = await getVideoDuration(FFMPEG, videoPath)
  log(`   Vídeo: ${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)} MB, ${actualDur.toFixed(1)}s reais`)

  // 4️⃣ Rebase words pro trecho escolhido
  log('4/10 Rebase words pro trecho escolhido...')
  const words = rebaseWordsToRange(allWords, fromSec, toSec)
  log(`   Palavras no trecho: ${words.length}`)
  if (!words.length) throw new Error('Sem palavras no range — VTT muito esparsa?')

  // 5️⃣ Detecta silêncios (agressivo: -28dB, 0.30s)
  log('5/10 Detectando silêncios (agressivo)...')
  const silences = await detectSilences(FFMPEG, videoPath, { threshold: -28, minSilence: 0.30 })
  log(`   ${silences.length} silêncios detectados`)
  const keepRanges = buildKeepRanges(silences, actualDur, 0.10)
  const keptDur = totalKeptDuration(keepRanges)
  log(`   Mantém ${keepRanges.length} blocos = ${keptDur.toFixed(1)}s (cortou ${(actualDur - keptDur).toFixed(1)}s de silêncio)`)

  // 5️⃣ ffmpeg #1: SÓ corte de silêncio (sem crop ainda — crop precisa dos timestamps
  // remapeados pós-corte, então faz na ETAPA 9). Sai com vídeo original aspect.
  log('6/10 Cortando silêncio (mantém aspect original)...')
  const denso = path.join(tmpDir, `denso_${videoId}.mp4`)
  if (fs.existsSync(denso)) fs.unlinkSync(denso)
  let cutCmd
  if (silences.length === 0 || keptDur >= actualDur - 0.5) {
    log('   ↳ sem silêncios apreciáveis, só copia')
    cutCmd = `"${FFMPEG}" -y -i "${videoPath}" -c:v libx264 -preset ultrafast -crf 22 -c:a aac -b:a 128k "${denso}"`
  } else {
    const kr = buildKeepRangesFilter(keepRanges)
    cutCmd = `"${FFMPEG}" -y -i "${videoPath}" -filter_complex "[0:v]${kr.vFilter}[v];[0:a]${kr.aFilter}[a]" -map "[v]" -map "[a]" -c:v libx264 -preset ultrafast -crf 22 -c:a aac -b:a 128k "${denso}"`
  }
  await runCmd(cutCmd)
  const densoDur = await getVideoDuration(FFMPEG, denso)
  log(`   denso.mp4: ${densoDur.toFixed(1)}s`)

  // 6️⃣ Remapeia timestamps de words pro vídeo encurtado
  log('7/10 Remapeando timestamps p/ vídeo encurtado...')
  const remapped = []
  for (const w of words) {
    const ns = remapTime(w.start, keepRanges)
    const ne = remapTime(w.end, keepRanges)
    if (ns !== null && ne !== null && ne > ns) {
      remapped.push({ word: w.word, start: ns, end: ne, speakerChange: !!w.speakerChange })
    }
  }
  const changes = remapped.filter(w => w.speakerChange).length
  log(`   ${remapped.length} palavras | ${changes} marcas de troca de speaker (>>)`)
  log(`   ${remapped.length} palavras sobreviveram ao corte (de ${words.length})`)

  // 7️⃣ Marca palavras-chave
  const annotated = pickKeyWords(remapped, 5)
  const hi = annotated.filter(w => w.highlight).length
  log(`8/10 Palavras-chave destacadas: ${hi}`)

  // 8️⃣ Gera .ass — estilo TikTok pesado
  // Vídeo 1080×1344 centralizado em y=[288, 1632]. Legenda em y≈1240 (centro-baixo do vídeo).
  // Fonte 80pt, margens laterais grandes pra forçar quebra em 3 palavras/linha, sombra mais pesada.
  log('9/10 Gerando legenda karaokê (.ass) estilo TikTok...')
  const ass = buildKaraokeASS(annotated, {
    videoW: 1080, videoH: 1920,
    fontName: 'Arial Black',
    words_per_line: 3, fontSize: 100,
    marginV: 700, marginL: 140, marginR: 140,
    outline: 8, shadow: 5,
  })
  const assPath = path.join(tmpDir, `subs_${videoId}.ass`)
  fs.writeFileSync(assPath, ass, 'utf-8')
  log(`   .ass: ${Math.round(fs.statSync(assPath).size / 1024)} KB`)

  // 🔟 Face tracking denso (amostra a cada 2s) + render final
  log('10/10 Face tracking + render final...')

  const { width: srcW, height: srcH } = await getVideoDimensions(FFMPEG, denso)
  log(`   vídeo: ${srcW}×${srcH}`)

  log('   9a) amostrando rostos a cada 2s...')
  const tStart = Date.now()
  const facePoints = await buildFaceTimeline({
    ffmpegPath: FFMPEG, videoPath: denso, totalDur: densoDur,
    tmpDir: path.join(tmpDir, 'frames'), log,
    sampleSec: 2.0, srcW, srcH, debug: true,
  })
  log(`   face tracking levou ${((Date.now() - tStart)/1000).toFixed(1)}s`)

  log('   9b) gerando filter com cortes secos entre shots...')
  // Layout: crop 1080×1344 (70% da altura) — mais zoom, mais "TikTok cheio"
  // Cortes secos: |Δx| > 250px no source = cut entre shots (min 2.5s por shot)
  const CROP_H = 1344
  const cropFilter = buildFaceCropFilter(facePoints, srcW, srcH, {
    cropW: 1080, cropH: CROP_H,
    cutDiffPx: 250, minShotSec: 2.5,
  })

  log('   9c) renderizando reel final...')
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
  const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:')
  // Centraliza crop 1344h verticalmente: y = (1920 - 1344) / 2 = 288
  const padY = Math.round((1920 - CROP_H) / 2)
  const filter = `[0:v]${cropFilter}[cropped];` +
                 `[cropped]pad=1080:1920:0:${padY}:black[padded];` +
                 `[padded]subtitles='${assEscaped}':charenc=UTF-8[out]`
  const finalCmd = `"${FFMPEG}" -y -i "${denso}" -filter_complex "${filter}" -map "[out]" -map 0:a? -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -movflags +faststart "${outPath}"`
  await runCmd(finalCmd)

  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1)
  log(`✅ PRONTO: ${outPath} (${sizeMB} MB)`)
  log(`   Trecho final: ${densoDur.toFixed(1)}s | Palavras: ${remapped.length} | Destaques: ${hi}`)

  return outPath
}

async function runCmd(cmd, opts = {}) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 600000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts })
    return { stdout, stderr }
  } catch (e) {
    console.error('CMD FAIL:', cmd.slice(0, 200))
    console.error('stderr:', (e.stderr || '').slice(-2000))
    throw e
  }
}

function formatTs(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
