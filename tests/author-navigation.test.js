'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {authorTarget,validAuthorNavigation,authorNavigationFor}=require('../shared/author-navigation');
const {navigationFromShareLink,ensureAuthorProfile,saveAuthorProfile}=require('../cloudfunctions/collectTick/lib/author-profiles');
const {canOpenAuthor,openAuthor}=require('../miniprogram/lib/author-source');
const {MemoryStore}=require('./helpers');
const id='a'.repeat(24),other='b'.repeat(24),now=Date.parse('2026-09-15T09:30:00+08:00');
const nav={authorId:id,token:'sample+/=?token',source:'app_share'};
const record={recordType:'author_navigation',authorId:id,capturedAt:now,navigation:nav};
test('author route preserves same-author share token and never falls back to a bare identifier',()=>{
 const u=new URL('https://www.xiaohongshu.com/user/profile/'+id);u.searchParams.set('xsec_token',nav.token);u.searchParams.set('xsec_source',nav.source);
 assert.deepEqual(navigationFromShareLink(u.href,id),nav);
 const target=authorTarget(nav,id);assert.equal(target.appId,'wxb296433268a1c654');assert.ok(target.path.startsWith('pages/secondary/author/index?author_id='+id));
 const q=new URL('https://local/'+target.path).searchParams;assert.equal(q.get('xsec_token'),nav.token);assert.equal(q.get('xsec_source'),'app_share');
 assert.equal(authorTarget(null,id),null);assert.equal(authorTarget({...nav,token:''},id),null);assert.equal(authorTarget(nav,other),null);
});
test('wrong author, deceptive domain, duplicate token and untrusted parameter sources are rejected',()=>{
 for(const u of ['https://www.xiaohongshu.com/user/profile/'+other+'?xsec_token=t&xsec_source=app_share','https://www.xiaohongshu.com.evil/user/profile/'+id+'?xsec_token=t&xsec_source=app_share','https://www.xiaohongshu.com/user/profile/'+id+'?xsec_token=t&xsec_token=u&xsec_source=app_share'])assert.equal(navigationFromShareLink(u,id),null);
 assert.equal(validAuthorNavigation({...nav,source:'unknown'},id),false);assert.equal(validAuthorNavigation({...nav,token:'a\nb'},id),false);assert.equal(validAuthorNavigation({...nav,extraData:{}},id),false);
 assert.equal(authorNavigationFor({...record,authorId:other},id,now),null);assert.equal(authorNavigationFor({...record,capturedAt:now+1},id,now),null);
});
test('click opens the matching author and cancellation never reports success or copies anything',async()=>{
 assert.equal(canOpenAuthor({authorId:id,authorNavigation:nav}),true);let sent;
 assert.equal(await openAuthor({authorId:id,authorNavigation:nav},x=>{sent=x;x.success();}),'requested');assert.equal(sent.path,authorTarget(nav,id).path);
 assert.equal(await openAuthor({authorId:id,authorNavigation:nav},x=>x.fail({errMsg:'navigateToMiniProgram:fail cancel'})),'cancelled');
 await assert.rejects(openAuthor({authorId:other,authorNavigation:nav},()=>assert.fail('wrong-author navigation')),/AUTHOR_LINK_UNAVAILABLE/);
 await assert.rejects(openAuthor({authorId:id,authorNavigation:nav},x=>x.fail({errMsg:'denied'})),/AUTHOR_OPEN_FAILED/);
});
test('fresh author profile is reused and non-selected candidates never spend requests',async()=>{
 const store=new MemoryStore();await store.put('dfp_results','author_profile_'+id,record);let calls=0;
 const args={store,lease:{},provider:{request:async()=>{calls++;}},clock:()=>now,note:{authorId:id,boards:['today']}};
 assert.deepEqual(await ensureAuthorProfile(args),{status:'cached'});assert.equal(calls,0);
 assert.deepEqual(await ensureAuthorProfile({...args,note:{authorId:other,boards:[]}}),{status:'not_selected'});assert.equal(calls,0);
});
test('missing share information stays missing and a failed lookup does not erase the old profile',async()=>{
 const store=new MemoryStore();await store.put('dfp_results','author_profile_'+id,{...record,capturedAt:now-86400001});
 const args={store,lease:{},provider:{request:async()=>({fans:100})},clock:()=>now,note:{authorId:id,boards:['week']}};
 assert.deepEqual(await ensureAuthorProfile(args),{status:'missing',fans:100});assert.deepEqual((await store.get('dfp_results','author_profile_'+id)).navigation,nav);
 await assert.rejects(ensureAuthorProfile({...args,provider:{request:async()=>{throw Object.assign(Error('limit'),{code:'ROUND_BUDGET'});}}}),/limit/);
});
