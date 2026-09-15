'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadConfig,scheduledRound}=require('../cloudfunctions/collectTick/lib/config');
const {reserveAttempt,claimLease}=require('../cloudfunctions/collectTick/lib/budget');
const {MemoryStore,NOW,PRICE}=require('./helpers');
const env={DFP_ENABLED:'true',DFP_FREE_AI_CONFIRMED:'true',DFP_TIMER_SECRET:'a'.repeat(64),DFP_DAILY_CALLS:'500',DFP_DAILY_MICRO_USD:'5000000',
 DFP_SWEEP_CALLS:'200',DFP_VALIDATION_CALLS:'20',DFP_VALIDATION_MICRO_USD:'200000',DFP_DISCOVERY_MODE:'adaptive',DFP_BUDGET_TIER:'expanded250'};
test('explicit expanded tier allocates 100/50/50/50; old configuration cannot silently expand',()=>{
 const config=loadConfig(env);assert.deepEqual([6,9,12,20].map(h=>scheduledRound(Date.parse(`2026-09-12T${String(h).padStart(2,'0')}:00:00+08:00`),config).roundCalls),[100,50,50,50]);
 assert.equal(scheduledRound(NOW,config).discoveryAllocation,'candidate-reserve-v2');
 assert.equal(scheduledRound(NOW,config).discoveryLimit,undefined);
 assert.throws(()=>loadConfig({...env,DFP_BUDGET_TIER:''}),/CONFIGURATION/);
 assert.throws(()=>loadConfig({...env,DFP_DAILY_CALLS:'501'}),/CONFIGURATION/);
});
async function setup(calls=134,extra=12){
 const time=Date.parse('2026-09-12T18:30:00+08:00'),config=loadConfig({...env,DFP_SUPPLEMENT_AT:'2026-09-12T18:30:00+08:00',DFP_SUPPLEMENT_CALLS:'50'});
 const round=scheduledRound(time,config),store=new MemoryStore(),lease=await claimLease(store,{owner:'expanded',now:time});
 await store.put('dfp_rounds',round.id,{status:'running',definition:round,calls:0});
 await store.put('dfp_budgets',round.day,{calls,microUsd:calls*10000,additionalResearchCalls:extra,additionalResearchMicroUsd:extra*10000});
 const args={roundId:round.id,lease,now:time,kind:'note_video',attempt:1,price:{...PRICE,verifiedAt:time-1,expiresAt:time+3600000},limits:{...config,roundCalls:round.roundCalls}};
 return{store,round,args};
}
test('expanded supplement spends at most fifty, preserves fifty for evening and counts prior extra research',async()=>{
 const {store,round,args}=await setup();// 18:30 leaves food's 20:00 and the FDE 21:00 round still to run, on one shared ledger.
 assert.equal(round.reservedRegularCalls,100);
 for(let i=0;i<50;i++)await reserveAttempt(store,{...args,requestKey:`note${i}`});
 await assert.rejects(()=>reserveAttempt(store,{...args,requestKey:'overflow'}),/ROUND_BUDGET/);
 const day=await store.get('dfp_budgets',round.day);assert.equal(day.calls,184);assert.equal(day.additionalResearchCalls,12);
 const evening=scheduledRound(Date.parse('2026-09-12T20:00:00+08:00'),loadConfig(env));
 await store.put('dfp_rounds',evening.id,{status:'running',definition:evening,calls:0});
 for(let i=0;i<50;i++)await reserveAttempt(store,{...args,roundId:evening.id,requestKey:`evening${i}`});
 const final=await store.get('dfp_budgets',round.day);assert.equal(final.calls+final.additionalResearchCalls,246);
});
test('parallel requests cannot spend the evening reserve including additional research money',async()=>{
 const {store,round,args}=await setup(387,12);
 const outcomes=await Promise.allSettled([0,1].map(i=>reserveAttempt(store,{...args,requestKey:`race${i}`})));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await store.get('dfp_budgets',round.day)).calls,388);
});
