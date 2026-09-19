"""Фиксированные синтетические вопросы: реальный Flash, без публикации кандидата."""

import argparse
import json
import os
from pathlib import Path
import tempfile

from chat_agent.facts import Catalog
from chat_agent.harness import Harness
from chat_agent.knowledge import Knowledge
from chat_agent.provider import Budget, DeepSeek
from chat_agent.seed import seed


CASES = [
    ('outside_fruit', 'сколько стоит 1кг арбузов', 'out_of_scope', ['компетенции'], ['+995', 'WhatsApp']),
    ('outside_rude', 'что делать если обосрался', 'out_of_scope', ['компетенции'], ['+995', 'WhatsApp']),
    ('outside_meta', 'как ты реагируешь на нестандартные вопросы - сколько стоит 1кг арбузов', 'out_of_scope', ['компетенции'], ['+995']),
    ('application', 'как подать заявку', 'enroll', ['WhatsApp'], ['расчёт', 'Правильный ответ']),
    ('enroll', 'как записаться на курсы', 'enroll', ['WhatsApp'], ['расчёт', 'Правильный ответ']),
    ('enroll_paraphrase', 'хочу к вам на занятия, с чего начать запись?', 'enroll', ['WhatsApp'], ['Правильный ответ']),
    ('online', 'Можно ли заниматься онлайн?', 'answer', ['Zoom'], ['+995']),
    ('online_category_context', 'Нужна категория B. Можно ли заниматься онлайн?', 'answer', ['Zoom'], ['+995', '₾']),
    ('documents', 'документы нужны', 'answer', ['паспорт'], ['Правильный ответ']),
    ('mixed', 'сколько стоят арбузы и можно ли заниматься онлайн?', 'answer', ['Zoom', 'компетенции'], ['+995', '₾', 'GEL', 'лари']),
    ('unknown_school', 'У вас есть обучение вождению автобуса категории D?', 'handoff', ['+995'], ['компетенции']),
    ('outside_car', 'Какой автомобиль мне лучше купить?', 'out_of_scope', ['компетенции'], ['+995']),
    ('price', 'Сколько стоит теория в группе?', 'answer', ['150'], ['200 ₾']),
    # При unknown допустимы handoff и answer с шаблоном render_group: оба дают контакт.
    ('dates', 'Когда ближайшая группа?', ('answer', 'handoff'), ['+995'], ['мест нет']),
]


def evaluate(harness, selected=()):
    rows = []
    for case_id, question, action, required, forbidden in CASES:
        if selected and case_id not in selected:
            continue
        result = harness.run(question)
        answer, trace = result['answer'], result['trace']
        errors = []
        allowed_actions = (action,) if isinstance(action, str) else action
        if trace.get('action') not in allowed_actions:
            errors.append('wrong_action')
        if any(word.lower() not in answer.lower() for word in required):
            errors.append('missing_expected_content')
        if any(word.lower() in answer.lower() for word in forbidden):
            errors.append('forbidden_content')
        row = {'id': case_id, 'passed': not errors, 'errors': errors,
               'answer': answer, 'status': result['status'], 'trace': trace}
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    print(json.dumps({'mode': 'live', 'passed': sum(r['passed'] for r in rows), 'total': len(rows),
        'cost_upper_micro_usd': sum(u.get('cost_upper_micro_usd', 0) for r in rows for u in r['trace']['usage'])}), flush=True)
    return bool(rows) and all(row['passed'] for row in rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--budget', required=True, type=Path,
                        help='Существующий общий ledger бота: не создавайте отдельный лимит для evals.')
    parser.add_argument('--kb', type=Path, default=Path('baza-znaniy/dlya-bota'))
    parser.add_argument('--case', action='append', choices=[c[0] for c in CASES], default=[])
    args = parser.parse_args()
    if not args.budget.is_file():
        parser.error('Укажите существующий ledger расходов бота.')
    model = DeepSeek(os.environ.get('DEEPSEEK_API_KEY'), Budget(args.budget))
    with tempfile.TemporaryDirectory(prefix='school-eval-facts-') as directory:
        catalog = Catalog(Path(directory)/'facts.sqlite3')
        seed(catalog)
        ok = evaluate(Harness(model, catalog, Knowledge(args.kb)), args.case)
    raise SystemExit(0 if ok else 1)


if __name__ == '__main__':
    main()
