const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');

function makeWorker(nowRef){
  const db=new DatabaseSync(':memory:');
  db.exec(fs.readFileSync('worker/schema.sql','utf8'));
  const DB={prepare(sql){let values=[];return {bind(...v){values=v;return this;},first(){return db.prepare(sql).get(...values)||null;},all(){return {results:db.prepare(sql).all(...values)};},run(){return db.prepare(sql).run(...values);}};}};
  class VirtualDate extends Date {static now(){return nowRef.value;}}
  const mod={exports:{}};
  let source=fs.readFileSync('worker/src/index.js','utf8').replace('export default {','module.exports = {');
  vm.runInNewContext(source,{module:mod,exports:mod.exports,URL,Request,Response,Headers,TextEncoder,TextDecoder,Uint8Array,Map,Set,Math,Number,String,Array,Object,JSON,RegExp,Error,Date:VirtualDate,Intl,crypto:crypto.webcrypto,btoa,console:{error(){}},setTimeout,clearTimeout});
  return {fetch:(path,method='GET',body)=>mod.exports.fetch(new Request(`https://worker.test${path}`,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}),{DB}),db};
}

test('D1 v2 migration keeps existing membership and adds safe empty dated state',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE members(room TEXT NOT NULL,user_id TEXT NOT NULL,name TEXT NOT NULL,secret_hash TEXT NOT NULL,today_seconds INTEGER NOT NULL DEFAULT 0,week_seconds INTEGER NOT NULL DEFAULT 0,streak INTEGER NOT NULL DEFAULT 0,level INTEGER NOT NULL DEFAULT 1,total_seconds INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL,PRIMARY KEY(room,user_id)); INSERT INTO members(room,user_id,name,secret_hash,today_seconds,week_seconds,last_seen) VALUES('ABC234','legacy','Old','hash',60,300,1);`);
  db.exec(fs.readFileSync('worker/migrate-v2.sql','utf8'));
  const row=db.prepare('SELECT * FROM members WHERE user_id=?').get('legacy');
  assert.equal(row.today_seconds,60);assert.equal(row.daily_json,'[]');assert.equal(row.cap_today,0);assert.equal(row.time_zone,'UTC');
  db.close();
});

test('Cloudflare Worker D1 protocol matches mock date and physics rules',async()=>{
  const today='2026-11-15';const yesterday='2026-11-14';const clock={value:Date.parse(`${today}T06:30:00Z`)};const worker=makeWorker(clock);
  const stats=(n,buckets)=>({todaySeconds:n,weekSeconds:n,streak:1,level:2,totalSeconds:9000,todayDate:today,timeZone:'Asia/Kolkata',dailySeconds:buckets});
  const created=await (await worker.fetch('/api/guilds','POST',{userId:'creator',name:'Creator',stats:stats(120,[{date:today,seconds:120}])})).json();
  assert.equal(created.members[0].todaySeconds,120);
  for(const secs of [600,600]){clock.value+=secs*1000;await worker.fetch(`/api/guilds/${created.code}/members`,'POST',{userId:'creator',secret:created.secret,name:'Creator',stats:stats(120,[{date:today,seconds:120}])});}
  clock.value+=300000;
  const batched=await (await worker.fetch(`/api/guilds/${created.code}/members`,'POST',{userId:'creator',secret:created.secret,name:'Creator',stats:stats(1620,[{date:today,seconds:1620}])})).json();
  assert.equal(batched.members[0].todaySeconds,1620);

  const joined=await (await worker.fetch(`/api/guilds/${created.code}/members`,'POST',{userId:'guest',name:'Guest',stats:stats(30,[{date:today,seconds:30}])})).json();
  clock.value+=1000;
  const abused=await (await worker.fetch(`/api/guilds/${created.code}/members`,'POST',{userId:'guest',secret:joined.secret,name:'Guest',stats:stats(3000,[{date:yesterday,seconds:86400},{date:today,seconds:3000},{date:today,seconds:2000}])})).json();
  const guest=abused.members.find(m=>m.userId==='guest');
  assert.ok(guest.weekSeconds<86400);
  assert.ok(guest.todaySeconds<3000);

  const offline=await (await worker.fetch('/api/guilds','POST',{userId:'offline',name:'Offline',stats:stats(0,[{date:yesterday,seconds:500}])})).json();
  assert.equal(offline.members[0].todaySeconds,0);
  assert.equal(offline.members[0].weekSeconds,500);
  clock.value+=86400000;
  const tomorrow=await (await worker.fetch(`/api/guilds/${offline.code}`)).json();
  assert.equal(tomorrow.members[0].todaySeconds,0);

  const bad=await worker.fetch('/api/guilds','POST','null');assert.equal(bad.status,400);
  const huge=await worker.fetch('/api/guilds','POST','x'.repeat(70_000));assert.equal(huge.status,400);
  const leave=await worker.fetch(`/api/guilds/${created.code}/leave`,'POST',{userId:'guest',secret:joined.secret});assert.equal(leave.status,200);
  const rejoin=await (await worker.fetch(`/api/guilds/${created.code}/members`,'POST',{userId:'guest',name:'Guest',stats:stats(8,[{date:today,seconds:8}])})).json();
  assert.ok(rejoin.secret&&rejoin.secret!==joined.secret);
  const recovered=await worker.fetch(`/api/guilds/${created.code}/members`,'POST',{userId:'guest',secret:rejoin.secret,name:'Guest',stats:stats(8,[{date:today,seconds:8}])});assert.equal(recovered.status,200);
  clock.value+=31*86400000;assert.equal((await worker.fetch(`/api/guilds/${created.code}`)).status,404);
  worker.db.close();
});
