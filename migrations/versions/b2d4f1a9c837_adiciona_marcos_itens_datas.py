"""adiciona marcos_itens_datas ao cliente

Revision ID: b2d4f1a9c837
Revises: f3a7c9d2b6e1
Create Date: 2026-11-24

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b2d4f1a9c837"
down_revision: Union[str, Sequence[str], None] = "f3a7c9d2b6e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "clientes",
        sa.Column("marcos_itens_datas", sa.JSON(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("clientes", "marcos_itens_datas")
