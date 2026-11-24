"""cria notificacoes

Revision ID: f3a7c9d2b6e1
Revises: a1f3e9c7b204
Create Date: 2026-11-24 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a7c9d2b6e1'
down_revision: Union[str, Sequence[str], None] = 'a1f3e9c7b204'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'notificacoes',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('usuario_id', sa.String(), nullable=False),
        sa.Column('tipo', sa.String(), nullable=False),
        sa.Column('texto', sa.String(), nullable=False),
        sa.Column('entidade_tipo', sa.String(), nullable=False),
        sa.Column('entidade_id', sa.Integer(), nullable=True),
        sa.Column('origem_usuario_id', sa.String(), nullable=True),
        sa.Column('origem_usuario_nome', sa.String(), nullable=False),
        sa.Column('lida', sa.Boolean(), nullable=False),
        sa.Column('criado_em', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['usuario_id'], ['usuarios.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_notificacoes_usuario_id'), 'notificacoes', ['usuario_id'], unique=False)
    op.create_index(op.f('ix_notificacoes_lida'), 'notificacoes', ['lida'], unique=False)
    op.create_index(op.f('ix_notificacoes_criado_em'), 'notificacoes', ['criado_em'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_notificacoes_criado_em'), table_name='notificacoes')
    op.drop_index(op.f('ix_notificacoes_lida'), table_name='notificacoes')
    op.drop_index(op.f('ix_notificacoes_usuario_id'), table_name='notificacoes')
    op.drop_table('notificacoes')
