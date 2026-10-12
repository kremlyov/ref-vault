const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
let data = null, library = [], loadVersion = 0, inspecting = false;
const selectedRefs = new Set();
let visibleRefs = [], bulkIds = [], bulkBusy = false;
async function api(url, options = {}) {
  const response = await fetch(url, options), result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || `Ошибка ${response.status}`);
  return result;
}
function message(text, error = false) {
  $('#message').textContent = text; $('#message').hidden = !text;
  $('#message').classList.toggle('error', error);
}
let heroMotion;
function revealForm(change, form) {
  const hero=$('.hero'), from=hero.getBoundingClientRect().height;
  heroMotion?.cancel();
  change();
  const to=hero.getBoundingClientRect().height;
  if(matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(to-from)<1)return;
  heroMotion=hero.animate([{height:from+'px',overflow:'hidden'},{height:to+'px',overflow:'hidden'}],{duration:420,easing:'cubic-bezier(.22,1,.36,1)'});
  if(form)form.animate([{opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],{duration:320,delay:80,fill:'backwards',easing:'ease-out'});
}
function resetCapture(){revealForm(resetCaptureContent);}
function resetCaptureContent() {
  data = null; $('#preview').hidden = true; $('#preview').innerHTML = '';
  $('#upload').hidden = true; $('#url').value = ''; $('#capture').hidden = false;
  $('#inspect').hidden = true; $('#addFile').hidden = false;
}
async function inspect() {
  const url = $('#url').value.trim();
  if (!url || inspecting) return;
  if (!$('#url').checkValidity()) { $('#url').reportValidity(); return; }
  inspecting = true; $('#inspect').hidden = false; $('#inspect').disabled = true;
  $('#inspect').textContent = ''; $('#inspect').classList.add('loading'); $('#inspect').setAttribute('aria-label', 'Читаю страницу'); $('#capture').setAttribute('aria-busy', 'true'); message('');
  try {
    const result = await api('/api/inspect', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url}) });
    if ($('#url').value.trim() !== url || !$('#upload').hidden) return;
    data = result; render();
  } catch (e) { message(e.message, true); }
  finally { inspecting = false; $('#capture').removeAttribute('aria-busy'); $('#inspect').classList.remove('loading'); $('#inspect').removeAttribute('aria-label'); $('#inspect').disabled = false; $('#inspect').textContent = 'Go'; $('#inspect').hidden = Boolean(data); }
}
$('#capture').onsubmit = e => { e.preventDefault(); inspect(); };
$('#url').oninput = () => { if(data) { data=null; $('#preview').hidden=true; } $('#inspect').hidden = !$('#url').value.trim(); };
$('#url').onpaste = () => setTimeout(inspect, 0);
$('#addFile').onclick = () => revealForm(() => { resetCaptureContent(); $('#capture').hidden=true; $('#addFile').hidden=true; $('#upload').hidden=false; message(''); renderSuggestions(); }, $('#upload'));
$('#uploadCancel').onclick = resetCapture;
$('#uploadFile').onchange = () => { $('#fileName').textContent = $('#uploadFile').files[0]?.name || 'file.png'; };
function render(){revealForm(renderPreview, $('#preview'));}
function renderPreview() {
  const all = [...(data.imageCandidates||[]).map(url=>({url,type:'image'})), ...(data.videoCandidates||[]).map(url=>({url,type:'video'}))];
  data.coverMedia = all[0]?.url || '';
  const cover = data.coverImage || data.poster || '';
  $('#preview').innerHTML = `<div class="preview"><div class="mediaPreview"><div class="mainMediaFrame">${cover?`<img class="mainMedia" src="${esc(cover)}" alt="Превью работы">`:'<div class="noCover">Видео</div>'}</div><div class="choices">${all.map(m=>`<label class="mediaOption" title="Включить в архив"><input type="checkbox" class="mediaPick" value="${esc(m.url)}" checked aria-label="Сохранить ${m.type==='image'?'изображение':'видео'}">${m.type==='image'?`<img class="choice" src="${esc(m.url)}" alt="">`:`<video class="choice" src="${esc(m.url)}" preload="metadata" muted></video><span class="videoLabel">Видео</span>`}<button type="button" class="selectionIcon" aria-label="Обложка в сетке" aria-pressed="false" title="Сделать обложкой"><img src="/assets/cover-selected-24.svg" width="24" height="24" alt=""></button></label>`).join('')}</div></div><div class="fields"><div class="fieldGroup"><input id="tags" placeholder="Теги" aria-label="Теги через запятую"><div class="suggestions" data-suggestions="tags" data-kind="tags"></div></div><div class="fieldGroup"><input id="collection" placeholder="Коллекция" aria-label="Коллекция"><div class="suggestions" data-suggestions="collection" data-kind="collection"></div></div><textarea id="note" placeholder="Нравится" aria-label="Заметка"></textarea><div class="actions"><button id="save" class="primary">Сохранить</button><button id="cancel" type="button">Отмена</button></div>${data.warning?`<p class="warning">${esc(data.warning)}</p>`:''}</div></div>`;
  $('#preview').hidden=false; $('#addFile').hidden=true; $('#inspect').hidden=true;
  $('#save').onclick=save; $('#cancel').onclick=resetCapture; renderSuggestions();
  $('#preview').querySelectorAll('.mediaOption').forEach(option=>{
    const input=option.querySelector('.mediaPick'),button=option.querySelector('.selectionIcon');
    button.onclick=e=>{e.preventDefault();e.stopPropagation();input.checked=true;setPreviewCover(input.value,all);};
    input.onchange=()=>{
      if(!$('#preview').querySelector('.mediaPick:checked') || ![...$('#preview').querySelectorAll('.mediaPick:checked')].some(i=>i.value===data.coverMedia))setPreviewCover($('#preview').querySelector('.mediaPick:checked')?.value||'',all);
    };
  });
  setPreviewCover(data.coverMedia,all);
}
function setPreviewCover(url,all){
  data.coverMedia=url;
  $('#preview').querySelectorAll('.selectionIcon').forEach(button=>{const active=button.closest('.mediaOption').querySelector('.mediaPick').value===url;button.classList.toggle('isCover',active);button.setAttribute('aria-pressed',String(active));});
  const media=all.find(m=>m.url===url),poster=data.videoPosters?.[url] || (url===data.videoCandidates?.[0]?data.poster:'');
  const cover=media?.type==='image'?url:poster;
  $('.mainMediaFrame').innerHTML=cover?`<img class="mainMedia" src="${esc(cover)}" alt="Превью работы">`:media?.type==='video'?`<video class="mainMedia" src="${esc(url)}" preload="metadata" muted playsinline></video>`:'<div class="noCover">Выбери медиа</div>';
}
async function save() {
  const selectedMedia = [...document.querySelectorAll('.mediaPick:checked')].map(input=>input.value);
  if(!selectedMedia.length) { message('Выбери хотя бы одно медиа',true);return; }
  const button=$('#save');button.disabled=true;button.textContent='Сохраняю…';
  try {
    const item=await api('/api/save-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:data.sourceUrl,selectedMedia,coverMedia:data.coverMedia,tags:$('#tags').value.split(',').map(t=>t.trim()).filter(Boolean),collection:$('#collection').value,note:$('#note').value})});
    resetCapture(); message(item.archiveErrors?.length?`Сохранено ${item.mediaArchived} из ${item.mediaFound} медиа`: ''); await load();
  }catch(e){message(e.message,true);button.disabled=false;button.textContent='Сохранить';}
}
$('#upload').onsubmit=async e=>{
  e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='Сохраняю…';
  try{await api('/api/upload',{method:'POST',body:new FormData(form)});form.reset();$('#fileName').textContent='file.png';resetCapture();message('');await load();}
  catch(err){message(err.message,true);}
  finally{button.disabled=false;button.textContent='Сохранить';}
};
function known(kind){return [...new Set(library.flatMap(item=>kind==='tags'?item.tags||[]:[item.collection]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));}
function popular(kind){
  const counts=new Map();
  for(const item of library){
    const values=kind==='tags'?item.tags||[]:[item.collection];
    for(const value of new Set(values.filter(Boolean)))counts.set(value,(counts.get(value)||0)+1);
  }
  return [...counts.keys()].sort((a,b)=>counts.get(b)-counts.get(a)||a.localeCompare(b,'ru'));
}
function fitSuggestions(container){
  const buttons=[...container.querySelectorAll('button')];
  buttons.forEach(button=>button.hidden=false);
  const width=container.clientWidth;
  if(!width)return;
  const gap=parseFloat(getComputedStyle(container).columnGap)||0;
  let used=0,full=false;
  for(const button of buttons){
    const needed=button.getBoundingClientRect().width+(used?gap:0);
    if(full||used+needed>width){button.hidden=true;full=true;}
    else used+=needed;
  }
}
const suggestionObserver=new ResizeObserver(entries=>entries.forEach(entry=>fitSuggestions(entry.target)));
function renderSuggestions(){
  suggestionObserver.disconnect();
  document.querySelectorAll('[data-suggestions]').forEach(container=>{
    const input=$('#'+container.dataset.suggestions),kind=container.dataset.kind;
    container.innerHTML=popular(kind).map(value=>`<button type="button" class="suggestion">${esc(value)}</button>`).join('');
    container.querySelectorAll('button').forEach(button=>button.onclick=()=>{
      if(kind==='tags'){const values=input.value.split(',').map(v=>v.trim()).filter(Boolean);const i=values.indexOf(button.textContent);if(i<0)values.push(button.textContent);else values.splice(i,1);input.value=values.join(', ');}
      else input.value=input.value===button.textContent?'':button.textContent;
      input.dispatchEvent(new Event('input'));input.focus();
    });
    fitSuggestions(container);suggestionObserver.observe(container);
  });
}
function filterOptions(selector,kind,label){const select=$(selector),previous=select.value;select.innerHTML=`<option value="">${label}</option>`+known(kind).map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');if([...select.options].some(o=>o.value===previous))select.value=previous;}
let gridFrame;
function scheduleGrid(){cancelAnimationFrame(gridFrame);gridFrame=requestAnimationFrame(layoutGrid);}
function layoutGrid(){
  const grid=$('#grid'),style=getComputedStyle(grid),columns=Number(style.getPropertyValue('--columns'))||4,gap=parseFloat(style.getPropertyValue('--card-gap'))||20;
  const width=(grid.clientWidth-gap*(columns-1))/columns,heights=Array(columns).fill(0);
  for(const card of grid.children){
    card.style.width=width+'px';
    const column=heights.indexOf(Math.min(...heights));
    card.style.left=column*(width+gap)+'px';card.style.top=heights[column]+'px';
    heights[column]+=card.getBoundingClientRect().height+gap;
  }
  grid.style.height=Math.max(0,...heights)- (grid.children.length?gap:0)+'px';
}
let gridWidth=0;
new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(width!==gridWidth){gridWidth=width;scheduleGrid();}}).observe($('#grid'));
function renderLibrary(){
  const q=$('#search').value.trim().toLowerCase(),type=$('#type').value,tag=$('#tagFilter').value,collection=$('#collectionFilter').value;
  const items=library.filter(item=>(!q||[item.title,item.description,item.note,item.source,item.collection,...(item.tags||[])].join(' ').toLowerCase().includes(q))&&(!type||(item.media||[]).some(m=>m.type===type))&&(!tag||(item.tags||[]).includes(tag))&&(!collection||item.collection===collection));
  visibleRefs=items;
  const visibleIds=new Set(items.map(item=>item.id));
  for(const id of selectedRefs)if(!visibleIds.has(id))selectedRefs.delete(id);
  $('#resetFilters').hidden=!(q||type||tag||collection);
  $('#grid').querySelectorAll('video').forEach(v=>v.pause());
  $('#grid').innerHTML=items.map((item,i)=>{
    const media=item.media||[],chosen=media.find(m=>m.id===item.coverMediaId),image=media.find(m=>m.type==='image'),video=chosen?.type==='video'?chosen:media.find(m=>m.type==='video');
    const cover=item.coverUrl||(chosen?(chosen.type==='image'?chosen.localUrl||chosen.remoteUrl:chosen.posterUrl):image?.localUrl||image?.remoteUrl||video?.posterUrl)||'';
    const videoUrl=video?.localUrl||video?.remoteUrl||'';
    const sourceUrl=safeLink(item.sourceUrl),source=esc((item.source||'manual').toLowerCase());
    const sourceBadge=sourceUrl?`<a class="badge sourceBadge" href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Открыть источник: ${source}">${source}</a>`:`<span class="badge sourceBadge">${source}</span>`;
    return `<article class="card" role="button" tabindex="0" data-open="${i}" data-ref-id="${esc(item.id)}" aria-label="Открыть ${esc(item.title||'работу')}">${cover?`<img class="cardCover" src="${esc(cover)}" alt="" loading="lazy">`:(videoUrl?`<video class="cardCover" src="${esc(videoUrl)}" preload="metadata" muted playsinline></video>`:'<div class="noCover">Нет медиа</div>')}${cover&&videoUrl?`<video class="hoverVideo" data-src="${esc(videoUrl)}" preload="none" muted playsinline></video>`:''}<div class="sourceBadges">${sourceBadge}${videoUrl?'<span class="badge videoBadge" aria-label="Есть видео"><img src="/assets/play.svg" alt=""></span>':''}</div><button type="button" class="badge countBadge" role="checkbox" aria-checked="false"><span>${media.length}</span><img src="/assets/bulk-selected.svg" width="32" height="32" alt="" hidden></button></article>`;
  }).join('');
  $('#grid').querySelectorAll('img,video').forEach(media=>{media.addEventListener('load',scheduleGrid);media.addEventListener('error',scheduleGrid);media.addEventListener('loadedmetadata',scheduleGrid);});
  layoutGrid();
  $('#empty').hidden=items.length>0;$('#empty').textContent=library.length?'Ничего не найдено':'Пока пусто';
  document.querySelectorAll('[data-open]').forEach(card=>{
    const video=card.querySelector('video');let hovering=false;
    const stop=()=>{hovering=false;if(!video)return;video.pause();try{video.currentTime=0;}catch{}card.classList.remove('playingVideo');};
    if(video){
      video.muted=true;
      card.onpointerenter=e=>{if(e.pointerType!=='mouse')return;hovering=true;if(video.dataset.src&&!video.getAttribute('src'))video.src=video.dataset.src;video.play().then(()=>{if(!hovering)stop();}).catch(()=>{card.classList.remove('playingVideo');});};
      card.onpointerleave=stop;
      video.onplaying=()=>{if(hovering)card.classList.add('playingVideo');else stop();};
      video.onerror=stop;
    }
    const open=()=>{stop();openViewer(items[Number(card.dataset.open)]);};
    card.onclick=e=>{if(e.target.closest('a,button'))return;open();};
    card.onkeydown=e=>{if(e.target===card&&(e.key==='Enter'||e.key===' ')){e.preventDefault();open();}};
    card.querySelector('.countBadge').onclick=()=>{const id=card.dataset.refId;if(selectedRefs.has(id))selectedRefs.delete(id);else selectedRefs.add(id);updateSelection();};
  });
  updateSelection();
}
function updateSelection(){
  const count=selectedRefs.size,all=visibleRefs.length>0&&count===visibleRefs.length;
  const titles=new Map(visibleRefs.map(item=>[item.id,item.title||'работу']));
  $('#selectionControls').classList.toggle('hasSelection',count>0);
  $('#stats').textContent=(count||visibleRefs.length).toLocaleString('ru-RU');
  $('#stats').setAttribute('aria-checked',all?'true':count?'mixed':'false');
  $('#stats').setAttribute('aria-label',all?`Снять выбор со всех ${count} рефов`:`Выбрано ${count}. Выбрать все ${visibleRefs.length} рефов в сетке`);
  $('#stats').title=all?'Снять выбор со всех':'Выбрать все рефы в сетке';
  $('#stats').disabled=bulkBusy||!visibleRefs.length;
  for(const selector of ['#deleteSelected','#editSelected']){$(selector).hidden=!count;$(selector).disabled=bulkBusy;}
  $('#grid').querySelectorAll('.card').forEach(card=>{
    const selected=selectedRefs.has(card.dataset.refId),button=card.querySelector('.countBadge');
    button.setAttribute('aria-checked',String(selected));button.disabled=bulkBusy;
    button.setAttribute('aria-label',`${selected?'Снять выбор:':'Выбрать:'} ${titles.get(card.dataset.refId)}. Медиа: ${button.querySelector('span').textContent}`);
    button.title=selected?'Снять выбор':'Выбрать реф';
    button.querySelector('span').hidden=selected;button.querySelector('img').hidden=!selected;
  });
}
$('#stats').onclick=()=>{
  if(selectedRefs.size===visibleRefs.length)selectedRefs.clear();else visibleRefs.forEach(item=>selectedRefs.add(item.id));
  updateSelection();
};
$('#editSelected').onclick=()=>{
  bulkIds=[...selectedRefs];if(!bulkIds.length)return;
  $('#bulkForm').reset();$('#bulkError').hidden=true;$('#bulkSave').disabled=true;
  $('#bulkEditor').showModal();renderSuggestions();$('#bulkTags').focus();
};
function bulkChanged(){$('#bulkSave').disabled=bulkBusy||!($('#bulkTags').value.trim()||$('#bulkCollection').value.trim());}
$('#bulkTags').oninput=bulkChanged;$('#bulkCollection').oninput=bulkChanged;
$('#bulkCancel').onclick=()=>$('#bulkEditor').close();
$('#bulkEditor').onclick=e=>{if(e.target===$('#bulkEditor')&&!bulkBusy)$('#bulkEditor').close();};
$('#bulkEditor').addEventListener('cancel',e=>{if(bulkBusy)e.preventDefault();});
function setBulkBusy(busy){
  bulkBusy=busy;
  $('#bulkForm').querySelectorAll('input,button').forEach(control=>control.disabled=busy);
  $('#bulkSave').textContent=busy?'Сохраняю…':'Сохранить';
  bulkChanged();updateSelection();
}
$('#bulkForm').onsubmit=async e=>{
  e.preventDefault();if(bulkBusy||$('#bulkSave').disabled)return;
  const addTags=$('#bulkTags').value.split(',').map(t=>t.trim()).filter(Boolean),collection=$('#bulkCollection').value.trim();
  setBulkBusy(true);$('#bulkError').hidden=true;
  try{
    await api('/api/items/bulk',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:bulkIds,addTags,...(collection?{collection}:{})})});
    selectedRefs.clear();$('#bulkEditor').close();await load();
  }catch(err){$('#bulkError').textContent=err.message;$('#bulkError').hidden=false;}
  finally{setBulkBusy(false);}
};
$('#deleteSelected').onclick=async()=>{
  const ids=[...selectedRefs];if(!ids.length||bulkBusy)return;
  if(!confirm(`Удалить выбранные рефы (${ids.length})? Их локальные изображения и видео тоже будут удалены.`))return;
  setBulkBusy(true);
  try{await api('/api/items/bulk',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});selectedRefs.clear();await load();}
  catch(err){message(err.message,true);alert(err.message);}
  finally{setBulkBusy(false);}
};
async function load(){const version=++loadVersion;try{const items=await api('/api/items');if(version!==loadVersion)return;library=items;filterOptions('#tagFilter','tags','Все теги');filterOptions('#collectionFilter','collection','Все коллекции');renderLibrary();renderSuggestions();}catch(e){message(e.message,true);}}
$('#search').oninput=renderLibrary;$('#type').onchange=renderLibrary;
['#tagFilter','#collectionFilter'].forEach(selector=>{
  const select=$(selector);
  select.onchange=()=>{renderLibrary();select.blur();};
  select.onkeydown=e=>{if(e.key==='Escape')select.blur();};
});
document.addEventListener('pointerdown',e=>{const active=document.activeElement;if(active?.matches('#tagFilter,#collectionFilter')&&!active.contains(e.target))active.blur();});
function syncTypeFilters(){document.querySelectorAll('[data-type]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.type===$('#type').value)));}
function clearFilters(){
  $('#search').value='';$('#type').value='';$('#tagFilter').value='';$('#collectionFilter').value='';syncTypeFilters();
}
$('#resetFilters').onclick=()=>{clearFilters();renderLibrary();};
document.querySelectorAll('[data-type]').forEach(button=>button.onclick=()=>{
  const type=$('#type');type.value=type.value===button.dataset.type?'':button.dataset.type;syncTypeFilters();renderLibrary();
});
function mediaHTML(m){const src=m.localUrl||m.remoteUrl||'';return m.type==='video'?`<video src="${esc(src)}" ${m.posterUrl?`poster="${esc(m.posterUrl)}"`:''} controls preload="metadata"></video>`:`<img src="${esc(src)}" alt="" loading="lazy">`;}
function safeLink(url){try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}}
function sizeViewer(){
  const media=[...$('#viewerContent').querySelectorAll('img,video')];
  const natural=Math.max(0,...media.map(m=>m.naturalWidth||m.videoWidth||0))||1024;
  const available=innerWidth<=800?innerWidth-32:innerWidth-360;
  $('#viewer').style.setProperty('--media-width',Math.min(natural,1024,available)+'px');
  fitViewerNote();
}
window.addEventListener('resize',()=>{if($('#viewer').open)sizeViewer();});
function filterFromViewer(kind,value){
  $('#viewer').close();clearFilters();
  $('#tagFilter').value=kind==='tags'?value:'';
  $('#collectionFilter').value=kind==='collection'?value:'';
  document.querySelectorAll('[data-type]').forEach(b=>b.setAttribute('aria-pressed','false'));
  renderLibrary();$('.library').scrollIntoView({block:'start'});
}
function fitViewerNote(){
  const field=$('.viewerNote textarea');if(!field)return;
  field.style.height='auto';field.style.height=field.scrollHeight+'px';
}
function setupViewerNote(item){
  const form=$('.viewerNote'),field=form.querySelector('textarea'),actions=form.querySelector('.noteActions'),error=form.querySelector('.noteError');
  let saving=false;
  const finish=()=>{field.blur();form.classList.remove('editing');actions.hidden=true;error.hidden=true;fitViewerNote();};
  const cancel=()=>{if(saving)return;field.value=item.note||'';finish();};
  field.onfocus=()=>{form.classList.add('editing');actions.hidden=false;fitViewerNote();};
  field.oninput=fitViewerNote;
  field.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}};
  form.querySelector('.noteCancel').onclick=cancel;
  form.onsubmit=async e=>{
    e.preventDefault();if(saving)return;saving=true;error.hidden=true;
    const note=field.value;field.disabled=true;actions.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{await api(`/api/items/${encodeURIComponent(item.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({note})});item.note=note;finish();await load();}
    catch(err){error.textContent=err.message;error.hidden=false;}
    finally{saving=false;field.disabled=false;actions.querySelectorAll('button').forEach(b=>b.disabled=false);}
  };
}
function renderViewerTags(item){
  const root=$('.viewerTags'),sourceUrl=safeLink(item.sourceUrl),source=esc((item.source||'manual').toLowerCase());
  const row=(kind,value,index)=>`<div class="viewerChipRow" data-kind="${kind}" ${kind==='tags'?`data-index="${index}"`:''}><button type="button" class="tag${kind==='collection'?' prominent':''}${value?'':' emptyCollection'}" ${kind==='collection'?'data-viewer-collection':`data-viewer-tag="${index}"`}>${esc(value||'Коллекция')}</button><button type="button" class="chipAction chipEdit${kind==='collection'?' prominent':''}" aria-label="${kind==='collection'?'Редактировать коллекцию':'Редактировать тег '+esc(value)}" title="Редактировать"><img src="/assets/edit-12.svg" width="12" height="12" alt=""></button></div>`;
  root.innerHTML=`${sourceUrl?`<a class="tag prominent sourceLink" href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${source}</a>`:`<span class="tag prominent">${source}</span>`}${row('collection',item.collection||'')}${(item.tags||[]).map((t,i)=>row('tags',t,i)).join('')}<div class="viewerAddTag"><button type="button" class="tag addViewerTag" aria-label="Добавить тег" title="Добавить тег"><img src="/assets/plus-16.svg" width="16" height="16" alt=""></button></div>`;
  let active=null;
  const edit=(container,kind,index,adding=false)=>{
    if(active?.saving)return;
    active?.cancel();
    const previous=container.innerHTML,value=adding?'':kind==='collection'?item.collection||'':item.tags[index],width=adding?null:container.querySelector('.tag').getBoundingClientRect().width+60;
    container.innerHTML=`<form class="chipEditor${kind==='collection'?' prominent':''}${adding?' addingTag':''}" ${width?`style="width:${width}px"`:''}><input type="text" value="${esc(value)}" placeholder="${kind==='collection'?'Коллекция':'тег'}" aria-label="${kind==='collection'?'Название коллекции':adding?'Новый тег':'Название тега'}" ${kind==='tags'?'required':''}><button type="submit" class="chipAction chipSave" aria-label="${kind==='collection'?'Сохранить коллекцию':'Сохранить тег'}" title="Сохранить"><img src="/assets/check-16.svg" width="16" height="16" alt=""></button><button type="button" class="chipAction chipCancel" aria-label="Отменить редактирование" title="Отмена"><img src="/assets/close-16.svg" width="16" height="16" alt=""></button><p class="chipError" role="status" hidden></p></form>`;
    const form=container.querySelector('form'),field=form.querySelector('input'),error=form.querySelector('.chipError');
    const state={saving:false,cancel:()=>{if(state.saving)return;container.innerHTML=previous;active=null;bind(container);}};
    active=state;
    form.querySelector('.chipCancel').onclick=state.cancel;
    field.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();state.cancel();}};
    form.onsubmit=async e=>{
      e.preventDefault();if(state.saving)return;error.hidden=true;
      const text=field.value.trim(),normalize=v=>v.trim().toLocaleLowerCase('ru'),value=known(kind).find(v=>normalize(v)===normalize(text))||text;
      if(kind==='tags'&&(!value||(item.tags||[]).some((tag,i)=>(adding||i!==index)&&normalize(tag)===normalize(value)))){error.textContent=value?'Этот тег уже добавлен':'Введи название тега';error.hidden=false;return;}
      const tags=[...(item.tags||[])];if(kind==='tags'){if(adding)tags.push(value);else tags[index]=value;}
      const patch=kind==='collection'?{collection:value}:{tags};
      state.saving=true;form.querySelectorAll('input,button').forEach(c=>c.disabled=true);
      try{
        await api(`/api/items/${encodeURIComponent(item.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
        Object.assign(item,patch);if(root.isConnected&&$('#viewer').open)renderViewerTags(item);await load();
      }catch(err){error.textContent=err.message;error.hidden=false;}
      finally{state.saving=false;form.querySelectorAll('input,button').forEach(c=>c.disabled=false);}
    };
    field.focus();field.select();
  };
  const bind=container=>{
    if(container.classList.contains('viewerAddTag')){container.querySelector('.addViewerTag').onclick=()=>edit(container,'tags',-1,true);return;}
    const kind=container.dataset.kind,index=Number(container.dataset.index);
    container.querySelector('.chipEdit').onclick=()=>edit(container,kind,index);
    container.querySelector('.tag').onclick=()=>{const value=kind==='collection'?item.collection:item.tags[index];if(value)filterFromViewer(kind,value);else edit(container,kind,index);};
  };
  root.querySelectorAll('.viewerChipRow,.viewerAddTag').forEach(bind);
}
function openViewer(item){
  $('#viewer > .deleteItem')?.remove();
  $('#viewerContent').innerHTML=(item.media||[]).map(m=>`<div class="viewerMedia">${mediaHTML(m)}</div>`).join('');
  $('#viewerContent').querySelectorAll('img,video').forEach(m=>{m.addEventListener('load',sizeViewer);m.addEventListener('loadedmetadata',sizeViewer);});
  $('#viewerDetails').innerHTML=`<div class="viewerTags"></div><form class="viewerNote"><textarea aria-label="Описание" placeholder="Описание" rows="1">${esc(item.note||'')}</textarea><div class="noteActions" hidden><button type="submit" class="noteSave" aria-label="Сохранить описание" title="Сохранить"><img src="/assets/check.svg" alt=""></button><button type="button" class="noteCancel" aria-label="Отменить изменения" title="Отмена"><img src="/assets/close.svg" alt=""></button></div><p class="noteError" role="status" hidden></p></form><button class="deleteItem" type="button" aria-label="Удалить работу" title="Удалить работу"><img src="/assets/trash.svg" alt=""></button>`;
  setupViewerNote(item);renderViewerTags(item);
  const deleteButton=$('#viewerDetails .deleteItem');deleteButton.onclick=e=>deleteItem(item,e.currentTarget);$('#viewer').append(deleteButton);$('#viewer').showModal();$('#viewer').scrollTop=0;sizeViewer();
}
$('#viewerClose').onclick=()=>$('#viewer').close();$('#viewer').onclick=e=>{if(e.target===$('#viewer'))$('#viewer').close();};
$('#viewer').addEventListener('close',()=>{$('#viewerContent').querySelectorAll('video').forEach(v=>v.pause());$('#viewerContent').innerHTML='';});
async function deleteItem(item,button){
  if(!confirm(`Удалить «${item.title||'работу'}»? Локальные изображения и видео этой работы тоже будут удалены.`))return;
  button.disabled=true;
  try{await api(`/api/items/${encodeURIComponent(item.id)}`,{method:'DELETE'});$('#viewer').close();await load();}
  catch(e){message(e.message,true);button.disabled=false;alert(e.message);}
}
load();

const inboxLabels = { queued: "В очереди", processing: "Загружается", saved: "Сохранено", error: "Ошибка" };
let inboxSavedSignature = null, inboxLoading = false;
async function loadInbox() {
  if (inboxLoading) return;
  inboxLoading = true;
  try {
    const inbox = await api("/api/inbox");
    $("#inboxPath").textContent = inbox.directory;
    $("#inboxStatus").textContent = inbox.error || (inbox.available ? "Папка подключена · Проверка каждые 3 секунды" : "Папка Inbox ещё не подключена");
    const signature = inbox.jobs.filter(j => j.status === "saved").map(j => j.id).join(",");
    if (inboxSavedSignature !== null && signature !== inboxSavedSignature) await load();
    inboxSavedSignature = signature;
    $("#inboxJobs").innerHTML = inbox.jobs.length ? inbox.jobs.map(j => `<div class="inboxJob"><div><strong>${esc(inboxLabels[j.status] || j.status)}${j.partial ? " · частично" : ""}</strong><div class="inboxUrl">${esc(j.url || j.filename)}</div><small>${esc(j.collection)}${j.status === "saved" ? ` · ${j.mediaArchived} из ${j.mediaFound} медиа` : ""}</small>${j.error ? `<p>${esc(j.error)}</p>` : ""}</div>${j.status === "error" ? `<button type="button" data-retry="${esc(j.id)}">Повторить</button>` : ""}</div>`).join("") : "<p>Очередь пока пустая.</p>";
    document.querySelectorAll("[data-retry]").forEach(button => button.onclick = async () => {
      button.disabled = true;
      try { await api(`/api/inbox/${encodeURIComponent(button.dataset.retry)}/retry`, { method: "POST" }); await loadInbox(); }
      catch (e) { alert(e.message); button.disabled = false; }
    });
  } catch (e) { $("#inboxStatus").textContent = "Не удалось получить очередь: " + e.message; }
  finally { inboxLoading = false; }
}
$("#refreshInbox").onclick = loadInbox;
if (!$(".inboxSection").hidden) loadInbox();
setInterval(() => { if (!document.hidden && !$(".inboxSection").hidden) loadInbox(); }, 5000);

document.fonts.ready.then(()=>document.querySelectorAll('[data-suggestions]').forEach(fitSuggestions));
