"""persiste jobs de sincronizacao SSX

Revision ID: 71cb5c3a9e42
Revises: 2f88345225aa
Create Date: 2026-10-28

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "71cb5c3a9e42"
down_revision: Union[str, Sequence[str], None] = "2f88345225aa"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "migracao_ssx_sync_jobs",
        sa.Column("job_id", sa.String(), nullable=False),
        sa.Column("migracao_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("diff", sa.JSON(), nullable=True),
        sa.Column("erro", sa.Text(), nullable=True),
        sa.Column("resultado", sa.JSON(), nullable=True),
        sa.Column("criado_em", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["migracao_id"], ["migracoes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("job_id"),
    )
    op.create_index(
        "ix_migracao_ssx_sync_jobs_migracao_id",
        "migracao_ssx_sync_jobs",
        ["migracao_id"],
    )
    op.create_index(
        "ix_migracao_ssx_sync_jobs_status",
        "migracao_ssx_sync_jobs",
        ["status"],
    )
    op.create_index(
        "ix_migracao_ssx_sync_jobs_criado_em",
        "migracao_ssx_sync_jobs",
        ["criado_em"],
    )


def downgrade() -> None:
    op.drop_index("ix_migracao_ssx_sync_jobs_criado_em", table_name="migracao_ssx_sync_jobs")
    op.drop_index("ix_migracao_ssx_sync_jobs_status", table_name="migracao_ssx_sync_jobs")
    op.drop_index("ix_migracao_ssx_sync_jobs_migracao_id", table_name="migracao_ssx_sync_jobs")
    op.drop_table("migracao_ssx_sync_jobs")
