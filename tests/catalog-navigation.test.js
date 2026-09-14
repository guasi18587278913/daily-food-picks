'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {MemoryStore,NOW}=require('./helpers');
const {createCatalog}=require('../cloudfunctions/catalog/lib/queries');const {mergeRegistry}=require('../shared/source-navigation');const {registerLinks}=require('../cloudfunctions/catalog/lib/navigation-registry');
const id='1'.repeat(24),other='2'.repeat(24),link='#小程序://小红书/笔记详情/fixtureOnlyLink1',appId='wx8a2388888683b769',snapshotId='20260912-0900-abcdefabcdef';
async function setup(){const store=new MemoryStore();await store.put('dfp_users','owner',{role:'member',status:'active',grantedAt:'2026-09-12T00:00:00Z',grantedVia:'invite',inviteCode:'ABCDEFGHJK',updatedAt:'2026-09-12T00:00:00Z',updatedBy:'owner'});
await store.put('dfp_snapshots',snapshotId,{published:true,status:'complete',parts:[],count:0});await store.put('dfp_candidates','published_'+id,{snapshotId,indexId:'index1'});await store.put('dfp_notes','index1',{snapshotId,note:{noteId:id,title:'蒸蛋',author:'作者',fileId:'cloud://cover'},searchText:'蒸蛋'});
let reads=0;const original=store.get.bind(store);store.get=async(c,k)=>{if(k==='source_navigation_v1')reads++;return original(c,k)};
const api=createCatalog({store,config:{appId,migrationFallback:false},clock:()=>NOW,sign:async()=>[{fileID:'cloud://cover',tempFileURL:'https://image.test/cover'}]});return{store,api,reads:()=>reads,ctx:{APPID:appId,OPENID:'owner'}};}
test('navigation is attached only to requested notes, once per nonempty note response, with existing image data intact',async()=>{
 const x=await setup();await x.store.put('dfp_state','source_navigation_v1',mergeRegistry(null,[{noteId:id,shortLink:link,confirmed:true}],0,NOW));
 const r=await x.api({action:'getNotes',noteIds:[id]},x.ctx);assert.equal(r.ok,true);assert.equal(r.data.notes[0].sourceNavigation.shortLink,link);assert.equal(r.data.notes[0].thumbUrl,'https://image.test/cover');assert.equal(x.reads(),1);
 const empty=await x.api({action:'getNotes',noteIds:[other]},x.ctx);assert.deepEqual(empty.data.notes,[]);assert.equal(x.reads(),1);
 await x.api({action:'status'},x.ctx);await x.api({action:'listRounds'},x.ctx);await x.api({action:'getNotes',noteIds:[id]},{});assert.equal(x.reads(),1);
});
test('directory errors preserve notes and copy URLs with an explicit unavailable state',async()=>{
 const x=await setup();const original=x.store.get.bind(x.store);x.store.get=async(c,k)=>{if(k==='source_navigation_v1')throw Error('TEST_READ_FAIL');return original(c,k)};
 const r=await x.api({action:'getNotes',noteIds:[id]},x.ctx);assert.equal(r.ok,true);assert.equal(r.data.notes[0].title,'蒸蛋');assert.equal(r.data.notes[0].sourceNavigation,null);assert.equal(r.data.notes[0].sourceNavigationState,'unavailable');
});
test('registration previews without writing, requires a published note and rejects concurrent stale updates',async()=>{
 const x=await setup(),input={entries:[{noteId:id,shortLink:link,confirmed:true}],expectedRevision:0,now:NOW};
 const preview=await registerLinks(x.store,input);assert.equal(preview.applied,false);assert.equal(await x.store.get('dfp_state','source_navigation_v1'),null);
 const attempts=await Promise.allSettled([registerLinks(x.store,{...input,apply:true}),registerLinks(x.store,{...input,apply:true})]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 await assert.rejects(()=>registerLinks(x.store,{entries:[{noteId:other,shortLink:'#小程序://小红书/fixtureOther2',confirmed:true}],expectedRevision:1,now:NOW,apply:true}),/SOURCE_NOTE_NOT_PUBLISHED/);
 assert.equal((await x.store.get('dfp_snapshots',snapshotId)).published,true);
});
