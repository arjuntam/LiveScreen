'use strict';
const fs=require('node:fs'),path=require('node:path'),asar=require('@electron/asar');
function verifyRuntime(archive,root) {
  const paths=asar.listPackage(archive);
  for(const relative of ['node_modules/pdfjs-dist/build/pdf.mjs','node_modules/pdfjs-dist/build/pdf.worker.mjs','node_modules/pdfjs-dist/LICENSE','LICENSE','THIRD-PARTY-NOTICES.txt']) {
    if(!asar.extractFile(archive,relative).equals(fs.readFileSync(path.join(root,relative))))throw Error('Packaged dependency or license mismatch: '+relative);
  }
  if(paths.some(p=>/node_modules[\\/]@napi-rs[\\/].+\.(node|dll|dylib)$/.test(p)))throw Error('Optional native PDF canvas must not be bundled');
  if(paths.some(p=>/company-guide-assets|wireless-auth\.jpg|enterprise\.jpg/.test(p)))throw Error('Private guide asset in runtime');
  const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
  let count=0;
  for(const file of ['src','web','assets','examples'].flatMap(d=>files(path.join(root,d)))) {
    const relative=path.relative(root,file);
    if(!asar.extractFile(archive,relative).equals(fs.readFileSync(file)))throw Error('Packaged source mismatch: '+relative);
    count++;
  }
  console.log(`Runtime verified: ${count} source/resource files; PDF parser and worker; project and dependency licenses; no native canvas or private guide assets.`);
  return count;
}
module.exports={verifyRuntime};
