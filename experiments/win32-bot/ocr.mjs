// OCR helper — encontra texto numa screenshot e retorna bbox.
// Uso CLI: node ocr.mjs <png-path> <texto-procurado>
//          → imprime JSON {x, y, w, h, conf} ou null
// Uso lib: import { findText } from './ocr.mjs'
//          const r = await findText('screenshot.png', 'Criar')

import Tesseract from 'tesseract.js'
import fs from 'fs'
import path from 'path'

const CACHE_DIR = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'tess-cache')
fs.mkdirSync(CACHE_DIR, { recursive: true })

let _workerPromise = null
async function getWorker() {
  if (_workerPromise) return _workerPromise
  _workerPromise = (async () => {
    console.error('[ocr] criando worker (1a vez baixa ~20MB do modelo por+eng)...')
    const w = await Tesseract.createWorker(['por', 'eng'], 1, {
      cachePath: CACHE_DIR,
      logger: m => {
        if (m.status === 'recognizing text' && m.progress === 1) console.error('[ocr] recognize done')
        if (m.status?.includes('loading') && m.progress === 1) console.error(`[ocr] ${m.status} done`)
      },
      errorHandler: e => console.error('[ocr] error:', e),
    })
    console.error('[ocr] worker pronto')
    return w
  })()
  return _workerPromise
}

// Normaliza texto pra comparar (case-insensitive, sem acentos, trim)
function normalize(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim()
}

// Acha texto na imagem. Retorna primeira palavra que casa OU concatenacao de words
// sucessivas que casam o texto (suporta "Enviar videos" = 2 words).
// Retorna null se nao encontrar.
// Achata blocks.paragraphs.lines.words -> array unico
function flattenWords(data) {
  const out = []
  for (const block of (data.blocks || [])) {
    for (const para of (block.paragraphs || [])) {
      for (const line of (para.lines || [])) {
        for (const w of (line.words || [])) {
          if (w.text) out.push(w)
        }
      }
    }
  }
  return out
}

export async function findText(imgPath, target, opts = {}) {
  const { minConf = 50, all = false } = opts
  const targetN = normalize(target)
  const w = await getWorker()
  const { data } = await w.recognize(imgPath, {}, { blocks: true })
  const words = flattenWords(data).filter(w => (w.confidence || 0) >= minConf)
  const matches = []
  // 1) match palavra unica
  for (const word of words) {
    if (normalize(word.text) === targetN) {
      const b = word.bbox
      matches.push({
        x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0,
        cx: Math.round((b.x0 + b.x1) / 2),
        cy: Math.round((b.y0 + b.y1) / 2),
        text: word.text, conf: word.confidence,
      })
    }
  }
  // 2) match phrase (sequencia de words com texto concatenado = target)
  if (matches.length === 0 && targetN.includes(' ')) {
    for (let i = 0; i < words.length; i++) {
      let combined = normalize(words[i].text)
      let endIdx = i
      for (let j = i + 1; j < Math.min(i + 5, words.length); j++) {
        combined += ' ' + normalize(words[j].text)
        endIdx = j
        if (combined === targetN) {
          const b0 = words[i].bbox, b1 = words[endIdx].bbox
          matches.push({
            x: b0.x0, y: b0.y0, w: b1.x1 - b0.x0, h: b1.y1 - b0.y0,
            cx: Math.round((b0.x0 + b1.x1) / 2),
            cy: Math.round((b0.y0 + b1.y1) / 2),
            text: combined,
            conf: (words[i].confidence + words[endIdx].confidence) / 2,
          })
          break
        }
        if (combined.length > targetN.length + 10) break
      }
    }
  }
  if (all) return matches
  return matches[0] || null
}

// Lista todos os textos achados (debug)
export async function listAll(imgPath, opts = {}) {
  const { minConf = 30 } = opts
  const w = await getWorker()
  const { data } = await w.recognize(imgPath, {}, { blocks: true })
  return (data.words || [])
    .filter(w => (w.confidence || 0) >= minConf)
    .map(w => ({ text: w.text, conf: Math.round(w.confidence), x: w.bbox.x0, y: w.bbox.y0 }))
}

export async function terminate() {
  if (_workerPromise) {
    const w = await _workerPromise
    await w.terminate()
    _workerPromise = null
  }
}

// CLI
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const [imgPath, ...rest] = process.argv.slice(2)
  const target = rest.join(' ')
  if (!imgPath) {
    console.error('Uso: node ocr.mjs <png-path> <texto>')
    console.error('     node ocr.mjs <png-path>  # lista todas as words')
    process.exit(1)
  }
  if (!target) {
    const w2 = await getWorker()
    const { data } = await w2.recognize(imgPath, {}, { blocks: true, text: true })
    console.error('[ocr] keys data:', Object.keys(data).join(','))
    console.error('[ocr] text len:', (data.text || '').length)
    console.error('[ocr] text preview:', (data.text || '').slice(0, 300))
    const wordCount = (data.blocks || []).reduce((acc, b) => acc + (b.paragraphs || []).reduce((a2, p) => a2 + (p.lines || []).reduce((a3, l) => a3 + (l.words?.length || 0), 0), 0), 0)
    console.error('[ocr] words via blocks:', wordCount)
    const all = await listAll(imgPath, { minConf: 0 })
    console.log(`total words via listAll: ${all.length}`)
    console.log(JSON.stringify(all.slice(0, 40), null, 2))
  } else {
    const r = await findText(imgPath, target)
    console.log(JSON.stringify(r))
  }
  await terminate()
}
