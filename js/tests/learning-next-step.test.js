import test from 'node:test';
import assert from 'node:assert/strict';
import { examVerdict, MAX_MISTAKES, QUESTION_COUNT } from '../exam-logic.js';
import { learningNextStep } from '../learning-next-step.js';

test('практика предлагается после завершённой успешной попытки, в том числе на пороге ошибок', () => {
  for (const mistakes of [0, MAX_MISTAKES]) {
    const result = examVerdict({ answered: QUESTION_COUNT, mistakes, timeUp: false });
    assert.equal(learningNextStep(result).goal, 'practice');
  }
});

test('незавершённая попытка, таймаут и превышение ошибок ведут к теории', () => {
  for (const attempt of [
    { answered: QUESTION_COUNT - 1, mistakes: 0, timeUp: true },
    { answered: 2, mistakes: 0, timeUp: false },
    { answered: 10, mistakes: MAX_MISTAKES + 1, timeUp: false },
  ]) {
    assert.equal(learningNextStep(examVerdict(attempt)).goal, 'theory');
  }
});
