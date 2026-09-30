import { authorizeAdmin, requireAdminMutation, csrfSession, AdminDenied, type AdminConfig } from "./admin-auth";
import { publicGroups, listGroups, previewSchedule, commitSchedule, patchGroup } from "./groups";
import { createBooking, findBookingReplay, bookingAction, listBookings, getBooking } from "./bookings";
import { type ScheduleCommand, type CreateBookingInput, type GroupPatch, type BookingActionInput } from "./booking-types";
import { DomainError } from "./booking-commands";
import { listNotifications, notificationAction } from "./outbox";

export interface BookingAPIEnv extends AdminConfig {
 DB: D1Database; BOOKING_ENABLED?: string; BOOKING_ALLOWED_ORIGINS?: string; TURNSTILE_SECRET?: string; ASSETS?: Fetcher;
}
const MAX_BODY=16384;
const MUTATIONS=new Set(["POST","PATCH","PUT","DELETE"]);
function wire(value:unknown):unknown {
 if(Array.isArray(value))return value.map(wire);
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k.replace(/[A-Z]/g,c=>`_${c.toLowerCase()}`),wire(v)]));
 return value;
}
function internal(value:Record<string,unknown>):Record<string,unknown>{return Object.fromEntries(Object.entries(value).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));}
function receipt(value:{reference:string;status:string;contactMethod:string}){return {reference:value.reference,status:value.status,message:"Заявка принята. Ожидает подтверждения администратора",contact_method:value.contactMethod};}
function json(body:unknown,status=200,headers?:HeadersInit){return new Response(JSON.stringify(wire(body)),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...Object.fromEntries(new Headers(headers))}});}
async function body(request:Request):Promise<Record<string,unknown>>{
 if(!request.headers.get("Content-Type")?.startsWith("application/json"))throw new DomainError("invalid_content_type",400);
 if(Number(request.headers.get("Content-Length")??0)>MAX_BODY)throw new DomainError("body_too_large",413);
 const reader=request.body?.getReader();if(!reader)throw new DomainError("invalid_body",400);
 let size=0;const chunks:Uint8Array[]=[];
 for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>MAX_BODY){await reader.cancel();throw new DomainError("body_too_large",413);}chunks.push(next.value);}
 const all=new Uint8Array(size);let off=0;for(const part of chunks){all.set(part,off);off+=part.length;}
 try{const value=JSON.parse(new TextDecoder().decode(all));if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();return value;}catch{throw new DomainError("invalid_body",400);}
}
function only(value:Record<string,unknown>,keys:string[]){if(Object.keys(value).some(k=>!keys.includes(k)))throw new DomainError("invalid_fields",400);}
function key(request:Request){const v=request.headers.get("Idempotency-Key")??"";if(!/^[a-zA-Z0-9:_-]{22,128}$/.test(v))throw new DomainError("invalid_idempotency_key",400);return v;}
function enabled(env:BookingAPIEnv){if(env.BOOKING_ENABLED!=="true"||!env.BOOKING_SECRET||env.BOOKING_SECRET.length<32)throw new DomainError("booking_unconfigured",503);}
function origins(env:BookingAPIEnv){return (env.BOOKING_ALLOWED_ORIGINS??"").split(",").map(x=>x.trim()).filter(Boolean);}
function cors(request:Request,env:BookingAPIEnv):Record<string,string>{const origin=request.headers.get("Origin");return origin&&origins(env).includes(origin)?{"Access-Control-Allow-Origin":origin,"Vary":"Origin"}:{};}
async function rateLimit(request:Request,env:BookingAPIEnv){
 const ip=request.headers.get("CF-Connecting-IP")??"unknown";
 const hkey=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.BOOKING_SECRET!),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const hash=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",hkey,new TextEncoder().encode(ip))),b=>b.toString(16).padStart(2,"0")).join("");
 const minute=Math.floor(Date.now()/60000);const expires=new Date((minute+2)*60000).toISOString();
 try{await env.DB.batch([...[{id:`${minute}:${hash}`,max:6},{id:`${minute}:global`,max:120}].map(b=>env.DB.prepare("INSERT INTO booking_rate_limits(bucket,count,max_count,expires_at) VALUES(?,1,?,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1").bind(b.id,b.max,expires)),env.DB.prepare("DELETE FROM booking_rate_limits WHERE expires_at < ?").bind(new Date().toISOString())]);}
 catch(e){if(String(e).includes("CHECK constraint failed"))throw new DomainError("rate_limited",429);throw e;}
}
export async function verifyTurnstile(request:Request,env:BookingAPIEnv,token:string){
 if(!env.TURNSTILE_SECRET)throw new DomainError("booking_unconfigured",503);
 const data=new URLSearchParams({secret:env.TURNSTILE_SECRET,response:token});
 const ip=request.headers.get("CF-Connecting-IP");if(ip)data.set("remoteip",ip);
 let result:{success?:boolean;hostname?:string;action?:string};
 try{const response=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{method:"POST",body:data,signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error();result=await response.json();}
 catch{throw new DomainError("captcha_unavailable",503);}
 const hostname=new URL(request.headers.get("Origin")!).hostname;
 if(result.success!==true||result.hostname!==hostname||result.action!=="booking")throw new DomainError("captcha_invalid",400);
}
export interface RouterDependencies {
 authorize:typeof authorizeAdmin; verifyCaptcha:typeof verifyTurnstile;
}
export function createBookingRouter(deps:RouterDependencies={authorize:authorizeAdmin,verifyCaptcha:verifyTurnstile}){
 return async function route(request:Request,env:BookingAPIEnv):Promise<Response|null>{
  const url=new URL(request.url),path=url.pathname;
  const publicRoute=path.startsWith("/api/v1/");
  const adminRoute=path==="/admin"||path.startsWith("/admin/")||path.startsWith("/api/admin/v1/");
  if(!publicRoute&&!adminRoute)return null;
  const c=publicRoute?cors(request,env):{};
  try{
   enabled(env);
   if(publicRoute){
    const origin=request.headers.get("Origin");
    if(origin&&!origins(env).includes(origin))return json({error:"origin_not_allowed"},403);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:{...c,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Idempotency-Key","Access-Control-Max-Age":"600"}});
    if(path==="/api/v1/groups"&&request.method==="GET"){
     if(url.searchParams.get("service_id")&&url.searchParams.get("service_id")!=="theory_group")throw new DomainError("invalid_service",400);
     return json(await publicGroups(env.DB),200,c);
    }
    if(path==="/api/v1/bookings"&&request.method==="POST"){
     if(!origin||!origins(env).includes(origin))throw new DomainError("origin_not_allowed",403);
     const value=await body(request);only(value,["group_id","group_revision","name","phone","consent_version","consent","source","turnstile_token"]);
     if(value.consent!==true||typeof value.turnstile_token!=="string"||value.turnstile_token.length>2048||!value.turnstile_token||!["site_form","site_chat"].includes(String(value.source)))throw new DomainError("invalid_body",400);
     const {turnstile_token,consent,...business}=value;const input=internal(business);const k=key(request);
     const replay=await findBookingReplay(env.DB,input as unknown as CreateBookingInput,k,env.BOOKING_SECRET!);
     if(replay)return json(receipt(replay.result),200,c);
     await rateLimit(request,env);await deps.verifyCaptcha(request,env,turnstile_token);
     const outcome=await createBooking(env.DB,input as unknown as CreateBookingInput,k,env.BOOKING_SECRET!);
     return json(receipt(outcome.result),outcome.replayed?200:201,c);
    }
    return json({error:"not_found"},404,c);
   }
   const actor=await deps.authorize(request,env);
   if(MUTATIONS.has(request.method))await requireAdminMutation(request,actor,env);
   if(path==="/api/admin/v1/session"&&request.method==="GET"){
    const s=await csrfSession(actor,env);return json({actor,csrf_token:s.token},200,{"Set-Cookie":s.cookie});
   }
   if(path==="/admin"||path.startsWith("/admin/")){
    if(request.method!=="GET"||!env.ASSETS)return json({error:"not_found"},404);
    const assetsPath=path==="/admin"||path==="/admin/"?"/index.html":path.slice("/admin".length);
    if(!["/index.html","/admin.js","/admin.css"].includes(assetsPath))return json({error:"not_found"},404);
    const asset=await env.ASSETS.fetch(new Request(new URL(assetsPath,url.origin),{method:"GET"}));
    const headers=new Headers(asset.headers);headers.set("Cache-Control","no-store");headers.set("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");headers.set("X-Content-Type-Options","nosniff");headers.set("Referrer-Policy","no-referrer");
    return new Response(asset.body,{status:asset.status,headers});
   }
   if(path==="/api/admin/v1/groups"&&request.method==="GET")return json(await listGroups(env.DB,{includeHistory:url.searchParams.get("history")==="true",limit:50,cursor:url.searchParams.get("cursor")??undefined}));
   if(path==="/api/admin/v1/bookings"&&request.method==="GET"){
    if(url.searchParams.has("q"))throw new DomainError("use_private_search",400);
    return json(await listBookings(env.DB,{groupId:url.searchParams.get("group_id")??undefined,status:(url.searchParams.get("status")??undefined) as import("./booking-types").BookingStatus|undefined,cursor:url.searchParams.get("cursor")??undefined}));
   }
   // Имя и телефон в URL попали бы в инфраструктурные HTTP-логи.
   if(path==="/api/admin/v1/bookings/search"&&request.method==="POST"){
    const v=await body(request);only(v,["group_id","status","q","cursor"]);
    for(const value of Object.values(v))if(typeof value!=="string")throw new DomainError("invalid_body",400);
    return json(await listBookings(env.DB,{groupId:(v.group_id as string)||undefined,status:((v.status as string)||undefined) as import("./booking-types").BookingStatus|undefined,query:v.q as string|undefined,cursor:(v.cursor as string)||undefined}));
   }
   const bookingDetail=path.match(/^\/api\/admin\/v1\/bookings\/([a-zA-Z0-9-]+)$/);
   if(bookingDetail&&request.method==="GET"){
    const booking=await getBooking(env.DB,bookingDetail[1]);if(!booking)return json({error:"not_found"},404);
    const cursor=url.searchParams.get("cursor");let at:string|null=null,id:string|null=null;
    if(cursor){const parts=cursor.split("|");if(parts.length!==2||!Number.isFinite(Date.parse(parts[0]))||! /^[a-zA-Z0-9-]+$/.test(parts[1]))throw new DomainError("invalid_cursor",400);[at,id]=parts;}
    const rows=await env.DB.prepare(`SELECT id,actor_id,action,created_at FROM audit_events WHERE entity_type='booking' AND entity_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 51`).bind(booking.id,at,at,at,id).all<{id:string;actor_id:string;action:string;created_at:string}>();
    const history=rows.results.slice(0,50),last=history.at(-1);
    return json({booking,history,next_cursor:rows.results.length>50&&last?`${last.created_at}|${last.id}`:null});
   }
   if(path==="/api/admin/v1/schedule/preview"&&request.method==="POST")return json(await previewSchedule(env.DB,internal(await body(request)) as unknown as ScheduleCommand));
   if(path==="/api/admin/v1/schedule/commit"&&request.method==="POST"){
    const value=await body(request);only(value,["normalized_command","expected_revision"]);
    if(!value.normalized_command||typeof value.normalized_command!=="object"||Array.isArray(value.normalized_command))throw new DomainError("invalid_body",400);
    const command=internal({...value.normalized_command,expected_revision:value.expected_revision}) as unknown as ScheduleCommand;
    return json((await commitSchedule(env.DB,command,key(request),actor,env.BOOKING_SECRET!)).result);
   }
   const groupPatch=path.match(/^\/api\/admin\/v1\/groups\/([a-zA-Z0-9-]+)$/);
   if(groupPatch&&request.method==="PATCH"){const v=await body(request);only(v,["expected_revision","expected_schedule_revision","date_status","enrollment_open","capacity"]);return json((await patchGroup(env.DB,groupPatch[1],internal(v) as unknown as GroupPatch,key(request),actor,env.BOOKING_SECRET!)).result);}
   const actions=path.match(/^\/api\/admin\/v1\/bookings\/([a-zA-Z0-9-]+)\/actions$/);
   if(actions&&request.method==="POST"){const v=await body(request);only(v,["action","expected_revision","group_revision","target_group_id","target_group_revision"]);return json((await bookingAction(env.DB,actions[1],internal(v) as unknown as BookingActionInput,key(request),actor,env.BOOKING_SECRET!)).result);}
   if(path==="/api/admin/v1/notifications"&&request.method==="GET")return json(await listNotifications(env.DB,url.searchParams.get("state")??undefined,url.searchParams.get("cursor")??undefined));
   const notification=path.match(/^\/api\/admin\/v1\/notifications\/([a-zA-Z0-9-]+)\/actions$/);
   if(notification&&request.method==="POST"){const v=await body(request);only(v,["action","expected_revision"]);return json(await notificationAction(env.DB,notification[1],v as unknown as {action:"retry"|"contacted";expected_revision:number},key(request),actor,env.BOOKING_SECRET!));}
   if(path==="/api/admin/v1/legacy"&&request.method==="GET"){
    const cursor=Number(url.searchParams.get("cursor")??Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(cursor)||cursor<1)throw new DomainError("invalid_cursor",400);
    const data=await env.DB.prepare("SELECT id,name,phone,status,created_at,delivery_status FROM leads WHERE id < ? ORDER BY id DESC LIMIT 50").bind(cursor).all();return json({items:data.results,next_cursor:data.results.length===50?(data.results[49] as {id:number}).id:null});
   }
   return json({error:"not_found"},404);
  }catch(error){
   if(error instanceof DomainError||error instanceof AdminDenied){
    const details=error instanceof DomainError?error.details:undefined;
    return json({error:error.code,...(details?{details}:{})},error.status,c);
   }
   // Ошибки могут содержать SQL и контакты, наружу и в обычный лог их не выводим.
   return json({error:"unavailable"},503,c);
  }
 };
}
export const routeBookingRequest=createBookingRouter();
