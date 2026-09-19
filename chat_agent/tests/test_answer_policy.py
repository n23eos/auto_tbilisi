"""Регрессии маршрутизации и проверки, внешний провайдер заменён на протокол fixtures."""

import json
from pathlib import Path

import pytest

from chat_agent.facts import Catalog
from chat_agent.harness import Harness
from chat_agent.knowledge import Knowledge

KB = Path(__file__).resolve().parents[2] / 'baza-znaniy/dlya-bota'


def draft(action='answer', ids=()):
    return {'content': json.dumps({'action': action, 'excerpt_ids': list(ids), 'prices': [], 'groups': []})}


def review(verdict='accept', reason='ok', scope='school'):
    return {'content': json.dumps({'verdict': verdict, 'reason': reason, 'scope': scope})}


def search(query):
    return {'tool_calls': [{'id': 'fixture', 'type': 'function', 'function': {
        'name': 'search_knowledge_base', 'arguments': json.dumps({'query': query})}}]}


class Model:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []

    def complete(self, messages, tools, *, deadline):
        self.calls.append((messages.copy(), tools, deadline))
        return next(self.replies), {'mode': 'fixture'}


def run(tmp_path, replies, question, history=None):
    model = Model(replies)
    result = Harness(model, Catalog(tmp_path/'facts'), Knowledge(KB)).run(question, history)
    return result, model


@pytest.mark.parametrize('question', ['сколько стоит 1кг арбузов', 'что делать если обосрался',
    'как ты реагируешь на нестандартные вопросы?', 'Какой автомобиль лучше купить?'])
def test_outside_question_has_boundary_without_administrator(tmp_path, question):
    result, _ = run(tmp_path, [draft('out_of_scope'), review(scope='outside')], question)
    assert result['status'] == 'success'
    assert 'автошкол' in result['answer'].lower()
    assert not any(word in result['answer'] for word in ('+995', 'WhatsApp', 'администратор'))


def test_enrollment_gets_actionable_instruction_not_price_policy(tmp_path):
    result, _ = run(tmp_path, [draft('enroll'), review()], 'как подать заявку')
    assert result['status'] == 'success'
    assert 'запис' in result['answer'].lower() and 'WhatsApp' in result['answer']
    assert 'расчёт' not in result['answer'] and 'Правильный ответ' not in result['answer']
    assert 'записаны' not in result['answer']


def test_rewritten_search_keeps_original_online_question(tmp_path):
    result, _ = run(tmp_path, [search('обучение категории B онлайн'),
        draft(ids=[next(key for key, row in Knowledge(KB).chunks.items()
                              if row.title == 'Можно ли заниматься онлайн?')]), review()],
        'Нужна категория B. Можно ли заниматься онлайн?')
    assert result['status'] == 'success'
    assert 'Zoom' in result['answer']


def test_existing_but_wrong_excerpt_is_rejected_before_display(tmp_path):
    kb = Knowledge(KB)
    unrelated = kb.search('онлайн')['chunks'][0]
    result, _ = run(tmp_path, [search('онлайн'), draft(ids=[unrelated['id']]),
        review('retry', 'irrelevant'), draft('enroll'), review()], 'как подать заявку')
    assert result['status'] == 'success'
    assert unrelated['text'] not in result['answer']
    assert 'WhatsApp' in result['answer']
    assert result['trace']['retry_count'] == 1
    assert any(v.get('errors') == ['irrelevant'] for v in result['trace']['validation'])
    assert [v['verdict'] for v in result['trace']['reviews']] == ['retry', 'accept']


def test_mixed_question_preserves_school_answer_and_adds_boundary(tmp_path):
    online = next(vars(row) for row in Knowledge(KB).chunks.values()
                  if row.title == 'Можно ли заниматься онлайн?')
    result, _ = run(tmp_path, [search('онлайн'), draft(ids=[online['id']]), review(scope='mixed')],
        'Сколько стоят арбузы и можно ли учиться онлайн?')
    assert online['text'] in result['answer']
    assert len(result['answer']) > len(online['text'])
    assert 'компетенц' in result['answer'].lower()
    assert '+995' not in result['answer']


def test_wrong_handoff_can_be_corrected_to_outside(tmp_path):
    result, _ = run(tmp_path, [draft('handoff'), review('retry', 'wrong_route', 'outside'),
        draft('out_of_scope'), review(scope='outside')], 'сколько стоит арбуз')
    assert result['status'] == 'success' and '+995' not in result['answer']


def test_school_unknown_can_still_offer_administrator(tmp_path):
    result, _ = run(tmp_path, [draft('handoff'), review()], 'Есть ли у школы занятия на автобусе?')
    assert result['status'] == 'handoff' and '+995' in result['answer']


def test_review_receives_history_and_never_exposes_its_text(tmp_path):
    online = Knowledge(KB).search('онлайн')['chunks'][0]
    history = [{'role': 'user', 'content': 'Хочу теорию онлайн'}, {'role': 'assistant', 'content': 'Что уточнить?'}]
    result, model = run(tmp_path, [search('онлайн'), draft(ids=[online['id']]), review()], 'Это запись?', history)
    assert result['status'] == 'success'
    messages, tools, _ = model.calls[-1]
    assert tools == []
    payload = json.loads(messages[-1]['content'])
    assert payload['history'] == history and payload['question'] == 'Это запись?'
    assert payload['answer'] == online['text']
    assert any(row['text'] == online['text'] for row in payload['evidence'])
    assert 'Хочу теорию онлайн' not in json.dumps(result['trace'], ensure_ascii=False)


