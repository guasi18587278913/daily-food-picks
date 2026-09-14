'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const id='1'.repeat(24),link='#小程序://小红书/笔记详情/fixtureOnlyLink1';
function setup(){let definition;const calls={navigate:[],copy:0,toasts:[]};global.wx={cloud:{callFunction:async()=>({})},navigateToMiniProgram:o=>calls.navigate.push(o),setClipboardData:()=>calls.copy++,showToast:o=>calls.toasts.push(o)};global.Page=d=>definition=d;
 const p=require.resolve('../miniprogram/pages/detail/detail');delete require.cache[p];require(p);delete global.Page;
 const page={...definition,data:{...structuredClone(definition.data),note:{noteId:id,sourceNavigation:{noteId:id,shortLink:link}}},setData(patch){Object.assign(this.data,patch);}};return{page,calls};}
test('rapid repeat taps in detail request one original navigation and cancellation performs no copy or error',async()=>{
 const x=setup();const first=x.page.onOpenOriginal();await x.page.onOpenOriginal();assert.equal(x.calls.navigate.length,1);
 x.calls.navigate[0].fail({errMsg:'navigateToMiniProgram:fail cancel'});await first;assert.equal(x.calls.copy,0);assert.equal(x.calls.toasts.length,0);assert.equal(x.page.data.openingOriginal,false);
});
test('failed original navigation preserves readable detail and never copies a link',async()=>{
 const x=setup();const pending=x.page.onOpenOriginal();x.calls.navigate[0].fail({errMsg:'invalid link'});await pending;
 assert.equal(x.calls.copy,0);assert.equal(x.calls.toasts.length,1);assert.equal(x.page.data.note.noteId,id);
});
test('all cards provide content viewing while reliable external links remain distinguishable',()=>{
 const {card}=require('../miniprogram/lib/view');const n={noteId:id,sourceNavigation:{noteId:id,shortLink:link}};
 assert.equal(card(n,'week','likes',false).sourceActionLabel,'查看内容');assert.equal(card({noteId:id},'week','likes',false).sourceActionLabel,'查看内容');
 assert.equal(card(n,'week','likes',false).canOpenSource,true);assert.equal(card({noteId:id},'week','likes',false).canOpenSource,false);
});
test('missing or revoked originals cannot navigate or write the clipboard',async()=>{
 const x=setup();delete x.page.data.note.sourceNavigation;await x.page.onOpenOriginal();assert.equal(x.calls.copy,0);assert.equal(x.calls.navigate.length,0);
 x.page.data.note=null;await x.page.onOpenOriginal();assert.equal(x.calls.copy,0);assert.equal(x.calls.navigate.length,0);
});
