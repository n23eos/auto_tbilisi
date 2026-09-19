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
