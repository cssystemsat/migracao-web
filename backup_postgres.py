"""Exporta todas as tabelas do Postgres (o banco de produção no Render) para
JSON dentro de backups/, versionado no git. Serve de rede de segurança caso a
conta do Render seja perdida: os dados ficam salvos no próprio projeto.

Uso:
    python backup_postgres.py

Lê DATABASE_URL do .env/ambiente (ver db_sql.py). Para fazer backup do banco
de PRODUÇÃO a partir da sua máquina local, aponte DATABASE_URL para a
"External Database URL" que o Render mostra na página do banco Postgres.
"""
import json
from datetime import datetime, date
from decimal import Decimal
from pathlib import Path

from sqlalchemy import inspect

from db_sql import engine
from models import Base

BACKUP_DIR = Path(__file__).parent / "backups"

# Guardam senha cifrada de sistema externo (credenciais) — não entram no
# backup versionado pra não deixar segredo na história do git.
TABELAS_SENSIVEIS = {"credenciais", "credenciais_cliente"}


def _serializar(valor):
    if isinstance(valor, (datetime, date)):
        return valor.isoformat()
    if isinstance(valor, Decimal):
        return float(valor)
    return valor


def main():
    BACKUP_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    destino = BACKUP_DIR / timestamp
    destino.mkdir()

    inspetor = inspect(engine)
    tabelas_existentes = set(inspetor.get_table_names())

    resumo = {}
    with engine.connect() as conexao:
        for tabela in Base.metadata.sorted_tables:
            nome = tabela.name
            if nome not in tabelas_existentes or nome in TABELAS_SENSIVEIS:
                continue
            linhas = conexao.execute(tabela.select()).mappings().all()
            dados = [
                {chave: _serializar(valor) for chave, valor in linha.items()}
                for linha in linhas
            ]
            (destino / f"{nome}.json").write_text(
                json.dumps(dados, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            resumo[nome] = len(dados)

    (destino / "_resumo.json").write_text(
        json.dumps(resumo, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"Backup salvo em {destino}")
    for nome, total in resumo.items():
        print(f"  {nome}: {total} linha(s)")


if __name__ == "__main__":
    main()
