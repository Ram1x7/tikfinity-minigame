// Private viewer activity. This subtree is never publicly readable through Firebase.
const field=(f,keys,max=80)=>{for(const key of keys){const value=f[key];if(value!==undefined&&value!==null&&String(value).trim())return String(value).replace(/[\x00-\x1f\x7f]/g,'').slice(0,max)}return ''};
const countOf=(raw)=>{const n=Number(raw);return Number.isFinite(n)&&n>0?Math.min(9999,Math.floor(n)):1};
const dateJst=(ms)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
async function viewerKey(value){const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(buf),x=>x.toString(16).padStart(2,'0')).join('')}
export async function saveActivity(db,envName,fields,forcedType='',now=Date.now()){
 const type=forcedType||field(fields,['type'],24).toLowerCase();
 if(!['attendance','like','comment','gift','follow'].includes(type))return {status:'skipped'};
 const rawId=field(fields,['userId','userID','user_id','uniqueId','username'],128);
 const name=field(fields,['nickname','displayName','username','userName'],40)||'視聴者';
 const amount=countOf(field(fields,type==='gift'?['repeatCount','count']:['likeCount','count','likes'],20));
 const rawMessage=field(fields,['comment','commentText','message','text'],250);
 const rawGift=field(fields,['giftName','gift_name'],70);
 const msgId=field(fields,['msgId','eventId','messageId'],128);
 const base='envs/'+envName+'/overlay/private';
 if(msgId && /^[\w-]{1,128}$/.test(msgId)){
  const path=base+'/dedupe/'+type+'_'+msgId;
  const {value,etag}=await db.getWithEtag(path);
  if(value && now-Number(value)<86400000)return {status:'duplicate'};
  if(!await db.putIfMatch(path,now,etag))return {status:'duplicate'};
 }
 const uid=rawId?await viewerKey(rawId):'';
 const event={type,name,amount,at:now};
 if(type==='comment')event.message=rawMessage;
 if(type==='gift')event.gift=rawGift||'ギフト';
 await db.post(base+'/recent',event);
 if(uid && (type==='attendance'||type==='like')){
  const path=base+'/users/'+uid;
  for(let attempt=0;attempt<6;attempt++){
   const {value,etag}=await db.getWithEtag(path);
   const prev=value&&typeof value==='object'?value:{};
   const days={...(prev.days||{})};
   if(type==='attendance')days[dateJst(now)]=true;
   const recentDays=Object.fromEntries(Object.entries(days).filter(([day])=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&day>=dateJst(now-366*86400000)).slice(-366));
   const updated={name:name==='視聴者'?(prev.name||name):name,likes:(Number(prev.likes)||0)+(type==='like'?amount:0),days:recentDays,updatedAt:now};
   if(await db.putIfMatch(path,updated,etag))break;
   if(attempt===5)throw new Error('Activity concurrent update failed');
  }
 }
 return {status:'saved',identified:Boolean(uid)};
}
export async function getActivity(db,envName){
 const base='envs/'+envName+'/overlay/private';
 const [people,events]=await Promise.all([db.get(base+'/users'),db.get(base+'/recent',{limitToLast:'70'})]);
 const users=Object.entries(people||{}).map(([id,x])=>({id,name:String(x.name||'視聴者').slice(0,40),likes:Number(x.likes)||0,days:Object.keys(x.days||{}).sort()})).sort((a,b)=>b.likes-a.likes).slice(0,100);
 const recent=Object.entries(events||{}).map(([id,x])=>({id,type:x.type,name:String(x.name||'視聴者').slice(0,40),amount:Number(x.amount)||1,at:Number(x.at)||0,message:String(x.message||'').slice(0,250),gift:String(x.gift||'').slice(0,70)})).sort((a,b)=>b.at-a.at);
 return {users,recent};
}
