"""adiciona fase_entrada do cliente

Revision ID: c7e2a4f8d913
Revises: b1e5e029fb2a
Create Date: 2026-11-26 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'c7e2a4f8d913'
down_revision: Union[str, Sequence[str], None] = 'b1e5e029fb2a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Fase de vida em que o cliente ENTROU no sistema (implantacao/onboarding/
    # ongoing) — gravada na criação e nunca mais alterada. As fases são
    # sequenciais, e cliente antigo que entra direto numa fase não pode contar
    # nos dados das fases anteriores (ver docs/HISTORICO_DECISOES.md). Só
    # acrescenta a coluna: todo cliente existente fica com "implantacao"
    # (todos entraram pelo fluxo de Implantação até aqui).
    op.add_column(
        'clientes',
        sa.Column('fase_entrada', sa.String(), nullable=False, server_default='implantacao'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('clientes', 'fase_entrada')
