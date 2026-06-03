/**
 * Motor de IA embarcado — usa node-llama-cpp (sem Ollama, sem instalação extra).
 * Na 1ª execução baixa o modelo (~400 MB) e salva em userData.
 */
import { join } from 'path'
import { existsSync, createWriteStream, mkdirSync, renameSync } from 'fs'
import { stat } from 'fs/promises'
import https from 'https'
import http from 'http'

const MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf'
const MIN_MODEL_SIZE = 300 * 1024 * 1024 // 300 MB mínimo para arquivo válido

let _llama   = null
let _model   = null
let _loading = null // Promise em andamento para evitar duplo load
let _modelPath = null

export function setModelPath(p) {
  _modelPath = p
}

export function getModelPath() {
  return _modelPath
}

export function modelExists() {
  if (!_modelPath) return false
  if (!existsSync(_modelPath)) return false
  return true
}

export async function modelIsValid() {
  if (!modelExists()) return false
  try {
    const s = await stat(_modelPath)
    return s.size >= MIN_MODEL_SIZE
  } catch { return false }
}

// ── Download ──────────────────────────────────────────────────────────────────

export function downloadModel(onProgress) {
  return new Promise((resolve, reject) => {
    mkdirSync(join(_modelPath, '..'), { recursive: true })
    const file = createWriteStream(_modelPath + '.tmp')

    function doRequest(url, redirects = 0) {
      if (redirects > 5) { reject(new Error('Muitos redirecionamentos')); return }

      const mod = url.startsWith('https') ? https : http
      mod.get(url, { headers: { 'User-Agent': 'PostMaster/1.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          doRequest(res.headers.location, redirects + 1)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download falhou: HTTP ${res.statusCode}`))
          return
        }

        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        let lastPct  = -1

        res.on('data', chunk => {
          received += chunk.length
          file.write(chunk)
          if (total > 0) {
            const pct = Math.floor((received / total) * 100)
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct
              const mb = (received / 1024 / 1024).toFixed(0)
              const tot = (total   / 1024 / 1024).toFixed(0)
              onProgress?.(`Baixando IA: ${mb} MB / ${tot} MB (${pct}%)`)
            }
          }
        })

        res.on('end', () => {
          file.close()
          // Renomeia .tmp → arquivo final
          try { renameSync(_modelPath + '.tmp', _modelPath) } catch {}
          onProgress?.('Download concluído')
          resolve()
        })

        res.on('error', reject)
      }).on('error', reject)
    }

    doRequest(MODEL_URL)
    file.on('error', reject)
  })
}

// ── Carregamento do modelo ────────────────────────────────────────────────────

export async function loadModel(onLog) {
  if (_model) return _model
  if (_loading) return _loading

  _loading = (async () => {
    const { getLlama } = await import('node-llama-cpp')
    const modelPath = _modelPath

    onLog?.('Carregando motor de IA...')
    _llama = await getLlama()
    _model = await _llama.loadModel({ modelPath })
    onLog?.('Motor de IA pronto')
    return _model
  })().catch(e => {
    _loading = null
    throw e
  })

  return _loading
}

// ── Geração de legenda ────────────────────────────────────────────────────────

const PREAMBLE = /^(aqui (está|estão|vai)|claro[,!]|veja|eis|here (is|are)|legenda:|caption:)/i
let _aiQueue   = Promise.resolve()

