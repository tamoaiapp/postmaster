/**
 * TTS local via Piper. Vozes BR pré-treinadas (homem + mulher) baked no installer.
 * Output: WAV concatenado de cada segmento, com timing sincronizado.
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import ffmpegStaticLib from 'ffmpeg-static'

const execAsync = promisify(exec)
const ffmpegPath = (ffmpegStaticLib || 'ffmpeg').replace(/[\\/]app\.asar[\\/]/, '/app.asar.unpacked/')

const VOICES = {
  homem: { model: 'pt_BR-faber-medium.onnx', config: 'pt_BR-faber-medium.onnx.json' },
  mulher: { model: 'pt_BR-cadu-medium.onnx', config: 'pt_BR-cadu-medium.onnx.json' },
}

function findPiper() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'piper') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null,
    path.join(process.cwd(), 'bin', 'piper'),
    path.join(process.cwd(), 'bin'),
  ].filter(Boolean)
  for (const dir of candidates) {
    const e = path.join(dir, process.platform === 'win32' ? 'piper.exe' : 'piper')
    if (fs.existsSync(e)) return { exe: e, dir: path.dirname(e) }
  }
  return { exe: null, dir: null }
}

function findVoice(voiceKey) {
  const v = VOICES[voiceKey] || VOICES.homem
  const { dir } = findPiper()
  if (!dir) return null
  // Procura model + config na pasta do piper OU em subpasta voices/
  const candidates = [dir, path.join(dir, 'voices'), path.join(dir, '..', 'piper-voices')]
  for (const d of candidates) {
    const m = path.join(d, v.model)
    const c = path.join(d, v.config)
    if (fs.existsSync(m) && fs.existsSync(c)) return { model: m, config: c }
  }
  return null
}

/**
 * Gera audio TTS pra cada segmento e concatena no timing original.
 * @param {Array<{start,end,text,textPtBr}>} segments
 * @param {Object} opts
 * @param {'homem'|'mulher'} [opts.voice='homem']
 * @param {number} opts.duration - duracao total do video em segundos
 * @param {string} opts.outputWav - caminho do WAV final
 * @param {function} [opts.log]
 */
