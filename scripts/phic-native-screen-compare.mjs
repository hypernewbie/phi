// Native-test oracle. Compare the inner widget's cells, visible attributes,
// and visible cursor, not the encoding chosen by the outer console renderer.
import { createHeadlessSandbox } from '../test-js/_xtermHeadless.js';
import { readFileSync } from 'node:fs';
const [a,b] = JSON.parse(readFileSync(0,'utf8'));
const {Terminal} = createHeadlessSandbox();
const frames=[];
for (const s of [a,b]) {
 const t = new Terminal({cols:120,rows:36,convertEol:true,allowProposedApi:true});
 await new Promise(resolve=>t.write(s.cells.replace(/\n$/,''),resolve));
 const cells=[];
 for(let y=4;y<34;y++)for(let x=28;x<119;x++) {
  const c=t.buffer.active.getLine(y).getCell(x);
  const chars=c.getChars()||' ';
  let fg=[c.getFgColorMode(),c.getFgColor()],bg=[c.getBgColorMode(),c.getBgColor()];
  if(c.isInverse()) [fg,bg]=[bg,fg];
  // Foreground on an unadorned blank is not visible. Renderer optimizations
  // can omit it; background and all visible glyph/underline/strike colors count.
  const plainBlank=chars===' '&&!c.isUnderline()&&!c.isStrikethrough();
  cells.push([chars,c.getWidth(),plainBlank?null:fg,bg,plainBlank?false:!!c.isBold(),plainBlank?false:!!c.isDim(),!!c.isUnderline(),!!c.isStrikethrough(),plainBlank?false:!!c.isItalic()]);
 }
 const cursor=s.cursor.split(' ').map(Number);
 frames.push({cells,cursor:cursor[3]?[cursor[0],cursor[1],cursor[2],cursor[3]]:[cursor[2],cursor[3]]});
 t.dispose();
}
const equal=JSON.stringify(frames[0])===JSON.stringify(frames[1]);
console.log(JSON.stringify({equal,firstDifference:frames[0].cells.findIndex((c,i)=>JSON.stringify(c)!==JSON.stringify(frames[1].cells[i])),cursor:[frames[0].cursor,frames[1].cursor]}));
