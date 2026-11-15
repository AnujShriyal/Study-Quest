const {test}=require('node:test');
const assert=require('node:assert/strict');
const sync=require('../sync.js');

test('sync retains offline revocation, retries before rejoin, adopts rotated secrets and broadcasts no credentials',async()=>{
  const data={settings:{guild:{baseUrl:'http://127.0.0.1:9999',enabled:false,userId:'test-user',roomCode:null,memberSecret:null,snapshot:[]}}};
  const events=[];let failWrites=false;let offline=false;let durable=structuredClone(data);const requestSecrets=[];
  const okMember={userId:'test-user',name:'Tester',todaySeconds:0,weekSeconds:0,streak:0,level:1,totalSeconds:0,lastSeen:Date.now(),todayDate:'2026-11-15',timeZone:'UTC'};
  global.fetch=async(url,options={})=>{
    if(offline)throw new Error('offline');
    const path=new URL(url).pathname;
    let value={};
    if(path==='/api/guilds'&&options.method==='POST')value={code:'ABC234',secret:'initial-secret',members:[okMember]};
    else if(path.endsWith('/leave'))value={ok:true};
    else if(path.endsWith('/members')&&options.method==='POST'){
      const request=JSON.parse(options.body);
      if(request.secret)requestSecrets.push(request.secret);
      value=request.secret?{secret:'rotated-secret',members:[okMember]}:{secret:'joined-secret',members:[okMember]};
    } else value={members:[okMember]};
    return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
  };
  sync.initSync({getData:()=>data,saveData:()=>{if(failWrites){Object.assign(data,structuredClone(durable));return {ok:false,error:'disk'};}durable=structuredClone(data);return {ok:true};},computeStats:()=>({todaySeconds:0,weekSeconds:0,streak:{current:0},level:1,totalSeconds:0,todayDate:'2026-11-15',timeZone:'UTC',dailySeconds:[]}),sendToAll:(...args)=>events.push(args),uid:()=>Math.random().toString(36).slice(2)});
  const created=await sync.createGuild({displayName:'Tester'});assert.equal(created.ok,true);
  offline=true;
  const leave=await sync.leaveGuild();assert.deepEqual(leave,{ok:true,pendingLeave:true});
  assert.ok(data.settings.guild.pendingLeave.secret);
  const trapped=await sync.joinGuild({code:'DEF345',displayName:'Tester'});assert.equal(trapped.ok,false);
  assert.ok(data.settings.guild.pendingLeave,'failed leave stays retryable');
  offline=false;
  const joined=await sync.joinGuild({code:'DEF345',displayName:'Tester'});assert.equal(joined.ok,true);
  assert.equal(data.settings.guild.pendingLeave,null);
  assert.equal(data.settings.guild.memberSecret,'joined-secret');
  failWrites=true;
  const syncResult=await sync.syncNow('test');
  assert.equal(syncResult.ok,false,'failed durable write is not reported as success');
  assert.equal(data.settings.guild.memberSecret,'joined-secret','main-style nested rollback restores the durable credential');
  assert.ok(!JSON.stringify(events).includes('rotated-secret'));
  assert.ok(!JSON.stringify(events).includes('joined-secret'));
  failWrites=false;
  const recovered=await sync.syncNow('recovery');
  assert.equal(recovered.ok,true);
  assert.equal(requestSecrets.at(-1),'rotated-secret','volatile rotated credential authenticates after storage recovers');
  assert.equal(data.settings.guild.memberSecret,'rotated-secret');
});

test('sync rejects insecure non-loopback servers and spectator lookup does not change membership URL',async()=>{
  const data={settings:{guild:{baseUrl:'http://example.com',enabled:false,snapshot:[]}}};
  sync.initSync({getData:()=>data,saveData:()=>({ok:true}),computeStats:()=>({}),sendToAll:()=>{},uid:()=> 'id'});
  const result=await sync.createGuild({displayName:'Test'});assert.equal(result.ok,false);
  data.settings.guild.baseUrl='https://safe.example';
  global.fetch=async()=>new Response(JSON.stringify({members:[]}),{status:200});
  const viewed=await sync.viewGuild({code:'ABC234',baseUrl:'http://127.0.0.1:8787'});assert.equal(viewed.ok,true);
  assert.equal(data.settings.guild.baseUrl,'https://safe.example');
});

test('failed nested rollback keeps leave credential private until storage and network recover',async()=>{
  const data={settings:{guild:{baseUrl:'http://127.0.0.1:9998',enabled:false,userId:'leave-user',roomCode:null,memberSecret:null,snapshot:[]}}};
  let durable=structuredClone(data),failWrites=false,offline=false;const events=[];let revoked=false;
  global.fetch=async(url,options={})=>{
    if(offline)throw new Error('offline');
    const path=new URL(url).pathname;
    if(path.endsWith('/leave')){revoked=true;return new Response('{"ok":true}',{status:200});}
    const payload=path==='/api/guilds'?{code:'GHI456',secret:'volatile-secret',members:[]}:{secret:'new-secret',members:[]};
    return new Response(JSON.stringify(payload),{status:200});
  };
  sync.initSync({getData:()=>data,saveData:()=>{if(failWrites){Object.assign(data,structuredClone(durable));return {ok:false,error:'disk'};}durable=structuredClone(data);return {ok:true};},computeStats:()=>({todaySeconds:0,weekSeconds:0,streak:{current:0},level:1,totalSeconds:0,dailySeconds:[]}),sendToAll:(...args)=>events.push(args),uid:()=> 'stable-id'});
  assert.equal((await sync.createGuild({displayName:'Tester'})).ok,true);
  failWrites=true;offline=true;
  const left=await sync.leaveGuild();assert.equal(left.pendingLeave,true);assert.equal(left.ok,false);
  assert.equal(data.settings.guild.memberSecret,'volatile-secret','rollback restores durable guild but secret is held by sync recovery state');
  assert.ok(!JSON.stringify(events).includes('volatile-secret'));
  failWrites=false;offline=false;
  const joined=await sync.joinGuild({code:'JKL567',displayName:'Tester'});
  assert.equal(joined.ok,true);assert.equal(revoked,true,'leave is retried before a new join request');
  assert.equal(data.settings.guild.memberSecret,'new-secret');
});
