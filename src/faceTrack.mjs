/**
 * faceTrack — detecção e tracking de rosto pra crop inteligente 9:16.
 *
 * Stack:
 *  - onnxruntime-node (prebuilt, sem build nativo)
 *  - Modelo: Ultra-Light-Face-Detector RFB-640 (~1.5MB) — public domain, ONNX
 *  - sharp pra leitura/resize de imagem
 *  - ffmpeg pra scene detection + extração de keyframes
 *
 * Pipeline:
 *  1. detectScenes(video) → lista de timestamps de cortes de câmera
 *  2. Pra cada cena: extrai 1 keyframe (mid-scene), roda face detection
 *  3. Constrói timeline [{from, to, faceX, faceY, faceW, faceH}]
 *  4. buildCropFilter(timeline) → ffmpeg crop expression que segue o rosto
 *
 * Performance: ~50-200ms por keyframe (CPU). Em vídeo de 120s com ~30 cenas,
 * face detection custa ~3-10s. Total render fica ~30% mais lento.
 */
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// ── Modelo: input/output specs do Ultra-Light RFB-640 ──────────────────────────
const MODEL_INPUT_W = 640
const MODEL_INPUT_H = 480
const MODEL_INPUT_NAME = 'input'   // verificado no modelo
const MODEL_OUT_SCORES = 'scores'
const MODEL_OUT_BOXES  = 'boxes'

let _session = null
let _modelPath = null

export function setModelPath(p) { _modelPath = p }

async function getSession() {
  if (_session) return _session
  if (!_modelPath || !fs.existsSync(_modelPath)) throw new Error(`Modelo face não encontrado em ${_modelPath}`)
  _session = await ort.InferenceSession.create(_modelPath, { executionProviders: ['cpu'] })
  return _session
}

// ── 1. Detecção de cenas via ffmpeg ───────────────────────────────────────────

/**
 * Usa ffmpeg select=gt(scene,0.3) pra detectar mudanças de câmera.
 * Retorna timestamps [t1, t2, ...] de inícios de cena (t=0 não incluso).
 */
