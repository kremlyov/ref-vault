import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInbox, normalizeInboxInput } from '../inbox.js';
const delay = ms => new Promise(r => setTimeout(r, ms));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-inbox-test-'));
  const inboxDir = path.join(root, 'inbox'); fs.mkdirSync(inboxDir);
  return { root, inboxDir };
}
async function discover(queue) { await queue.scan(); await delay(15); await queue.scan(); }

test('optional fields, tags and URL validation', () => {
  assert.equal(normalizeInboxInput({url:'https://example.com'}).collection, 'Inbox / Без разбора');
  assert.deepEqual(normalizeInboxInput({url:'https://example.com',tags:'a, b'}).tags,['a','b']);
  for(const value of [[],null,{url:'file:///tmp/a'},{url:'https://user:pass@example.com'}]) assert.throws(()=>normalizeInboxInput(value));
});

test('stable files, malformed JSON, retry, restart and duplicate scans', async () => {
  const {root,inboxDir}=fixture(); let calls=0, fail=true;
  const archiveReference=async input=>{ calls++; if(fail)throw Error('offline'); assert.equal(input.note,'note');return {id:'item',mediaArchived:2,mediaFound:3,archiveErrors:[{}]}; };
  let queue=createInbox({storageDir:root,inboxDir,archiveReference,autoStart:false,intervalMs:10});
  try {
    fs.writeFileSync(path.join(inboxDir,'good.json'),JSON.stringify({url:'https://example.com',note:'note'}));
    fs.writeFileSync(path.join(inboxDir,'bad.json'),'{');
    await queue.scan();assert.equal(queue.snapshot().jobs.length,0);
    await delay(15); await queue.scan();assert.equal(calls,1);
    assert.equal(queue.snapshot().jobs.filter(j=>j.status==='error').length,2);
    const good=queue.snapshot().jobs.find(j=>j.url);fail=false;queue.retry(good.id);
    await delay(15);assert.equal(queue.snapshot().jobs.find(j=>j.id===good.id).status,'saved');
    assert.equal(queue.snapshot().jobs.find(j=>j.id===good.id).partial,true);
    assert.equal(queue.snapshot().jobs.some(j=>'raw' in j),false);
    await queue.scan();assert.equal(calls,2);
    queue.stop();queue=createInbox({storageDir:root,inboxDir,archiveReference,autoStart:false,intervalMs:10});
    await discover(queue);assert.equal(calls,2);
    fs.writeFileSync(path.join(inboxDir,'bad.json'),JSON.stringify({url:'https://example.com',note:'note'}));
    await discover(queue);assert.equal(calls,3);
  } finally {queue.stop();fs.rmSync(root,{recursive:true});}
});

test('interrupted job resumes with same id even when inbox is unavailable', async()=>{
 const {root,inboxDir}=fixture();let received;
 fs.writeFileSync(path.join(root,'inbox-queue.json'),JSON.stringify({jobs:[{id:'stable-id',raw:'{"url":"https://example.com"}',status:'processing'}]}));
 fs.rmSync(inboxDir,{recursive:true});
 const queue=createInbox({storageDir:root,inboxDir,autoStart:false,archiveReference:async input=>{received=input.inboxJobId;return {id:'existing',mediaArchived:1,mediaFound:1};}});
 try {await queue.scan();assert.equal(received,'stable-id');assert.equal(queue.snapshot().jobs[0].status,'saved');assert.ok(queue.snapshot().error);}
 finally {queue.stop();fs.rmSync(root,{recursive:true});}
});

test('serial processing, changing file waits for next stable scan',async()=>{
 const {root,inboxDir}=fixture();let running=0,max=0,calls=0;
 const queue=createInbox({storageDir:root,inboxDir,autoStart:false,intervalMs:10,archiveReference:async()=>{calls++;running++;max=Math.max(max,running);await delay(20);running--;return {id:String(calls),mediaArchived:1,mediaFound:1};}});
 try {
  fs.writeFileSync(path.join(inboxDir,'a.json'),'{');await queue.scan();
  fs.writeFileSync(path.join(inboxDir,'a.json'),' {"url":"https://example.com/a"}');
  fs.writeFileSync(path.join(inboxDir,'b.json'),'{"url":"https://example.com/b"}');
  await queue.scan();assert.equal(calls,0);await delay(15);await Promise.all([queue.scan(),queue.scan()]);assert.equal(calls,2);assert.equal(max,1);
 }finally{queue.stop();fs.rmSync(root,{recursive:true});}
});
