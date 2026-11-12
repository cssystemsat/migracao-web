"""adiciona objetivo universal implantacao

Revision ID: 44240710c2b8
Revises: 6f47a83d1c20
Create Date: 2026-11-10 11:19:40.025597

"""
from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '44240710c2b8'
down_revision: Union[str, Sequence[str], None] = '6f47a83d1c20'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Atividades sugeridas no contexto de negócio (configuráveis depois em
# Configurações → Templates de Objetivos, igual a qualquer outro template).
ITENS_TEMPLATE_UNIVERSAL = [
    "Realizar reunião inicial",
    "Apresentar a plataforma",
    "Orientar sobre o primeiro acesso",
    "Apontar o primeiro rastreador",
    "Demonstrar o funcionamento básico",
    "Realizar treinamento inicial",
    "Orientar sobre acesso à Universidade Systemsat",
    "Validar se o cliente conseguiu utilizar os recursos básicos",
    "Alinhar os próximos passos da operação",
]


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "objetivo_templates",
        sa.Column("universal", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "cliente_objetivos",
        sa.Column("universal", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    # Seed do template fixo "IMPLANTAÇÃO" — só insere se ainda não existir
    # (idempotente; evita duplicar em re-execução/downgrade+upgrade).
    bind = op.get_bind()
    templates = sa.table(
        "objetivo_templates",
        sa.column("id", sa.Integer()),
        sa.column("nome", sa.String()),
        sa.column("prazo_dias", sa.Integer()),
        sa.column("universal", sa.Boolean()),
        sa.column("criado_em", sa.DateTime(timezone=True)),
        sa.column("atualizado_em", sa.DateTime(timezone=True)),
    )
    itens = sa.table(
        "objetivo_template_itens",
        sa.column("template_id", sa.Integer()),
        sa.column("texto", sa.String()),
        sa.column("ordem", sa.Integer()),
    )

    ja_existe = bind.execute(
        sa.select(templates.c.id).where(templates.c.universal.is_(True))
    ).first()
    if ja_existe is None:
        agora = datetime.now(timezone.utc)
        bind.execute(
            templates.insert().values(
                nome="Implantação",
                prazo_dias=None,
                universal=True,
                criado_em=agora,
                atualizado_em=agora,
            )
        )
        # sa.table() não conhece a PK da tabela real pra expor
        # inserted_primary_key — busca de volta pelo filtro único (só pode
        # haver um template universal) em vez de depender disso.
        template_id = bind.execute(
            sa.select(templates.c.id).where(templates.c.universal.is_(True))
        ).scalar_one()
        for ordem, texto in enumerate(ITENS_TEMPLATE_UNIVERSAL):
            bind.execute(
                itens.insert().values(template_id=template_id, texto=texto, ordem=ordem)
            )


def downgrade() -> None:
    """Downgrade schema."""
    # Remove o template seed antes de dropar a coluna que o identifica —
    # evita duplicar "IMPLANTAÇÃO" num upgrade seguinte (itens cascadeiam via
    # FK ondelete=CASCADE). ClienteObjetivo.origem_template_id é SET NULL,
    # então cópias já feitas em clientes não são afetadas.
    bind = op.get_bind()
    templates = sa.table(
        "objetivo_templates",
        sa.column("id", sa.Integer()),
        sa.column("universal", sa.Boolean()),
    )
    bind.execute(templates.delete().where(templates.c.universal.is_(True)))

    op.drop_column("cliente_objetivos", "universal")
    op.drop_column("objetivo_templates", "universal")