export async function detectScenes(ffmpegPath, videoPath, threshold = 0.3) {
  const cmd = `"${ffmpegPath}" -nostats -i "${videoPath}" -vf "select=gt(scene\\,${threshold}),showinfo" -f null - 2>&1`
  let stderr = ''
  try {
    const { stdout } = await execAsync(cmd, { timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    stderr = stdout
  } catch (e) {
    stderr = (e.stderr || '') + (e.stdout || '')
  }
  const scenes = []
  for (const line of stderr.split(/\r?\n/)) {
    // [Parsed_showinfo_1 @ ...] n: X pts: Y pts_time: T.TTT ...
    const m = line.match(/pts_time:\s*([\d.]+)/)
    if (m) scenes.push(parseFloat(m[1]))
  }
  // Deduplica timestamps muito próximos (< 1s)
  const out = []
  for (const t of scenes.sort((a, b) => a - b)) {
    if (!out.length || t - out[out.length - 1] > 0.5) out.push(t)
  }
  return out
}

// ── 2. Extração de frame em um timestamp específico ───────────────────────────

export async function extractFrameAt(ffmpegPath, videoPath, t, outPath) {
  const cmd = `"${ffmpegPath}" -y -ss ${t.toFixed(2)} -i "${videoPath}" -frames:v 1 -q:v 3 "${outPath}"`
  await execAsync(cmd, { timeout: 30000, windowsHide: true })
  return outPath
}

// ── 3. Face detection num único frame ─────────────────────────────────────────

/**
 * Preprocessa imagem e roda inference. Retorna lista de faces detectadas
 * em coordenadas da imagem ORIGINAL (não da resolução do modelo).
 *
 * @returns [{ x, y, w, h, confidence }]
 */
export async function detectFacesInImage(imagePath, minConfidence = 0.7) {
  const session = await getSession()

  // Carrega imagem original pra saber dims
  const meta = await sharp(imagePath).metadata()
  const origW = meta.width, origH = meta.height

  // Resize pro tamanho do modelo (640x480), RGB raw
  const { data } = await sharp(imagePath)
    .resize(MODEL_INPUT_W, MODEL_INPUT_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // RGB raw → NCHW BGR float (Ultra-Light espera BGR, mean=127, std=128)
  // Layout do output: [B[0..W*H-1], G[0..W*H-1], R[0..W*H-1]]
  const N = MODEL_INPUT_W * MODEL_INPUT_H
  const tensor = new Float32Array(3 * N)
  for (let i = 0; i < N; i++) {
    const r = data[i * 3]
    const g = data[i * 3 + 1]
    const b = data[i * 3 + 2]
    tensor[i]         = (b - 127) / 128      // B
    tensor[N + i]     = (g - 127) / 128      // G
    tensor[2 * N + i] = (r - 127) / 128      // R
  }

  const input = new ort.Tensor('float32', tensor, [1, 3, MODEL_INPUT_H, MODEL_INPUT_W])
  const results = await session.run({ [MODEL_INPUT_NAME]: input })

  const scores = results[MODEL_OUT_SCORES].data  // [1, N, 2] flat
  const boxes  = results[MODEL_OUT_BOXES].data   // [1, N, 4] flat (normalized x1,y1,x2,y2)
  const numAnchors = results[MODEL_OUT_BOXES].dims[1]

  // Coleta candidatos acima do threshold
  const candidates = []
  for (let i = 0; i < numAnchors; i++) {
    const bgScore = scores[i * 2]
    const faceScore = scores[i * 2 + 1]
    if (faceScore < minConfidence) continue
    const x1 = boxes[i * 4]     * origW
    const y1 = boxes[i * 4 + 1] * origH
    const x2 = boxes[i * 4 + 2] * origW
    const y2 = boxes[i * 4 + 3] * origH
    candidates.push({ x1, y1, x2, y2, confidence: faceScore })
  }

  // NMS (Non-Maximum Suppression) — remove caixas sobrepostas
  const filtered = nms(candidates, 0.3)
  return filtered.map(b => ({
    x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1,
    centerX: (b.x1 + b.x2) / 2, centerY: (b.y1 + b.y2) / 2,
    confidence: b.confidence,
  }))
}

function nms(boxes, iouThreshold) {
  // Ordena por confidence desc
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence)
  const keep = []
  while (sorted.length) {
    const top = sorted.shift()
    keep.push(top)
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(top, sorted[i]) > iouThreshold) sorted.splice(i, 1)
    }
  }
  return keep
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)
  if (x2 <= x1 || y2 <= y1) return 0
  const inter = (x2 - x1) * (y2 - y1)
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (areaA + areaB - inter)
}

// ── 4. Active speaker detection via lip movement ──────────────────────────────

/**
 * Recorta a região da BOCA (terço inferior do bbox do rosto) de uma imagem
 * e retorna os pixels raw pra comparação.
 */
