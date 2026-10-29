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
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, JSON, Numeric, Text, UniqueConstraint
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

    ATIVA — fonte de verdade de login, substituindo a coleção "app_usuarios"
    do Firestore (mantida intacta lá só como backup, sem prazo de remoção).

    `id` usa o MESMO valor que o documento tinha no Firestore (não um Integer
    auto-incremento) — tarefas.responsavel_id/criado_por, log_auditoria.usuario_id,
    historico_cliente.autor_id e o cookie de sessão guardam essa mesma string
    solta. Usuário novo criado depois da migração ganha um id novo via
    uuid.uuid4().hex, no mesmo formato "opaco" que o Firestore já gerava.

    Foto do perfil fica em tabela própria (`UsuarioFoto`), não aqui — é um
    blob base64 que pode chegar a ~700KB e só é lido em poucos pontos
    (login, tela de Minha Conta, endpoint de avatar); mantê-la fora evita
    carregar esse peso em listagens em massa (lista de usuários, dropdown de
    responsável, mapa de telefones, aniversariantes do dia)."""

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

    # "YYYY-MM-DD" da última vez que o post automático de aniversário (feed)
    # rodou pra este usuário — None/nunca é diferente de string vazia, por
    # isso nullable em vez de default="" como os outros campos de texto.
    aniversario_post_em: Mapped[str | None] = mapped_column(nullable=True, default=None)


class UsuarioFoto(Base):
    """Extensão 1:1 de Usuario, só pra foto de perfil (ver docstring de
    Usuario). Sem linha = sem foto — mais simples que coluna nullable, e
    ON DELETE CASCADE já limpa isso sozinho ao excluir o usuário."""

    __tablename__ = "usuario_foto"

    usuario_id: Mapped[str] = mapped_column(
        ForeignKey("usuarios.id", ondelete="CASCADE"), primary_key=True
    )
    foto: Mapped[str] = mapped_column(Text)


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


class Cliente(Base):
    """Cadastro único de cliente (ver docs/HISTORICO_DECISOES.md — unificação
    de implantação/migração). `csm`/`vendedor` do Firestore eram texto livre;
    aqui ganham FK de verdade pra Usuario (nullable, porque nem todo CS/
    vendedor tem login — planilha de CS sincroniza por nome, às vezes sem
    bater com nenhum Usuario) com o nome sempre denormalizado em `*_nome`
    pra exibição/fallback quando a FK não resolve.

    `marcos_*`/`motivo_atraso` ficam como JSON (sem normalizar em tabelas) —
    é checklist aninhado de profundidade variável, sem necessidade hoje de
    query relacional dentro dele (decisão explícita)."""

    __tablename__ = "clientes"

    id: Mapped[int] = mapped_column(primary_key=True)
    idcentral: Mapped[str] = mapped_column(unique=True, index=True)
    cliente: Mapped[str] = mapped_column()
    tem_implantacao: Mapped[bool] = mapped_column(default=True)

    data_entrada: Mapped[str] = mapped_column(default="")
    objetivo: Mapped[str] = mapped_column(Text, default="")
    valor_contrato: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)

    responsavel_usuario_id: Mapped[str | None] = mapped_column(
        ForeignKey("usuarios.id", ondelete="SET NULL"), nullable=True, index=True
    )
    csm_nome: Mapped[str] = mapped_column(default="")
    vendedor_usuario_id: Mapped[str | None] = mapped_column(
        ForeignKey("usuarios.id", ondelete="SET NULL"), nullable=True, index=True
    )
    vendedor_nome: Mapped[str] = mapped_column(default="")

    etapa: Mapped[str] = mapped_column(default="marco-1")
    estagio: Mapped[str] = mapped_column(default="implantacao")
    momento: Mapped[str] = mapped_column(default="")
    flag: Mapped[str] = mapped_column(default="")
    persona: Mapped[str] = mapped_column(default="")

    decisor_nome: Mapped[str] = mapped_column(default="")
    decisor_whatsapp: Mapped[str] = mapped_column(default="")
    decisor_estado: Mapped[str] = mapped_column(default="")
    decisor_cidade: Mapped[str] = mapped_column(default="")

    implantado: Mapped[bool] = mapped_column(default=False)
    implantado_em: Mapped[str] = mapped_column(default="")
    implantado_por: Mapped[str] = mapped_column(default="")
    concluido_em: Mapped[str] = mapped_column(default="")
    concluido_por: Mapped[str] = mapped_column(default="")

    marcos_concluidos: Mapped[list] = mapped_column(JSON, default=list)
    marcos_concluidos_em: Mapped[dict] = mapped_column(JSON, default=dict)
    marcos_atualizado_em: Mapped[str] = mapped_column(default="")
    marcos_itens_feitos: Mapped[list] = mapped_column(JSON, default=list)
    marcos_itens_extras: Mapped[dict] = mapped_column(JSON, default=dict)
    marcos_concluidos_manual: Mapped[list] = mapped_column(JSON, default=list)
    marcos_prioridades: Mapped[list] = mapped_column(JSON, default=list)
    motivo_atraso: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    ultima_acao: Mapped[str] = mapped_column(default="")
    ultima_acao_data: Mapped[str] = mapped_column(default="")

    # Código de associação usado por sistemas externos (ex. Suporte) que não
    # têm API pra resolver isso a partir do idcentral — preenchimento manual.
    # Só perfil "adm" grava (trava aplicada em clientes_sql.editar_cliente,
    # não aqui no model).
    codigo_idcentral: Mapped[str | None] = mapped_column(nullable=True)

    # Linha crua da planilha de CS (colunas variáveis, texto->texto) — só
    # existe depois da primeira sincronização (ver app.py, Sincronizar
    # Planilha). Usado pro front ler indicadores pontuais (ex. "7 - UR's").
    dados_planilha: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class ClienteEvento(Base):
    """Timeline por setor (Implantação/Migração/Suporte/Comercial) — distinta
    de HistoricoCliente (que é a timeline curada da Ficha)."""

    __tablename__ = "cliente_eventos"

    id: Mapped[int] = mapped_column(primary_key=True)
    cliente_id: Mapped[int] = mapped_column(ForeignKey("clientes.id", ondelete="CASCADE"), index=True)

    setor: Mapped[str] = mapped_column()
    titulo: Mapped[str] = mapped_column()
    descricao: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[str] = mapped_column(default="")
    # Texto livre de propósito (não é FK pra Usuario) — decisão deliberada mantida.
    responsavel: Mapped[str] = mapped_column(default="")
    tag: Mapped[str] = mapped_column(default="")

    __table_args__ = (
        Index("ix_cliente_eventos_timeline", "cliente_id", "data"),
    )


class WootricAvaliacao(Base):
    """Avaliação de NPS da Wootric, persistida localmente — evita bater na
    API da Wootric a cada abertura de Ficha (ver wootric_api.py/
    wootric_sql.py). Sincronizada incrementalmente em segundo plano a partir
    de `GET /v1/responses`, que já inclui `end_user.email` — é de lá que
    `idcentral` é extraído (sufixo do e-mail, ex. "... - 997"; ver
    `_idcentral_da_resposta` em wootric_api.py). Esse código bate com
    `Cliente.codigo_idcentral`, não necessariamente com `Cliente.idcentral`
    — por isso `idcentral` aqui é referência solta (string, sem FK), igual
    ao padrão já usado em HistoricoCliente pros campos espelhados do
    Firestore."""

    __tablename__ = "wootric_avaliacoes"

    id: Mapped[int] = mapped_column(primary_key=True)
    wootric_id: Mapped[str] = mapped_column(unique=True, index=True)
    idcentral: Mapped[str] = mapped_column(default="", index=True)

    score: Mapped[int] = mapped_column()
    texto: Mapped[str] = mapped_column(Text, default="")
    email: Mapped[str] = mapped_column(default="")

    criado_em_wootric: Mapped[datetime] = mapped_column(index=True)
    sincronizado_em: Mapped[datetime] = mapped_column(default=_agora)


class ClienteDocumento(Base):
    """Documento anexado ao cadastro do cliente (ficha de entrada assinada,
    contrato) — mesmo padrão de blob em Postgres que UsuarioFoto (`conteudo`
    é a data URL base64 inteira), mas com `tipo` fixo em vez de 1:1, porque
    um cliente tem até 2 documentos (ver TIPOS_DOCUMENTO_CLIENTE em app.py).
    Sem linha pra um tipo = documento não enviado ainda."""

    __tablename__ = "cliente_documentos"

    id: Mapped[int] = mapped_column(primary_key=True)
    cliente_id: Mapped[int] = mapped_column(ForeignKey("clientes.id", ondelete="CASCADE"), index=True)

    tipo: Mapped[str] = mapped_column()  # "ficha_entrada" | "contrato"
    nome_arquivo: Mapped[str] = mapped_column(default="")
    conteudo: Mapped[str] = mapped_column(Text)
    tamanho: Mapped[int] = mapped_column(default=0)

    enviado_em: Mapped[str] = mapped_column(default="")
    enviado_por: Mapped[str] = mapped_column(default="")

    __table_args__ = (
        UniqueConstraint("cliente_id", "tipo", name="uq_cliente_documento_tipo"),
    )


class Migracao(Base):
    """Uma tentativa de migração do cliente pra outra plataforma. Regra "só
    uma em_andamento por cliente" é aplicada em Python (migracoes_sql.py),
    não em constraint de banco."""

    __tablename__ = "migracoes"

    id: Mapped[int] = mapped_column(primary_key=True)
    cliente_id: Mapped[int] = mapped_column(ForeignKey("clientes.id", ondelete="CASCADE"), index=True)

    plataforma_origem: Mapped[str] = mapped_column(default="")
    link_planilha: Mapped[str] = mapped_column(default="")
    link_acesso_origem: Mapped[str] = mapped_column(default="")
    login_acesso_origem: Mapped[str] = mapped_column(default="")
    # Cifrada (criptografia.py) — no Firestore era texto puro.
    senha_acesso_origem_cifrada: Mapped[str | None] = mapped_column(Text, nullable=True)

    qtd_clientes: Mapped[int] = mapped_column(default=0)
    qtd_placas: Mapped[int] = mapped_column(default=0)
    percentual_migracao: Mapped[float] = mapped_column(default=0.0)
    percentual_atualizado_em: Mapped[float | None] = mapped_column(nullable=True)

    etapa: Mapped[str] = mapped_column(default="analise")
    status: Mapped[str] = mapped_column(default="em_andamento")
    data_inicio: Mapped[str] = mapped_column(default="")
    data_fim: Mapped[str] = mapped_column(default="")
    motivo: Mapped[str] = mapped_column(default="")

    __table_args__ = (
        Index("ix_migracoes_cliente_status", "cliente_id", "status"),
    )


class MigracaoSsxSyncJob(Base):
    """Prévia de sincronização SSX persistida até o usuário aplicá-la."""

    __tablename__ = "migracao_ssx_sync_jobs"

    job_id: Mapped[str] = mapped_column(primary_key=True)
    migracao_id: Mapped[int] = mapped_column(
        ForeignKey("migracoes.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(default="rodando", index=True)
    diff: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    erro: Mapped[str | None] = mapped_column(Text, nullable=True)
    resultado: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_agora, index=True)


class MigracaoVeiculo(Base):
    __tablename__ = "migracao_veiculos"

    id: Mapped[int] = mapped_column(primary_key=True)
    migracao_id: Mapped[int] = mapped_column(ForeignKey("migracoes.id", ondelete="CASCADE"), index=True)

    # Nome do titular do veículo (coincidência de nome com Cliente — NÃO é FK).
    cliente: Mapped[str] = mapped_column()
    veiculo: Mapped[str] = mapped_column()  # placa
    equipamento: Mapped[str] = mapped_column(default="")
    id_equipamento: Mapped[str] = mapped_column(default="")
    apn: Mapped[str] = mapped_column(default="")
    ls_apn: Mapped[str] = mapped_column(default="")
    numero_linha: Mapped[str] = mapped_column(default="")
    comando: Mapped[str] = mapped_column(default="")
    ultima_comunicacao: Mapped[str] = mapped_column(default="")
    status: Mapped[str] = mapped_column(default="Aguardando")

    # Preenchidos a partir do match com a SSX (Vehicle/List, por
    # id_equipamento == IdTracker — ver ssx_veiculos_sync.py) — nulos até a
    # primeira sincronização encontrar o equipamento lá.
    # codigo_integracao_rastreador_ssx é só informativo (TrackerIntegrationCode,
    # opcional na SSX) — nunca usado pra casar linha nenhuma.
    codigo_integracao_veiculo_ssx: Mapped[str | None] = mapped_column(nullable=True)
    codigo_integracao_rastreador_ssx: Mapped[str | None] = mapped_column(nullable=True)
    # ClientTradingName da SSX — nosso "cliente" (nome do titular) é texto
    # livre da planilha; a central tem vários clientes finais (ver plano), e
    # esse campo mostra de qual cliente SSX esse veículo é de fato.
    cliente_ssx: Mapped[str | None] = mapped_column(nullable=True)

    # Marco "já comunicou pela primeira vez depois da migração" (não é
    # status de saúde contínuo — isso é papel do próprio SSX). Uma vez
    # True, nunca volta pra False.
    migracao_confirmada_ssx: Mapped[bool] = mapped_column(default=False)
    migracao_confirmada_em: Mapped[str | None] = mapped_column(nullable=True)

    __table_args__ = (
        # Substitui o hash determinístico (cliente+veiculo) que era o id do
        # doc no Firestore — mesma chave de upsert, agora como constraint.
        UniqueConstraint("migracao_id", "cliente", "veiculo", name="uq_migracao_veiculo"),
    )


class MigracaoModeloComando(Base):
    """Catálogo local por migração (template simples com {porta}) — sistema
    deliberadamente separado do catálogo global (fabricantes/
    modelos_rastreador/catalogo_comandos/parametros_comando), que continua
    no Firestore por enquanto."""

    __tablename__ = "migracao_modelos_comando"

    id: Mapped[int] = mapped_column(primary_key=True)
    migracao_id: Mapped[int] = mapped_column(ForeignKey("migracoes.id", ondelete="CASCADE"), index=True)

    modelo: Mapped[str] = mapped_column()
    porta: Mapped[str] = mapped_column(default="")
    comando_template: Mapped[str] = mapped_column(default="")


class Tarefa(Base):
    __tablename__ = "tarefas"

    id: Mapped[int] = mapped_column(primary_key=True)
    titulo: Mapped[str] = mapped_column()
    descricao: Mapped[str] = mapped_column(Text, default="")
    data_limite: Mapped[str] = mapped_column()

    cliente_id: Mapped[int | None] = mapped_column(
        ForeignKey("clientes.id", ondelete="CASCADE"), nullable=True, index=True
    )
    idcentral: Mapped[str] = mapped_column(default="")
    cliente_nome: Mapped[str] = mapped_column(default="")

    # RESTRICT de propósito: excluir um usuário com tarefa atribuída deve
    # falhar com erro amigável (tratado em app.py), não apagar a tarefa.
    responsavel_id: Mapped[str] = mapped_column(
        ForeignKey("usuarios.id", ondelete="RESTRICT"), index=True
    )
    responsavel_nome: Mapped[str] = mapped_column(default="")

    concluida: Mapped[bool] = mapped_column(default=False, index=True)
    concluida_em: Mapped[str] = mapped_column(default="")

    criado_por: Mapped[str | None] = mapped_column(
        ForeignKey("usuarios.id", ondelete="SET NULL"), nullable=True, index=True
    )
    criado_por_nome: Mapped[str] = mapped_column(default="")
    criado_em: Mapped[str] = mapped_column(default="")

    resultado: Mapped[str] = mapped_column(default="")
    resultado_descricao: Mapped[str] = mapped_column(Text, default="")
    finalizada_por_nome: Mapped[str] = mapped_column(default="")


class Credencial(Base):
    """Login salvo manual (Ferramentas Auxiliares), admin-only — sem ligação
    com cliente (ver CredencialCliente pra essa)."""

    __tablename__ = "credenciais"

    id: Mapped[int] = mapped_column(primary_key=True)
    nome: Mapped[str] = mapped_column()
    login: Mapped[str] = mapped_column()
    senha_cifrada: Mapped[str] = mapped_column(Text)


class CredencialCliente(Base):
    """Extensão 1:1 de Cliente (mesmo padrão de UsuarioFoto) — no Firestore o
    doc id era o idcentral; aqui vira FK de verdade pro id do Cliente."""

    __tablename__ = "credenciais_cliente"

    cliente_id: Mapped[int] = mapped_column(
        ForeignKey("clientes.id", ondelete="CASCADE"), primary_key=True
    )
    login: Mapped[str] = mapped_column()
    senha_cifrada: Mapped[str] = mapped_column(Text)


class FeedPost(Base):
    __tablename__ = "feed_posts"

    id: Mapped[int] = mapped_column(primary_key=True)
    texto: Mapped[str] = mapped_column(Text)
    # Sem FK de propósito — pode ser o sentinela fixo "sasha-robo" (post
    # automático de aniversário), que não é um Usuario real.
    autor_id: Mapped[str] = mapped_column(default="", index=True)
    autor_nome: Mapped[str] = mapped_column(default="")

    cliente_id: Mapped[int | None] = mapped_column(
        ForeignKey("clientes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    cliente_nome: Mapped[str] = mapped_column(default="")

    criado_em: Mapped[datetime] = mapped_column(default=_agora, index=True)
    comentarios_total: Mapped[int] = mapped_column(default=0)
    tipo: Mapped[str] = mapped_column(default="")


class FeedPostCurtida(Base):
    """Junção N:N post<->usuário que curtiu — era um array `curtidas` dentro
    do post no Firestore."""

    __tablename__ = "feed_post_curtidas"

    post_id: Mapped[int] = mapped_column(ForeignKey("feed_posts.id", ondelete="CASCADE"), primary_key=True)
    usuario_id: Mapped[str] = mapped_column(ForeignKey("usuarios.id", ondelete="CASCADE"), primary_key=True)
    criado_em: Mapped[datetime] = mapped_column(default=_agora)


class MunicipioIbge(Base):
    """Cache em banco dos municípios por UF, vindos da API de Localidades do
    IBGE (ver municipios_sql.py) — a rota /api/localidades/municipios/<uf>
    lê só daqui, nunca chama o IBGE na hora que alguém abre a tela. A API
    só é batida pelo script sincronizar_municipios_ibge.py, roda manual
    (seed inicial ou quando o IBGE inclui/altera algum município — evento
    raro, não precisa de sincronização automática)."""

    __tablename__ = "municipios_ibge"

    id: Mapped[int] = mapped_column(primary_key=True)
    uf: Mapped[str] = mapped_column(index=True)
    nome: Mapped[str] = mapped_column()

    __table_args__ = (
        UniqueConstraint("uf", "nome", name="uq_municipio_ibge_uf_nome"),
    )


class FeedComentario(Base):
    __tablename__ = "feed_comentarios"

    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int] = mapped_column(ForeignKey("feed_posts.id", ondelete="CASCADE"), index=True)
    texto: Mapped[str] = mapped_column(Text)
    # FK de verdade (diferente de FeedPost.autor_id) — comentário é sempre de
    # usuário real logado, nunca da Sasha.
    autor_id: Mapped[str | None] = mapped_column(
        ForeignKey("usuarios.id", ondelete="SET NULL"), nullable=True, index=True
    )
    autor_nome: Mapped[str] = mapped_column(default="")
    criado_em: Mapped[datetime] = mapped_column(default=_agora, index=True)
