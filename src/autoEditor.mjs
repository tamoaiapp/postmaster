/**
 * autoEditor — pipeline completo de edição automática estilo TikTok.
 *
 * Aplica em sequência sobre um vídeo já recortado:
 *  1. Cortar partes mortas (ffmpeg silencedetect)
 *  2. Remap word-level timestamps pós-corte
 *  3. Marca palavras-chave
 *  4. Gera legenda karaokê word-by-word (.ass)
 *  5. Face tracking denso (lip movement, ignora intérpretes de Libras)
 *  6. Build crop filter com cuts secos entre speakers
 *  7. Render final 1080×1920: pad + crop 1080×1344 (70% topo centralizado) + legenda burned
 *
 * Recebe vídeo + VTT (do trecho já recortado) e retorna outputPath.
 */
import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import {
  parseVTTWordLevel, rebaseWordsToRange,
  detectSilences, buildKeepRanges, remapTime, totalKeptDuration,
  pickKeyWords, buildKaraokeASS, buildKeepRangesFilter,
  getVideoDuration,
} from './videoEditor.mjs'
import {
  setModelPath as setFaceModelPath,
  buildFaceTimeline, buildFaceCropFilter, getVideoDimensions,
} from './faceTrack.mjs'

const execAsync = promisify(exec)

/**
 * @param {Object} opts
 * @param {string} opts.videoPath    — caminho do MP4 já recortado (input)
 * @param {string} opts.outputPath   — onde salvar o reel final
 * @param {string} opts.vttPath      — VTT inteira do vídeo original do YT
 * @param {number} opts.fromSec      — onde o trecho começa (no vídeo original)
 * @param {number} opts.toSec        — onde termina
 * @param {string} opts.ffmpegPath   — path do ffmpeg-static (já com unpacked path)
 * @param {string} opts.modelPath    — path do face-detector.onnx
 * @param {string} opts.tmpDir       — pasta pra arquivos intermediários
 * @param {Function} opts.log
 * @param {Object} [opts.options]    — { cutSilence:true, karaokeSubs:true, faceTrack:true }
 * @returns {Promise<string>} outputPath
 */
