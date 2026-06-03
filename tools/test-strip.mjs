// Teste rápido do stripForbiddenOutlets sem expor a função
const forbidden = ['globo','globonews','sbt','record','recordtv','rede tv','redetv','band','bandnews','cnn brasil','cnn','jovem pan','jovempan','jornal nacional','jornal da globo','bom dia brasil','fantástico','fantastico','jornal hoje','jornal do sbt','jornal da record','jornal da band','mais você','mais voce','hora da venenosa','domingão','domingao','ratinho','uol',' g1','g1.','globo.com','estadão','estadao','folha de s','folha de são paulo','veja','istoé','isto é','carta capital','metropoles','metrópoles','r7','r7.com']

function strip(text) {
  let c = text
  for (const term of forbidden) {
    const re = new RegExp(`(?<![A-Za-zÀ-ú])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-zÀ-ú])`, 'gi')
    c = c.replace(re, '').replace(/\s{2,}/g, ' ')
  }
  return c.replace(/#\s/g, '#').replace(/#(\W|$)/g, '$1').trim()
}

const tests = [
  'Jornal Nacional mostrou Anitta em entrevista',
  'O Globo reportou que Luan Santana cantou',
  'UOL: Pabllo Vittar lança música',
  'Anitta confessou no SBT que ama Luan',
  'g1.globo.com noticia novo álbum',
  'Sem nomes proibidos, só Anitta e Luan',
]
for (const t of tests) {
  console.log('IN :', t)
  console.log('OUT:', strip(t))
  console.log('---')
}
