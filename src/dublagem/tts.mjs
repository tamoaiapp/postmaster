/**
 * TTS via Microsoft Edge Neural Voices (msedge-tts).
 * v1.3.2: Trocado Piper (que crashava com voices novas) e SAPI (qualidade ruim)
 * por Edge TTS — vozes neurais PT-BR HD (Francisca, Antonio) via API publica
 * do Microsoft Edge. Sem API key, sem custo. Precisa internet (que o app
 * ja usa pra baixar/postar).
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import ffmpegStaticLib from 'ffmpeg-static'

const execAsync = promisify(exec)
const ffmpegPath = (ffmpegStaticLib || 'ffmpeg').replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/')

// Vozes neurais Edge TTS PT-BR
const VOICES = {
  homem:   'pt-BR-AntonioNeural',     // homem - voz profissional
  mulher:  'pt-BR-FranciscaNeural',   // mulher - voz padrao Edge
  brenda:  'pt-BR-BrendaNeural',      // mulher alternativa
  donato:  'pt-BR-DonatoNeural',      // homem alternativo
  fabio:   'pt-BR-FabioNeural',       // homem profissional
  giovanna:'pt-BR-GiovannaNeural',    // mulher jovem
  humberto:'pt-BR-HumbertoNeural',    // homem maduro
  leila:   'pt-BR-LeilaNeural',
  manuela: 'pt-BR-ManuelaNeural',
  yara:    'pt-BR-YaraNeural',
}

async function synthEdge(text, outWav, voiceName) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
  const tts = new MsEdgeTTS()
  await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
  const mp3Out = outWav.replace(/\.wav$/i, '.mp3')
  const { audioStream } = tts.toStream(text)
  const chunks = []
  for await (const chunk of audioStream) chunks.push(chunk)
  fs.writeFileSync(mp3Out, Buffer.concat(chunks))
  // Converte MP3 -> WAV (rest do pipeline espera WAV)
  await execAsync(`"${ffmpegPath}" -y -i "${mp3Out}" -ar 22050 -ac 1 "${outWav}" 2>nul`, {
    timeout: 30000, windowsHide: true, shell: true, maxBuffer: 32 * 1024 * 1024
  })
  try { fs.unlinkSync(mp3Out) } catch {}
}

export async function gerarAudioDublado(segments, { voice = 'mulher', duration, outputWav, log = () => {} }) {
  const voiceName = VOICES[voice] || VOICES.mulher
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tts-'))
  log(`   🎤 Edge TTS (${voiceName}) gerando ${segments.length} segmentos...`)

  const wavs = []
  let lastLog = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const txt = (seg.textPtBr || seg.text || '').trim()
    if (!txt) continue
    const rawOut = path.join(tmpDir, `s${String(i).padStart(4, '0')}_raw.wav`)
    const out = path.join(tmpDir, `s${String(i).padStart(4, '0')}.wav`)

    try {
      await synthEdge(txt, rawOut, voiceName)
      if (!fs.existsSync(rawOut) || fs.statSync(rawOut).size < 500) continue

      // Mede duracao e ajusta velocidade
      const slotEnd = (segments[i + 1]?.start ?? (seg.end + 0.5))
      const slot = Math.max(0.3, slotEnd - seg.start)

      let actualDur = 0
      try {
        const probe = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${rawOut}"`, { timeout: 10000, windowsHide: true })
        actualDur = parseFloat(probe.stdout.trim()) || 0
      } catch {}

      if (actualDur > slot && actualDur > 0) {
        const speedup = Math.min(1.8, actualDur / slot)
        const filters = buildAtempoChain(speedup)
        const speedCmd = `"${ffmpegPath}" -y -i "${rawOut}" -filter:a "${filters}" -ar 22050 -ac 1 "${out}" 2>nul`
        try {
          await execAsync(speedCmd, { timeout: 30000, windowsHide: true, shell: true })
          try { fs.unlinkSync(rawOut) } catch {}
        } catch {
          fs.renameSync(rawOut, out)
        }
      } else {
        fs.renameSync(rawOut, out)
      }

      if (fs.existsSync(out) && fs.statSync(out).size > 500) {
        wavs.push({ path: out, start: seg.start, end: seg.end })
      }
    } catch (e) {
      if (i - lastLog >= 5) { log(`   ⚠️ Edge TTS seg ${i}: ${e.message.slice(0, 60)}`); lastLog = i }
    }

    // Progresso a cada 10%
    if (i > 0 && i % Math.max(1, Math.floor(segments.length / 10)) === 0) {
      log(`   🎤 ${i}/${segments.length}`)
    }
  }

  if (wavs.length === 0) throw new Error('Edge TTS nao gerou nenhum segmento - verifique sua conexao com internet')

  log(`   🔗 Mixando ${wavs.length} segmentos...`)

  const BATCH_SIZE = 80
  const tmpBatchDir = path.dirname(outputWav)
  let mixedTracks = []

  if (wavs.length <= BATCH_SIZE) {
    const baseInput = `-f lavfi -t ${Math.ceil(duration)} -i "anullsrc=channel_layout=stereo:sample_rate=22050"`
    const inputs = wavs.map(w => `-i "${w.path}"`).join(' ')
    let filter = '[0]asplit=1[base];'
    let mix = '[base]'
    for (let i = 0; i < wavs.length; i++) {
      const offsetMs = Math.round(wavs[i].start * 1000)
      filter += `[${i + 1}:a]adelay=${offsetMs}|${offsetMs}[d${i}];`
      mix += `[d${i}]`
    }
    filter += `${mix}amix=inputs=${wavs.length + 1}:duration=longest:normalize=0[out]`
    const filterFile = path.join(tmpBatchDir, `filter_${Date.now()}.txt`)
    fs.writeFileSync(filterFile, filter)
    const cmd = `"${ffmpegPath}" -y ${baseInput} ${inputs} -filter_complex_script "${filterFile}" -map "[out]" -c:a pcm_s16le -ar 22050 -ac 2 "${outputWav}"`
    await execAsync(cmd, { timeout: 600000, windowsHide: true, maxBuffer: 128 * 1024 * 1024, shell: true })
    try { fs.unlinkSync(filterFile) } catch {}
  } else {
    log(`   📦 ${wavs.length} -> batches de ${BATCH_SIZE}`)
    for (let b = 0; b < wavs.length; b += BATCH_SIZE) {
      const batch = wavs.slice(b, b + BATCH_SIZE)
      const batchOut = path.join(tmpBatchDir, `batch_${b}_${Date.now()}.wav`)
      const baseInput = `-f lavfi -t ${Math.ceil(duration)} -i "anullsrc=channel_layout=stereo:sample_rate=22050"`
      const inputs = batch.map(w => `-i "${w.path}"`).join(' ')
      let filter = '[0]asplit=1[base];'
      let mix = '[base]'
      for (let i = 0; i < batch.length; i++) {
        const offsetMs = Math.round(batch[i].start * 1000)
        filter += `[${i + 1}:a]adelay=${offsetMs}|${offsetMs}[d${i}];`
        mix += `[d${i}]`
      }
      filter += `${mix}amix=inputs=${batch.length + 1}:duration=longest:normalize=0[out]`
      const filterFile = path.join(tmpBatchDir, `filter_b${b}_${Date.now()}.txt`)
      fs.writeFileSync(filterFile, filter)
      const cmd = `"${ffmpegPath}" -y ${baseInput} ${inputs} -filter_complex_script "${filterFile}" -map "[out]" -c:a pcm_s16le -ar 22050 -ac 2 "${batchOut}"`
      await execAsync(cmd, { timeout: 600000, windowsHide: true, maxBuffer: 128 * 1024 * 1024, shell: true })
      try { fs.unlinkSync(filterFile) } catch {}
      mixedTracks.push(batchOut)
      log(`   ✓ batch ${Math.floor(b/BATCH_SIZE)+1}/${Math.ceil(wavs.length/BATCH_SIZE)}`)
    }
    const finalInputs = mixedTracks.map(t => `-i "${t}"`).join(' ')
    let finalFilter = ''
    for (let i = 0; i < mixedTracks.length; i++) finalFilter += `[${i}:a]`
    finalFilter += `amix=inputs=${mixedTracks.length}:duration=longest:normalize=0[out]`
    const finalFilterFile = path.join(tmpBatchDir, `filter_final_${Date.now()}.txt`)
    fs.writeFileSync(finalFilterFile, finalFilter)
    const finalCmd = `"${ffmpegPath}" -y ${finalInputs} -filter_complex_script "${finalFilterFile}" -map "[out]" -c:a pcm_s16le -ar 22050 -ac 2 "${outputWav}"`
    await execAsync(finalCmd, { timeout: 600000, windowsHide: true, maxBuffer: 128 * 1024 * 1024, shell: true })
    try { fs.unlinkSync(finalFilterFile) } catch {}
    for (const t of mixedTracks) { try { fs.unlinkSync(t) } catch {} }
  }

  for (const w of wavs) try { fs.unlinkSync(w.path) } catch {}
  try { fs.rmdirSync(tmpDir) } catch {}
  return outputWav
}

export function listarVozes() {
  return Object.keys(VOICES)
}

function buildAtempoChain(factor) {
  if (factor <= 2.0) return `atempo=${factor.toFixed(3)}`
  const chain = []
  let remaining = factor
  while (remaining > 2.0) {
    chain.push('atempo=2.0')
    remaining /= 2.0
  }
  chain.push(`atempo=${remaining.toFixed(3)}`)
  return chain.join(',')
}
