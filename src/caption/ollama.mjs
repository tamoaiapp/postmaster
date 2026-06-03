/**
 * Geração de legenda via IA embarcada (node-llama-cpp).
 * Mantém o mesmo nome de arquivo para compatibilidade com jobRunner.
 */
import * as aiManager from '../aiManager.mjs'

const PREAMBLE = /^(aqui (está|estão|vai)|claro[,!]|veja|eis|here (is|are)|legenda:|caption:)/i

export async function gerarCaption(titulo, nicho = '') {
  const nichoFinal = nicho || 'conteúdo geral'

  try {
    return await aiManager.gerarCaption(titulo, nichoFinal)
  } catch (e) {
    console.error('IA caption falhou:', e.message)
    return fallback(titulo, nichoFinal)
  }
}

function fallback(titulo, nicho) {
  return `${titulo}\n\n#${nicho.replace(/\s+/g, '')} #viral #reels #conteudo #brasil`
}
