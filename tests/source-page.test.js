'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const id='1'.repeat(24),link='#小程序://小红书/笔记详情/fixtureOnlyLink1';
function setup(){let definition;const calls={navigate:[],copy:0,modals:[],toasts:[]};global.wx={cloud:{callFunction:async()=>({})},navigateToMiniProgram:o=>calls.navigate.push(o),setClipboardData:()=>calls.copy++,showModal:o=>calls.modals.push(o),showToast:o=>calls.toasts.push(o)};global.Page=d=>definition=d;
const p=require.resolve('../miniprogram/pages/index/index');delete require.cache[p];require(p);delete global.Page;
const page={...definition,_notes:[{noteId:id,sourceNavigation:{noteId:id,shortLink:link}}],setData(){}};
return{page,calls,event:{currentTarget:{dataset:{id}}}};}
test('rapid repeat taps request one navigation and cancellation performs no copy or error modal',async()=>{
const x=setup();const first=x.page.onOpenSource(x.event);await x.page.onOpenSource(x.event);assert.equal(x.calls.navigate.length,1);
x.calls.navigate[0].fail({errMsg:'navigateToMiniProgram:fail cancel'});await first;assert.equal(x.calls.copy,0);assert.equal(x.calls.modals.length,0);assert.equal(x.calls.toasts.length,0);
});
test('a failed jump only reports unavailability and never offers or performs copying',async()=>{
const x=setup();const pending=x.page.onOpenSource(x.event);x.calls.navigate[0].fail({errMsg:'invalid link'});await pending;
assert.equal(x.calls.copy,0);assert.equal(x.calls.modals.length,0);assert.equal(x.calls.toasts.length,1);assert.equal(x.page.onCopy,undefined);
});
test('legacy cards expose an unavailable status rather than a copy action',()=>{
const {card}=require('../miniprogram/lib/view');const n={noteId:id,sourceNavigation:{noteId:id,shortLink:link}};
assert.equal(card(n,'week','likes',false).sourceActionLabel,'查看原笔记');assert.equal(card({noteId:id},'week','likes',false).sourceActionLabel,'原文暂不可直达');
});
test('revoked navigation and removed notes never fall back to the clipboard',async()=>{
const x=setup();delete x.page._notes[0].sourceNavigation;await x.page.onOpenSource(x.event);assert.equal(x.calls.copy,0);assert.equal(x.calls.modals.length,0);assert.equal(x.calls.toasts.length,1);
const gone=setup();gone.page._notes=[];await gone.page.onOpenSource(gone.event);assert.equal(gone.calls.copy,0);assert.equal(gone.calls.navigate.length,0);assert.equal(gone.calls.toasts.length,1);
});
