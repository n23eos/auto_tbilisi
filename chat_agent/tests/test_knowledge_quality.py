from pathlib import Path

import pytest

from chat_agent.knowledge import Knowledge


KB = Path(__file__).resolve().parents[2] / 'baza-znaniy/dlya-bota'


@pytest.fixture(scope='module')
def knowledge():
    return Knowledge(KB)


def result_with_title(knowledge, query, title):
    result = knowledge.search(query)
    return next(row for row in result['chunks'] if row['title'] == title)


def test_application_query_returns_contacts_without_bot_instructions(knowledge):
    result = knowledge.search('как подать заявку')

    assert result['chunks'][0]['title'] == 'Контакты'
    assert 'https://avtoshkola.ge/#contact' in result['chunks'][0]['text']
    assert all('Правильный ответ' not in row['text'] for row in result['chunks'])


def test_total_cost_keeps_customer_facts_and_call_to_action(knowledge):
    row = result_with_title(
        knowledge,
        'сколько выйдет обучение целиком',
        'Сколько выйдет обучение целиком?',
    )

    assert 'зависит от текущего уровня, формата и скорости вождения' in row['text']
    assert 'бесплатный расчёт по телефону' in row['text']
    assert 'оставить заявку на звонок' in row['text']
    assert 'бот' not in row['text'].lower()
    assert 'правильный ответ' not in row['text'].lower()


@pytest.mark.parametrize(('query', 'title', 'kept', 'removed'), [
    (
        'срок справки формы 100',
        'Что за справка формы 100 и где её взять?',
        'Точный срок действия лучше уточнить при получении справки',
        'Бот срок не называет',
    ),
    (
        'ограничения для 17-летних водителей',
        'С какого возраста можно учиться?',
        'точный список — на горячей линии МВД 1272',
        'нельзя возить пассажиров',
    ),
    (
        'скутер категория B1',
        'Что разрешает категория B и B1?',
        'отдельная категория AM',
        'ВНИМАНИЕ: Расхождение',
    ),
    (
        'действуют ли грузинские права за границей',
        'Действуют ли грузинские права за границей?',
        'Уточнять на горячей линии МВД 1272 или в консульстве',
        'Бот не должен',
    ),
])
def test_service_annotations_are_not_returned_with_customer_facts(
        knowledge, query, title, kept, removed):
    row = result_with_title(knowledge, query, title)

    assert kept in row['text']
    assert removed not in row['text']
