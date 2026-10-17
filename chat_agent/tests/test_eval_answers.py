from chat_agent.eval_answers import evaluate


class CompletedRun:
    def __init__(self, result):
        self.result = result

    def run(self, _question):
        return self.result


def test_mixed_eval_rejects_unrequested_school_price(capsys):
    result = {'status': 'success', 'answer': 'Теория в Zoom. Цена 280 ₾. Остальное вне компетенции.',
              'trace': {'action': 'answer', 'usage': []}}
    assert not evaluate(CompletedRun(result), ['mixed'])


def test_unknown_dates_contact_is_valid_outcome(capsys):
    result = {'status': 'handoff', 'answer': 'Дату уточните: +995 599 98 77 07',
              'trace': {'action': 'handoff', 'usage': []}}
    assert evaluate(CompletedRun(result), ['dates'])


def test_general_theory_eval_requires_all_course_formats(capsys):
    result = {'status': 'success', 'answer': 'Теория в группе 150; Индивидуальная теория онлайн 350; Индивидуальная теория в аудитории 350',
              'trace': {'action': 'answer', 'usage': []}}
    assert evaluate(CompletedRun(result), ['theory_overview'])
    result['answer'] = 'Теория в группе 150'
    assert not evaluate(CompletedRun(result), ['theory_overview'])


def test_followup_eval_passes_conversation_to_harness(capsys):
    class FollowupRun:
        def run(self, question, history=None):
            if question == 'А сколько стоит?' and history == [
                {'role': 'user', 'content': 'Меня интересует вождение в городе'},
                {'role': 'assistant', 'content': 'Что хотите узнать о вождении в городе?'},
            ]:
                return {'status': 'success', 'answer': 'Вождение в городе 50',
                        'trace': {'action': 'answer', 'usage': []}}
            return {'status': 'handoff', 'answer': '+995', 'trace': {'usage': []}}
    assert evaluate(FollowupRun(), ['price_followup'])
