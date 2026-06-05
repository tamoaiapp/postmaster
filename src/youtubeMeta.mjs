/**
 * Gera titulo, descricao e tags pra YouTube via IA local (Qwen 2.5 0.5B GGUF).
 * Reusa o aiManager que ja roda na app.
 */
import { aiManager } from './aiManager.mjs'

const ZERO_WIDTH = ''

/**
 * @param {Object} input
 * @param {string} input.tituloOriginal - titulo do video fonte
 * @param {string} [input.nicho] - "futebol", "noticia", "ciencia" etc
 * @param {string} [input.transcricao] - primeiras 500 chars da fala (se tiver)
 */
export async function gerarMetadadosYoutube({ tituloOriginal, nicho = '', transcricao = '' }) {
  const llm = await aiManager.get().catch(() => null)
  if (!llm) {
    // Fallback sem IA: usa o titulo original puro
    return {
      title: tituloOriginal.slice(0, 100),
      description: tituloOriginal,
      tags: nicho ? [nicho] : [],
    }
  }

  const ctx = transcricao ? `\nPrimeiras frases do vídeo: "${transcricao.slice(0, 400)}"` : ''
  const nichoTxt = nicho ? `\nNicho do canal: ${nicho}` : ''
  const prompt = `Voce eh um especialista em SEO de YouTube BR. Reescreva esse video pra atrair clicks brasileiros.

Titulo original: "${tituloOriginal}"${nichoTxt}${ctx}

Responda em JSON valido:
{
  "title": "novo titulo brasileiro com hook, max 90 chars",
  "description": "descricao em PT-BR com 2-3 paragrafos, hook nas primeiras 2 linhas, max 800 chars",
  "tags": ["tag1", "tag2", "tag3", "ate 10 tags em portugues, sem #"]
}`

  let out = ''
  try {
    out = await llm.complete(prompt, { maxTokens: 400, temperature: 0.7 })
  } catch (e) {
    // Fallback
    return { title: tituloOriginal.slice(0, 100), description: tituloOriginal, tags: nicho ? [nicho] : [] }
  }
  // Extrai JSON
  const m = out.match(/\{[\s\S]*\}/)
  if (!m) return { title: tituloOriginal.slice(0, 100), description: tituloOriginal, tags: nicho ? [nicho] : [] }
  try {
    const parsed = JSON.parse(m[0])
    return {
      title: String(parsed.title || tituloOriginal).slice(0, 100),
      description: String(parsed.description || tituloOriginal).slice(0, 4900),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(t => String(t).slice(0, 30)).slice(0, 12) : [],
    }
  } catch {
    return { title: tituloOriginal.slice(0, 100), description: tituloOriginal, tags: nicho ? [nicho] : [] }
  }
}
