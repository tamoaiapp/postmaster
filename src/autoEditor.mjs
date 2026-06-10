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
  // v1.3.3: applyAutoEdit antes ignorava watermark - jobs editMode=auto saiam SEM marca dagua
  // mesmo o user configurando no wizard. Agora aplica drawtext (texto) ou overlay (imagem).
  watermarkType,    // 'none' | 'text' | 'image'
  watermarkText,    // ex: '@ai.tiago'
  watermarkImagePath, // path absoluto pra png/jpg
  watermarkPosition, // 'tl' | 't' | 'tr' | 'c' (sem 'b' por causa de IG/TT que cobrem rodape)
  // v1.3.9: chyron estilo manchete - texto branco bold sobre fundo preto
  // centralizado horizontal, posicao upper-middle. Tipo G1/TV news.
  chyronText,       // ex: '"ODEIO HOMENS BONITOS!", DIZ TRUMP AO CUMPRIMENTAR GRADUADO DA GUARDA COSTEIRA'
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
    // Source ja vertical (Reel IG/Short TT): mantem 1080x1920
    filter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[stacked]`
    log?.('   🎬 Renderizando 1080x1920 (manter formato vertical do source)...')
  } else {
    // v1.3.2: source horizontal (YT/podcast 16:9) NAO faz mais split-screen.
    // Antes fazia: topo panorama 1080x608 + bottom face crop 1080x1312 - ficava feio
    // pq mostrava o mesmo conteudo 2x (com gente reclamando).
    // Agora: usa SO o face crop ocupando 1080x1920 inteiro (com cropFilter ja gerado
    // pelo face tracking se tiver, senao crop central).
    if (cropFilter) {
      // Re-escala o crop pra 1080x1920 (era 1080x1312)
      // cropFilter original: 'scale=-2:1312,crop=1080:1312:(iw-1080)/2:0' -> 1080x1312
      // Adapta pra altura cheia: scale=-2:1920,crop=1080:1920:(iw-1080)/2:0
      filter = `[0:v]scale=-2:1920,crop=1080:1920:(iw-1080)/2:0[stacked]`
    } else {
      // Fallback: crop central full-height
      filter = `[0:v]scale=-2:1920,crop=1080:1920:(iw-1080)/2:0[stacked]`
    }
    log?.('   🎬 Renderizando 1080x1920 (crop central do horizontal, sem split-screen)...')
  }
  if (assPath) {
    const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:')
    filter += `;[stacked]subtitles='${assEscaped}':charenc=UTF-8[wsub]`
  } else {
    filter += `;[stacked]null[wsub]`
  }

  // v1.3.3: Watermark (texto ou imagem) na posicao escolhida pelo user
  // Posicoes (em 1080x1920):
  //   tl = top-left   (40, 40)
  //   t  = top-center (centro, 40)
  //   tr = top-right  (1080-w-40, 40)
  //   c  = center     (centro, centro)
  const wmActive = (watermarkType === 'text' && watermarkText?.trim()) ||
                   (watermarkType === 'image' && watermarkImagePath && fs.existsSync(watermarkImagePath))
  let extraInputs = ''
  if (wmActive) {
    const pos = watermarkPosition || 'tl'
    if (watermarkType === 'text') {
      const txt = String(watermarkText).replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/\\/g, '\\\\')
      const fontSize = 48
      // Coord:
      // x: tl/t left=40, tr right=1080-tw-40 (tw = text_w), t = (1080-text_w)/2, c = centro
      // y: tl/t/tr top=40, c centro
      const xExpr = pos === 'tl' ? '40'
                  : pos === 't'  ? '(w-text_w)/2'
                  : pos === 'tr' ? 'w-text_w-40'
                  : pos === 'c'  ? '(w-text_w)/2'
                  : '40'
      const yExpr = pos === 'c' ? '(h-text_h)/2' : '40'
      filter += `;[wsub]drawtext=text='${txt}':fontcolor=white@0.92:fontsize=${fontSize}:borderw=3:bordercolor=black@0.7:x=${xExpr}:y=${yExpr}[wmout]`
    } else if (watermarkType === 'image') {
      // Imagem como input adicional (-i)
      const imgPath = watermarkImagePath.replace(/\\/g, '/')
      extraInputs = ` -i "${imgPath}"`
      // Logo redimensionada a ~15% da largura (162 de 1080)
      const xExpr = pos === 'tl' ? '40'
                  : pos === 't'  ? '(W-w)/2'
                  : pos === 'tr' ? 'W-w-40'
                  : pos === 'c'  ? '(W-w)/2'
                  : '40'
      const yExpr = pos === 'c' ? '(H-h)/2' : '40'
      filter += `;[1:v]scale=162:-1[wm];[wsub][wm]overlay=${xExpr}:${yExpr}[wmout]`
    } else {
      filter += `;[wsub]null[wmout]`
    }
    log?.(`   💧 Marca dagua aplicada: ${watermarkType} em ${pos}`)
  } else {
    filter += `;[wsub]null[wmout]`
  }

  // v1.3.9: Chyron estilo manchete (texto branco bold sobre faixa PRETA SÓLIDA).
  // Posicao ligeiramente abaixo do centro (~y=1080 de 1920), centralizado.
  // Auto-split em ate 3 linhas pra nao estourar 1080px de largura.
  if (chyronText?.trim()) {
    const raw = String(chyronText).replace(/["'`]/g, '').toUpperCase().trim()
    // Wrap em ~22 chars - cabe em ~880px com fontsize 58 e margem esquerda 50
    const MAX_PER_LINE = 22
    const words = raw.split(/\s+/)
    const lines = []
    let cur = ''
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > MAX_PER_LINE && cur) {
        lines.push(cur.trim())
        cur = w
      } else {
        cur = (cur + ' ' + w).trim()
      }
    }
    if (cur) lines.push(cur.trim())

    const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,')
    const chFs = 58
    const chBorder = 22
    const lineH = chFs + 28
    const blockH = lines.length * lineH
    // Bloco centralizado VERTICALMENTE (960 = meio do 1920)
    const startY = Math.floor(960 - blockH / 2)
    // Bloco centralizado HORIZONTALMENTE usando a linha MAIS LONGA como referencia.
    // Todas linhas iniciam no MESMO X (alinhamento esquerda dentro do bloco), mas
    // o bloco como um todo fica centrado no video.
    const maxChars = Math.max(...lines.map(l => l.length))
    const approxLongestW = Math.floor(maxChars * chFs * 0.55) + (2 * chBorder)
    const chX = Math.max(50, Math.floor((1080 - approxLongestW) / 2))

    // v1.3.16: fonte padrao do ffmpeg drawtext nao tem Ç, ã, ó etc - aparecem como
    // quadrados pretos no chyron. Usa Arial Bold do Windows que tem suporte
    // completo Latin Extended.
    let chyronFontFile = ''
    try {
      const arialBd = 'C:/Windows/Fonts/arialbd.ttf'
      if (fs.existsSync(arialBd)) {
        // ffmpeg drawtext exige `:` escaped como `\:` e `\` como `/`
        chyronFontFile = `:fontfile=C\\:/Windows/Fonts/arialbd.ttf`
      }
    } catch {}

    let chyronF = ''
    let prevLabel = 'wmout'
    lines.forEach((line, i) => {
      const isLast = i === lines.length - 1
      const nextLabel = isLast ? 'out' : `ch${i}`
      const y = startY + (i * lineH)
      chyronF += `;[${prevLabel}]drawtext=text='${esc(line)}'${chyronFontFile}:fontcolor=white:fontsize=${chFs}:box=1:boxcolor=black:boxborderw=${chBorder}:x=${chX}:y=${y}[${nextLabel}]`
      prevLabel = nextLabel
    })
    filter += chyronF
    log?.(`   📰 Chyron (${lines.length} linhas): "${raw.slice(0, 60)}${raw.length > 60 ? '...' : ''}"`)
  } else {
    filter += `;[wmout]null[out]`
  }

  const finalCmd = `"${ffmpegPath}" -y -i "${workingVideo}"${extraInputs} -filter_complex "${filter}" -map "[out]" -map 0:a? -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`
  await execAsync(finalCmd, { timeout: 900000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })

  // Cleanup
  if (workingVideo !== videoPath) try { fs.unlinkSync(workingVideo) } catch {}
  if (assPath) try { fs.unlinkSync(assPath) } catch {}

  return outputPath
}
