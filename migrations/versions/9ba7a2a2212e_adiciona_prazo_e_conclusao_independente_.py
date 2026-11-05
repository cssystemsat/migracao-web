"""adiciona prazo e conclusao independente no objetivo

Revision ID: 9ba7a2a2212e
Revises: 0a9ef9c2b741
Create Date: 2026-11-05 12:55:57.849590

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '9ba7a2a2212e'
down_revision: Union[str, Sequence[str], None] = '0a9ef9c2b741'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    `concluido_em`/`prazo_dias`: conclusão do objetivo independente das
    sub-atividades (ver models.ClienteObjetivo e docs/HISTORICO_DECISOES.md).
    server_default='' em concluido_em preenche as linhas já existentes (sem
    isso, add_column NOT NULL falha numa tabela com dados)."""
    op.add_column('cliente_objetivos', sa.Column('concluido_em', sa.String(), nullable=False, server_default=''))
    op.alter_column('cliente_objetivos', 'concluido_em', server_default=None)
    op.add_column('cliente_objetivos', sa.Column('prazo_dias', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('cliente_objetivos', 'prazo_dias')
    op.drop_column('cliente_objetivos', 'concluido_em')
