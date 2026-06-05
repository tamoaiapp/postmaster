/**
 * Anexa uma "outro" (foto ou video curto) no FINAL do reel pra divulgar
 * produto/servico/marca. Re-codifica com mesma config do reel pra concat
 * funcionar sem desync de codec/timebase.
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import ffmpegPathLib from 'ffmpeg-static'

const execAsync = promisify(exec)
const ffmpegPath = (ffmpegPathLib || 'ffmpeg').replace('app.asar', 'app.asar.unpacked')

/**
 * @param {string} reelPath - mp4 final do reel (9:16 1080x1920 ja convertido)
 * @param {Object} opts
 * @param {'image'|'video'} opts.type
 * @param {string} opts.outroPath - caminho do .png/.jpg ou .mp4
 * @param {number} [opts.durationSec=3] - so pra image (video usa a duracao real)
 * @param {function} [opts.log]
 * @returns {Promise<string>} caminho do reel COM outro anexado (substitui reelPath)
 */
export async function appendOutroToReel(reelPath, { type, outroPath, durationSec = 3, log = () => {} }) {
  if (!type || type === 'none' || !outroPath) return reelPath
  if (!fs.existsSync(outroPath)) {
    log(`⚠️ Outro: arquivo nao encontrado em ${outroPath}, pulando`)
    return reelPath
  }
  const dur = Math.max(1, Math.min(15, durationSec || 3))
  const dir = path.dirname(reelPath)
  const tmpOutro = path.join(dir, `_outro_${Date.now()}.mp4`)
  const finalOut = reelPath.replace(/\.mp4$/, '_with_outro.mp4')

  try {
    if (type === 'image') {
      // Foto vira mp4 1080x1920 com fundo preto cobrindo, com audio silente
      const cmd = `"${ffmpegPath}" -y -loop 1 -t ${dur} -i "${outroPath}" ` +
        `-f lavfi -t ${dur} -i anullsrc=channel_layout=stereo:sample_rate=44100 ` +
        `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30" ` +
        `-c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p ` +
        `-c:a aac -b:a 128k -shortest -movflags +faststart "${tmpOutro}"`
      log(`📢 Gerando outro de imagem (${dur}s)...`)
      await execAsync(cmd, { timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    } else {
      // Video: re-codifica pra mesma config do reel (1080x1920, 30fps, h264, aac)
      const cmd = `"${ffmpegPath}" -y -i "${outroPath}" ` +
        `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30" ` +
        `-c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p ` +
        `-c:a aac -b:a 128k -ar 44100 -ac 2 -movflags +faststart "${tmpOutro}"`
      log(`📢 Re-codificando outro de video...`)
      await execAsync(cmd, { timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    }

    // Concat com filter_complex (robusto contra timebase diferente)
    const concatCmd = `"${ffmpegPath}" -y -i "${reelPath}" -i "${tmpOutro}" ` +
      `-filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]" ` +
      `-map "[v]" -map "[a]" -c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k -movflags +faststart "${finalOut}"`
    log(`🔗 Concatenando reel + outro...`)
    await execAsync(concatCmd, { timeout: 180000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })

    // Limpa temp + substitui original
    try { fs.unlinkSync(tmpOutro) } catch {}
    try { fs.unlinkSync(reelPath) } catch {}
    log(`✅ Outro anexado`)
    return finalOut
  } catch (e) {
    log(`⚠️ Erro ao anexar outro: ${e.message.split('\n')[0].slice(0, 100)} — postando sem outro`)
    try { fs.unlinkSync(tmpOutro) } catch {}
    return reelPath
  }
}