async function extractMouthPixels(imagePath, face) {
  // Boca = bottom 30% do bbox, com margem horizontal (boca não usa rosto inteiro)
  const mouthH = face.h * 0.35
  const mouthY = face.y + face.h * 0.6
  const mouthW = face.w * 0.7
  const mouthX = face.x + face.w * 0.15

  const SAMPLE_W = 32, SAMPLE_H = 16 // resolução baixa pra comparação rápida e robusta a ruído
  try {
    const { data } = await sharp(imagePath)
      .extract({
        left:   Math.max(0, Math.round(mouthX)),
        top:    Math.max(0, Math.round(mouthY)),
        width:  Math.max(4, Math.round(mouthW)),
        height: Math.max(4, Math.round(mouthH)),
      })
      .resize(SAMPLE_W, SAMPLE_H, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return data
  } catch {
    return null
  }
}

/**
 * Compara 2 buffers de pixels (mesmo tamanho) e retorna MSE — quanto maior,
 * mais movimento entre os 2 frames na região da boca.
 */
function pixelDiff(buf1, buf2) {
  if (!buf1 || !buf2 || buf1.length !== buf2.length) return 0
  let sum = 0
  for (let i = 0; i < buf1.length; i++) {
    const d = buf1[i] - buf2[i]
    sum += d * d
  }
  return sum / buf1.length
}

/**
 * Match rostos entre 2 frames consecutivos via IoU (closest bbox).
 * Retorna pares [{ face1, face2 }] de rostos correspondentes.
 */
function matchFacesAcrossFrames(faces1, faces2, iouThreshold = 0.3) {
  const pairs = []
  const used2 = new Set()
  for (const f1 of faces1) {
    let bestMatch = null
    let bestIou = iouThreshold
    for (let i = 0; i < faces2.length; i++) {
      if (used2.has(i)) continue
      const iouVal = bboxIou(f1, faces2[i])
      if (iouVal > bestIou) { bestIou = iouVal; bestMatch = i }
    }
    if (bestMatch !== null) {
      pairs.push({ face1: f1, face2: faces2[bestMatch] })
      used2.add(bestMatch)
    }
  }
  return pairs
}

function bboxIou(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  if (x2 <= x1 || y2 <= y1) return 0
  const inter = (x2 - x1) * (y2 - y1)
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/**
 * Detecta o "active speaker" entre rostos detectados em 2 frames consecutivos.
 * Retorna o face1 com maior diff de pixels na região da boca.
 *
 * CRÍTICO: descarta rostos no terço inferior da imagem — geralmente são intérpretes
 * de Libras (que estão sempre falando) ou outros elementos de UI que sobrecarregam
 * o "lip movement" total. Esses rostos NUNCA devem ser escolhidos como speaker.
 *
 * @param imgH altura da imagem ORIGINAL (pra calcular limite vertical)
 */
export async function pickActiveSpeaker(framePath1, framePath2, faces1, faces2, imgH = 720) {
  // Filtra primeiro pelo limite vertical (descarta libras/UI)
  const yLimit = imgH * 0.75
  const validFaces1 = faces1.filter(f => f.centerY < yLimit)
  const validFaces2 = faces2.filter(f => f.centerY < yLimit)
  if (!validFaces1.length || !validFaces2.length) return null

  const pairs = matchFacesAcrossFrames(validFaces1, validFaces2)
  if (!pairs.length) return null

  const scored = []
  for (const { face1, face2 } of pairs) {
    const m1 = await extractMouthPixels(framePath1, face1)
    const m2 = await extractMouthPixels(framePath2, face2)
    const diff = pixelDiff(m1, m2)
    scored.push({ face: face1, lipDiff: diff })
  }
  scored.sort((a, b) => b.lipDiff - a.lipDiff)
  return scored[0]
}

// ── 5. Picker: escolhe rosto principal pra focar ──────────────────────────────

/**
 * Score combinado pra escolher o rosto principal:
 *  - Área (rosto maior = mais perto da câmera, geralmente importante)
 *  - Posição vertical: rostos no terço SUPERIOR ganham boost; no INFERIOR (libras,
 *    legendas, watermarks) ganham penalidade
 *  - Centralidade horizontal: leve preferência por estar perto do centro
 *  - Hard filter: ignora rostos abaixo de 75% da altura (claramente libras/UI)
 *
 * @param faces array do detectFacesInImage
 * @param imgH altura da imagem original (pra normalizar y)
 */
export function pickPrimaryFace(faces, imgH = 720) {
  if (!faces.length) return null

  const scored = faces
    .filter(f => f.centerY < imgH * 0.75) // descarta rostos no quarto inferior
    .map(f => {
      const yNorm = f.centerY / imgH                      // 0 (topo) ... 1 (base)
      const heightScore  = Math.max(0.4, 1.5 - yNorm * 1.5) // ~1.5 no topo, 0.4 na base
      const area         = f.w * f.h
      const score = area * heightScore * f.confidence
      return { ...f, score }
    })
    .sort((a, b) => b.score - a.score)

  return scored[0] || null
}

// ── 5. Pipeline: timeline densa via amostragem regular ────────────────────────

/**
 * Amostra o vídeo a cada `sampleSec` segundos, detecta rosto em cada amostra.
 * Independente de detecção de cena — funciona como tracking denso.
 *
 * Retorna array de pontos { t, centerX, centerY } com lacunas preenchidas:
 *  - Sem face detectada → herda do vizinho mais próximo (anterior ou próximo)
 *  - Se TODO o vídeo não tiver face → todos os pontos centrados
 *
 * @param sampleSec intervalo entre amostras (default 2.0s — ~60 amostras pra 120s)
 * @param srcW, srcH dimensões da imagem original (pra normalização do picker)
 */
export async function buildFaceTimeline({
  ffmpegPath, videoPath, totalDur, tmpDir, log,
  sampleSec = 2.0, srcW = 1280, srcH = 720, debug = false,
  detectSpeaker = true, // se true, extrai 2 frames por amostra e usa lip-movement
}) {
  fs.mkdirSync(tmpDir, { recursive: true })

  // Lista de timestamps a amostrar
  const times = []
  for (let t = 0.5; t < totalDur - 0.4; t += sampleSec) times.push(t)
  log?.(`   amostrando ${times.length} pontos (a cada ${sampleSec}s)${detectSpeaker ? ' + lip-movement' : ''}`)

  // Roda detecção em cada amostra
  const raw = []
  let speakerHits = 0
  for (let i = 0; i < times.length; i++) {
    const t = times[i]
    const framePathA = path.join(tmpDir, `kf_${i.toString().padStart(3, '0')}_a.jpg`)
    const framePathB = path.join(tmpDir, `kf_${i.toString().padStart(3, '0')}_b.jpg`)
    try {
      await extractFrameAt(ffmpegPath, videoPath, t, framePathA)
      const facesA = await detectFacesInImage(framePathA, 0.55)

      let primary = null
      let usedSpeaker = false
      if (detectSpeaker && facesA.length >= 2) {
        // Extrai 2º frame e tenta detectar speaker via lip movement
        await extractFrameAt(ffmpegPath, videoPath, t + 0.3, framePathB)
        const facesB = await detectFacesInImage(framePathB, 0.55)
        const speaker = await pickActiveSpeaker(framePathA, framePathB, facesA, facesB, srcH)
        if (speaker && speaker.lipDiff > 50) { // threshold mínimo de movimento
          primary = speaker.face
          usedSpeaker = true
          speakerHits++
        }
        try { fs.unlinkSync(framePathB) } catch {}
      }
      if (!primary) primary = pickPrimaryFace(facesA, srcH)

      raw.push({ t, face: primary, candidates: facesA.length, viaSpeaker: usedSpeaker })
      if (debug && i % 8 === 0 && primary) {
        const tag = usedSpeaker ? '🎤' : ''
        log?.(`      [${i}/${times.length}] t=${t.toFixed(1)}s rosto em (${Math.round(primary.centerX)},${Math.round(primary.centerY)}) ${facesA.length}c ${tag}`)
      }
      try { fs.unlinkSync(framePathA) } catch {}
    } catch (e) {
      raw.push({ t, face: null, candidates: 0 })
    }
  }
  if (detectSpeaker) log?.(`   ${speakerHits}/${raw.length} amostras escolhidas via lip-movement`)

  const withFace = raw.filter(p => p.face).length
  log?.(`   ${withFace}/${raw.length} amostras com rosto detectado`)
  if (!withFace) {
    log?.('   ⚠️ Nenhum rosto detectado em nenhuma amostra — vai usar centro')
    return raw.map(p => ({ t: p.t, centerX: srcW / 2, centerY: srcH / 2, hasFace: false }))
  }

  // Preenche lacunas: NEAREST neighbor (anterior ou próximo)
  const filled = raw.map((p, i) => {
    if (p.face) return { t: p.t, centerX: p.face.centerX, centerY: p.face.centerY, hasFace: true }
    let prev = null, next = null
    for (let j = i - 1; j >= 0; j--) { if (raw[j].face) { prev = raw[j]; break } }
    for (let j = i + 1; j < raw.length; j++) { if (raw[j].face) { next = raw[j]; break } }
    const chosen = !prev ? next : !next ? prev : (Math.abs(p.t - prev.t) <= Math.abs(next.t - p.t) ? prev : next)
    return { t: p.t, centerX: chosen.face.centerX, centerY: chosen.face.centerY, hasFace: false }
  })

  // Smooth: média móvel de janela 3 pra reduzir tremidos do tracker
  const smoothed = filled.map((p, i) => {
    const win = filled.slice(Math.max(0, i - 1), Math.min(filled.length, i + 2))
    const avgX = win.reduce((a, q) => a + q.centerX, 0) / win.length
    const avgY = win.reduce((a, q) => a + q.centerY, 0) / win.length
    return { t: p.t, centerX: avgX, centerY: avgY, hasFace: p.hasFace }
  })

  return smoothed
}

// ── 6. Filter ffmpeg que faz crop seguindo o rosto ────────────────────────────

/**
 * Gera ffmpeg filter complex que segue o rosto com crop INTERPOLADO.
 *
 * Recebe timeline densa [{t, centerX, centerY}] (em coords da imagem original).
 * Constrói expression que interpola linearmente entre pontos consecutivos —
 * câmera "navega" suavemente em vez de teleportar entre cenas.
 *
 * Layout: scale=-2:cropH (mantém aspect), crop=cropW:cropH:x=interp:0
 *  - cropW=1080, cropH=1080 → quadrado, ocupa 56% da tela 1920 (menos zoom)
 *
 * @param points [{t, centerX, centerY}] em coords da imagem ORIGINAL
 * @param srcW, srcH dimensões da imagem original
 * @param cropH altura do crop final (default 1080 = quadrado)
 */
export function buildFaceCropFilter(points, srcW, srcH, {
  cropW = 1080, cropH = 1344,
  cutDiffPx = 250,       // diff em x (coords source) que considera "troca de speaker" → cut seco
  minShotSec = 2.5,      // duração mínima de um shot antes de outro cut
} = {}) {
  if (!points.length) return `scale=-2:${cropH},crop=${cropW}:${cropH}:(iw-${cropW})/2:0`

  const scaledH = cropH
  const scaledW = Math.round(srcW * (scaledH / srcH) / 2) * 2
  const maxX = scaledW - cropW

  // ── 1) Agrupa pontos em SHOTS: novo shot quando |Δx| > cutDiffPx E passou minShotSec
  const shots = [] // cada shot é array de {t, x}
  let cur = []
  let lastCutT = points[0].t

  function addPoint(p) {
    const xScaled = (p.centerX / srcW) * scaledW
    cur.push({ t: p.t, x: Math.max(0, Math.min(maxX, xScaled - cropW / 2)), srcX: p.centerX })
  }
  addPoint(points[0])

  for (let i = 1; i < points.length; i++) {
    const prevSrc = cur[cur.length - 1].srcX
    const dx = Math.abs(points[i].centerX - prevSrc)
    if (dx > cutDiffPx && (points[i].t - lastCutT) >= minShotSec) {
      shots.push(cur)
      cur = []
      lastCutT = points[i].t
    }
    addPoint(points[i])
  }
  if (cur.length) shots.push(cur)

  // ── 2) Pra cada shot, computa x MÉDIO (estável) — dentro do shot fica fixo, sem pan
  //     (visual de "câmera parada em pessoa", clássico de edição agressiva)
  const shotXs = shots.map(s => {
    const avgX = s.reduce((a, p) => a + p.x, 0) / s.length
    return { from: s[0].t, to: s[s.length - 1].t, x: avgX }
  })

  // ── 3) Constrói expression cascateado:
  //     Pra cada t entre shot.from e shot.to, x = shot.x (fixo).
  //     Entre shots, cut instantâneo.
  let xExpr = shotXs[shotXs.length - 1].x.toFixed(0)
  for (let i = shotXs.length - 1; i >= 0; i--) {
    const s = shotXs[i]
    // 'to' do último shot extende-se até inf; do penúltimo, até o 'from' do próximo
    const to = (i === shotXs.length - 1) ? 99999 : shotXs[i + 1].from
    xExpr = `if(between(t\\,${s.from.toFixed(2)}\\,${to.toFixed(2)})\\,${s.x.toFixed(0)}\\,${xExpr})`
  }
  // Antes do 1º shot: usa x do 1º
  xExpr = `if(lt(t\\,${shotXs[0].from.toFixed(2)})\\,${shotXs[0].x.toFixed(0)}\\,${xExpr})`

  return `scale=${scaledW}:${scaledH},crop=${cropW}:${cropH}:'${xExpr}':0`
}

// ── 7. Helper: pega dims do video ─────────────────────────────────────────────

export async function getVideoDimensions(ffmpegPath, videoPath) {
  const cmd = `"${ffmpegPath}" -i "${videoPath}" 2>&1`
  let out = ''
  try { const { stdout } = await execAsync(cmd, { timeout: 30000, windowsHide: true }); out = stdout }
  catch (e) { out = (e.stderr || '') + (e.stdout || '') }
  const m = out.match(/(\d{2,5})x(\d{2,5})/)
  return m ? { width: +m[1], height: +m[2] } : { width: 1280, height: 720 }
}
