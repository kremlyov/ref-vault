const pinId = value => String(value || '').match(/\/pin\/(?:[^/]*--)?(\d+)\/?(?:[?#]|$)/)?.[1];
const metadataEntries = payloads => payloads.flatMap(p => Array.isArray(p) ? p : p?.['@graph'] || [p]).filter(Boolean);
function pinIds(payloads, pageUrl) {
  const ids = new Set([pinId(pageUrl)].filter(Boolean));
  const primary = metadataEntries(payloads).find(n => [n['@type']].flat().includes('SocialMediaPosting'));
  const alias = pinId(primary?.mainEntityOfPage?.['@id']);
  if (alias) ids.add(alias);
  return ids;
}

// Pinterest embeds Relay responses as a registration call with a JSON second
// argument. Parse that JSON only; never execute JavaScript from the page.
export function pinterestPagePayloads(scripts) {
  return scripts.flatMap(source => {
    try {
      const relay = source.match(/^\s*window\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\("(?:[^"\\]|\\.)*",\s*(\{[\s\S]*\})\);?\s*$/);
      return [JSON.parse(relay ? relay[1] : source)];
    } catch { return []; }
  });
}

export function pinterestGallery(payloads, structuredMetadata, pageUrl) {
  const ids = pinIds(structuredMetadata, pageUrl);
  const pending = [...payloads];
  const visited = new Set();
  let gallery = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);
    const identity = String(node.entityId || node.id || '');
    const matchesPin = ids.has(identity) || ids.has(pinId(node.seoUrl));
    const slots = node.carouselData?.carouselSlots || node.carousel_data?.carousel_slots;
    if (matchesPin && Array.isArray(slots)) {
      const images = slots.flatMap(slot => {
        if (!slot || typeof slot !== 'object') return [];
        const variants = [
          ...Object.entries(slot).filter(([key]) => key.startsWith('images_')).map(([, value]) => value),
          ...Object.values(slot.images || {})
        ].flatMap(image => {
          try {
            const url = new URL(image?.url);
            if (url.protocol !== 'https:' || !/(^|\.)pinimg\.com$/.test(url.hostname)) return [];
            const size = Number(url.pathname.match(/^\/(\d+)x/)?.[1]) || 0;
            return [{ url: url.href, rank: url.pathname.startsWith('/originals/') ? Infinity : Number(image.width) || size }];
          } catch { return []; }
        }).sort((a, b) => b.rank - a.rank);
        return variants[0] ? [variants[0].url] : [];
      });
      const seen = new Set();
      const unique = images.filter(image => {
        const url = new URL(image);
        const key = url.hostname + url.pathname.replace(/^\/(?:originals|\d+x(?:\d+)?(?:_RS)?|\d+x\d+_A)\//, '/asset/');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // Multiple Relay fragments can repeat the same pin. Use the fullest one
      // rather than appending the cover or unrelated recommendation assets.
      if (unique.length > gallery.length) gallery = unique;
    }
    pending.push(...Object.values(node).filter(value => value && typeof value === 'object'));
  }
  return gallery;
}

// Read only top-level structured metadata for this pin, never the recommendation feed.
export function pinterestVideo(payloads, pageUrl) {
  const entries=metadataEntries(payloads);
  const types=n=>Array.isArray(n['@type'])?n['@type']:[n['@type']];
  const ids=pinIds(payloads,pageUrl);
  const primary=entries.find(n=>types(n).includes('SocialMediaPosting'));
  const videos=entries.filter(n=>types(n).includes('VideoObject'));
  const video=videos.find(n=>ids.has(pinId(n['@id']||n.url)))|| (videos.length===1&&!pinId(videos[0]['@id']||videos[0].url)?videos[0]:null);
  if(!video)return null;
  let url;try{url=new URL(video.contentUrl);}catch{return null;}
  if(url.protocol!=='https:'||!/(^|\.)pinimg\.com$/.test(url.hostname)||!/\.mp4$/i.test(url.pathname))return null;
  const poster=Array.isArray(video.thumbnailUrl)?video.thumbnailUrl[0]:video.thumbnailUrl||primary?.image||'';
  return {url:url.href,poster};
}