// Veículos de imprensa que não podem aparecer na legenda — evita copyright e
// "descaracterização" pedida pelo dono do app. Nomes próprios de pessoas/artistas
// passam livres (eles ajudam o SEO de busca).
const FORBIDDEN_OUTLETS = [
  // TV abertas e canais de notícia
  'globo', 'globonews', 'sbt', 'record', 'recordtv', 'rede tv', 'redetv', 'band', 'bandnews',
  'cnn brasil', 'cnn', 'jovem pan', 'jovempan',
  // Telejornais conhecidos
  'jornal nacional', 'jornal da globo', 'bom dia brasil', 'fantástico', 'fantastico',
  'jornal hoje', 'jornal do sbt', 'jornal da record', 'jornal da band',
  // Programas
  'mais você', 'mais voce', 'hora da venenosa', 'domingão', 'domingao', 'ratinho',
  // Portais e jornais escritos
  'uol', ' g1', 'g1.', 'globo.com', 'estadão', 'estadao', 'folha de s', 'folha de são paulo',
  'veja', 'istoé', 'isto é', 'carta capital', 'metropoles', 'metrópoles', 'r7', 'r7.com',
]

function stripForbiddenOutlets(text) {
  let cleaned = text
  for (const term of FORBIDDEN_OUTLETS) {
    const re = new RegExp(`(?<![A-Za-zÀ-ú])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-zÀ-ú])`, 'gi')
    cleaned = cleaned.replace(re, '').replace(/\s{2,}/g, ' ')
  }
  // Limpa hashtags "vazias" ou com lixo após o strip
  cleaned = cleaned.replace(/#\s/g, '#').replace(/#(\W|$)/g, '$1')
  return cleaned.trim()
}

export async function gerarCaption(titulo, nicho = 'conteúdo geral') {
  if (!_model) throw new Error('Motor de IA não carregado')

  const { LlamaChatSession } = await import('node-llama-cpp')
  // Limpa o título antes de mandar pra IA — evita que ela "puxe" o nome do veículo
  const tituloLimpo = stripForbiddenOutlets(titulo).replace(/^[-:\s]+|[-:\s]+$/g, '').trim() || titulo

  const prompt = `Escreva uma legenda CURTA pra um Reel de ${nicho} sobre: "${tituloLimpo}".

REGRAS:
- Foque em SEO: use palavras que as pessoas pesquisam (nomes de artistas, lugares, situações).
- NÃO copie o título. Reescreva com outras palavras, mantendo o assunto.
- NUNCA cite veículos de imprensa (jornal, canal de TV, portal de notícia, etc).
- Pode citar nomes de pessoas, artistas, cantores, jogadores.
- Use 1-2 emojis.
- 2 a 3 linhas no total.
- Termina com 5 a 7 hashtags em PT-BR, com termos pesquisáveis (#nomedoartista, #cidade, #tema), uma palavra por hashtag.

Responda SÓ a legenda. Sem prefixo, sem "Aqui está", sem aspas.`

  const run = async () => {
    const ctx     = await _model.createContext({ contextSize: 1024 })
    const session = new LlamaChatSession({ contextSequence: ctx.getSequence() })
    try {
      let texto = await session.prompt(prompt, { maxTokens: 250 })
      texto = texto.trim()
      texto = texto.split('\n').filter(l => !PREAMBLE.test(l.trim())).join('\n').trim()
      texto = texto.replace(/^["'""]|["'""]$/g, '').trim()
      // Defesa em profundidade: remove veículos que escaparam
      texto = stripForbiddenOutlets(texto)
      return texto || fallback(tituloLimpo, nicho)
    } finally {
      ctx.dispose()
    }
  }

  // Fila para evitar múltiplos contextos simultâneos
  const next = _aiQueue.then(run).catch(e => {
    console.error('IA caption erro:', e.message)
    return fallback(tituloLimpo, nicho)
  })
  _aiQueue = next.catch(() => {})
  return next
}

// ── Status ────────────────────────────────────────────────────────────────────

export async function getStatus() {
  const valid = await modelIsValid()
  return {
    ok:         !!_model,
    modelReady: !!_model,
    downloaded: valid,
  }
}

export function stopServer() {
  // node-llama-cpp não tem servidor — nada a parar
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fallback(titulo, nicho) {
  return `${titulo}\n\n#${nicho.replace(/\s+/g, '')} #viral #reels #conteudo #brasil`
}
