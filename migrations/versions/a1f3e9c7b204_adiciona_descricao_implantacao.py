"""adiciona descricao_implantacao ao cliente

Revision ID: a1f3e9c7b204
Revises: 3c1f3fccee31
Create Date: 2026-11-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1f3e9c7b204"
down_revision: Union[str, Sequence[str], None] = "3c1f3fccee31"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "clientes",
        sa.Column("descricao_implantacao", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("clientes", "descricao_implantacao")
