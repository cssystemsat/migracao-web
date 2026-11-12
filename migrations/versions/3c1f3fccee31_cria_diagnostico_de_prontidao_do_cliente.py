"""cria diagnostico de prontidao do cliente

Revision ID: 3c1f3fccee31
Revises: 24e683c0ce3a
Create Date: 2026-11-12 11:17:00.653117

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3c1f3fccee31'
down_revision: Union[str, Sequence[str], None] = '24e683c0ce3a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'cliente_diagnostico_prontidao',
        sa.Column('cliente_id', sa.Integer(), nullable=False),
        sa.Column('possui_equipamentos', sa.Boolean(), nullable=True),
        sa.Column('possui_chips', sa.Boolean(), nullable=True),
        sa.Column('possui_operacao_definida', sa.Boolean(), nullable=True),
        sa.Column('possui_clientes_proprios', sa.Boolean(), nullable=True),
        sa.Column('equipe_disponivel_treinamento', sa.Boolean(), nullable=True),
        sa.Column('estrutura_para_operar', sa.Boolean(), nullable=True),
        sa.Column('observacoes', sa.Text(), nullable=False),
        sa.Column('atualizado_em', sa.DateTime(timezone=True), nullable=False),
        sa.Column('atualizado_por', sa.String(), nullable=False),
        sa.ForeignKeyConstraint(['cliente_id'], ['clientes.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('cliente_id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('cliente_diagnostico_prontidao')
