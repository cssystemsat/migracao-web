"""renomeia objetivo universal para Implantacao

Revision ID: 7f6aa5a7a29f
Revises: 93d5a1185682
Create Date: 2026-11-10 16:19:38.639638

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7f6aa5a7a29f'
down_revision: Union[str, Sequence[str], None] = '93d5a1185682'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NOME_ANTIGO = "IMPLANTAÇÃO"
NOME_NOVO = "Implantação"


def upgrade() -> None:
    """Upgrade schema."""
    # Só renomeia o label de exibição — `universal=True` continua sendo o
    # que identifica o template/objetivo pro resto do código (nada compara
    # por nome). Atualiza tanto o template (pra cópias futuras) quanto os
    # objetivos já copiados em clientes (inclusive pelo backfill preguiçoso).
    bind = op.get_bind()
    templates = sa.table("objetivo_templates", sa.column("nome", sa.String()), sa.column("universal", sa.Boolean()))
    objetivos = sa.table("cliente_objetivos", sa.column("nome", sa.String()), sa.column("universal", sa.Boolean()))
    bind.execute(templates.update().where(templates.c.universal.is_(True)).values(nome=NOME_NOVO))
    bind.execute(objetivos.update().where(
        objetivos.c.universal.is_(True), objetivos.c.nome == NOME_ANTIGO
    ).values(nome=NOME_NOVO))


def downgrade() -> None:
    """Downgrade schema."""
    bind = op.get_bind()
    templates = sa.table("objetivo_templates", sa.column("nome", sa.String()), sa.column("universal", sa.Boolean()))
    objetivos = sa.table("cliente_objetivos", sa.column("nome", sa.String()), sa.column("universal", sa.Boolean()))
    bind.execute(templates.update().where(templates.c.universal.is_(True)).values(nome=NOME_ANTIGO))
    bind.execute(objetivos.update().where(
        objetivos.c.universal.is_(True), objetivos.c.nome == NOME_NOVO
    ).values(nome=NOME_ANTIGO))
