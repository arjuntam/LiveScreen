import { getDocument } from '../../node_modules/pdfjs-dist/build/pdf.mjs';
import { WorkerMessageHandler } from '../../node_modules/pdfjs-dist/build/pdf.worker.mjs';
// Run the parser in this disposable, isolated renderer. No external worker or
// network access is needed, including when the application is inside ASAR.
globalThis.pdfjsWorker = { WorkerMessageHandler };
const send = request => window.presentationRender.send(request);
let task;
try {
  const { bytes, maxPages } = await send({ action:'load' });
  const resources = new URL('../../node_modules/pdfjs-dist/', import.meta.url).href;
  task = getDocument({ data: new Uint8Array(bytes), isEvalSupported:false, enableXfa:false,
    cMapUrl:resources+'cmaps/', cMapPacked:true, standardFontDataUrl:resources+'standard_fonts/', wasmUrl:resources+'wasm/',
    maxImageSize:16_000_000, stopAtErrors:true, useSystemFonts:true });
  const doc = await task.promise;
  if (doc.numPages > maxPages) { await send({ action:'total', total:doc.numPages }); throw new Error('too many pages'); }
  await send({ action:'total', total:doc.numPages });
  const canvas = document.querySelector('#page');
  for (let index=0; index<doc.numPages; index++) {
    const page = await doc.getPage(index+1), size=page.getViewport({scale:1});
    const scale = Math.min(2560/Math.max(size.width,size.height), Math.sqrt(4_000_000/(size.width*size.height)));
    const viewport=page.getViewport({scale}); canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext:canvas.getContext('2d'), viewport, annotationMode:0, background:'rgb(255,255,255)' }).promise;
    await send({ action:'page', index, png:canvas.toDataURL('image/png').split(',')[1] });
    page.cleanup(); canvas.width=canvas.height=1;
  }
  await task.destroy(); task=null; await send({ action:'done' });
} catch (error) {
  console.error('Presentation render:',error.name,error.message);
  await send({ action:'error', password:error.name==='PasswordException' }).catch(()=>{});
} finally { await task?.destroy().catch(()=>{}); }
