"""cria cliente ativacao

Revision ID: 93d5a1185682
Revises: b4fe5b856939
Create Date: 2026-11-10 16:03:36.606666

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '93d5a1185682'
down_revision: Union[str, Sequence[str], None] = 'b4fe5b856939'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'cliente_ativacao',
        sa.Column('cliente_id', sa.Integer(), nullable=False),
        sa.Column('capacitacao_em', sa.String(), nullable=False),
        sa.Column('primeiro_valor_em', sa.String(), nullable=False),
        sa.Column('ativacao_operacional_em', sa.String(), nullable=False),
        sa.Column('data_primeiro_vencimento', sa.String(), nullable=False),
        sa.Column('data_primeiro_acesso', sa.String(), nullable=False),
        sa.Column('data_primeiro_treinamento', sa.String(), nullable=False),
        sa.Column('situacao', sa.String(), nullable=False),
        sa.Column('motivo_nao_iniciou', sa.Text(), nullable=False),
        sa.Column('proxima_acao', sa.Text(), nullable=False),
        sa.Column('atualizado_em', sa.DateTime(timezone=True), nullable=False),
        sa.Column('atualizado_por', sa.String(), nullable=False),
        sa.ForeignKeyConstraint(['cliente_id'], ['clientes.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('cliente_id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('cliente_ativacao')
