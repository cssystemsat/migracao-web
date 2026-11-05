"""vincula eventos automaticos da timeline aos objetivos

Revision ID: 6f47a83d1c20
Revises: d2cbe3a2f950
Create Date: 2026-11-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "6f47a83d1c20"
down_revision: Union[str, Sequence[str], None] = "d2cbe3a2f950"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("cliente_eventos", sa.Column("origem_tipo", sa.String(), nullable=True))
    op.add_column("cliente_eventos", sa.Column("origem_id", sa.String(), nullable=True))
    op.create_index(
        "ix_cliente_eventos_origem",
        "cliente_eventos",
        ["cliente_id", "origem_tipo", "origem_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_cliente_eventos_origem", table_name="cliente_eventos")
    op.drop_column("cliente_eventos", "origem_id")
    op.drop_column("cliente_eventos", "origem_tipo")
