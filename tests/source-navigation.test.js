'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {shortLink,validNavigation,navigationFor,mergeRegistry}=require('../shared/source-navigation');
const id='1'.repeat(24),other='2'.repeat(24),link='#小程序://小红书/笔记详情/fixtureOnlyLink1',now=1789380000000;
test('only the intended official link form is accepted and a descriptor cannot bind to another note',()=>{
 assert.equal(shortLink(link),true);assert.equal(validNavigation({noteId:id,shortLink:link},id),true);
 assert.equal(validNavigation({noteId:other,shortLink:link},id),false);
 for(const bad of ['https://xhslink.com/a/test','#小程序://其他应用/fixtureOnlyLink1',link+'\n',link+'?id=2',link+' '.repeat(600)])assert.equal(shortLink(bad),false);
});
test('confirmed links retain exact bytes, expired ones disappear, and invalid records never become live links',()=>{
 const r=mergeRegistry(null,[{noteId:id,shortLink:link,confirmed:true,expiresAt:now+1000}],0,now);
 assert.deepEqual(navigationFor(r,id,now),{noteId:id,shortLink:link});assert.equal(navigationFor(r,id,now+1000),null);
 assert.equal(navigationFor({...r,entries:{[id]:{...r.entries[id],noteId:other}}},id,now),null);
 assert.throws(()=>mergeRegistry(null,[{noteId:id,shortLink:link}],0,now),/UNCONFIRMED/);
});
test('directory revisions reject stale writes and one opaque short code cannot point to two notes',()=>{
 const r=mergeRegistry(null,[{noteId:id,shortLink:link,confirmed:true}],0,now);
 assert.throws(()=>mergeRegistry(r,[{noteId:other,shortLink:'#小程序://小红书/另一个标题/fixtureOnlyLink1',confirmed:true}],1,now),/REGISTRY_INVALID/);
 assert.throws(()=>mergeRegistry(r,[{noteId:id,shortLink:link,confirmed:true}],0,now),/CONFLICT/);
});
