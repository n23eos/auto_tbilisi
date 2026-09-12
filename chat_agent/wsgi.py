"""Production entrypoint для gunicorn."""

import os
from pathlib import Path

from chat_agent.access import CloudflareAccess
from chat_agent.facts import Catalog
from chat_agent.harness import Harness
from chat_agent.http_app import Application
from chat_agent.knowledge import Knowledge
from chat_agent.provider import Budget, DeepSeek
from chat_agent.seed import seed


def create_application():
    state = Path(os.environ.get('CHAT_STATE_DIR', '/var/lib/avtoshkola-chat'))
    knowledge = Path(os.environ.get('CHAT_KB_DIR', '/opt/avtoshkola-chat/baza-znaniy/dlya-bota'))
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    catalog = Catalog(state/'facts.sqlite3')
    seed(catalog)
    model = DeepSeek(os.environ.get('DEEPSEEK_API_KEY'), Budget(state/'budget.sqlite3'))
    harness = Harness(model, catalog, Knowledge(knowledge))
    origins = tuple(filter(None, os.environ.get('CHAT_ALLOWED_ORIGINS',
        'https://avtoshkola.ge,https://www.avtoshkola.ge').split(',')))
    team, audience = os.environ.get('CF_ACCESS_TEAM_DOMAIN'), os.environ.get('CF_ACCESS_AUD')
    allowed_emails = tuple(filter(None, os.environ.get('CF_ACCESS_ALLOWED_EMAILS', '').split(',')))
    access = CloudflareAccess(team, audience, allowed_emails) if team and audience and allowed_emails else None
    return Application(harness, origins, access=access,
        admin_origin=os.environ.get('CHAT_ADMIN_ORIGIN', 'https://admin.avtoshkola.ge'))


application = create_application()
