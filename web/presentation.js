'use strict';
let presentationFlow;
const presentationDialog = $('#presentationDialog');
function presentationFeedback(text, error=false) { LS.feedback('#presentationStatus',text,error); }
function selectionCount() {
  const flow=presentationFlow; if (!flow) return;
  $('#presentationCount').textContent=`已选 ${flow.selected.size} / 50 页`;
  $('#confirmPresentation').disabled=flow.committing || flow.job?.state!=='ready' || !flow.selected.size;
  for (const button of $('#presentationPages').querySelectorAll('button')) button.setAttribute('aria-pressed',String(flow.selected.has(Number(button.dataset.page))));
}
function showPresentationJob(job) {
  const flow=presentationFlow; if (!flow || flow.closed) return;
  flow.job=job; presentationFeedback(job.message,job.state==='failed');
  const working=['uploading','converting','rendering'].includes(job.state);
  $('#presentationChoose').hidden=working || job.state==='ready'; $('#presentationProgress').hidden=!working;
  if (job.total) { $('#presentationProgress').max=job.total; $('#presentationProgress').value=job.completed; }
  else $('#presentationProgress').removeAttribute('value');
  if (job.state==='ready') {
    $('#presentationSelection').hidden=false;
    $('#presentationName').value=job.name.replace(/\.(pptx?|pdf)$/i,'').slice(0,80);
    flow.selected=new Set(job.pages.slice(0,50).map(p=>p.index));
    $('#presentationPages').replaceChildren(...job.pages.map(p=>{
      const button=el('button',{type:'button',className:'import-page','data-page':p.index,'aria-label':`选择第 ${p.index+1} 页`,'aria-pressed':String(flow.selected.has(p.index))},[
        el('img',{src:p.url,loading:'lazy',alt:`第 ${p.index+1} 页预览`}),el('span',{text:`第 ${p.index+1} 页`})
      ]);
      button.onclick=()=>{
        if (flow.selected.has(p.index)) flow.selected.delete(p.index);
        else if (flow.selected.size<50) flow.selected.add(p.index);
        else { presentationFeedback('每个场景最多 50 页，请先取消其他页面。',true); return; }
        presentationFeedback('确认选页后创建场景；播放默认手动翻页、完整显示。'); selectionCount();
      }; return button;
    })); selectionCount();
  }
  if (working) flow.timer=setTimeout(async()=>{
    try { const next=await api(`/api/admin/imports/${job.id}`); if (presentationFlow===flow) showPresentationJob(next); }
    catch(error) { if (presentationFlow===flow) { presentationFeedback(error.message+'；可取消后重新打开导入以继续查看。',true); $('#presentationProgress').hidden=true; } }
  },800);
}
async function closePresentation() {
  const flow=presentationFlow; if (!flow || flow.committing) return;
  flow.closed=true; presentationFlow=null; clearTimeout(flow.timer); flow.xhr?.abort(); presentationDialog.close();
  if (flow.job) { try { await api(`/api/admin/imports/${flow.job.id}`,{method:'DELETE'}); } catch { /* Expiry or offline jobs are cleaned by the host. */ } }
}
$('#importPresentation').onclick=async()=>{
  if (!project()) return;
  const flow={target:project(),selected:new Set(),closed:false}; presentationFlow=flow;
  $('#presentationSelection').hidden=true; $('#presentationPages').replaceChildren(); $('#presentationChoose').hidden=true;
  $('#presentationProgress').hidden=true; $('#confirmPresentation').disabled=true; $('#presentationFile').value='';
  $('#presentationEnvironment').textContent='正在检查大屏主机的转换工具…'; presentationFeedback(''); presentationDialog.showModal();
  try {
    const capabilities=await api('/api/admin/imports/capabilities'); if (presentationFlow!==flow) return;
    flow.capabilities=capabilities;
    $('#presentationEnvironment').textContent=capabilities.ppt ? `大屏主机使用 ${capabilities.converter} 转换 PPT；PDF 可直接导入。` : '大屏主机尚无 PPT 转换工具。可先导出 PDF 后导入；PPT 直导需要 Windows PowerPoint 或 LibreOffice。';
    $('#presentationFile').accept=capabilities.ppt ? '.ppt,.pptx,.pdf' : '.pdf';
    $('#presentationChoose').firstChild.textContent=capabilities.ppt ? '选择 PPT / PPTX / PDF' : '选择 PDF';
    $('#presentationChoose').hidden=false;
    if (capabilities.activeJob) showPresentationJob(capabilities.activeJob);
  } catch(error) { if (presentationFlow===flow) presentationFeedback(error.message,true); }
};
$('#cancelPresentation').onclick=()=>void closePresentation();
presentationDialog.addEventListener('cancel',event=>{event.preventDefault();void closePresentation();});
$('#presentationSelectAll').onclick=()=>{const flow=presentationFlow;if(flow?.job?.pages){flow.selected=new Set(flow.job.pages.slice(0,50).map(p=>p.index));selectionCount();}};
$('#presentationSelectNone').onclick=()=>{presentationFlow?.selected.clear();selectionCount();};
$('#presentationFile').onchange=async event=>{
  const flow=presentationFlow, file=event.target.files[0]; if (!flow || !file) return;
  if (file.size>128*1024*1024 || !file.size) { presentationFeedback('请选择 128 MB 以内的非空文件。',true);event.target.value='';return; }
  if (!/\.(pptx?|pdf)$/i.test(file.name) || (!flow.capabilities?.ppt && !/\.pdf$/i.test(file.name))) { presentationFeedback('此主机请先使用 PDF 导入。',true);return; }
  $('#presentationChoose').hidden=true; $('#presentationProgress').hidden=false; $('#presentationProgress').max=100; $('#presentationProgress').value=0;
  presentationFeedback('正在上传到大屏主机…');
  try {
    if (flow.job) await api(`/api/admin/imports/${flow.job.id}`,{method:'DELETE'});
    const job=await new Promise((resolve,reject)=>{
      const xhr=flow.xhr=new XMLHttpRequest();xhr.open('POST','/api/admin/imports/upload');xhr.timeout=120000;
      xhr.setRequestHeader('X-LiveScreen','1');xhr.setRequestHeader('X-Filename',encodeURIComponent(file.name));xhr.setRequestHeader('Content-Type','application/octet-stream');
      xhr.upload.onprogress=e=>{if(e.lengthComputable && presentationFlow===flow){$('#presentationProgress').value=100*e.loaded/e.total;presentationFeedback(`正在上传 ${Math.round(100*e.loaded/e.total)}%`);}};
      xhr.onload=()=>{try{const data=JSON.parse(xhr.responseText);xhr.status>=200&&xhr.status<300?resolve(data):reject(new Error(data.error||'上传失败'));}catch{reject(new Error('上传结果无法读取，请重试。'));}};
      xhr.onerror=xhr.ontimeout=()=>reject(new Error('上传连接中断或超时，请检查网络后重试。'));xhr.onabort=()=>reject(new Error('已取消上传'));xhr.send(file);
    });
    if (presentationFlow===flow) showPresentationJob(job);
  } catch(error) { if (presentationFlow===flow) { presentationFeedback(error.message,true);$('#presentationChoose').hidden=false;$('#presentationProgress').hidden=true; } }
  finally { flow.xhr=null;event.target.value=''; }
};
$('#confirmPresentation').onclick=async()=>{
  const flow=presentationFlow;if(!flow?.job || flow.committing || !flow.selected.size)return;
  if(!library.draft.includes(flow.target) || flow.target.scenes.length>=200){presentationFeedback('目标项目不可用，或场景已达到 200 个，请取消后重新选择项目。',true);return;}
  const name=$('#presentationName').value.trim();if(!name){presentationFeedback('请填写场景名称。',true);$('#presentationName').focus();return;}
  flow.committing=true;selectionCount();$('#cancelPresentation').disabled=true;
  presentationFeedback('正在保存页面图片…');
  try {
    const result=await api(`/api/admin/imports/${flow.job.id}/commit`,{method:'POST',body:{pages:[...flow.selected],name}});
    for(const asset of result.assets)library.assets[asset.id]=asset;
    flow.target.scenes.push(result.scene);if(!flow.target.defaultSceneId)flow.target.defaultSceneId=result.scene.id;
    projectId=flow.target.id;sceneId=result.scene.id;changed();renderProjects();
    presentationFlow=null;flow.closed=true;presentationDialog.close();message(`已导入 ${result.assets.length} 页。请保存场景并发布，大屏当前画面未改变。`);
  } catch(error) {presentationFeedback(error.message,true);}
  finally {flow.committing=false;$('#cancelPresentation').disabled=false;selectionCount();}
};
