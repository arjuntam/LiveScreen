'use strict';
// Launch with Electron, passing the built app.asar and a three-page PDF fixture.
// This loads the shipped parser and preload from ASAR without launching the
// production application or touching the operator's LiveScreen data directory.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const archive=path.resolve(process.argv[2]),pdf=path.resolve(process.argv[3]);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-packaged-pdf-'));app.setPath('userData',temp);
const deadline=setTimeout(()=>{console.error('Packaged PDF render timed out');app.exit(1);},45000);deadline.unref();
app.whenReady().then(async()=>{
  const adapter=require(path.join(archive,'src/desktop/presentation-adapter.cjs')).createPresentationAdapter({BrowserWindow,ipcMain});
  let total=0;const pages=[];
  await adapter.renderPDF(pdf,{signal:new AbortController().signal,maxPages:200,
    onTotal(value){total=value;},onPage(index,png){const size=nativeImage.createFromBuffer(png).getSize();if(size.width<1||size.height<1)throw Error('Empty packaged render');pages.push({index,...size,sha256:crypto.createHash('sha256').update(png).digest('hex')});}});
  if(total!==3||pages.length!==3||new Set(pages.map(p=>p.sha256)).size!==3)throw Error('Packaged PDF pages missing or indistinguishable');
  console.log(JSON.stringify({packagedPDFRender:true,total,pages},null,2));
}).then(()=>{clearTimeout(deadline);app.quit();},error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
app.on('will-quit',()=>{try{fs.rmSync(temp,{recursive:true,force:true});}catch{/* OS cache handles may outlive quit briefly. */}});
