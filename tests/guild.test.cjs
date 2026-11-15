const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');

let server;
let base;
let fakeNow;
const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const yesterday = new Date(`${today}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate()-1);
const yesterdayDate = yesterday.toISOString().slice(0,10);
const stats = (todaySeconds, dailySeconds) => ({todaySeconds,weekSeconds:todaySeconds,streak:1,level:2,totalSeconds:9000,todayDate:today,timeZone:'Asia/Kolkata',dailySeconds});
const post = async (path, value) => fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
const json = async (response) => response.json();
const setClock = (ms) => new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('mock clock did not acknowledge')),1000);
  const handler=(m)=>{if(m&&m.clockSet&&m.now===ms){clearTimeout(timer);server.off('message',handler);resolve();}};
  server.on('message',handler);server.send({now:ms});
});

before(async () => {
  const probe=net.createServer();
  await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port; await new Promise(r=>probe.close(r));
  base=`http://127.0.0.1:${port}`;
  fakeNow=Date.parse(`${today}T06:30:00.000Z`);
  server=spawn(process.execPath,['worker/mock-server.js'],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,STUDY_QUEST_PORT:String(port)}});
  await setClock(fakeNow);
  for(let i=0;i<80;i++){try{if((await fetch(base+'/')).status===404)return;}catch{} await new Promise(r=>setTimeout(r,50));}
  throw new Error('isolated mock guild server did not start');
});
after(() => { if (server) server.kill(); });

test('mock guild protocol: creator baseline, rolling local days, caps, leave and malformed JSON', async () => {
  const create = await json(await post('/api/guilds',{userId:'creator-test',name:'Creator',stats:stats(120,[{date:today,seconds:120}])}));
  assert.match(create.code,/^[A-Z0-9]{6}$/);
  assert.equal(create.members[0].todaySeconds,120);
  assert.equal(create.members[0].todayDate,today);

  for (const advance of [600,600]) {
    fakeNow+=advance*1000; await setClock(fakeNow);
    await post(`/api/guilds/${create.code}/members`,{userId:'creator-test',secret:create.secret,name:'Creator',stats:stats(120,[{date:today,seconds:120}])});
  }
  fakeNow+=300*1000; await setClock(fakeNow);
  const savedBatch=await json(await post(`/api/guilds/${create.code}/members`,{userId:'creator-test',secret:create.secret,name:'Creator',stats:stats(1620,[{date:today,seconds:1620}])}));
  assert.equal(savedBatch.members.find(m=>m.userId==='creator-test').todaySeconds,1620,'unused wall-clock budget accumulates across unchanged syncs');
  const join = await json(await post(`/api/guilds/${create.code}/members`,{userId:'join-test',name:'Joiner',stats:stats(70,[{date:today,seconds:70}])}));
  assert.ok(join.secret);
  assert.equal(join.members.find(m=>m.userId==='join-test').todaySeconds,70);

  const abuse = await json(await post(`/api/guilds/${create.code}/members`,{userId:'join-test',secret:join.secret,name:'Joiner',stats:stats(2000,[{date:yesterdayDate,seconds:86400},{date:today,seconds:2000},{date:today,seconds:3000}])}));
  const member = abuse.members.find(m=>m.userId==='join-test');
  assert.ok(member.weekSeconds < 86400, 'prior-day injection stays within elapsed-time budget');
  assert.ok(member.todaySeconds < 2000, 'immediate claim is capped');
  assert.deepEqual(Object.keys(member).sort(),['lastSeen','level','name','streak','timeZone','todayDate','todaySeconds','totalSeconds','userId','weekSeconds'].sort());

  const bad = await fetch(`${base}/api/guilds`,{method:'POST',headers:{'content-type':'application/json'},body:'null'});
  assert.equal(bad.status,400);
  const malformed = await fetch(`${base}/api/guilds`,{method:'POST',headers:{'content-type':'application/json'},body:'{' });
  assert.equal(malformed.status,400);
  const tooLarge=await fetch(`${base}/api/guilds`,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(70_000)});
  assert.equal(tooLarge.status,400);
  const leave=await json(await post(`/api/guilds/${create.code}/leave`,{userId:'join-test',secret:join.secret}));
  assert.equal(leave.ok,true);
  const rejoin=await json(await post(`/api/guilds/${create.code}/members`,{userId:'join-test',name:'Joiner',stats:stats(12,[{date:today,seconds:12}])}));
  assert.ok(rejoin.secret && rejoin.secret!==join.secret,'rejoin receives a fresh usable member credential');
  const recovered=await post(`/api/guilds/${create.code}/members`,{userId:'join-test',secret:rejoin.secret,name:'Joiner',stats:stats(12,[{date:today,seconds:12}])});
  assert.equal(recovered.status,200);

  const offline=await json(await post('/api/guilds',{userId:'offline-test',name:'Offline',stats:stats(0,[{date:yesterdayDate,seconds:500}])}));
  assert.equal(offline.members[0].todaySeconds,0,'old offline bucket does not rank as Today');
  assert.equal(offline.members[0].weekSeconds,500);
});

test('packaging includes sync runtime but excludes test sources', () => {
  const pkg=require('../package.json');
  assert.ok(pkg.build.files.includes('sync.js'));
  assert.ok(pkg.build.files.some(x=>x.startsWith('lib/')));
  assert.ok(!pkg.build.files.some(x=>x.includes('tests')));
});
