"""adiciona prazo padrao no template de objetivo

Revision ID: d2cbe3a2f950
Revises: 9ba7a2a2212e
Create Date: 2026-11-05 16:02:23.448799

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'd2cbe3a2f950'
down_revision: Union[str, Sequence[str], None] = '9ba7a2a2212e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('objetivo_templates', sa.Column('prazo_dias', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('objetivo_templates', 'prazo_dias')
