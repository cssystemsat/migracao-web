"""Conexão com o banco relacional (log de auditoria + histórico do cliente).
Roda em PARALELO ao Firestore (ver app.py) — não é o banco principal do app,
só a base nova pra essas duas features (ver plano de escopo aprovado).

DATABASE_URL:
  - produção: string do Postgres (o Render injeta sozinho quando você cria
    o addon de banco por lá).
  - local/dev: se a variável não estiver definida, cai pra um arquivo SQLite
    (`local_dev.db`, na raiz do projeto) — zero infra pra rodar/testar, e é
    SQL de verdade (não uma simulação, ao contrário do Firestore fake em
    dev_offline_preview.py).
"""
import os
from contextlib import contextmanager

from dotenv import load_dotenv
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from models import Base

# Lê .env na raiz do projeto se existir (dev local) — em produção as env vars
# já vêm do provedor, load_dotenv() não sobrescreve o que já estiver setado.
load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///local_dev.db")

# Render (e a maioria dos provedores) ainda entrega a URL como "postgres://",
# mas o SQLAlchemy 2.x só aceita o dialeto "postgresql://" — normaliza aqui
# pra não depender de lembrar disso toda vez que a env var for configurada.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine = create_engine(DATABASE_URL, future=True)

# SQLite vem com checagem de FOREIGN KEY desligada por padrão (por conexão) —
# sem isso, ON DELETE CASCADE/SET NULL dos models.py simplesmente não
# aconteceriam no SQLite local, mesmo funcionando certo no Postgres de
# produção. Liga aqui pra dev/teste local se comportar igual a produção.
if engine.dialect.name == "sqlite":
    @event.listens_for(engine, "connect")
    def _ativar_fk_sqlite(conexao_dbapi, _):
        cursor = conexao_dbapi.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

SessionLocal = sessionmaker(bind=engine, future=True, expire_on_commit=False)


def criar_tabelas():
    """Cria as tabelas direto a partir dos models — só pra teste local rápido.
    Produção usa Alembic (pasta migrations/) pra versionar o schema."""
    Base.metadata.create_all(engine)


@contextmanager
def obter_sessao():
    """`with obter_sessao() as sessao: ...` — comita no fim do bloco se não
    deu erro, desfaz e propaga a exceção se deu."""
    sessao = SessionLocal()
    try:
        yield sessao
        sessao.commit()
    except Exception:
        sessao.rollback()
        raise
    finally:
        sessao.close()
