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

  // v1.2.3: Qwen 0.5B as vezes entra em loop de placeholder ("#Nome de Pessoa #Nome de Jogador..."),
  // copiando literalmente os EXEMPLOS abstratos do prompt. Trocado por exemplos CONCRETOS
  // e adicionado anti-loop no post-processamento.
  const prompt = `Escreva uma legenda CURTA e REAL pra um Reel sobre: "${tituloLimpo}".

REGRAS:
- 1 linha de texto + 5 a 7 hashtags REAIS (uma palavra cada, sem espaços).
- Não use palavras genericas tipo "Nome", "Tema", "Conteúdo", "Situação", "Lugar" nas hashtags.
- Não escreva placeholders. Hashtag tem que ser uma coisa REAL: #futebol, #carnaval, #musica, etc.
- Pode citar pessoas, artistas, cantores. NUNCA jornal, TV, portal de noticia.
- 1 emoji no maximo.
- Maximo 200 caracteres.

EXEMPLO DE BOA LEGENDA:
Esse passe foi cirurgico 😱 #futebol #brasileirao #craque #gol #neymar

EXEMPLO DE LEGENDA RUIM (NAO FAZER):
#Reel #SEO #Nome de Pessoa #Nome de Lugar #Tema

Responda SO a legenda final. Sem prefixo, sem aspas.`

  const run = async () => {
    const ctx     = await _model.createContext({ contextSize: 1024 })
    const session = new LlamaChatSession({ contextSequence: ctx.getSequence() })
    try {
      let texto = await session.prompt(prompt, { maxTokens: 180 })
      texto = texto.trim()
      texto = texto.split('\n').filter(l => !PREAMBLE.test(l.trim())).join('\n').trim()
      texto = texto.replace(/^["'""]|["'""]$/g, '').trim()
      // Defesa em profundidade: remove veiculos que escaparam
      texto = stripForbiddenOutlets(texto)
      // v1.2.3: remove placeholder ("#Nome de XX") e loop de hashtags genericas
      texto = stripPlaceholders(texto)
      // Sanity: se sobrou pouca coisa real (so 1-2 chars + hashtags lixo), usa fallback
      if (!texto || isMostlyPlaceholder(texto)) {
        return fallback(tituloLimpo, nicho)
      }
      return texto
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

// ── API generica de complete (pra youtubeMeta, dublagem/translate, etc) ──────
// Adicionado em v1.0.60: youtubeMeta.mjs e dublagem/translate.mjs importavam
// `aiManager` mas nada exportava esse objeto -> import retornava undefined ->
// jobRunner.mjs falhava silenciosamente no import top-level -> erro
// "jobRunner is not a function". Pra padronizar, exponho objeto com .get()
// e .complete() que reusa o _model ja carregado.
async function _complete(prompt, { maxTokens = 250 } = {}) {
  if (!_model) {
    try { await loadModel() } catch { return '' }
  }
  if (!_model) return ''
  const { LlamaChatSession } = await import('node-llama-cpp')
  const ctx = await _model.createContext({ contextSize: 1024 })
  const session = new LlamaChatSession({ contextSequence: ctx.getSequence() })
  try {
    return await session.prompt(prompt, { maxTokens })
  } catch {
    return ''
  } finally {
    try { ctx.dispose() } catch {}
  }
}

export const aiManager = {
  async get() {
    if (!_model) await loadModel().catch(() => {})
    if (!_model) return null
    return { complete: _complete }
  },
  complete: _complete,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fallback(titulo, nicho) {
  const tag = (nicho || 'conteudo').replace(/\s+/g, '').toLowerCase()
  return `${titulo}\n\n#${tag} #viral #reels #brasil #fyp`
}

// v1.2.3: remove placeholders e loops do Qwen 0.5B
// Hashtags como "#Nome de Pessoa", "#Nome de Jogador" sao templates abstratos —
// a IA copia literalmente nossos exemplos do prompt. Detecta e remove.
// Palavras genericas que Qwen 0.5B usa em hashtags placeholder
const PLACEHOLDER_WORDS = [
  'nome', 'nomes', 'tema', 'temas', 'conteudo', 'conteudos',
  'seo', 'situacao', 'situacoes', 'lugar', 'lugares',
  'artista', 'artistas', 'jogador', 'jogadores', 'cantor', 'cantores',
  'pessoa', 'pessoas', 'reel', 'reels', 'placeholder', 'placeholders',
  'geral', 'xx', 'xxx', 'yyy', 'zzz',
]
// Hashtag inteira que comeca com palavra-placeholder (ignora acentos pra match)
const PLACEHOLDER_HASHTAG_RX = new RegExp(
  '#(?:' + PLACEHOLDER_WORDS.join('|') + ')(?=\\W|$)',
  'giu'
)

function unaccent(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function stripPlaceholders(text) {
  if (!text) return text
  let t = String(text)
  // 1) Remove sequencia "#Nome de XX" / "#Nome do XX"
  t = t.replace(/#Nome\s+(?:de|do|da)\s+\w+/gi, '')
  t = t.replace(/#Tema\s+\w*/gi, '')
  // 2) Tira hashtags individuais que sao placeholder (compara ignorando acentos)
  t = t.replace(/#[A-Za-zÀ-ÿ_]+/g, (h) => {
    const word = unaccent(h.slice(1)).toLowerCase()
    return PLACEHOLDER_WORDS.includes(word) ? '' : h
  })
  // 3) Remove residuos tipo "de Conteúdo Geral", "de XXX" sozinhos (fragmentos sem hashtag pai)
  t = t.replace(/\b(de|do|da|dos|das)\s+(Conteudo|Conteúdo|Tema|Geral|SEO|Lugar|Lugares|Situacao|Situação|Situacoes|Situações|Artista|Artistas|Pessoa|Pessoas|Jogador|Jogadores|Cantor|Cantores|Nome|Nomes)(\s+(Geral|Pessoa|Lugar|Tema|Situa[çc][ãa]o))?/gi, '')
  // 4) Detecta loop: mesma hashtag se repete 2+ vezes -> corta a partir da 1a repeticao
  const tags = t.match(/#[\w]+/g) || []
  const seen = new Map()
  for (let i = 0; i < tags.length; i++) {
    const key = tags[i].toLowerCase()
    const n = (seen.get(key) || 0) + 1
    seen.set(key, n)
    if (n >= 2) {
      const firstIdx = t.toLowerCase().indexOf(key)
      const secondIdx = t.toLowerCase().indexOf(key, firstIdx + key.length)
      if (secondIdx > firstIdx) { t = t.slice(0, secondIdx).trimEnd(); break }
    }
  }
  // 5) Compacta espaços/quebra de linhas
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return t
}

function isMostlyPlaceholder(text) {
  if (!text) return true
  // Conta hashtags REAIS (nao placeholder, e com pelo menos 3 chars)
  const tags = text.match(/#[\w]+/g) || []
  const realTags = tags.filter(h => {
    const w = unaccent(h.slice(1)).toLowerCase()
    return w.length >= 3 && !PLACEHOLDER_WORDS.includes(w)
  })
  // Texto SEM hashtags
  const real = text.replace(/#[\w]+/g, '').trim()
  // Considera placeholder se sobrou pouco conteudo real
  if (real.length < 10 && realTags.length < 3) return true
  return false
}
