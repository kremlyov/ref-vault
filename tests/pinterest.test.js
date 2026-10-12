import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pinterestVideo, pinterestGallery, pinterestPagePayloads} from '../pinterest.js';
const galleryFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/pinterest-gallery.json', import.meta.url), 'utf8'));
const galleryUrl = 'https://ru.pinterest.com/pin/633248397655857241/';
const expectedGallery = [
 'https://i.pinimg.com/1200x/f9/6b/2e/f96b2e0748f2f939a2f4e81bf6376e92.jpg',
 'https://i.pinimg.com/1200x/d0/b3/4f/d0b34ffe71ad47218f7e46e70f966d14.jpg',
 'https://i.pinimg.com/1200x/ec/3a/ec/ec3aec7bebfa0df205bfa5f06be3b823.jpg'
];
test('Pinterest repin resolves original pin MP4, without recommendation videos',()=>{
 const result=pinterestVideo([{'@type':'SocialMediaPosting',mainEntityOfPage:{'@id':'https://au.pinterest.com/pin/clock-video--123/'}},{'@type':'VideoObject','@id':'https://au.pinterest.com/pin/123/',contentUrl:'https://v1.pinimg.com/videos/clock.mp4',thumbnailUrl:'https://i.pinimg.com/poster.jpg'},{'@type':'VideoObject','@id':'https://pinterest.com/pin/999/',contentUrl:'https://v1.pinimg.com/videos/other.mp4'}],'https://ru.pinterest.com/pin/456/');
 assert.deepEqual(result,{url:'https://v1.pinimg.com/videos/clock.mp4',poster:'https://i.pinimg.com/poster.jpg'});
});

test('real Pinterest gallery preserves all three photos in order, preferring largest sizes',()=>{
 const recommendation = structuredClone(galleryFixture);
 const pin = recommendation.data.v3GetPinQueryv2.data;
 pin.entityId='999';pin.seoUrl='/pin/999/';
 pin.carouselData.carouselSlots[0].images_1200x.url='https://i.pinimg.com/1200x/recommendation.jpg';
 assert.deepEqual(pinterestGallery([recommendation,galleryFixture,galleryFixture],[],galleryUrl),expectedGallery);
 assert.deepEqual(pinterestGallery([recommendation],[],galleryUrl),[]);
});

test('gallery resolves original-pin alias, tolerates incomplete fragments and deduplicates sized assets',()=>{
 const fixture = structuredClone(galleryFixture);
 const pin=fixture.data.v3GetPinQueryv2.data;
 pin.entityId='450289662765794631';delete pin.seoUrl;
 const first=pin.carouselData.carouselSlots[0];
 first.images_orig={url:expectedGallery[0].replace('/1200x/','/originals/'),width:2000};
 pin.carouselData.carouselSlots.push(structuredClone(first),null,{images_1200x:{url:'https://unrelated.example/image.jpg'}},{images_1200x:{url:'javascript:alert(1)'}});
 const metadata=[{'@type':'SocialMediaPosting',mainEntityOfPage:{'@id':'https://www.pinterest.com/pin/desk-setup--450289662765794631/'}}];
 assert.deepEqual(pinterestGallery([{},null,fixture],metadata,galleryUrl),[first.images_orig.url,...expectedGallery.slice(1)]);
 assert.deepEqual(pinterestGallery([fixture],[],galleryUrl),[]);
 assert.deepEqual(pinterestGallery([{entityId:'633248397655857241',images_1200x:{url:expectedGallery[0]}}],[],galleryUrl),[]);
});

test('Relay registration is parsed as JSON only, with invalid or executable scripts ignored',()=>{
 const registration=`window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("%7B%22pinId%22%3A%22633248397655857241%22%7D", ${JSON.stringify(galleryFixture)});`;
 const payloads=pinterestPagePayloads([registration,JSON.stringify(galleryFixture),'not json',registration+'window.unwanted=true;', 'window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("key", (() => { throw Error("executed"); })());']);
 assert.equal(payloads.length,2);
 assert.deepEqual(pinterestGallery(payloads,[],galleryUrl),expectedGallery);
});
test('Pinterest ignores wrong pins, blob streams and non-video structured metadata',()=>{
 assert.equal(pinterestVideo([{'@type':'VideoObject','@id':'https://pinterest.com/pin/999/',contentUrl:'https://v1.pinimg.com/other.mp4'}],'https://pinterest.com/pin/456/'),null);
 assert.equal(pinterestVideo([{'@type':'VideoObject',contentUrl:'blob:https://pinterest.com/video'}],'https://pinterest.com/pin/456/'),null);
 assert.equal(pinterestVideo([{'@type':'ImageObject',contentUrl:'https://i.pinimg.com/image.jpg'}],'https://pinterest.com/pin/456/'),null);
});
