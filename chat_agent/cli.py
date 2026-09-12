"""Локальный/серверный запуск реального harness без HTTP-публикации."""

import argparse
import json
import os
from pathlib import Path

from chat_agent.facts import Catalog
from chat_agent.harness import Harness
from chat_agent.knowledge import Knowledge
from chat_agent.provider import Budget, DeepSeek


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('question')
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--kb', type=Path, default=Path('baza-znaniy/dlya-bota'))
    args = parser.parse_args()
    args.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    model = DeepSeek(os.environ.get('DEEPSEEK_API_KEY'), Budget(args.state / 'budget.sqlite3'))
    harness = Harness(model, Catalog(args.state / 'facts.sqlite3'), Knowledge(args.kb))
    print(json.dumps(harness.run(args.question), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
