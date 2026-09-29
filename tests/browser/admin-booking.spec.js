import { test,expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const read=path=>readFileSync(new URL(`../../${path}`,import.meta.url),'utf8');
const group=(id,date,sequence)=>({id,service_id:'theory_group',sequence,start_date:date,start_time:'19:00',starts_at_utc:`${date}T15:00:00.000Z`,date_status:'planned',enrollment_open:true,lifecycle:'scheduled',capacity:12,revision:1,pending_count:1,confirmed_count:0});
async function fixture(page,conflict=false){
 const data={schedule_revision:1,groups:[group('g1','2099-10-05',1),group('g2','2099-10-19',2)],next_cursor:null};const commands=[];
 await page.route('**/admin/**',async route=>{const path=new URL(route.request().url()).pathname;const file=path==='/admin/'?'index.html':path.split('/').at(-1);if(['index.html','admin.js','admin.css'].includes(file))return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:read(`bot/admin/${file}`)});return route.abort();});
 await page.route('**/api/admin/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(path.endsWith('/session'))return route.fulfill({json:{actor:'staff@example.com',csrf_token:'test-token'}});
  if(req.method()==='GET'){
   if(path.endsWith('/groups'))return route.fulfill({json:data});
   if(path.endsWith('/bookings'))return route.fulfill({json:{bookings:[{id:'b1',public_reference:'AV-TEST',group_id:'g1',group_revision:1,name:'Тест ученик',phone:'+995555123456',status:'pending',revision:1,possible_duplicate:false,group_start_date:'2099-10-05',group_start_time:'19:00'}],next_cursor:null}});
   return route.fulfill({json:{items:[],next_cursor:null}});
  }
  const body=req.postDataJSON();commands.push({path,body,headers:req.headers()});
  if(path.endsWith('/preview'))return route.fulfill({json:{expected_revision:1,normalized_command:body,changes:[{old_date:'2099-10-05',new_date:body.new_date,old_time:'19:00',new_time:'19:00',lifecycle:'scheduled'}],affected_bookings:1,notification_count:1,warnings:[]}});
  if(path.endsWith('/commit')){
   if(conflict)return route.fulfill({status:409,json:{error:'schedule_changed'}});
   data.groups[0].start_date=body.normalized_command.new_date;data.schedule_revision=2;return route.fulfill({json:{schedule_revision:2}});
  }
  return route.fulfill({json:{id:'b1',status:'confirmed',revision:2}});
 });
 return commands;
}
test('админка: перенос с предпросмотром и сохранением, без переполнения',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const commands=await fixture(page);await page.goto('/admin/');await expect(page.locator('#status')).toHaveText('Данные загружены.');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const first=page.locator('#groups .card').first();await first.locator('summary').click();await first.getByLabel('Новая дата').fill('2099-10-12');await first.getByRole('button',{name:'Посмотреть перенос'}).click();await expect(page.locator('#preview')).toBeVisible();await expect(page.locator('#preview-count')).toContainText('Затронуто записей: 1');await page.getByRole('button',{name:'Сохранить изменение',exact:true}).click();await expect(page.locator('#status')).toContainText('Изменение сохранено');await expect(page.locator('#groups .card').first().locator('h3')).toContainText('12.10.2099');expect(commands.find(x=>x.path.endsWith('/commit')).headers['x-csrf-token']).toBe('test-token');expect(commands.find(x=>x.path.endsWith('/commit')).headers['idempotency-key']).toBeTruthy();expect(errors).toEqual([]);
 if(test.info().project.name==='desktop')await page.screenshot({path:'/tmp/avtoshkola-booking-admin-20260929.png'});
});
test('админка: конфликт сохраняет предпросмотр и введенную дату',async({page})=>{
 await fixture(page,true);await page.goto('/admin/');const first=page.locator('#groups .card').first();await first.locator('summary').click();await first.getByLabel('Новая дата').fill('2099-10-12');await first.getByRole('button',{name:'Посмотреть перенос'}).click();await page.getByRole('button',{name:'Сохранить изменение',exact:true}).click();await expect(page.locator('#status')).toContainText('Расписание изменил другой сотрудник');await expect(first.getByLabel('Новая дата')).toHaveValue('2099-10-12');await expect(page.locator('#preview')).toBeVisible();
});

test('админка: завершение записи прошлой группы без загрузки истории',async({page})=>{
 await fixture(page);const commands=[];
 await page.route('**/api/admin/v1/bookings**',async route=>{
  const req=route.request();if(req.method()==='GET')return route.fulfill({json:{bookings:[{id:'past-booking',public_reference:'AV-PAST',group_id:'past-group',group_revision:7,name:'Тест',phone:'+995555123456',status:'confirmed',revision:3,group_start_date:'2020-01-01',group_start_time:'19:00'}],next_cursor:null}});
  commands.push(req.postDataJSON());return route.fulfill({json:{status:'completed'}});
 });
 await page.goto('/admin/');await expect(page.locator('#status')).toHaveText('Данные загружены.');
 await expect(page.locator('#history')).not.toBeChecked();await page.getByRole('button',{name:'Завершить обучение',exact:true}).click();
 await expect(page.locator('#status')).toContainText('Запись обновлена');expect(commands).toEqual([{action:'complete',expected_revision:3,group_revision:7}]);
});

test('админка: поиск телефона не передается в адресе запроса',async({page})=>{
 await fixture(page);const requests=[];await page.route('**/api/admin/v1/bookings/search',async route=>{requests.push({url:route.request().url(),body:route.request().postDataJSON(),headers:route.request().headers()});return route.fulfill({json:{bookings:[],next_cursor:null}});});
 await page.goto('/admin/');await expect(page.locator('#status')).toHaveText('Данные загружены.');await page.locator('[name=q]').fill('+995555123456');await page.locator('#filters').getByRole('button').click();await expect(page.locator('#bookings')).toContainText('По этому фильтру записей нет');expect(requests).toHaveLength(1);expect(requests[0].url).not.toContain('995555');expect(requests[0].body.q).toBe('+995555123456');expect(requests[0].headers['x-csrf-token']).toBe('test-token');
});

test('админка: история записи показывает событие и сотрудника',async({page})=>{
 await fixture(page);await page.route('**/api/admin/v1/bookings/b1',route=>route.fulfill({json:{booking:{id:'b1'},history:[{id:'e1',actor_id:'staff@example.com',action:'confirm',created_at:'2026-09-29T08:00:00Z'}],next_cursor:null}}));
 await page.goto('/admin/');await expect(page.locator('#status')).toHaveText('Данные загружены.');await page.getByRole('button',{name:'История записи',exact:true}).click();await expect(page.locator('#bookings')).toContainText('confirm · staff@example.com');
});
