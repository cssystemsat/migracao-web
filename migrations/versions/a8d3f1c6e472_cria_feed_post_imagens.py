"""cria feed_post_imagens (imagens anexadas a publicacoes do Feed)

Revision ID: a8d3f1c6e472
Revises: e5b1d7c3a920
Create Date: 2026-11-26 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'a8d3f1c6e472'
down_revision: Union[str, Sequence[str], None] = 'e5b1d7c3a920'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'feed_post_imagens',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('post_id', sa.Integer(), nullable=False),
        sa.Column('ordem', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('imagem', sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(['post_id'], ['feed_posts.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_feed_post_imagens_post_id'), 'feed_post_imagens', ['post_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_feed_post_imagens_post_id'), table_name='feed_post_imagens')
    op.drop_table('feed_post_imagens')
