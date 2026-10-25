// ブラウザに保存する日次ギフト集計。FirebaseやDOMに依存しない。
export function jstDate(ms) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
}
export function emptyStats(day=jstDate(Date.now()),cursor=null) {
  return {day,cursor,events:0,gifts:0,rank:Object.create(null),updatedAt:0};
}
export function applyGift(stats,key,item,now=Date.now()) {
  if (!item || typeof item!=='object' || Array.isArray(item)) return {stats,changed:false};
  if (key && stats.cursor && key<=stats.cursor) return {stats,changed:false};
  const day=jstDate(now);
  const base=stats.day===day?stats:emptyStats(day,stats.cursor);
  const received=Number(item.receivedAt);
  const eventDay=Number.isFinite(received)&&received>0?jstDate(received):day;
  const cursor=key||base.cursor;
  if (eventDay!==day) return {stats:{...base,cursor},changed:false};
  const sender=String(item.sender||'視聴者').slice(0,40);
  const raw=Number(item.repeatCount);
  const quantity=Number.isFinite(raw)&&raw>0?Math.min(9999,Math.max(1,Math.floor(raw))):1;
  const rank=Object.assign(Object.create(null),base.rank);
  rank[sender]=(Number(rank[sender])||0)+quantity;
  return {stats:{...base,cursor,events:base.events+1,gifts:base.gifts+quantity,rank,updatedAt:now},changed:true,sender,name:String(item.giftName||'ギフト').slice(0,70),quantity};
}
