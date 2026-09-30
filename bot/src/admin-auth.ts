import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";
export interface AdminConfig {
  ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; ACCESS_ALLOWED_EMAILS?: string;
  ADMIN_ORIGIN?: string; BOOKING_SECRET?: string;
}
export class AdminDenied extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const keySets = new Map<string, JWTVerifyGetKey>();
const cookieName = "__Host-booking-csrf";
const encoder = new TextEncoder();
export function adminSettings(config: AdminConfig) {
  const team = config.ACCESS_TEAM_DOMAIN?.replace(/^https:\/\//, "").replace(/\/$/, "");
  const audience = config.ACCESS_AUD;
  const emails = (config.ACCESS_ALLOWED_EMAILS ?? "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  let origin: string;
  try {
    const url = new URL(config.ADMIN_ORIGIN ?? "");
    if (url.protocol !== "https:" || url.origin !== config.ADMIN_ORIGIN) throw new Error();
    origin = url.origin;
  } catch { throw new AdminDenied(503, "admin_unconfigured"); }
  if (!team || !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team) || !audience || !emails.length || !config.BOOKING_SECRET || config.BOOKING_SECRET.length < 32) throw new AdminDenied(503, "admin_unconfigured");
  return { issuer: `https://${team}`, audience, emails, origin };
}
export async function authorizeAdmin(request: Request, config: AdminConfig, key?: JWTVerifyGetKey): Promise<string> {
  const settings = adminSettings(config);
  if (new URL(request.url).origin !== settings.origin) throw new AdminDenied(403, "admin_origin");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AdminDenied(401, "access_required");
  let payload: JWTPayload;
  try {
    const url = `${settings.issuer}/cdn-cgi/access/certs`;
    if (!key && !keySets.has(url)) keySets.set(url, createRemoteJWKSet(new URL(url), { timeoutDuration: 3000 }));
    ({payload} = await jwtVerify(token, key ?? keySets.get(url)!, {issuer:settings.issuer,audience:settings.audience,algorithms:["RS256"],requiredClaims:["exp","iat","email","aud","iss"],clockTolerance:5}));
  } catch { throw new AdminDenied(403, "invalid_access"); }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!settings.emails.includes(email)) throw new AdminDenied(403, "access_not_allowed");
  return email;
}
async function signature(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(bytes, b=>b.toString(16).padStart(2,"0")).join("");
}
function equal(a: string, b: string) {
  const aa=encoder.encode(a),bb=encoder.encode(b);
  return aa.length===bb.length && crypto.subtle.timingSafeEqual(aa,bb);
}
export async function csrfSession(actor: string, config: AdminConfig, now=Date.now()) {
  adminSettings(config);
  const payload=btoa(JSON.stringify({actor,at:now,nonce:crypto.randomUUID()}));
  const token=`${payload}.${await signature(payload,config.BOOKING_SECRET!)}`;
  return {token,cookie:`${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`};
}
export async function requireAdminMutation(request: Request,actor: string,config: AdminConfig,now=Date.now()) {
  const settings=adminSettings(config);
  if(request.headers.get("Origin")!==settings.origin) throw new AdminDenied(403,"origin_not_allowed");
  const cookie=request.headers.get("Cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
  const token=request.headers.get("X-CSRF-Token")??"";
  if(!cookie||!equal(cookie,token))throw new AdminDenied(403,"csrf");
  try {
    const [payload,mac,extra]=token.split(".");
    if(extra||!payload||!mac||!equal(mac,await signature(payload,config.BOOKING_SECRET!)))throw new Error();
    const value=JSON.parse(atob(payload));
    if(value.actor!==actor||!Number.isFinite(value.at)||now<value.at||now-value.at>3600000)throw new Error();
  }catch{throw new AdminDenied(403,"csrf");}
}
