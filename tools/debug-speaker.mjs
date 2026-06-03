import fs from 'fs'
import { parseVTTWordLevel, rebaseWordsToRange } from '../src/videoEditor.mjs'

const vttPath = process.argv[2] || 'C:/Users/Notebook/AppData/Local/Temp/pm-edit-demo/subs_krAFCi2sFns.pt.vtt'
const vtt = fs.readFileSync(vttPath, 'utf-8')
const words = parseVTTWordLevel(vtt)
console.log('Total words:', words.length)
const changes = words.filter(w => w.speakerChange)
console.log('Speaker changes (>>):', changes.length)
console.log('Primeiras 5:')
changes.slice(0, 5).forEach(w => console.log(`  ${w.start.toFixed(2)}s "${w.word}"`))
console.log('No trecho 30-150:')
const inRange = rebaseWordsToRange(words, 30, 150).filter(w => w.speakerChange)
console.log('  trocas in range:', inRange.length)
inRange.forEach(w => console.log(`  ${w.start.toFixed(2)}s "${w.word}"`))