export async function gerarAudioDublado(segments, { voice = 'homem', duration, outputWav, log = () => {} }) {
  const { exe } = findPiper()
  if (!exe) throw new Error('Piper TTS nao encontrado em bin/piper/')
  const voiceFiles = findVoice(voice)
  if (!voiceFiles) throw new Error(`Voz ${voice} nao encontrada em bin/piper/`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tts-'))
  log(`   🎤 Piper TTS (${voice}) gerando ${segments.length} segmentos...`)

  // Gera 1 WAV por segmento + ajusta velocidade pra caber no slot (sem overlap)
  const wavs = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const txt = (seg.textPtBr || seg.text || '').replace(/"/g, '\\"').trim()
    if (!txt) continue
    const rawOut = path.join(tmpDir, `s${String(i).padStart(4, '0')}_raw.wav`)
    const out = path.join(tmpDir, `s${String(i).padStart(4, '0')}.wav`)
    const cmd = `echo "${txt}" | "${exe}" --model "${voiceFiles.model}" --config "${voiceFiles.config}" --output_file "${rawOut}" 2>nul`
    try {
      await execAsync(cmd, { timeout: 60000, windowsHide: true, shell: true })
      if (!fs.existsSync(rawOut) || fs.statSync(rawOut).size < 100) continue

      // Mede duracao real do WAV e calcula slot disponivel (ate o proximo segmento)
      const slotEnd = (segments[i + 1]?.start ?? (seg.end + 0.5))
      const slot = Math.max(0.3, slotEnd - seg.start)  // minimo 300ms

      let actualDur = 0
      try {
        const probe = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${rawOut}"`, { timeout: 10000, windowsHide: true })
        actualDur = parseFloat(probe.stdout.trim()) || 0
      } catch {}

      // Se passa do slot, aplica atempo pra encolher (max 1.8x pra nao ficar desnaturado)
      if (actualDur > slot && actualDur > 0) {
        const speedup = Math.min(1.8, actualDur / slot)
        const filters = buildAtempoChain(speedup)
        const speedCmd = `"${ffmpegPath}" -y -i "${rawOut}" -filter:a "${filters}" "${out}" 2>nul`
        try {
          await execAsync(speedCmd, { timeout: 30000, windowsHide: true, shell: true })
          try { fs.unlinkSync(rawOut) } catch {}
        } catch {
          // Falhou speedup: usa raw mesmo (vai ter overlap, mas melhor que nada)
          fs.renameSync(rawOut, out)
        }
      } else {
        fs.renameSync(rawOut, out)
      }

      if (fs.existsSync(out) && fs.statSync(out).size > 100) {
        wavs.push({ path: out, start: seg.start, end: seg.end })
      }
    } catch (e) {
      // Pula segmento que falhou
    }
  }

  if (wavs.length === 0) throw new Error('Piper TTS nao gerou nenhum segmento')

  // Monta filtro complex: cria silencio base e cola cada WAV no offset correto
  log('   🔗 Montando track de audio dublado...')

  // v1.1.8: pra videos longos (>5min) podemos ter 200+ segmentos = comando ffmpeg
  // ultrapassa limite de 8191 chars no Windows. Usa arquivo de texto:
  //   - inputs num .txt (1 input por linha) lido com -i_file (NAO suportado)
  // Solucao: usa -filter_complex_script com arquivo .txt pro filter.
  // Pros inputs, separa em batches de WAVs pra arquivos intermediarios concat.

  const BATCH_SIZE = 80  // ~80 inputs por batch fica abaixo do limite de cmd line
  const tmpBatchDir = path.dirname(outputWav)
  let mixedTracks = []

  if (wavs.length <= BATCH_SIZE) {
    // Caso simples: 1 unico comando ffmpeg
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
    // Escreve filter num arquivo pra evitar cmd line gigante
    const filterFile = path.join(tmpBatchDir, `filter_${Date.now()}.txt`)
    fs.writeFileSync(filterFile, filter)
    const cmd = `"${ffmpegPath}" -y ${baseInput} ${inputs} -filter_complex_script "${filterFile}" -map "[out]" -c:a pcm_s16le -ar 22050 -ac 2 "${outputWav}"`
    await execAsync(cmd, { timeout: 600000, windowsHide: true, maxBuffer: 128 * 1024 * 1024, shell: true })
    try { fs.unlinkSync(filterFile) } catch {}
  } else {
    // Caso pesado: divide em batches, cada batch gera 1 WAV intermediario, depois mix final
    log(`   📦 ${wavs.length} segmentos -> processando em batches de ${BATCH_SIZE}`)
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
    // Mix final dos batches
    log(`   🎚️ Mix final dos ${mixedTracks.length} batches`)
    const finalInputs = mixedTracks.map(t => `-i "${t}"`).join(' ')
    let finalFilter = ''
    for (let i = 0; i < mixedTracks.length; i++) finalFilter += `[${i}:a]`
    finalFilter += `amix=inputs=${mixedTracks.length}:duration=longest:normalize=0[out]`
    const finalFilterFile = path.join(tmpBatchDir, `filter_final_${Date.now()}.txt`)
    fs.writeFileSync(finalFilterFile, finalFilter)
    const finalCmd = `"${ffmpegPath}" -y ${finalInputs} -filter_complex_script "${finalFilterFile}" -map "[out]" -c:a pcm_s16le -ar 22050 -ac 2 "${outputWav}"`
    await execAsync(finalCmd, { timeout: 600000, windowsHide: true, maxBuffer: 128 * 1024 * 1024, shell: true })
    try { fs.unlinkSync(finalFilterFile) } catch {}
    // Limpa batches intermediarios
    for (const t of mixedTracks) { try { fs.unlinkSync(t) } catch {} }
  }

  // Limpa
  for (const w of wavs) try { fs.unlinkSync(w.path) } catch {}
  try { fs.rmdirSync(tmpDir) } catch {}
  return outputWav
}

export function listarVozes() {
  return Object.keys(VOICES)
}

// atempo so aceita 0.5-2.0; pra valores fora, encadeia varios
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