export async function applyAutoEdit({
  videoPath, outputPath, vttPath, fromSec, toSec,
  ffmpegPath, modelPath, tmpDir, log,
  options = {},
}) {
  const { cutSilence = true, karaokeSubs = true, faceTrack = true } = options
  fs.mkdirSync(tmpDir, { recursive: true })

  if (modelPath) setFaceModelPath(modelPath)

  // ── 1. Parse VTT pra word-level timestamps ───────────────────────────────────
  let words = []
  if (karaokeSubs) {
    if (!vttPath || !fs.existsSync(vttPath)) {
      log?.('   ⚠️ VTT não disponível — pulando legenda karaokê')
    } else {
      const vtt = fs.readFileSync(vttPath, 'utf-8')
      const allWords = parseVTTWordLevel(vtt)
      words = rebaseWordsToRange(allWords, fromSec, toSec)
      log?.(`   📝 ${words.length} palavras no trecho (VTT)`)
    }
  }

  const actualDur = await getVideoDuration(ffmpegPath, videoPath)

  // ── 2. Corte de silêncio (agressivo: -28dB, 0.30s) ───────────────────────────
  let workingVideo = videoPath
  let keepRanges = null
  let densoDur = actualDur
  if (cutSilence) {
    log?.('   🔇 Detectando silêncios...')
    const silences = await detectSilences(ffmpegPath, videoPath, { threshold: -28, minSilence: 0.30 })
    keepRanges = buildKeepRanges(silences, actualDur, 0.10)
    const keptDur = totalKeptDuration(keepRanges)
    log?.(`   ✂️ ${silences.length} silêncios → cortou ${(actualDur - keptDur).toFixed(1)}s`)

    if (silences.length > 0 && keptDur < actualDur - 0.5) {
      workingVideo = path.join(tmpDir, `denso_${Date.now()}.mp4`)
      const kr = buildKeepRangesFilter(keepRanges)
      const cutCmd = `"${ffmpegPath}" -y -i "${videoPath}" -filter_complex "[0:v]${kr.vFilter}[v];[0:a]${kr.aFilter}[a]" -map "[v]" -map "[a]" -c:v libx264 -preset ultrafast -crf 22 -c:a aac -b:a 128k "${workingVideo}"`
      await execAsync(cutCmd, { timeout: 600000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
      densoDur = await getVideoDuration(ffmpegPath, workingVideo)
    }
  }

  // ── 3. Remap word timestamps pro vídeo pós-silêncio ──────────────────────────
  let remapped = []
  if (karaokeSubs && words.length) {
    if (keepRanges) {
      for (const w of words) {
        const ns = remapTime(w.start, keepRanges)
        const ne = remapTime(w.end, keepRanges)
        if (ns !== null && ne !== null && ne > ns) {
          remapped.push({ word: w.word, start: ns, end: ne, speakerChange: !!w.speakerChange })
        }
      }
    } else {
      remapped = words
    }
  }

  // ── 4. Gera .ass karaokê estilo TikTok ───────────────────────────────────────
  let assPath = null
  if (karaokeSubs && remapped.length) {
    const annotated = pickKeyWords(remapped, 5)
    // MarginV 400 = legenda em y≈1520 (dentro do CROP bottom em y=[608,1920],
    // ~80% da altura, acima da zona de botões TikTok mas longe da divisão com o topo)
    const ass = buildKaraokeASS(annotated, {
      videoW: 1080, videoH: 1920,
      fontName: 'Arial Black',
      words_per_line: 3, fontSize: 100,
      marginV: 400, marginL: 140, marginR: 140,
      outline: 8, shadow: 5,
    })
    assPath = path.join(tmpDir, `subs_${Date.now()}.ass`)
    fs.writeFileSync(assPath, ass, 'utf-8')
    log?.(`   🎤 Legenda karaokê: ${annotated.filter(w => w.highlight).length} destaques`)
  }

  // v1.2.6: detecta aspect do source.
  // - Source horizontal (YT/podcast 16:9): split-screen (topo panorama + face crop bottom)
  // - Source ja vertical (IG/TT reel 9:16): so re-encoda pra 1080x1920 + legenda + watermark
  //   NAO faz split-screen porque "panorama 1080x608" de um 9:16 fica espremido com black bars
  //   e o "face crop bottom" eh redundante (video ja eh closer up)
  const { width: srcWidth, height: srcHeight } = await getVideoDimensions(ffmpegPath, workingVideo)
  const srcAspect = srcHeight / srcWidth  // > 1 = vertical, < 1 = horizontal
  const isAlreadyVertical = srcAspect >= 1.2  // 9:16 = 1.78, 4:5 = 1.25, square = 1.0
  log?.(`   📐 Source ${srcWidth}x${srcHeight} aspect=${srcAspect.toFixed(2)} ${isAlreadyVertical ? '(JA VERTICAL - skip split-screen)' : '(horizontal - usa split-screen + face crop)'}`)

  // ── 5. Face tracking denso (so se source horizontal) ────────────────────────
  // Layout split-screen: topo = vídeo inteiro 16:9 (1080×608), baixo = crop face (1080×1312)
  // Total = 1920 (sem bandas pretas)
  const TOP_H    = 608   // vídeo inteiro 16:9 escalado pra 1080 wide
  const BOTTOM_H = 1312  // 1920 - 608
  let cropFilter = null
  if (isAlreadyVertical) {
    log?.('   ⏭ Pulando face track (video ja vertical)')
  } else
  if (faceTrack) {
    try {
      const { width: srcW, height: srcH } = await getVideoDimensions(ffmpegPath, workingVideo)
      log?.('   👤 Face tracking (amostra a cada 2s + lip-movement)...')
      const facePoints = await buildFaceTimeline({
        ffmpegPath, videoPath: workingVideo, totalDur: densoDur,
        tmpDir: path.join(tmpDir, 'frames'), log,
        sampleSec: 2.0, srcW, srcH, debug: false,
      })
      cropFilter = buildFaceCropFilter(facePoints, srcW, srcH, {
        cropW: 1080, cropH: BOTTOM_H,
        cutDiffPx: 250, minShotSec: 2.5,
      })
    } catch (e) {
      log?.(`   ⚠️ Face tracking falhou: ${e.message.split('\n')[0]} — usando crop central`)
    }
  }

  // Fallback se face tracking falhou OU não foi ligado (so usado no modo horizontal)
  if (!isAlreadyVertical && !cropFilter) {
    cropFilter = `scale=-2:${BOTTOM_H},crop=1080:${BOTTOM_H}:(iw-1080)/2:0`
  }

  // ── 6. Render final ─────────────────────────────────────────────────────────
  if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath) } catch {}

  let filter
  if (isAlreadyVertical) {
    // v1.2.6: source ja eh vertical (Reel IG/Short TT) - mantem 1080x1920
    // Scale por largura preservando aspect, crop centro pra 1080x1920 exato.
    // Se source >= 9:16 (mais alto que 9:16, ex: 4:5), corta laterais.
    // Se source <= 9:16 (mais baixo, ex: square), pad top/bottom.
    filter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[stacked]`
    log?.('   🎬 Renderizando 1080x1920 (manter formato vertical do source)...')
  } else {
    // Layout split-screen pra source 16:9 (YT/podcast):
    //   y=0..608    -> video inteiro 16:9 (panorama)
    //   y=608..1920 -> crop com face tracking (close em quem fala)
    filter =
      `[0:v]split=2[vA][vB];` +
      `[vA]scale=1080:${TOP_H}:force_original_aspect_ratio=decrease,pad=1080:${TOP_H}:(ow-iw)/2:(oh-ih)/2:black[top];` +
      `[vB]${cropFilter}[bot];` +
      `[top][bot]vstack=inputs=2[stacked]`
    log?.('   🎬 Renderizando reel split-screen (topo 16:9 + baixo face crop)...')
  }
  if (assPath) {
    const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:')
    filter += `;[stacked]subtitles='${assEscaped}':charenc=UTF-8[out]`
  } else {
    filter += `;[stacked]null[out]`
  }
  const finalCmd = `"${ffmpegPath}" -y -i "${workingVideo}" -filter_complex "${filter}" -map "[out]" -map 0:a? -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`
  await execAsync(finalCmd, { timeout: 900000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })

  // Cleanup
  if (workingVideo !== videoPath) try { fs.unlinkSync(workingVideo) } catch {}
  if (assPath) try { fs.unlinkSync(assPath) } catch {}

  return outputPath
}
