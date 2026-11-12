"""remove cliente ativacao, metricas viram sub-atividades

Revision ID: 24e683c0ce3a
Revises: 7f6aa5a7a29f
Create Date: 2026-11-10 16:43:10.395017

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '24e683c0ce3a'
down_revision: Union[str, Sequence[str], None] = '7f6aa5a7a29f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Pedido explícito da usuária: as métricas da jornada de ativação viram
    # sub-atividades com data (concluido_em) do objetivo universal
    # "Implantação", em vez de um controle separado. Tabela nunca teve dados
    # reais gravados (conferido antes de dropar), então é uma remoção limpa.
    op.drop_table('cliente_ativacao')


def downgrade() -> None:
    """Downgrade schema."""
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
