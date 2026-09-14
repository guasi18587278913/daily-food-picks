'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const id='1'.repeat(24),link='#小程序://小红书/笔记详情/fixtureOnlyLink1';
function setup(){let definition;const calls={navigate:[],copy:0,modals:[],toasts:[]};global.wx={cloud:{callFunction:async()=>({})},navigateToMiniProgram:o=>calls.navigate.push(o),showModal:o=>calls.modals.push(o),showToast:o=>calls.toasts.push(o)};global.Page=d=>definition=d;
const p=require.resolve('../miniprogram/pages/index/index');delete require.cache[p];require(p);delete global.Page;
const page={...definition,_notes:[{noteId:id,sourceNavigation:{noteId:id,shortLink:link}}],onCopy:async()=>{calls.copy++},setData(){}};
return{page,calls,event:{currentTarget:{dataset:{id}}}};}
test('rapid repeat taps request one navigation and cancellation performs no copy or error modal',async()=>{
const x=setup();const first=x.page.onOpenSource(x.event);await x.page.onOpenSource(x.event);assert.equal(x.calls.navigate.length,1);
x.calls.navigate[0].fail({errMsg:'navigateToMiniProgram:fail cancel'});await first;assert.equal(x.calls.copy,0);assert.equal(x.calls.modals.length,0);assert.equal(x.calls.toasts.length,0);
});
test('a failed jump offers copying, and only the explicit confirmation copies the matching source',async()=>{
const x=setup();const pending=x.page.onOpenSource(x.event);x.calls.navigate[0].fail({errMsg:'invalid link'});await pending;
assert.equal(x.calls.copy,0);assert.equal(x.calls.modals.length,1);x.calls.modals[0].success({confirm:false});assert.equal(x.calls.copy,0);await x.calls.modals[0].success({confirm:true});assert.equal(x.calls.copy,1);
});
test('legacy cards retain copying and accurate labels',async()=>{
const x=setup();delete x.page._notes[0].sourceNavigation;await x.page.onCopy(x.event);assert.equal(x.calls.navigate.length,0);assert.equal(x.calls.copy,1);
const {card}=require('../miniprogram/lib/view');const n={noteId:id,sourceNavigation:{noteId:id,shortLink:link}};
assert.equal(card(n,'week','likes',false).sourceActionLabel,'查看原笔记');assert.equal(card({noteId:id},'week','likes',false).sourceActionLabel,'复制链接');
});
test('a previously visible open action whose navigation was revoked never silently copies',async()=>{
const x=setup();delete x.page._notes[0].sourceNavigation;await x.page.onOpenSource(x.event);assert.equal(x.calls.copy,0);assert.equal(x.calls.modals.length,1);
const gone=setup();gone.page._notes=[];await gone.page.onOpenSource(gone.event);assert.equal(gone.calls.copy,0);assert.equal(gone.calls.navigate.length,0);assert.equal(gone.calls.toasts.length,1);
});