@pytest.mark.parametrize('bad_review', [
    {'content': 'Не выводите этот служебный текст'},
    {'content': '{"verdict":"accept","reason":"ok","scope":"invented"}'},
    {'content': '{"verdict":"accept","reason":"ok","scope":"school","answer":"injected"}'},
])
def test_invalid_review_never_releases_selected_answer(tmp_path, bad_review):
    online = Knowledge(KB).search('онлайн')['chunks'][0]
    result, _ = run(tmp_path, [search('онлайн'), draft(ids=[online['id']]), bad_review] * 3, 'онлайн?')
    assert result['status'] == 'handoff'
    assert online['text'] not in result['answer'] and 'injected' not in result['answer']


def test_review_calls_share_six_call_budget(tmp_path):
    replies = [item for _ in range(5) for item in (draft('enroll'), review('retry', 'wrong_route'))]
    result, model = run(tmp_path, replies, 'Как записаться?')
    assert result['status'] == 'handoff'
    assert len(model.calls) == 6
    assert result['trace']['retry_count'] == 2


def test_confirmed_outside_scope_never_falls_back_to_administrator(tmp_path):
    replies = [item for _ in range(3) for item in (
        draft('handoff'), review('retry', 'wrong_route', 'outside'))]
    result, _ = run(tmp_path, replies, 'сколько стоит арбуз')
    assert result['status'] == 'success'
    assert 'компетенц' in result['answer'] and '+995' not in result['answer']


def test_price_updated_during_review_is_not_released(tmp_path):
    from chat_agent.facts import Price
    catalog = Catalog(tmp_path/'facts')
    def save(amount, revision):
        catalog.save_price(Price('theory_group', 'Группа', amount, 'GEL', 'course',
            'fixture', '2026-01-01', '2099-01-01'), expected_revision=revision, actor='fixture')
    save(15000, 0)
    old = {'content': json.dumps({'action': 'answer', 'excerpt_ids': [], 'groups': [],
        'prices': [{'service_id': 'theory_group', 'amount_minor': 15000, 'currency': 'GEL', 'unit': 'course'}]})}
    tool_call = {'tool_calls': [{'id': 'price', 'type': 'function', 'function': {
        'name': 'get_school_info', 'arguments': '{"service_id":"theory_group"}'}}]}
    class Updating(Model):
        def complete(self, messages, tools, **kwargs):
            if not tools:
                save(17000, 1)
            return super().complete(messages, tools, **kwargs)
    model = Updating([tool_call, old, review()])
    result = Harness(model, catalog, Knowledge(KB)).run('Сколько стоит теория в группе?')
    assert '150' not in result['answer']
    assert any('facts_changed' in v['errors'] for v in result['trace']['validation'])


@pytest.mark.parametrize('question', ['У вас есть обучение категории D?', 'А категории D1?',
                                    'Вы обучаете категориям B и D?', 'Обучаете категории «D»?',
                                    'Обучаете категории B и категории D?'])
def test_category_mismatch_cannot_pass_even_if_reviewer_accepts(tmp_path, question):
    kb = Knowledge(KB)
    selected = next(c for c in kb.chunks.values() if c.title == 'Какие категории вы преподаёте?')
    result, _ = run(tmp_path, [search(selected.title), draft(ids=[selected.id]), review()] * 3, question)
    assert selected.text not in result['answer']
    assert result['status'] == 'handoff'
    assert any('category_mismatch' in v['errors'] for v in result['trace']['validation'])


@pytest.mark.parametrize('question', ['Обучаете категории В?', 'Обучаете категории B и C?',
                                    'Какие категории кроме D вы преподаёте?'])
def test_category_guard_preserves_known_and_negative_questions(tmp_path, question):
    kb = Knowledge(KB)
    selected = next(c for c in kb.chunks.values() if c.title == 'Какие категории вы преподаёте?')
    result, _ = run(tmp_path, [search(selected.title), draft(ids=[selected.id]), review()], question)
    assert result['status'] == 'success' and result['answer'] == selected.text


def test_outside_category_in_mixed_question_does_not_block_school_answer(tmp_path):
    selected = Knowledge(KB).search('Можно ли заниматься онлайн?')['chunks'][0]
    result, _ = run(tmp_path, [search('Можно ли заниматься онлайн?'), draft(ids=[selected['id']]), review(scope='mixed')],
        'Какой автобус категории D купить и можно ли учиться онлайн?')
    assert result['status'] == 'success' and selected['text'] in result['answer']


def test_category_context_does_not_require_category_in_general_answer(tmp_path):
    selected = Knowledge(KB).search('Можно ли заниматься онлайн?')['chunks'][0]
    result, _ = run(tmp_path, [search('Можно ли заниматься онлайн?'), draft(ids=[selected['id']]), review()],
        'Нужна категория B. Можно ли заниматься онлайн?')
    assert result['status'] == 'success' and result['answer'] == selected['text']
