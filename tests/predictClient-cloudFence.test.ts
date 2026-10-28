import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

let mode='normal';let posts=0;let first=true;let challenges=0;const events:string[]=[];
const token=`e30.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.synthetic`;
axios.defaults.adapter=async(config:any)=>{
  const ok=(data:any)=>({data,status:200,statusText:'OK',headers:{},config});
  if(config.url==='/auth/message'){challenges++;return ok({success:true,data:{message:'synthetic challenge'}});}
  if(config.url==='/auth')return ok({success:true,data:{token}});
  if(config.url==='/orders'){
    posts++;events.push('post');
    if(mode==='retry'&&first){first=false;throw {response:{status:401,data:{message:'synthetic token rejection'}}};}
    return ok({success:true,data:{orderId:'synthetic-order'}});
  }
  throw new Error('Unexpected mock request');
};
const client=await import('../server/predictClient');
const key='0x'+'02'.repeat(32);
const epoch=Math.floor(Date.now()/300000)*300;
const market={id:1,categorySlug:`btc-updown-5m-${epoch}`,tradingStatus:'OPEN',decimalPrecision:3,feeRateBps:200,isNegRisk:false,isYieldBearing:false,outcomes:[{name:'Up',onChainId:'1'}]};
const place=(fence:()=>Promise<void>)=>client.placePredictOrder('BULL',.5,key,'','synthetic-api',.5,epoch,'BUY',market,market.outcomes[0],fence);
test('lease guard runs after signing and blocks every POST when ownership is lost',async()=>{
  const before=posts;let fences=0;
  await assert.rejects(place(async()=>{fences++;throw new Error('synthetic lost lease');}),/lost lease/);
  assert.equal(fences,1);assert.equal(posts,before);
});
test('authentication retry must pass the execution fence again immediately before writing',async()=>{
  mode='retry';first=true;events.length=0;
  await place(async()=>{events.push('fence');});
  assert.deepEqual(events,['fence','post','fence','post']);mode='normal';
});
test('readiness authentication invalidation requires a new signed challenge',async()=>{
  const builder=await client.getOrderBuilder(key,'');
  await client.getJwtToken(builder,'','synthetic-api');const before=challenges;
  await client.getJwtToken(builder,'','synthetic-api');assert.equal(challenges,before);
  client.invalidatePredictAuth(builder,'','synthetic-api');
  await client.getJwtToken(builder,'','synthetic-api');assert.equal(challenges,before+1);
});
