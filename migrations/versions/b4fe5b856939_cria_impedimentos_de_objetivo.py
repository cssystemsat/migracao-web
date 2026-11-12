"""cria impedimentos de objetivo

Revision ID: b4fe5b856939
Revises: 44240710c2b8
Create Date: 2026-11-10 11:29:01.298199

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b4fe5b856939'
down_revision: Union[str, Sequence[str], None] = '44240710c2b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'cliente_objetivo_impedimentos',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('cliente_objetivo_id', sa.Integer(), nullable=False),
        sa.Column('categoria', sa.String(), nullable=False),
        sa.Column('responsabilidade', sa.String(), nullable=False),
        sa.Column('descricao', sa.Text(), nullable=False),
        sa.Column('data_inicio', sa.String(), nullable=False),
        sa.Column('data_resolucao', sa.String(), nullable=False),
        sa.Column('status', sa.String(), nullable=False),
        sa.Column('impacto', sa.Text(), nullable=False),
        sa.Column('proxima_acao', sa.Text(), nullable=False),
        sa.Column('responsavel', sa.String(), nullable=False),
        sa.Column('criado_em', sa.DateTime(timezone=True), nullable=False),
        sa.Column('atualizado_em', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['cliente_objetivo_id'], ['cliente_objetivos.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_cliente_objetivo_impedimentos_objetivo',
        'cliente_objetivo_impedimentos',
        ['cliente_objetivo_id', 'status'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_cliente_objetivo_impedimentos_objetivo', table_name='cliente_objetivo_impedimentos')
    op.drop_table('cliente_objetivo_impedimentos')
