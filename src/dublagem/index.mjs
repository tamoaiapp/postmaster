/**
 * Pipeline completo de dublagem PT-BR:
 *   video -> whisper -> traducao Qwen -> Piper TTS -> compose (audio novo + legenda opcional)
 *
 * Tudo local, sem custo de API. ~10-30min de processamento por video de 15min.
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import ffmpegStaticLib from 'ffmpeg-static'
import { transcreverVideo } from './transcribe.mjs'
import { traduzirSegmentos } from './translate.mjs'
import { gerarAudioDublado } from './tts.mjs'
import { getVideoDuration, detectSilences, buildKeepRanges, buildKeepRangesFilter, totalKeptDuration } from '../videoEditor.mjs'

const execAsync = promisify(exec)
const ffmpegPath = (ffmpegStaticLib || 'ffmpeg').replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/')

/**
 * @param {Object} opts
 * @param {string} opts.videoPath - mp4 input
 * @param {string} opts.outputPath - mp4 final dublado
 * @param {'homem'|'mulher'} [opts.voice='homem']
 * @param {boolean} [opts.queimarLegenda=false]
 * @param {string} [opts.langOrigem='auto'] - 'auto', 'en', 'es', 'ja', etc
 * @param {boolean} [opts.modoNarracao=false] - se true, pula traducao (video ja em PT, so re-narra)
 * @param {function} opts.log
 */
export async function dublarVideo({ videoPath, outputPath, voice = 'homem', queimarLegenda = false, langOrigem = 'auto', modoNarracao = false, log = () => {} }) {
  const dur = await getVideoDuration(ffmpegPath, videoPath)
  if (!dur || dur < 2) throw new Error(`Duracao invalida: ${dur}`)

  log('🎙️ [1/4] Transcrevendo audio original (Whisper local)...')
  const langWhisper = modoNarracao ? 'pt' : langOrigem
  const segments = await transcreverVideo(videoPath, { lang: langWhisper, log })
  if (segments.length === 0) throw new Error('Whisper nao retornou segmentos')
  log(`   ${segments.length} segmentos transcritos`)

  let traduzidos
  if (modoNarracao) {
    log('🇧🇷 [2/4] Modo NARRACAO: video ja em PT, pulando traducao')
    traduzidos = segments.map(s => ({ ...s, textPtBr: s.text }))
  } else {
    log('🇧🇷 [2/4] Traduzindo pra PT-BR (Qwen local)...')
    traduzidos = await traduzirSegmentos(segments, { log })
  }

  log('🎤 [3/4] Gerando narracao em PT-BR (Piper TTS)...')
  const dublagemWav = videoPath.replace(/\.\w+$/, '_dublagem.wav')
  await gerarAudioDublado(traduzidos, { voice, duration: dur, outputWav: dublagemWav, log })

  // Gera ASS legenda opcional
  let assPath = null
  if (queimarLegenda) {
    assPath = videoPath.replace(/\.\w+$/, '_subs.ass')
    fs.writeFileSync(assPath, segmentsToAss(traduzidos))
  }

  log('🎬 [4/5] Compondo video com audio dublado...')
  // Etapa intermediaria: video original + audio dublado (sem corte de silencio ainda)
  const stageMp4 = outputPath.replace(/\.mp4$/i, '_stage.mp4')
  let vf = 'null'
  if (assPath) {
    vf = `ass='${assPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'`
  }
  const stageCmd = `"${ffmpegPath}" -y -i "${videoPath}" -i "${dublagemWav}" -map 0:v -map 1:a -vf "${vf}" -c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart "${stageMp4}"`
  await execAsync(stageCmd, { timeout: 1800000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 })

  log('✂️ [5/5] Cortando pausas estranhas (silencio inerdado do ritmo original)...')
  try {
    const silences = await detectSilences(ffmpegPath, stageMp4, { threshold: -32, minSilence: 0.45 })
    const stageDur = await getVideoDuration(ffmpegPath, stageMp4)
    const keepRanges = buildKeepRanges(silences, stageDur, 0.10)
    const kept = totalKeptDuration(keepRanges)
    const cortou = stageDur - kept
    if (silences.length > 0 && cortou > 0.5) {
      log(`   ✂️ ${silences.length} silencios -> cortou ${cortou.toFixed(1)}s (${(stageDur/60).toFixed(1)}min -> ${(kept/60).toFixed(1)}min)`)
      const kr = buildKeepRangesFilter(keepRanges)
      // filter gigante (220 ranges) estoura limite 8191 do cmd Windows -> usa arquivo
      const filterScript = `[0:v]${kr.vFilter}[v];[0:a]${kr.aFilter}[a]`
      const filterFile = stageMp4.replace(/\.mp4$/i, '_cutfilter.txt')
      fs.writeFileSync(filterFile, filterScript)
      const cutCmd = `"${ffmpegPath}" -y -i "${stageMp4}" -filter_complex_script "${filterFile}" -map "[v]" -map "[a]" -c:v libx264 -preset ultrafast -crf 22 -c:a aac -b:a 192k -movflags +faststart "${outputPath}"`
      await execAsync(cutCmd, { timeout: 1800000, windowsHide: true, maxBuffer: 128 * 1024 * 1024, shell: true })
      try { fs.unlinkSync(filterFile) } catch {}
      try { fs.unlinkSync(stageMp4) } catch {}
    } else {
      log('   sem pausas significativas, usando stage direto')
      fs.renameSync(stageMp4, outputPath)
    }
  } catch (e) {
    log(`   ⚠️ corte de silencio falhou (${e.message.slice(0,60)}) - usando stage`)
    try { fs.renameSync(stageMp4, outputPath) } catch {}
  }

  try { fs.unlinkSync(dublagemWav) } catch {}
  if (assPath) try { fs.unlinkSync(assPath) } catch {}
  log('✅ Dublagem concluida')
  return outputPath
}

function segmentsToAss(segments) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Outline, Shadow, Alignment, MarginV
Style: D,Arial,52,&H00FFFFFF,&H00000000,&H80000000,3,2,2,80

[Events]
Format: Layer, Start, End, Style, Text
`
  const lines = segments.map(s => `Dialogue: 0,${asSec(s.start)},${asSec(s.end)},D,${(s.textPtBr || '').replace(/\n/g, ' ')}`)
  return header + lines.join('\n')
}

function asSec(s) {
  const h = Math.floor(s / 3600).toString()
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0')
  const sec = (s % 60).toFixed(2).padStart(5, '0')
  return `${h}:${m}:${sec}`
}
