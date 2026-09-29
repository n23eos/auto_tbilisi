import { describe,expect,it } from "vitest";
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from "jose";
import { authorizeAdmin,csrfSession,requireAdminMutation } from "../src/admin-auth";
const config={ACCESS_TEAM_DOMAIN:"school.cloudflareaccess.com",ACCESS_AUD:"aud-school",ACCESS_ALLOWED_EMAILS:"staff@example.com",ADMIN_ORIGIN:"https://admin.example.com",BOOKING_SECRET:"a".repeat(64)};
async function fixture(email="staff@example.com"){
 const keys=await generateKeyPair("RS256",{extractable:true});
 const jwk=await exportJWK(keys.publicKey);
 const token=await new SignJWT({email}).setProtectedHeader({alg:"RS256"}).setIssuer("https://school.cloudflareaccess.com").setAudience("aud-school").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
 return {request:new Request(`${config.ADMIN_ORIGIN}/api/admin/v1/groups`,{headers:{"Cf-Access-Jwt-Assertion":token}}),key:createLocalJWKSet({keys:[jwk]}),keys};
}
describe("booking admin access",()=>{
 it("allows signed matching Access JWT",async()=>{const f=await fixture();expect(await authorizeAdmin(f.request,config,f.key)).toBe("staff@example.com");});
 it("requires actual token rather than email header",async()=>{await expect(authorizeAdmin(new Request(`${config.ADMIN_ORIGIN}/admin/`,{headers:{"Cf-Access-Authenticated-User-Email":"staff@example.com"}}),config)).rejects.toMatchObject({status:401});});
 it("rejects different employee and direct workers.dev access",async()=>{const f=await fixture("stranger@example.com");await expect(authorizeAdmin(f.request,config,f.key)).rejects.toMatchObject({code:"access_not_allowed"});await expect(authorizeAdmin(new Request("https://school.workers.dev/admin/",f.request),config,f.key)).rejects.toMatchObject({code:"admin_origin"});});
 it("rejects wrong signature, issuer, audience and expired tokens",async()=>{
  const f=await fixture(), other=await generateKeyPair("RS256");
  for(const [issuer,aud,exp,key]of [["https://other.cloudflareaccess.com","aud-school","5m",f.keys.privateKey],["https://school.cloudflareaccess.com","wrong","5m",f.keys.privateKey],["https://school.cloudflareaccess.com","aud-school","-1m",f.keys.privateKey],["https://school.cloudflareaccess.com","aud-school","5m",other.privateKey]]as const){
   const token=await new SignJWT({email:"staff@example.com"}).setProtectedHeader({alg:"RS256"}).setIssuer(issuer).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key);
   await expect(authorizeAdmin(new Request(f.request.url,{headers:{"Cf-Access-Jwt-Assertion":token}}),config,f.key)).rejects.toMatchObject({code:"invalid_access"});
  }
 });
 it("fails closed with partial configuration",async()=>{const f=await fixture();await expect(authorizeAdmin(f.request,{...config,ACCESS_AUD:""},f.key)).rejects.toMatchObject({status:503});});
 it("binds CSRF to signed actor, exact Origin and expiry",async()=>{
  const now=Date.now(),s=await csrfSession("staff@example.com",config,now);
  const headers={Origin:config.ADMIN_ORIGIN,Cookie:s.cookie.split(";")[0],"X-CSRF-Token":s.token};
  const req=()=>new Request(`${config.ADMIN_ORIGIN}/api/admin/v1/groups`,{method:"POST",headers});
  await requireAdminMutation(req(),"staff@example.com",config,now+1);
  await expect(requireAdminMutation(req(),"stranger@example.com",config,now)).rejects.toMatchObject({code:"csrf"});
  await expect(requireAdminMutation(req(),"staff@example.com",config,now+3600001)).rejects.toMatchObject({code:"csrf"});
  headers.Origin="https://evil.example.com";
  await expect(requireAdminMutation(req(),"staff@example.com",config,now)).rejects.toMatchObject({code:"origin_not_allowed"});
 });
});
