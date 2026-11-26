"""adiciona encerramento da migracao (formulario de finalizacao e numeros congelados)

Revision ID: e5b1d7c3a920
Revises: c7e2a4f8d913
Create Date: 2026-11-26 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'e5b1d7c3a920'
down_revision: Union[str, Sequence[str], None] = 'c7e2a4f8d913'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Encerramento de uma migração (finalizada ou cancelada) — vai pro
    # Histórico da aba Migração da Ficha. Só acrescenta colunas; as migrações
    # em andamento ficam com tudo vazio até serem encerradas.
    # - resultado: "concluida" | "concluida_pendencias" (vazio se cancelada)
    # - resumo / pendencias: texto do formulário de finalização
    # - encerrado_por: nome de quem finalizou/cancelou
    # - snapshot_encerramento: números congelados no encerramento (veículos
    #   por status, comunicando, plataforma, planilha...) pra o histórico não
    #   mudar depois.
    op.add_column('migracoes', sa.Column('resultado', sa.String(), nullable=False, server_default=''))
    op.add_column('migracoes', sa.Column('resumo', sa.Text(), nullable=False, server_default=''))
    op.add_column('migracoes', sa.Column('pendencias', sa.Text(), nullable=False, server_default=''))
    op.add_column('migracoes', sa.Column('encerrado_por', sa.String(), nullable=False, server_default=''))
    op.add_column('migracoes', sa.Column('snapshot_encerramento', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('migracoes', 'snapshot_encerramento')
    op.drop_column('migracoes', 'encerrado_por')
    op.drop_column('migracoes', 'pendencias')
    op.drop_column('migracoes', 'resumo')
    op.drop_column('migracoes', 'resultado')
