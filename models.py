"""Tabelas do banco relacional (Postgres em produção / SQLite local) que guardam
o log de auditoria e o histórico do cliente — ver plano em
C:\\Users\\eduarda.melo\\.claude\\plans\\wild-hopping-hippo.md.

Roda em paralelo ao Firestore, não substitui: `cliente_id`/`usuario_id`/
`tarefa_id` aqui são referências soltas (string) pros docs que continuam no
Firestore — não são FK de verdade, porque não existe FK entre bancos
diferentes. As FKs de verdade (log_auditoria <-> log_auditoria_mudanca /
historico_cliente) são as que ficam 100% dentro deste banco.
"""
from datetime import datetime, timezone

from sqlalchemy import ForeignKey, Index, JSON, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _agora():
    return datetime.now(timezone.utc)


class LogAuditoria(Base):
    """Registro técnico e IMUTÁVEL de uma ação de escrita no sistema — nunca
    existe rota de editar/excluir isso, em nenhum perfil."""

    __tablename__ = "log_auditoria"

    id: Mapped[int] = mapped_column(primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(default=_agora, index=True)

    usuario_id: Mapped[str] = mapped_column(index=True)
    usuario_nome: Mapped[str] = mapped_column(default="")

    acao: Mapped[str] = mapped_column()  # "criar" | "editar" | "excluir" | "concluir" | "reabrir" | ...
    entidade_tipo: Mapped[str] = mapped_column()  # "cliente" | "tarefa" | "usuario" | "credencial" | ...
    entidade_id: Mapped[str] = mapped_column()
    entidade_nome: Mapped[str] = mapped_column(default="")

    origem: Mapped[str] = mapped_column(default="web")
    metadados: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    mudancas: Mapped[list["LogAuditoriaMudanca"]] = relationship(
        back_populates="log", cascade="all, delete-orphan", order_by="LogAuditoriaMudanca.id"
    )

    __table_args__ = (
        Index("ix_log_auditoria_entidade", "entidade_tipo", "entidade_id"),
    )


class LogAuditoriaMudanca(Base):
    """Uma linha por campo alterado numa ação de auditoria — tabela filha
    normalizada (só faz sentido separar assim porque agora estamos em SQL:
    dá pra ter FK de verdade com ON DELETE CASCADE)."""

    __tablename__ = "log_auditoria_mudanca"

    id: Mapped[int] = mapped_column(primary_key=True)
    log_auditoria_id: Mapped[int] = mapped_column(ForeignKey("log_auditoria.id", ondelete="CASCADE"), index=True)

    campo: Mapped[str] = mapped_column()
    rotulo: Mapped[str] = mapped_column(default="")
    valor_de: Mapped[str | None] = mapped_column(Text, nullable=True)
    valor_para: Mapped[str | None] = mapped_column(Text, nullable=True)

    log: Mapped["LogAuditoria"] = relationship(back_populates="mudancas")


class Usuario(Base):
    """Login da própria ferramenta (não confundir com credencial da SSX).

    PRONTA MAS NÃO ATIVA — app.py continua lendo/escrevendo isso no Firestore
    (coleção "app_usuarios") por enquanto. Produção hoje é o Render, sem
    Postgres provisionado lá; o destino combinado pra esta tabela é o
    Postgres do servidor da empresa, ainda sem data. Quando esse banco
    existir: trocar as funções em app.py (_sem_usuarios_cadastrados,
    _buscar_usuario_app, _buscar_usuario_por_id, _criar_usuario_app,
    _contar_admins e as rotas /api/app-usuario*) pra usar obter_sessao()/
    este model, criar a migration com `alembic revision --autogenerate`, e
    rodar migrar_usuarios_para_postgres.py --apply uma vez pra copiar quem já
    tem conta no Firestore.

    `id` usa o MESMO valor que o documento tem no Firestore (não um Integer
    auto-incremento) — tarefas.responsavel_id/criado_por, log_auditoria.usuario_id,
    historico_cliente.autor_id e o cookie de sessão guardam essa mesma string
    solta, então trocar o formato do id aqui exigiria remapear tudo isso
    também (fora do escopo desta migração). Usuário novo criado depois da
    migração ganha um id novo via uuid.uuid4().hex, no mesmo formato "opaco"
    que o Firestore já gerava."""

    __tablename__ = "usuarios"

    id: Mapped[str] = mapped_column(primary_key=True)
    usuario: Mapped[str] = mapped_column(unique=True)
    usuario_norm: Mapped[str] = mapped_column(unique=True, index=True)
    senha_hash: Mapped[str] = mapped_column()

    perfil: Mapped[str] = mapped_column(default="analista")  # "adm" | "analista" | "visualizacao"
    # "CS" | "Treinamento" | "Suporte" | "Comercial" — usuário com area="Comercial"
    # entra no select de Consultor Comercial no cadastro do cliente.
    area: Mapped[str | None] = mapped_column(nullable=True)

    # Liga esse login a um nome da lista de Responsável dos clientes (CSM) —
    # texto livre porque nem todo CS listado tem conta no app (ver decisão
    # 6.4 do schema_relacional_alvo_v3).
    nome_responsavel: Mapped[str] = mapped_column(default="")

    # Campos de "Minha Conta".
    nome: Mapped[str] = mapped_column(default="")
    sobrenome: Mapped[str] = mapped_column(default="")
    aniversario: Mapped[str] = mapped_column(default="")  # "MM-DD"
    telefone_profissional: Mapped[str] = mapped_column(default="")
    email: Mapped[str] = mapped_column(default="")
    foto: Mapped[str | None] = mapped_column(Text, nullable=True, default="")


class HistoricoCliente(Base):
    """Timeline curada de um cliente — o que aparece na aba Histórico da
    Ficha. `tipo == "manual"` é editável só pelo autor ou um admin; os
    outros tipos (auditoria/tarefa) só mudam via processo automático."""

    __tablename__ = "historico_cliente"

    id: Mapped[int] = mapped_column(primary_key=True)

    cliente_id: Mapped[str] = mapped_column(index=True)
    idcentral: Mapped[str] = mapped_column(default="")
    cliente_nome: Mapped[str] = mapped_column(default="")

    tipo: Mapped[str] = mapped_column()  # "manual" | "auditoria" | "tarefa"
    origem: Mapped[str] = mapped_column(default="")  # rótulo de exibição
    titulo: Mapped[str] = mapped_column()
    descricao: Mapped[str | None] = mapped_column(Text, nullable=True)

    autor_id: Mapped[str] = mapped_column(default="")
    autor_nome: Mapped[str] = mapped_column(default="")

    criado_em: Mapped[datetime] = mapped_column(default=_agora)

    tarefa_id: Mapped[str | None] = mapped_column(nullable=True)
    log_auditoria_id: Mapped[int | None] = mapped_column(
        ForeignKey("log_auditoria.id", ondelete="SET NULL"), nullable=True
    )

    editavel: Mapped[bool] = mapped_column(default=False)

    __table_args__ = (
        Index("ix_historico_cliente_timeline", "cliente_id", "criado_em"),
    )
