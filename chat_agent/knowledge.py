"""Локальный поиск по самостоятельным разделам подготовленных TXT."""

from dataclasses import asdict, dataclass
import hashlib
import math
from pathlib import Path
import re

STOP = set('и в во на по о об от до с со к как что это ли я вы мы мне у для или а не за'.split())
ALIASES = {'дистанционно': 'онлайн', 'удаленно': 'онлайн', 'стоимость': 'цена',
           'стоит': 'цена', 'оплачивать': 'платить', 'предоплату': 'предоплата',
           'новичок': 'нуля', 'новичкам': 'нуля', 'адрес': 'находитесь',
           'заявка': 'контакты', 'заявку': 'контакты', 'заявки': 'контакты'}
EXCLUDED = {'Цены школы', 'Теория', 'Вождение', 'Дополнительно', 'Государственные пошлины',
            'Когда стартует ближайшая группа?', 'Сколько билетов в базе?',
            'Кто преподаёт теорию?', 'Ограничения для 17-летних водителей', 'Страницы сайта'}
SERVICE_BLOCK = re.compile(
    r'^(?:ВНИМАНИЕ:\s*Расхождение|'
    r'ОГРАНИЧЕНИЯ ДЛЯ|'
    r'В разговоре с клиентом|'
    r'Бот(?:\s|у\b))|'
    r'при фактчекинге|'
    r'аудиоответе школы|'
    r'правильный ответ',
    re.I,
)


def customer_text(body):
    # Два смешанных абзаца содержат полезный факт внутри директивы боту.
    body = body.replace(
        'Точную сумму бот не называет: она ',
        'Точная сумма ',
    ).replace(
        'Правильный ответ — предложить бесплатный расчёт по телефону или заявку на звонок.',
        'Можно получить бесплатный расчёт по телефону или оставить заявку на звонок.',
    ).replace(
        'Бот срок не называет — предлагает уточнить при получении справки.',
        'Точный срок действия лучше уточнить при получении справки.',
    )
    paragraphs = [paragraph.strip() for paragraph in re.split(r'\n\s*\n', body)]
    return '\n\n'.join(paragraph for paragraph in paragraphs
                         if paragraph and not SERVICE_BLOCK.search(paragraph))


def tokens(text):
    words = re.findall(r'[а-яa-z0-9]+', text.lower().replace('ё', 'е'))
    # Префиксы помогают русским окончаниям; это эвристика, качество проверяют retrieval-тесты.
    return [ALIASES.get(word, word)[:6] for word in words if word not in STOP]


@dataclass(frozen=True)
class Chunk:
    id: str
    title: str
    text: str
    source_ref: str
    version: str


class Knowledge:
    def __init__(self, directory):
        self.chunks = {}
        for path in sorted(Path(directory).glob('0[0-5]-*.txt')):
            source = path.read_text(encoding='utf-8')
            sections = re.split(r'(?m)^(?:ВОПРОС|РАЗДЕЛ|ПОДРАЗДЕЛ): ', source)[1:]
            for section in sections:
                title, _, body = section.partition('\n')
                title, body = title.strip(), body.strip()
                if title in EXCLUDED or not body:
                    continue
                # Денежные значения имеют один источник: каталог, а не старые тексты.
                body = re.sub(r'; Цена: [^\n]+', '', body)
                body = re.sub(r'\([^()]*\d[^()]*(?:₾|лари|GEL)[^()]*\)', '(цену уточните в прайсе)', body)
                body = re.sub(r'\d[\d\s/.,–-]*(?:₾|лари|GEL)(?:\s+за\s+(?:курс|занятие))?', '[актуальная цена — в прайсе]', body)
                if re.search(r'боту не выдавать|непроверенн|опровергнут', body, re.I):
                    continue
                body = re.sub(r'(?m)^\*?Похожие формулировки:.*$', '', body).strip()
                body = customer_text(body)
                if not body:
                    continue
                # Не обрезаем длинный раздел: так можно потерять исключение в конце.
                if len(body) > 3500:
                    raise ValueError(f'Раздел требует смыслового разбиения: {path.name}: {title}')
                chunk_id = hashlib.sha256(f'{path.stem}:{title}'.encode()).hexdigest()[:16]
                if chunk_id in self.chunks:
                    raise ValueError('duplicate_chunk_id')
                self.chunks[chunk_id] = Chunk(chunk_id, title, body,
                    f'baza-znaniy/{path.stem}.md#{title}', hashlib.sha256(body.encode()).hexdigest()[:16])
        if not self.chunks:
            raise ValueError('empty_knowledge')
        self.index = {key: tokens(chunk.title + ' ' + chunk.title + ' ' + chunk.text)
                      for key, chunk in self.chunks.items()}
        self.title_index = {key: set(tokens(chunk.title)) for key, chunk in self.chunks.items()}

    def search(self, query, *, current_question=None, limit=4, max_chars=6000):
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 500:
            raise ValueError('invalid_query')
        terms = set(tokens(query))
        if current_question is not None:
            if not isinstance(current_question, str) or not 1 <= len(current_question.strip()) <= 2000:
                raise ValueError('invalid_current_question')
            # Переформулировка модели не должна вытеснять точный вопрос из FAQ.
            terms.update(tokens(current_question))
        ranking = []
        for key, words in self.index.items():
            score = 0
            for term in terms:
                frequency = words.count(term)
                if frequency:
                    documents = sum(term in row for row in self.index.values())
                    score += math.log(1 + len(self.index) / documents) * frequency / (frequency + 1 + len(words) / 100)
                if term in self.title_index[key]:
                    score += 4
            if score:
                ranking.append((score, key))
        found, total = [], 0
        for _, key in sorted(ranking, key=lambda item: (-item[0], item[1])):
            row = asdict(self.chunks[key])
            size = len(row['text']) + len(row['title'])
            if total + size > max_chars:
                continue
            found.append(row)
            total += size
            if len(found) >= limit:
                break
        return {'status': 'success' if found else 'unknown', 'chunks': found}
