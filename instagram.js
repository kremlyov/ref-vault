// Only inspect public post pages; no account cookies or private API credentials.
export function instagramPostUrl(value) {
  const url = new URL(value);
  if (!/(^|\.)instagram\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/(p|reel|reels|tv)\/([\w-]+)\/?$/);
  if (!match) throw new Error('Для Instagram нужна ссылка на отдельный пост или Reels. Профили и Stories пока не поддерживаются.');
  return `https://www.instagram.com/${match[1] === 'reels' ? 'reel' : match[1]}/${match[2]}/`;
}
const best = list => [...(list || [])].sort((a,b)=>(b.width||b.config_width||0)*(b.height||b.config_height||1)-(a.width||a.config_width||0)*(a.height||a.config_height||1))[0];
const valid = value => typeof value === 'string' && /^https?:\/\//i.test(value);
export function instagramMedia(payloads, shortcode) {
  let target;
  function find(value, depth=0) {
    if (!value || typeof value !== 'object' || depth>60 || target) return;
    if ((value.shortcode===shortcode || value.code===shortcode) && (value.display_url || value.image_versions2 || value.video_url || value.carousel_media || value.edge_sidecar_to_children)) {target=value;return;}
    for(const child of Object.values(value))find(child,depth+1);
  }
  payloads.forEach(p=>find(p));
  if(!target)return null;
  const images=[],videos=[],videoPosters={};
  const children=target.edge_sidecar_to_children?.edges?.map(e=>e.node)||target.carousel_media||[target];
  let cover='';
  for(const media of children){
    const image=best(media.display_resources)?.src||best(media.image_versions2?.candidates)?.url||media.display_url||media.thumbnail_src||'';
    const video=best(media.video_versions)?.url||media.video_url||'';
    if(!cover && valid(image))cover=image;
    if(valid(video)){videos.push(video);if(valid(image))videoPosters[video]=image;}
    else if(valid(image))images.push(image);
  }
  return {images,videos,videoPosters,cover,title:target.owner?.username||target.user?.username||'Instagram',description:target.edge_media_to_caption?.edges?.[0]?.node?.text||target.caption?.text||''};
}
export async function inspectInstagram(page, canonical) {
  const shortcode=new URL(canonical).pathname.split('/')[2],payloads=[],pending=[];
  const listener=response=>{
    if(!/(^|\.)instagram\.com$/.test(new URL(response.url()).hostname)||!response.headers()['content-type']?.includes('json')||pending.length>=20)return;
    pending.push(response.json().then(json=>payloads.push(json)).catch(()=>{}));
  };
  page.on('response',listener);
  let result;
  try {
    for(const url of [canonical,`${canonical}embed/captioned/`]){
      try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});}
      catch{continue;}
      await page.waitForTimeout(1800);
      const dom=await page.evaluate(()=>{
        const meta=key=>document.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.content||'';
        const scripts=[];
        document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]').forEach(s=>{try{scripts.push(JSON.parse(s.textContent));}catch{}});
        const root=document.querySelector('article')||document.querySelector('.EmbedMedia');
        const images=root?[...root.querySelectorAll('img')].filter(i=>(i.naturalWidth||i.width)>=250&&(i.naturalHeight||i.height)>=150).map(i=>i.currentSrc||i.src):[];
        const videos=root?[...root.querySelectorAll('video')].map(v=>({url:v.currentSrc||v.src||v.querySelector('source')?.src,poster:v.poster})):[];
        return {scripts,images,videos,ogImage:meta('og:image'),ogVideo:meta('og:video:secure_url')||meta('og:video'),title:meta('og:title'),description:meta('og:description'),login:location.pathname.includes('/accounts/login')};
      });
      await Promise.all(pending);
      const structured=instagramMedia([...payloads,...dom.scripts],shortcode);
      const videos=(structured?.videos||dom.videos.map(v=>v.url).filter(valid)).filter(valid);
      if(!videos.length && valid(dom.ogVideo))videos.push(dom.ogVideo);
      const posters=structured?.videoPosters||Object.fromEntries(dom.videos.filter(v=>valid(v.url)&&valid(v.poster)).map(v=>[v.url,v.poster]));
      const images=(structured?.images||dom.images).filter(valid);
      if(!images.length&&!videos.length&&valid(dom.ogImage))images.push(dom.ogImage);
      const cover=structured?.cover||dom.ogImage||images[0]||Object.values(posters)[0]||'';
      if(images.length||videos.length){
        const scoped=Boolean(structured);
        result={finalUrl:canonical,title:structured?.title||dom.title||'Instagram',description:structured?.description||dom.description||'',imageCandidates:[...new Set(images)],videoCandidates:[...new Set(videos)],videoPosters:posters,coverImage:cover,poster:cover,scoped,warning:scoped?'':'Instagram отдал только доступное превью. Карусель или видео могут быть неполными — проверь набор перед сохранением.'};
        if(scoped)break;
      }
    }
  }finally{page.off('response',listener);}
  if(!result)throw new Error('Instagram не отдал медиа без входа в аккаунт. Пост может быть закрытым, удалённым или ограниченным Instagram. Попробуй ручную загрузку файла.');
  return result;
}
