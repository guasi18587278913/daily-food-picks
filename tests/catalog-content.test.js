'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const{MemoryStore,NOW}=require('./helpers');const{createCatalog}=require('../cloudfunctions/catalog/lib/queries');
const{contentFor,sourceMediaUrl}=require('../cloudfunctions/catalog/lib/content');
const id='1'.repeat(24),authorId='2'.repeat(24),appId='wx8a2388888683b769',snapshotId='20260912-0900-abcdefabcdef';
async function setup(){const store=new MemoryStore();await store.put('dfp_users','owner',{role:'member',status:'active'});
 await store.put('dfp_snapshots',snapshotId,{published:true});await store.put('dfp_candidates','published_'+id,{snapshotId,indexId:'index1'});
 const note={noteId:id,authorId,type:'video',title:'蒸蛋',author:'作者',firstRoundId:'20260912-0900',fileId:null};
 await store.put('dfp_notes','index1',{snapshotId,note});
 await store.put('dfp_candidates','20260912-0900_'+id,{roundId:'20260912-0900',stage:'done',note:{...note,desc:'鸡蛋2个，加水搅匀蒸熟',bodyComplete:true,fetchedAt:new Date(NOW).toISOString(),coverUrl:'https://sns-i11.rednotecdn.com/cover.jpg',media:{url:'https://sns-v11.rednotecdn.com/video.mp4'},images:['https://sns-i11.rednotecdn.com/cover.jpg'],imageCount:1,imagesComplete:true,privateSecret:'must-not-return'}});
 return{store,note,ctx:{APPID:appId,OPENID:'owner'},api:createCatalog({store,config:{appId,migrationFallback:false},clock:()=>NOW})};}
test('published content is read from its bound candidate with no writes or hidden fields',async()=>{const x=await setup();const before=structuredClone(x.store.docs);const r=await x.api({action:'getContent',noteId:id},x.ctx);assert.equal(r.ok,true);assert.equal(r.data.content.desc,'鸡蛋2个，加水搅匀蒸熟');assert.equal(r.data.content.videoUrl,'https://sns-v11.rednotecdn.com/video.mp4');assert.equal(r.data.note.thumbUrl,'https://sns-i11.rednotecdn.com/cover.jpg');assert.equal(JSON.stringify(r).includes('must-not-return'),false);assert.deepEqual(x.store.docs,before);});
test('missing identity, suspended accounts and unpublished candidate IDs cannot read content',async()=>{const x=await setup();assert.equal((await x.api({action:'getContent',noteId:id},{})).ok,false);await x.store.put('dfp_users','owner',{role:'member',status:'suspended'});assert.equal((await x.api({action:'getContent',noteId:id},x.ctx)).error.code,'SUSPENDED');await x.store.put('dfp_users','owner',{role:'member',status:'active'});await x.store.put('dfp_snapshots',snapshotId,{published:false});assert.equal((await x.api({action:'getContent',noteId:id},x.ctx)).error.code,'NOT_FOUND');assert.equal((await x.api({action:'getContent',noteId:'../private'},x.ctx)).error.code,'INVALID_ARGUMENT');});
test('candidate identity mismatch and legacy absence produce an explicit missing state',async()=>{const x=await setup();const row=await x.store.get('dfp_candidates','20260912-0900_'+id);row.note.authorId='3'.repeat(24);await x.store.put('dfp_candidates','20260912-0900_'+id,row);const r=await x.api({action:'getContent',noteId:id},x.ctx);assert.equal(r.ok,true);assert.equal(r.data.content.status,'missing');assert.equal(r.data.content.videoUrl,null);});
test('CDN validation rejects unrelated hosts, credentials, ports and oversized URLs',()=>{for(const bad of ['https://evil.example/1','https://rednotecdn.com.evil.example/1','https://user:password@sns-v11.rednotecdn.com/1','https://sns-v11.rednotecdn.com:444/1','file:///tmp/x'])assert.equal(sourceMediaUrl(bad),null);const c=contentFor({type:'video',desc:'正文',bodyComplete:true,images:['https://evil.example/1','https://sns-i11.rednotecdn.com/1'],imageCount:2,imagesComplete:true,media:{url:'https://evil.example/video'}});assert.equal(c.images.length,1);assert.equal(c.imagesComplete,false);assert.equal(c.videoUrl,null);});
test('legacy cloud covers retain their source fallback even if signing fails',async()=>{
 const x=await setup();const row=await x.store.get('dfp_notes','index1');row.note.fileId='cloud://old-cover';await x.store.put('dfp_notes','index1',row);
 for(const successful of [false,true]){const api=createCatalog({store:x.store,config:{appId,migrationFallback:false},clock:()=>NOW,sign:async()=>{if(!successful)throw Error('signing down');return[{fileID:'cloud://old-cover',tempFileURL:'https://cloud.example/signed'}];}});
 const result=await api({action:'getNotes',noteIds:[id]},x.ctx);assert.equal(result.ok,true);assert.equal(result.data.notes[0].thumbUrl,successful?'https://cloud.example/signed':'https://sns-i11.rednotecdn.com/cover.jpg');assert.equal(result.data.notes[0].thumbFallbackUrl,'https://sns-i11.rednotecdn.com/cover.jpg');}
});
test('author navigation is bound to the published author, read-only, and failure does not hide content',async()=>{
 const x=await setup(),key='author_profile_'+authorId;
 const navigation={authorId,token:'opaque-share-value',source:'app_share'};
 await x.store.put('dfp_results',key,{recordType:'author_navigation',authorId,capturedAt:NOW,navigation});
 const before=structuredClone(x.store.docs);const r=await x.api({action:'getContent',noteId:id,authorId:'3'.repeat(24)},x.ctx);
 assert.deepEqual(r.data.note.authorNavigation,navigation);assert.deepEqual(x.store.docs,before);
 await x.store.put('dfp_results',key,{recordType:'author_navigation',authorId,capturedAt:NOW,navigation:{...navigation,authorId:'3'.repeat(24)}});
 assert.equal((await x.api({action:'getContent',noteId:id},x.ctx)).data.note.authorNavigation,null);
 const get=x.store.get.bind(x.store);x.store.get=async(c,k)=>{if(k===key)throw Error('cache offline');return get(c,k);};
 const failed=await x.api({action:'getContent',noteId:id},x.ctx);assert.equal(failed.ok,true);assert.equal(failed.data.note.authorNavigation,null);assert.ok(failed.data.content.desc);
});
