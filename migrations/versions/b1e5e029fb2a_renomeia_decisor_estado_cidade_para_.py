"""renomeia decisor_estado/decisor_cidade para estado/cidade do cliente

Revision ID: b1e5e029fb2a
Revises: b2d4f1a9c837
Create Date: 2026-11-25 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'b1e5e029fb2a'
down_revision: Union[str, Sequence[str], None] = 'b2d4f1a9c837'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # `estado`/`cidade` sempre foram a localização do CLIENTE (preenchidos
    # pela planilha de CS e pelo cadastro manual) — o nome "decisor_*" era um
    # erro de nomenclatura, nunca significou o estado/cidade do decisor (ver
    # docs/HISTORICO_DECISOES.md). Só renomeia a coluna; dado existente é
    # preservado.
    op.alter_column('clientes', 'decisor_estado', new_column_name='estado')
    op.alter_column('clientes', 'decisor_cidade', new_column_name='cidade')


def downgrade() -> None:
    """Downgrade schema."""
    op.alter_column('clientes', 'estado', new_column_name='decisor_estado')
    op.alter_column('clientes', 'cidade', new_column_name='decisor_cidade')
