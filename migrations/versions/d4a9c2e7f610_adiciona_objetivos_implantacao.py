"""adiciona objetivos de implantacao ao cliente

Revision ID: d4a9c2e7f610
Revises: c3fac6352c27
Create Date: 2026-11-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4a9c2e7f610"
down_revision: Union[str, Sequence[str], None] = "c3fac6352c27"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "clientes",
        sa.Column("objetivos_implantacao", sa.JSON(), nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("clientes", "objetivos_implantacao")
