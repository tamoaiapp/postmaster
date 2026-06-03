/**
 * Teste isolado: carrega modelo + extrai keyframe + detecta rostos.
 */
import * as ort from 'onnxruntime-node'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import ffmpegStatic from 'ffmpeg-static'
import { setModelPath, extractFrameAt, detectFacesInImage } from '../src/faceTrack.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(__dirname)
const modelPath = path.join(ROOT, 'models', 'face-detector.onnx')
setModelPath(modelPath)

// 1. Carrega modelo só pra ver input/output specs
console.log('Carregando modelo...')
const session = await ort.InferenceSession.create(modelPath)
console.log('Input names:', session.inputNames)
console.log('Output names:', session.outputNames)
for (const name of session.inputNames) {
  console.log(`  input "${name}":`, session.inputMetadata?.[name] || '(no metadata)')
}
for (const name of session.outputNames) {
  console.log(`  output "${name}":`, session.outputMetadata?.[name] || '(no metadata)')
}

// 2. Extrai keyframe do denso.mp4
const denso = 'C:/Users/Notebook/AppData/Local/Temp/pm-edit-demo/denso_krAFCi2sFns.mp4'
if (!fs.existsSync(denso)) {
  console.error('denso.mp4 não existe, rode edit-demo antes:', denso)
  process.exit(1)
}
const framePath = path.join(process.env.TEMP, 'test-frame.jpg')
console.log('\nExtraindo frame em t=60s...')
await extractFrameAt(ffmpegStatic, denso, 60, framePath)
console.log('Frame:', framePath, `(${Math.round(fs.statSync(framePath).size / 1024)} KB)`)

// 3. Detect
console.log('\nDetectando rostos...')
const t0 = Date.now()
const faces = await detectFacesInImage(framePath, 0.5)
console.log(`Tempo: ${Date.now() - t0}ms`)
console.log(`Rostos detectados: ${faces.length}`)
faces.forEach((f, i) => {
  console.log(`  [${i}] center=(${Math.round(f.centerX)},${Math.round(f.centerY)}) size=${Math.round(f.w)}x${Math.round(f.h)} conf=${f.confidence.toFixed(2)}`)
})
