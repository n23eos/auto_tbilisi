import test from 'node:test';
import assert from 'node:assert/strict';
import {SUGGESTIONS, formatPrice, nextHistory, publicAnswer} from '../chat-logic.js';

test('быстрые вопросы покрывают цену, группу, онлайн и документы',()=>{
  assert.equal(SUGGESTIONS.length,4);
  for(const word of ['стоят','группа','онлайн','документы']) assert.ok(SUGGESTIONS.some(q=>q.toLowerCase().includes(word)));
});
test('история остаётся в пределах трёх пар',()=>{
  let history=[];for(let i=0;i<5;i++) history=nextHistory(history,`в${i}`,`о${i}`);
  assert.equal(history.length,6);assert.equal(history[0].content,'в2');assert.equal(history.at(-1).content,'о4');
});
test('ответ и цена проверяются перед отображением',()=>{
  assert.equal(publicAnswer({status:'success',answer:' ответ '}),'ответ');
  assert.equal(formatPrice({status:'success',amount_minor:15000}),'150 ₾');
  assert.equal(formatPrice({status:'stale',amount_minor:15000}),null);
  assert.throws(()=>publicAnswer({status:'success',answer:''}));
});
