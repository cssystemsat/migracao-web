"""usuario_foto e aniversario_post_em

Revision ID: 2a5d0dfe59b2
Revises: 94589b32f45a
Create Date: 2026-10-23 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2a5d0dfe59b2'
down_revision: Union[str, Sequence[str], None] = '94589b32f45a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('usuarios', sa.Column('aniversario_post_em', sa.String(), nullable=True))
    op.drop_column('usuarios', 'foto')
    op.create_table('usuario_foto',
    sa.Column('usuario_id', sa.String(), nullable=False),
    sa.Column('foto', sa.Text(), nullable=False),
    sa.ForeignKeyConstraint(['usuario_id'], ['usuarios.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('usuario_id')
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('usuario_foto')
    op.add_column('usuarios', sa.Column('foto', sa.Text(), nullable=True))
    op.drop_column('usuarios', 'aniversario_post_em')
