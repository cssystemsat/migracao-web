"""cria templates e objetivos de implantacao hierarquicos

Revision ID: 0a9ef9c2b741
Revises: d4a9c2e7f610
Create Date: 2026-11-03

"""
from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0a9ef9c2b741"
down_revision: Union[str, Sequence[str], None] = "d4a9c2e7f610"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "objetivo_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("nome", sa.String(), nullable=False),
        sa.Column("criado_em", sa.DateTime(timezone=True), nullable=False),
        sa.Column("atualizado_em", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "objetivo_template_itens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("template_id", sa.Integer(), nullable=False),
        sa.Column("texto", sa.Text(), nullable=False),
        sa.Column("ordem", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["template_id"], ["objetivo_templates.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_objetivo_template_itens_template_id",
        "objetivo_template_itens",
        ["template_id"],
        unique=False,
    )
    op.create_table(
        "cliente_objetivos",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("cliente_id", sa.Integer(), nullable=False),
        sa.Column("nome", sa.String(), nullable=False),
        sa.Column("ordem", sa.Integer(), nullable=False),
        sa.Column("feito", sa.Boolean(), nullable=False),
        sa.Column("origem_template_id", sa.Integer(), nullable=True),
        sa.Column("criado_em", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["cliente_id"], ["clientes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["origem_template_id"], ["objetivo_templates.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_cliente_objetivos_cliente_id",
        "cliente_objetivos",
        ["cliente_id"],
        unique=False,
    )
    op.create_index(
        "ix_cliente_objetivos_cliente",
        "cliente_objetivos",
        ["cliente_id", "ordem"],
        unique=False,
    )
    op.create_table(
        "cliente_objetivo_itens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("cliente_objetivo_id", sa.Integer(), nullable=False),
        sa.Column("texto", sa.Text(), nullable=False),
        sa.Column("feito", sa.Boolean(), nullable=False),
        sa.Column("ordem", sa.Integer(), nullable=False),
        sa.Column("concluido_em", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["cliente_objetivo_id"], ["cliente_objetivos.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_cliente_objetivo_itens_cliente_objetivo_id",
        "cliente_objetivo_itens",
        ["cliente_objetivo_id"],
        unique=False,
    )

    bind = op.get_bind()
    clientes = sa.table(
        "clientes",
        sa.column("id", sa.Integer()),
        sa.column("objetivos_implantacao", sa.JSON()),
    )
    objetivos = sa.table(
        "cliente_objetivos",
        sa.column("cliente_id", sa.Integer()),
        sa.column("nome", sa.String()),
        sa.column("ordem", sa.Integer()),
        sa.column("feito", sa.Boolean()),
        sa.column("criado_em", sa.DateTime(timezone=True)),
    )
    for cliente_id, registros in bind.execute(
        sa.select(clientes.c.id, clientes.c.objetivos_implantacao)
    ):
        if not isinstance(registros, list):
            continue
        for ordem, registro in enumerate(registros):
            if not isinstance(registro, dict):
                continue
            nome = str(registro.get("texto") or "").strip()
            if not nome:
                continue
            bind.execute(
                objetivos.insert().values(
                    cliente_id=cliente_id,
                    nome=nome[:300],
                    ordem=ordem,
                    feito=registro.get("feito") is True,
                    criado_em=datetime.now(timezone.utc),
                )
            )


def downgrade() -> None:
    raise RuntimeError(
        "Downgrade bloqueado: objetivos com sub-atividades não podem ser "
        "representados sem perda no formato JSON legado. Faça backup e migre "
        "os dados manualmente antes de remover as tabelas."
    )
