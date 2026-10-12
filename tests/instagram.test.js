import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramPostUrl, instagramMedia } from '../instagram.js';
test('Instagram links are canonicalized and non-post links are rejected',()=>{
  assert.equal(instagramPostUrl('https://instagram.com/reel/Ab_-12/?igsh=tracking'),'https://www.instagram.com/reel/Ab_-12/');
  assert.equal(instagramPostUrl('https://www.instagram.com/p/Photo/'),'https://www.instagram.com/p/Photo/');
  assert.equal(instagramPostUrl('https://instagram.com.example.com/p/Photo/'),null);
  assert.throws(()=>instagramPostUrl('https://instagram.com/profile/'),/отдельный пост/);
});
test('Only requested carousel is collected, with largest images and video posters',()=>{
  const result=instagramMedia([{recommendations:{shortcode:'Other',display_url:'https://cdn/recommendation.jpg'},post:{shortcode:'Target',owner:{username:'author'},edge_sidecar_to_children:{edges:[{node:{display_resources:[{src:'https://cdn/small.jpg',config_width:320},{src:'https://cdn/original.jpg',config_width:1080}]}},{node:{display_url:'https://cdn/poster.jpg',video_url:'https://cdn/reel.mp4'}}]}}}],'Target');
  assert.deepEqual(result.images,['https://cdn/original.jpg']);
  assert.deepEqual(result.videos,['https://cdn/reel.mp4']);
  assert.equal(result.videoPosters['https://cdn/reel.mp4'],'https://cdn/poster.jpg');
  assert.equal(result.cover,'https://cdn/original.jpg');
  assert.equal(instagramMedia([{shortcode:'Other',display_url:'https://cdn/other.jpg'}],'Target'),null);
});
test('Mobile carousel media selects best video and does not archive its poster as image',()=>{
  const result=instagramMedia([{code:'Target',carousel_media:[{image_versions2:{candidates:[{url:'https://cdn/poster.jpg',width:1080}]},video_versions:[{url:'https://cdn/low.mp4',width:320},{url:'https://cdn/high.mp4',width:1080}]}]}],'Target');
  assert.deepEqual(result.images,[]);assert.deepEqual(result.videos,['https://cdn/high.mp4']);
});
