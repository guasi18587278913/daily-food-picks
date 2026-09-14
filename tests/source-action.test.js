'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {canOpenOriginal,openOriginal}=require('../miniprogram/lib/source');
const id='1'.repeat(24),link='#小程序://小红书/笔记详情/fixtureOnlyLink1',note={noteId:id,sourceNavigation:{noteId:id,shortLink:link}};
test('opening uses the exact official short link and never a constructed path',async()=>{
 let request;const result=await openOriginal(note,o=>{request=o;o.success({errMsg:'ok'})});assert.equal(result,'requested');
 assert.equal(request.shortLink,link);assert.equal(request.path,undefined);assert.equal(request.appId,undefined);
});
test('user cancellation is distinct from failure and neither writes the clipboard',async()=>{
 assert.equal(await openOriginal(note,o=>o.fail({errMsg:'navigateToMiniProgram:fail cancel'})),'cancelled');
 await assert.rejects(()=>openOriginal(note,o=>o.fail({errMsg:'invalid shortLink'})),/SOURCE_OPEN_FAILED/);
 await assert.rejects(()=>openOriginal(note,()=>{throw Error('transport')}),/SOURCE_OPEN_FAILED/);
});
test('missing or incorrectly bound descriptors cannot dispatch a navigation',async()=>{
 let calls=0;const invalid={...note,sourceNavigation:{...note.sourceNavigation,noteId:'2'.repeat(24)}};
 assert.equal(canOpenOriginal(invalid),false);assert.equal(canOpenOriginal({noteId:id}),false);
 await assert.rejects(()=>openOriginal(invalid,()=>calls++),/SOURCE_LINK_UNAVAILABLE/);assert.equal(calls,0);
});
