'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MemoryStore,NOW}=require('./helpers');const {claimLease}=require('../cloudfunctions/collectTick/lib/budget');
const {cachedJudgment,cacheJudgment,reviewVideo}=require('../cloudfunctions/collectTick/lib/content-review');
const {PRICE_URL,MODEL}=require('../cloudfunctions/collectTick/lib/vision-budget');
const {replay}=require('../scripts/validate-reuse-cost');
const note={noteId:'1'.repeat(24),type:'video',title:'菜',desc:'',bodyComplete:true,media:{identity:'stable-video'}};
const price={source:PRICE_URL,model:MODEL,inputMicroCnyPerMillion:1200000,outputMicroCnyPerMillion:3500000,verifiedAt:NOW-1,expiresAt:NOW+3600000};
test('only stable content results are cached; uncertainty expires in a day and media changes invalidate vision',async()=>{
 const store=new MemoryStore(),lease=await claimLease(store,{owner:'test',now:NOW});
 await cacheJudgment(store,lease,note,'text',{verdict:'error'},NOW);assert.equal(await cachedJudgment(store,note,'text',NOW),null);
 await cacheJudgment(store,lease,note,'visual',{verdict:'uncertain'},NOW);
 assert.equal((await cachedJudgment(store,note,'visual',NOW+1000)).verdict,'uncertain');
 assert.equal(await cachedJudgment(store,note,'visual',NOW+86400000),null);
 assert.equal(await cachedJudgment(store,{...note,media:{identity:'changed'}},'visual',NOW),null);
});
test('unchanged visual content reuses the decision without downloading or paying again',async()=>{
 const store=new MemoryStore(),lease=await claimLease(store,{owner:'test',now:NOW});let downloads=0,paid=0;
 const args={store,lease,round:{id:'20260912-0900',visionEnabled:true},note,settings:{enabled:true},clock:()=>NOW,
  verify:async()=>price,extract:async()=>{downloads++;return{samples:[{sha256:'one'},{sha256:'two'}]}},
  classify:async()=>{paid++;return{verdict:'on_topic',evidenceSource:'frames'}}};
 assert.equal((await reviewVideo(args)).verdict,'on_topic');assert.equal((await reviewVideo(args)).cached,true);
 assert.equal(downloads,1);assert.equal(paid,1);
});
test('identical frames are insufficient and never sent to a paid model',async()=>{
 const store=new MemoryStore(),lease=await claimLease(store,{owner:'test',now:NOW});let paid=0;
 const result=await reviewVideo({store,lease,round:{visionEnabled:true},note,settings:{enabled:true},clock:()=>NOW,verify:async()=>price,
  extract:async()=>({samples:Array.from({length:6},()=>({sha256:'same'}))}),classify:async()=>{paid++;return{verdict:'on_topic'}}});
 assert.equal(result.verdict,'uncertain');assert.equal(result.reason,'identical_frames');assert.equal(paid,0);
});
test('offline repeat-cost comparison keeps board outputs while removing redundant checks',async()=>{
 const r=await replay();assert.equal(r.repeatTikHubSavingsPercent,75);assert.equal(r.realPaidRequests,0);
});
test('visual cache write failure keeps the successful model decision instead of creating a model outage',async()=>{
 const store=new MemoryStore(),lease=await claimLease(store,{owner:'test',now:NOW});
 const transact=store.transaction.bind(store);store.transaction=fn=>transact(async tx=>{const put=tx.put.bind(tx);tx.put=async(c,id,v)=>{if(id.startsWith('judgment_'))throw Error('CACHE_WRITE_TEST');return put(c,id,v)};return fn(tx)});
 const result=await reviewVideo({store,lease,round:{visionEnabled:true},note,settings:{enabled:true},clock:()=>NOW,verify:async()=>price,
 extract:async()=>({samples:[{sha256:'one'},{sha256:'two'}]}),classify:async()=>({verdict:'on_topic',evidenceSource:'frames'})});
 assert.equal(result.verdict,'on_topic');assert.equal(result.cacheWarning,'CACHE_UNAVAILABLE');
});
