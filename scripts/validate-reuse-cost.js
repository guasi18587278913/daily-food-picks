'use strict';
// Offline only: deliberately uses a memory database and fixture HTTP/model responses.
const assert = require('node:assert/strict');
const { MemoryStore, NOW, PRICE, LIMITS } = require('../tests/helpers');
const { Provider } = require('../cloudfunctions/collectTick/lib/provider');
const { claimLease, releaseLease } = require('../cloudfunctions/collectTick/lib/budget');
const { cachedJudgment, cacheJudgment } = require('../cloudfunctions/collectTick/lib/content-review');
const { judgeNote } = require('../cloudfunctions/collectTick/lib/judge');
const { eligibleBoards } = require('../cloudfunctions/collectTick/lib/ranking');
const id = n => n.toString(16).padStart(24, '0');
const raws = [1, 2].map(n => ({ id: id(n), user: { userid: id(100+n) }, type:'video', title:n===1?'蒸蛋':'蒸南瓜',
 desc:'加水蒸十分钟', time:(NOW-2*86400000)/1000, liked_count:n===1?20000:600 }));
async function replay() {
 const store = new MemoryStore(), runs = [];
 for (const [i, roundId] of ['20260912-0900','20260912-1200'].entries()) {
  const now=NOW+i*3*3600000, lease=await claimLease(store,{owner:roundId,now});
  const round={id:roundId,kind:'regular',roundCalls:17,discoveryMode:'adaptive',discoveryLimit:4};
  await store.put('dfp_rounds',roundId,{status:'running',definition:round});
  const counts={search:0,detail:0,author:0,text:0}, outputs=[];
  const provider=new Provider({store,lease,round,config:{...LIMITS,enabled:true,freeAiConfirmed:true},
   price:{...PRICE,verifiedAt:now-1,expiresAt:now+3600000},clock:()=>now,key:'fixture-cost-replay-key',fetcher:async url=>{
    const name=new URL(url).pathname.split('/').at(-1);let data;
    if(name==='search_notes'){counts.search++;data={items:raws.map(note=>({note}))};}
    else if(name==='get_video_note_detail'){counts.detail++;data=[{note_list:[raws.find(r=>r.id===new URL(url).searchParams.get('note_id'))]}];}
    else if(name==='get_user_info'){counts.author++;data={fans:2000};}else throw Error('Unexpected fixture request');
    return Response.json({code:200,data:{success:true,code:0,data}});
   }});
  try {
   const search=await provider.request('search',{keyword:'蒸蛋',page:1,sort_type:'popularity_descending',time_filter:'一周内',note_type:'不限'},{forceFresh:true});
   for (const discovered of await provider.notes(search)) {
    const detail=await provider.request('note_video',{note_id:discovered.noteId},{expectedNote:discovered});
    const note=(await provider.notes(detail)).find(n=>n.noteId===discovered.noteId);
    let result=await cachedJudgment(store,note,'text',now);
    if(!result){result=await judgeNote(note,async()=>{counts.text++;return '{"verdict":"cooking","evidence":"加水蒸十分钟"}'});await cacheJudgment(store,lease,note,'text',result,now);}
    if(note.likes<10000){const author=await provider.request('user',{user_id:note.authorId},{purpose:'inspection'});note.fans=author.fans;}
    outputs.push({noteId:note.noteId,verdict:result.verdict,likes:note.likes,boards:eligibleBoards(note,now)});
   }
  } finally {await releaseLease(store,lease);}
  runs.push({counts,outputs});
 }
 assert.deepEqual(runs[0].outputs,runs[1].outputs);
 assert.deepEqual(runs[0].counts,{search:1,detail:2,author:1,text:2});
 assert.deepEqual(runs[1].counts,{search:1,detail:0,author:0,text:0});
 return {environment:'offline-fixtures',realPaidRequests:0,runs,repeatTikHubSavingsPercent:75,
  repeatDetailAuthorTextSavingsPercent:100,limitation:'Same unchanged batch within cache lifetime, not a live daily cost reduction estimate.'};
}
if(require.main===module)replay().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1});
module.exports={replay};
