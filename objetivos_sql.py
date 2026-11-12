"""Persistência de templates e objetivos de Implantação com sub-atividades."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import selectinload

import db_sql
import impedimentos_sql
from models import Cliente, ClienteObjetivo, ClienteObjetivoItem, ObjetivoTemplate, ObjetivoTemplateItem

_FUSO_BR = ZoneInfo("America/Sao_Paulo")


class RegistroNaoEncontradoError(Exception):
    pass


class IdentificadorInvalidoError(Exception):
    pass


class NomeDuplicadoError(Exception):
    pass


def _id_existente(valor, existentes):
    if valor is None or valor == "":
        return None
    if isinstance(valor, bool):
        raise IdentificadorInvalidoError()
    try:
        identificador = int(valor)
    except (TypeError, ValueError):
        return None
    if identificador not in existentes:
        raise IdentificadorInvalidoError()
    return identificador


class TemplateUniversalProtegidoError(Exception):
    """Template universal "IMPLANTAÇÃO" (seed da migração) não pode ser excluído."""


def _template_dict(template):
    return {
        "id": template.id,
        "nome": template.nome,
        "prazo_dias": template.prazo_dias,
        "universal": template.universal,
        "itens": [
            {"id": item.id, "texto": item.texto, "ordem": item.ordem}
            for item in template.itens
        ],
    }


def _objetivo_dict(objetivo, impedimentos=None):
    # `feito`/`concluido_em` são sempre manuais, independentes dos itens (ver
    # docstring de ClienteObjetivo) — os itens abaixo são só o checklist de
    # apoio exibido na Ficha, não determinam conclusão nem entram em KPI.
    itens = [
        {
            "id": item.id,
            "texto": item.texto,
            "feito": item.feito,
            "ordem": item.ordem,
            "concluido_em": item.concluido_em,
        }
        for item in objetivo.itens
    ]
    # Prazo ajustado (seção 5.2 do contexto de negócio): SLA original - dias
    # de impedimento, sem sobrepor períodos simultâneos — nunca sobrescreve
    # `prazo_dias` (o original fica sempre visível ao lado). `impedimentos`
    # vem pré-carregado por quem chama (listar_objetivos), pra evitar 1
    # SELECT por objetivo.
    impedimentos = impedimentos if impedimentos is not None else []
    dias_impedimento = impedimentos_sql.dias_impedimento_objetivo(impedimentos) if impedimentos else 0
    prazo_ajustado_dias = (
        max(objetivo.prazo_dias - dias_impedimento, 0) if objetivo.prazo_dias else None
    )
    return {
        "id": objetivo.id,
        "nome": objetivo.nome,
        "ordem": objetivo.ordem,
        "feito": objetivo.feito,
        "concluido_em": objetivo.concluido_em,
        "prazo_dias": objetivo.prazo_dias,
        "dias_impedimento": dias_impedimento,
        "prazo_ajustado_dias": prazo_ajustado_dias,
        "impedimentos_ativos": sum(1 for i in impedimentos if i["status"] == "ativo"),
        "criado_em": objetivo.criado_em.date().isoformat() if objetivo.criado_em else "",
        "origem_template_id": objetivo.origem_template_id,
        "universal": objetivo.universal,
        "itens": itens,
    }


def listar_templates():
    with db_sql.obter_sessao_leitura() as sessao:
        templates = (
            sessao.query(ObjetivoTemplate)
            .options(selectinload(ObjetivoTemplate.itens))
            .order_by(ObjetivoTemplate.nome, ObjetivoTemplate.id)
            .all()
        )
        return [_template_dict(template) for template in templates]


def salvar_template(nome, itens, template_id=None, prazo_dias=None):
    with db_sql.obter_sessao() as sessao:
        template = sessao.get(ObjetivoTemplate, template_id) if template_id is not None else None
        if template_id is not None and template is None:
            raise RegistroNaoEncontradoError()
        # Nome único (sem diferenciar maiúsculas/espaços nas pontas) — evita
        # dois templates "Rastreamento" e "rastreamento " coexistindo.
        duplicado = (
            sessao.query(ObjetivoTemplate.id)
            .filter(func.lower(ObjetivoTemplate.nome) == nome.strip().lower())
        )
        if template_id is not None:
            duplicado = duplicado.filter(ObjetivoTemplate.id != template_id)
        if duplicado.first() is not None:
            raise NomeDuplicadoError()
        if template is None:
            template = ObjetivoTemplate(nome=nome, prazo_dias=prazo_dias)
            sessao.add(template)
            existentes = {}
        else:
            existentes = {item.id: item for item in template.itens}
            template.nome = nome
            template.prazo_dias = prazo_dias

        atualizados = []
        ids_recebidos = set()
        for ordem, dados in enumerate(itens):
            item_id = _id_existente(dados.get("id"), existentes)
            if item_id is not None and item_id in ids_recebidos:
                raise IdentificadorInvalidoError()
            if item_id is not None:
                ids_recebidos.add(item_id)
                item = existentes[item_id]
                item.texto = dados["texto"]
                item.ordem = ordem
            else:
                item = ObjetivoTemplateItem(texto=dados["texto"], ordem=ordem)
            atualizados.append(item)
        template.itens = atualizados
        sessao.flush()
        sessao.refresh(template)
        return _template_dict(template)


def excluir_template(template_id):
    with db_sql.obter_sessao() as sessao:
        template = sessao.get(ObjetivoTemplate, template_id)
        if template is None:
            raise RegistroNaoEncontradoError()
        if template.universal:
            raise TemplateUniversalProtegidoError()
        sessao.delete(template)


def criar_objetivo_universal_para_cliente(cliente_id):
    """Copia o template universal "Implantação" (seed da migração) pra um
    ClienteObjetivo do cliente, igual a usar um template manualmente —
    chamada por clientes_sql.criar_cliente pra todo cliente novo com
    `tem_implantacao`, pelo backfill preguiçoso no GET de
    objetivos-implantacao-detalhados (app.py) pra clientes antigos, e por
    `backfill_objetivo_universal_todos_clientes` pra rodar em lote. Idempotente
    (não duplica se o cliente já tiver um objetivo universal) e silenciosa se
    não houver template universal cadastrado (não deveria acontecer fora de
    um banco que ainda não rodou a migração de seed)."""
    with db_sql.obter_sessao() as sessao:
        ja_tem = (
            sessao.query(ClienteObjetivo.id)
            .filter(ClienteObjetivo.cliente_id == cliente_id, ClienteObjetivo.universal.is_(True))
            .first()
        )
        if ja_tem is not None:
            return
        template = (
            sessao.query(ObjetivoTemplate)
            .options(selectinload(ObjetivoTemplate.itens))
            .filter(ObjetivoTemplate.universal.is_(True))
            .first()
        )
        if template is None:
            return
        objetivo = ClienteObjetivo(
            cliente_id=cliente_id,
            nome=template.nome,
            ordem=0,
            prazo_dias=template.prazo_dias,
            origem_template_id=template.id,
            universal=True,
        )
        objetivo.itens = [
            ClienteObjetivoItem(texto=item.texto, ordem=item.ordem)
            for item in template.itens
        ]
        sessao.add(objetivo)


def backfill_objetivo_universal_todos_clientes():
    """Roda `criar_objetivo_universal_para_cliente` pra todo cliente de
    Implantação (`tem_implantacao=True`) que ainda não tem — chamado uma vez
    (ver scratchpad da sessão/HISTORICO_DECISOES.md) pra cobrir os clientes
    cadastrados antes do objetivo universal existir, sem esperar o backfill
    preguiçoso de cada ficha ser aberta uma por uma. Retorna quantos clientes
    ganharam o objetivo nesta chamada."""
    with db_sql.obter_sessao_leitura() as sessao:
        ids_clientes = [
            cliente_id for (cliente_id,) in
            sessao.query(Cliente.id).filter(Cliente.tem_implantacao.is_(True)).all()
        ]
    criados = 0
    for cliente_id in ids_clientes:
        with db_sql.obter_sessao_leitura() as sessao:
            ja_tem = (
                sessao.query(ClienteObjetivo.id)
                .filter(ClienteObjetivo.cliente_id == cliente_id, ClienteObjetivo.universal.is_(True))
                .first()
            )
        if ja_tem is not None:
            continue
        criar_objetivo_universal_para_cliente(cliente_id)
        criados += 1
    return criados


# As métricas da jornada de ativação (antes em cliente_ativacao, removida —
# ver docs/HISTORICO_DECISOES.md) viraram sub-atividades com data do
# checklist do objetivo universal: a data fica em
# ClienteObjetivoItem.concluido_em, carimbada ao marcar a etapa como feita
# (mesmo mecanismo que qualquer outra sub-atividade, ver salvar_objetivos).
RENOMEACOES_CHECKLIST_UNIVERSAL = {
    "Realizar treinamento inicial": "Iniciou os treinamentos",
}
ITENS_NOVOS_CHECKLIST_UNIVERSAL = [
    "Finalizou esteira de treinamentos",
    "Primeiro valor percebido",
]


def atualizar_checklist_universal_ativacao():
    """Renomeia/completa o checklist do objetivo universal com os itens que
    substituem a jornada de ativação — roda no template (cópias futuras já
    nascem certas) e em todo ClienteObjetivo universal já existente.
    Idempotente: não duplica item nem renomeia de novo se já tiver rodado.
    Retorna quantos objetivos (incluindo o template) foram alterados."""
    alterados = 0
    with db_sql.obter_sessao() as sessao:
        template = (
            sessao.query(ObjetivoTemplate)
            .options(selectinload(ObjetivoTemplate.itens))
            .filter(ObjetivoTemplate.universal.is_(True))
            .first()
        )
        objetivos = (
            sessao.query(ClienteObjetivo)
            .options(selectinload(ClienteObjetivo.itens))
            .filter(ClienteObjetivo.universal.is_(True))
            .all()
        )
        alvos = ([template] if template else []) + list(objetivos)
        for alvo in alvos:
            mudou = False
            textos_atuais = {item.texto for item in alvo.itens}
            for antigo, novo in RENOMEACOES_CHECKLIST_UNIVERSAL.items():
                if novo in textos_atuais:
                    continue
                for item in alvo.itens:
                    if item.texto == antigo:
                        item.texto = novo
                        textos_atuais.add(novo)
                        mudou = True
                        break
            maior_ordem = max((item.ordem for item in alvo.itens), default=-1)
            ItemClasse = ObjetivoTemplateItem if isinstance(alvo, ObjetivoTemplate) else ClienteObjetivoItem
            for texto in ITENS_NOVOS_CHECKLIST_UNIVERSAL:
                if texto in textos_atuais:
                    continue
                maior_ordem += 1
                alvo.itens.append(ItemClasse(texto=texto, ordem=maior_ordem))
                textos_atuais.add(texto)
                mudou = True
            if mudou:
                alterados += 1
    return alterados


ITEM_CHECKLIST_PRIMEIRO_VALOR = "Primeiro valor percebido"


def estatisticas_dashboard_ativacao(limite_clientes=10, hoje=None):
    """Bloco "Jornada de ativação e prevenção de churn" do Dashboard (seção
    8.4 do contexto de negócio), recalculado em cima do checklist do
    objetivo universal — a jornada de 30 dias não é mais um controle
    separado (ver docs/HISTORICO_DECISOES.md). O marco usado é a
    sub-atividade "Primeiro valor percebido": sua `concluido_em` é a data em
    que o cliente percebeu valor na plataforma. O "vencimento" é sempre
    `Cliente.data_entrada + 30 dias`, calculado na hora — nunca um campo."""
    hoje = hoje or datetime.now(_FUSO_BR).date()
    with db_sql.obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(ClienteObjetivoItem, Cliente.id, Cliente.idcentral, Cliente.cliente, Cliente.data_entrada)
            .join(ClienteObjetivo, ClienteObjetivo.id == ClienteObjetivoItem.cliente_objetivo_id)
            .join(Cliente, Cliente.id == ClienteObjetivo.cliente_id)
            .filter(
                ClienteObjetivo.universal.is_(True),
                Cliente.tem_implantacao.is_(True),
                ClienteObjetivoItem.texto == ITEM_CHECKLIST_PRIMEIRO_VALOR,
            )
            .all()
        )

    total = 0
    com_valor = 0
    tempos_ate_valor = []
    proximos_vencimento_sem_valor = []
    for item, cliente_id, idcentral, cliente_nome, data_entrada in linhas:
        total += 1
        entrada = _data_iso(data_entrada)
        if item.feito:
            com_valor += 1
            concluido = _data_iso(item.concluido_em)
            if entrada and concluido and concluido >= entrada:
                tempos_ate_valor.append((concluido - entrada).days)
            continue
        if not entrada:
            continue
        dias_para_vencimento = (entrada + timedelta(days=30) - hoje).days
        if dias_para_vencimento <= 7:  # já venceu ou vence em até 7 dias, sem valor percebido ainda
            proximos_vencimento_sem_valor.append({
                "cliente_id": cliente_id, "idcentral": idcentral, "cliente_nome": cliente_nome,
                "dias_para_vencimento": dias_para_vencimento,
            })
    proximos_vencimento_sem_valor.sort(key=lambda c: c["dias_para_vencimento"])

    return {
        "total_clientes": total,
        "clientes_com_primeiro_valor": com_valor,
        "clientes_sem_primeiro_valor": total - com_valor,
        "taxa_ativacao_pct": round(com_valor / total * 100) if total else 0,
        "tempo_medio_primeiro_valor_dias": round(sum(tempos_ate_valor) / len(tempos_ate_valor)) if tempos_ate_valor else None,
        "clientes_proximos_vencimento_sem_valor": proximos_vencimento_sem_valor[:limite_clientes],
    }


def buscar_objetivo_do_cliente(objetivo_id, cliente_id):
    """Retorna o nome do objetivo se ele pertencer ao cliente informado
    (checagem de posse pras rotas de impedimentos em app.py), senão None."""
    with db_sql.obter_sessao_leitura() as sessao:
        linha = (
            sessao.query(ClienteObjetivo.nome)
            .filter(ClienteObjetivo.id == objetivo_id, ClienteObjetivo.cliente_id == cliente_id)
            .first()
        )
        return linha[0] if linha else None


def clientes_por_objetivo_nome(nome):
    """Lista os clientes de Implantação que têm um objetivo ESPECÍFICO (nunca
    o universal) com esse nome — pro drill-down do ranking "objetivos mais
    recorrentes"/"maior tempo" do Dashboard de Implantação (clicar no
    objetivo abre a lista de clientes que o usam)."""
    hoje = datetime.now(_FUSO_BR).date()
    with db_sql.obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(ClienteObjetivo, Cliente.idcentral, Cliente.cliente)
            .join(Cliente, Cliente.id == ClienteObjetivo.cliente_id)
            .filter(
                Cliente.tem_implantacao.is_(True),
                ClienteObjetivo.universal.is_(False),
                ClienteObjetivo.nome == nome,
            )
            .order_by(Cliente.cliente)
            .all()
        )
    resultado = []
    for objetivo, idcentral, cliente_nome in linhas:
        criado_em = objetivo.criado_em.date() if objetivo.criado_em else None
        prevista = criado_em + timedelta(days=objetivo.prazo_dias) if (criado_em and objetivo.prazo_dias) else None
        atrasado = bool(not objetivo.feito and prevista and hoje > prevista)
        resultado.append({
            "cliente_id": objetivo.cliente_id,
            "idcentral": idcentral,
            "cliente_nome": cliente_nome,
            "feito": objetivo.feito,
            "concluido_em": objetivo.concluido_em,
            "prazo_dias": objetivo.prazo_dias,
            "atrasado": atrasado,
        })
    return resultado


def listar_objetivos_atrasados():
    """Drill-down do tile "Objetivos atrasados (do prazo individual)" do
    Dashboard — objetivos ESPECÍFICOS não concluídos com prazo vencido."""
    hoje = datetime.now(_FUSO_BR).date()
    with db_sql.obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(ClienteObjetivo, Cliente.idcentral, Cliente.cliente)
            .join(Cliente, Cliente.id == ClienteObjetivo.cliente_id)
            .filter(
                Cliente.tem_implantacao.is_(True),
                ClienteObjetivo.universal.is_(False),
                ClienteObjetivo.feito.is_(False),
                ClienteObjetivo.prazo_dias.isnot(None),
            )
            .all()
        )
    resultado = []
    for objetivo, idcentral, cliente_nome in linhas:
        criado_em = objetivo.criado_em.date() if objetivo.criado_em else None
        prevista = criado_em + timedelta(days=objetivo.prazo_dias) if criado_em else None
        if not prevista or hoje <= prevista:
            continue
        resultado.append({
            "cliente_id": objetivo.cliente_id,
            "idcentral": idcentral,
            "cliente_nome": cliente_nome,
            "objetivo_nome": objetivo.nome,
            "prazo_previsto": prevista.isoformat(),
            "dias_atraso": (hoje - prevista).days,
        })
    resultado.sort(key=lambda r: r["dias_atraso"], reverse=True)
    return resultado


def listar_clientes_sem_objetivo_especifico():
    """Drill-down do tile "Clientes sem objetivo cadastrado" — clientes de
    Implantação sem nenhum objetivo ESPECÍFICO (o universal não conta)."""
    with db_sql.obter_sessao_leitura() as sessao:
        com_especifico = {
            cliente_id for (cliente_id,) in
            sessao.query(ClienteObjetivo.cliente_id)
            .filter(ClienteObjetivo.universal.is_(False))
            .distinct()
            .all()
        }
        clientes = (
            sessao.query(Cliente.id, Cliente.idcentral, Cliente.cliente, Cliente.data_entrada)
            .filter(Cliente.tem_implantacao.is_(True))
            .order_by(Cliente.cliente)
            .all()
        )
    return [
        {"cliente_id": cliente_id, "idcentral": idcentral, "cliente_nome": cliente_nome, "data_entrada": data_entrada}
        for cliente_id, idcentral, cliente_nome, data_entrada in clientes
        if cliente_id not in com_especifico
    ]


def listar_clientes_concluidos_por_objetivos(data_de=None, data_ate=None):
    """Drill-down do tile "Implantações concluídas (por objetivos)" — mesma
    regra de `estatisticas_dashboard_implantacao` (métrica própria desta
    tela, não mexe em Cliente.etapa), mas devolvendo a lista de clientes."""
    def _no_periodo(data):
        if data is None:
            return False
        if data_de and data < data_de:
            return False
        if data_ate and data > data_ate:
            return False
        return True

    with db_sql.obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(ClienteObjetivo, Cliente.idcentral, Cliente.cliente)
            .join(Cliente, Cliente.id == ClienteObjetivo.cliente_id)
            .filter(Cliente.tem_implantacao.is_(True), ClienteObjetivo.universal.is_(False))
            .all()
        )
    por_cliente = {}
    for objetivo, idcentral, cliente_nome in linhas:
        por_cliente.setdefault(objetivo.cliente_id, {
            "idcentral": idcentral, "cliente_nome": cliente_nome, "objetivos": [],
        })["objetivos"].append(objetivo)

    resultado = []
    for cliente_id, info in por_cliente.items():
        objetivos = info["objetivos"]
        if not all(o.feito for o in objetivos):
            continue
        datas_conclusao = [_data_iso(o.concluido_em) for o in objetivos]
        if any(d is None for d in datas_conclusao):
            continue
        data_conclusao = max(datas_conclusao)
        if (data_de or data_ate) and not _no_periodo(data_conclusao):
            continue
        resultado.append({
            "cliente_id": cliente_id, "idcentral": info["idcentral"], "cliente_nome": info["cliente_nome"],
            "total_objetivos": len(objetivos), "concluido_em": data_conclusao.isoformat(),
        })
    resultado.sort(key=lambda r: r["concluido_em"], reverse=True)
    return resultado


def listar_objetivos(cliente_id):
    with db_sql.obter_sessao_leitura() as sessao:
        objetivos = (
            sessao.query(ClienteObjetivo)
            .options(selectinload(ClienteObjetivo.itens))
            .filter(ClienteObjetivo.cliente_id == cliente_id)
            # Universal sempre primeiro (pedido explícito), independente do
            # que `ordem` guarda — ordenar por ele direto deixaria o universal
            # perder a posição depois de qualquer "Salvar objetivos" (ver
            # salvar_objetivos: reatribui `ordem` pela posição no array que o
            # front manda, sem tratamento especial pro universal).
            .order_by(ClienteObjetivo.universal.desc(), ClienteObjetivo.ordem, ClienteObjetivo.id)
            .all()
        )
        impedimentos_por_objetivo = impedimentos_sql.listar_impedimentos_por_objetivos(
            [objetivo.id for objetivo in objetivos]
        )
        return [
            _objetivo_dict(objetivo, impedimentos_por_objetivo.get(objetivo.id, []))
            for objetivo in objetivos
        ]


def _mediana(valores):
    if not valores:
        return None
    ordenados = sorted(valores)
    n = len(ordenados)
    meio = n // 2
    if n % 2:
        return ordenados[meio]
    return (ordenados[meio - 1] + ordenados[meio]) / 2


def _data_iso(valor):
    if not valor:
        return None
    try:
        return datetime.strptime(valor, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def estatisticas_dashboard_implantacao(data_de=None, data_ate=None):
    """Agrega os objetivos de Implantação de todos os clientes com
    Implantação (tem_implantacao) pro Dashboard de Implantação — usado junto
    com a distribuição por etapa (clientes_sql.contar_por_etapa_implantacao),
    que olha pra marco/etapa, não pro conteúdo dos objetivos em si.

    `feito`/`concluido_em`/`prazo_dias` são sempre manuais e independentes
    das sub-atividades (ver docstring de ClienteObjetivo) — essa função nunca
    olha pra `objetivo.itens` pra decidir conclusão, só pra listar no detalhe
    da Ficha (fora daqui).

    `data_de`/`data_ate` (date|None) filtram os eventos "concluído" (olhando
    `concluido_em`) e "iniciado" (olhando `criado_em`) dentro do período —
    "atrasado" é sempre um corte do presente (hoje vs. data prevista), não
    faz sentido recalcular retroativo sem guardar histórico.

    Objetivo com `feito=True` e `concluido_em=""` é um legado (concluído
    antes dessa mudança, sem data retroativa) — conta nos KPIs de
    quantidade/ranking, mas fica fora de qualquer média/mediana de tempo."""
    hoje = datetime.now(_FUSO_BR).date()

    def _no_periodo(data):
        if data is None:
            return False
        if data_de and data < data_de:
            return False
        if data_ate and data > data_ate:
            return False
        return True

    with db_sql.obter_sessao_leitura() as sessao:
        total_clientes_implantacao = (
            sessao.query(func.count(Cliente.id)).filter(Cliente.tem_implantacao.is_(True)).scalar() or 0
        )
        objetivos = (
            sessao.query(ClienteObjetivo)
            .join(Cliente, Cliente.id == ClienteObjetivo.cliente_id)
            .filter(Cliente.tem_implantacao.is_(True))
            .all()
        )

    clientes_com_objetivo = set()
    objetivos_por_cliente = {}  # cliente_id -> [ClienteObjetivo específico, ...] (universal NUNCA entra aqui)
    progresso_por_cliente = {}  # cliente_id -> [concluidos, total] (só específicos)
    por_nome = {}  # nome -> {usados, concluidos, pendentes, atrasados, _tempos: []} (só específicos)
    total_objetivos = 0
    total_objetivos_concluidos = 0
    total_objetivos_atrasados = 0
    total_objetivos_sem_data_retroativa = 0
    total_objetivos_iniciados_periodo = 0
    tempos_conclusao = []  # dias, só objetivos com concluido_em válido

    # Objetivo universal "Implantação" é um objetivo à parte (régua básica de
    # todo cliente, não um projeto contratado) — nunca mistura com o ranking
    # "objetivos mais usados"/tempo/progresso dos objetivos ESPECÍFICOS nem
    # com "todos os objetivos concluídos" (pedido explícito, ver
    # docs/HISTORICO_DECISOES.md). Tem a própria métrica separada abaixo.
    universal_total = 0
    universal_concluidos = 0
    universal_atrasados = 0

    for objetivo in objetivos:
        criado_em = objetivo.criado_em.date() if objetivo.criado_em else None
        concluido_em = _data_iso(objetivo.concluido_em)
        prevista = criado_em + timedelta(days=objetivo.prazo_dias) if (criado_em and objetivo.prazo_dias) else None
        atrasado = bool(not objetivo.feito and prevista and hoje > prevista)

        if objetivo.universal:
            universal_total += 1
            if objetivo.feito:
                universal_concluidos += 1
            if atrasado:
                universal_atrasados += 1
            continue

        total_objetivos += 1
        clientes_com_objetivo.add(objetivo.cliente_id)
        objetivos_por_cliente.setdefault(objetivo.cliente_id, []).append(objetivo)
        contagem_cliente = progresso_por_cliente.setdefault(objetivo.cliente_id, [0, 0])
        contagem_cliente[1] += 1

        if criado_em and _no_periodo(criado_em) and (data_de or data_ate):
            total_objetivos_iniciados_periodo += 1
        if atrasado:
            total_objetivos_atrasados += 1

        entrada_nome = por_nome.setdefault(objetivo.nome, {
            "usados": 0, "concluidos": 0, "pendentes": 0, "atrasados": 0, "_tempos": [],
        })
        entrada_nome["usados"] += 1
        if atrasado:
            entrada_nome["atrasados"] += 1

        if objetivo.feito:
            # Sem filtro de período: conta dentro ("sem valor" vale tudo). Com
            # filtro: só entra se concluído dentro da janela (concluido_em
            # ausente/legado nunca entra quando há período, por falta de data).
            dentro_do_periodo = True if not (data_de or data_ate) else (concluido_em is not None and _no_periodo(concluido_em))
            if dentro_do_periodo:
                total_objetivos_concluidos += 1
                contagem_cliente[0] += 1
                entrada_nome["concluidos"] += 1
                if concluido_em and criado_em:
                    dias = (concluido_em - criado_em).days
                    if dias >= 0:
                        tempos_conclusao.append(dias)
                        entrada_nome["_tempos"].append(dias)
                elif not concluido_em:
                    total_objetivos_sem_data_retroativa += 1
        else:
            if not (data_de or data_ate):
                entrada_nome["pendentes"] += 1

    progressos = [concluidos / total * 100 for concluidos, total in progresso_por_cliente.values() if total]
    progresso_medio = round(sum(progressos) / len(progressos)) if progressos else 0

    ranking_objetivos = []
    for nome, valores in por_nome.items():
        tempos = valores.pop("_tempos")
        pct = round(valores["concluidos"] / valores["usados"] * 100) if valores["usados"] else 0
        ranking_objetivos.append({
            "nome": nome,
            **valores,
            "pct_conclusao": pct,
            "tempo_medio_dias": round(sum(tempos) / len(tempos)) if tempos else None,
        })
    ranking_objetivos.sort(key=lambda item: item["usados"], reverse=True)
    objetivos_maior_tempo = sorted(
        (item for item in ranking_objetivos if item["tempo_medio_dias"] is not None),
        key=lambda item: item["tempo_medio_dias"],
        reverse=True,
    )[:8]

    # "Implantação concluída (por objetivos)" — métrica NOVA, só deste
    # dashboard (decisão explícita: não mexe em Cliente.etapa/concluido_em,
    # que continuam vindo só dos marcos em todo o resto do sistema). Cliente
    # entra aqui só se tiver pelo menos 1 objetivo E todos estiverem feitos.
    tempos_implantacao_objetivos = []
    implantacoes_concluidas_por_objetivos = 0
    for cliente_id, lista in objetivos_por_cliente.items():
        if not all(o.feito for o in lista):
            continue
        datas_conclusao = [_data_iso(o.concluido_em) for o in lista]
        if any(d is None for d in datas_conclusao):
            continue  # tem objetivo legado sem data — não dá pra datar a conclusão
        data_conclusao_cliente = max(datas_conclusao)
        if data_de or data_ate:
            if not _no_periodo(data_conclusao_cliente):
                continue
        implantacoes_concluidas_por_objetivos += 1

    return {
        "total_clientes_implantacao": total_clientes_implantacao,
        "clientes_com_objetivo": len(clientes_com_objetivo),
        "clientes_sem_objetivo": max(total_clientes_implantacao - len(clientes_com_objetivo), 0),
        "total_objetivos": total_objetivos,
        "total_objetivos_concluidos": total_objetivos_concluidos,
        "total_objetivos_atrasados": total_objetivos_atrasados,
        "total_objetivos_sem_data_retroativa": total_objetivos_sem_data_retroativa,
        "total_objetivos_iniciados_periodo": total_objetivos_iniciados_periodo,
        "progresso_medio_por_cliente": progresso_medio,
        "tempo_medio_conclusao_objetivo_dias": round(sum(tempos_conclusao) / len(tempos_conclusao)) if tempos_conclusao else None,
        "tempo_mediano_conclusao_objetivo_dias": _mediana(tempos_conclusao),
        "ranking_objetivos": ranking_objetivos[:8],
        "objetivos_maior_tempo": objetivos_maior_tempo,
        "implantacoes_concluidas_por_objetivos": implantacoes_concluidas_por_objetivos,
        # Métrica própria do objetivo universal — nunca entra no ranking nem
        # na conclusão "por objetivos" acima (ver comentário no loop).
        "universal_total": universal_total,
        "universal_concluidos": universal_concluidos,
        "universal_atrasados": universal_atrasados,
    }


def salvar_objetivos(cliente_id, objetivos):
    with db_sql.obter_sessao() as sessao:
        atuais = (
            sessao.query(ClienteObjetivo)
            .options(selectinload(ClienteObjetivo.itens))
            .filter(ClienteObjetivo.cliente_id == cliente_id)
            .order_by(ClienteObjetivo.ordem, ClienteObjetivo.id)
            .all()
        )
        existentes = {objetivo.id: objetivo for objetivo in atuais}
        atualizados = []
        ids_recebidos = set()

        for ordem, dados in enumerate(objetivos):
            objetivo_id = _id_existente(dados.get("id"), existentes)
            if objetivo_id is not None and objetivo_id in ids_recebidos:
                raise IdentificadorInvalidoError()
            if objetivo_id is not None:
                ids_recebidos.add(objetivo_id)
                objetivo = existentes[objetivo_id]
                objetivo.nome = dados["nome"]
                objetivo.ordem = ordem
            else:
                origem_template_id = dados.get("origem_template_id")
                if origem_template_id is not None and sessao.get(ObjetivoTemplate, origem_template_id) is None:
                    raise IdentificadorInvalidoError()
                objetivo = ClienteObjetivo(
                    cliente_id=cliente_id,
                    nome=dados["nome"],
                    ordem=ordem,
                    origem_template_id=origem_template_id,
                )
                sessao.add(objetivo)
            itens_existentes = {item.id: item for item in objetivo.itens}
            itens_atualizados = []
            item_ids_recebidos = set()
            for item_ordem, item_dados in enumerate(dados["itens"]):
                item_id = _id_existente(item_dados.get("id"), itens_existentes)
                if item_id is not None and item_id in item_ids_recebidos:
                    raise IdentificadorInvalidoError()
                if item_id is not None:
                    item_ids_recebidos.add(item_id)
                    item = itens_existentes[item_id]
                    item.texto = item_dados["texto"]
                    item.ordem = item_ordem
                    if item_dados["feito"] and not item.feito:
                        item.concluido_em = datetime.now(_FUSO_BR).date().isoformat()
                    elif not item_dados["feito"]:
                        item.concluido_em = ""
                    item.feito = item_dados["feito"]
                else:
                    item = ClienteObjetivoItem(
                        texto=item_dados["texto"],
                        feito=item_dados["feito"],
                        ordem=item_ordem,
                        concluido_em=(
                            datetime.now(_FUSO_BR).date().isoformat()
                            if item_dados["feito"] else ""
                        ),
                    )
                itens_atualizados.append(item)
            objetivo.itens = itens_atualizados

            # Conclusão do objetivo é sempre manual e independente dos itens
            # acima (ver docstring de ClienteObjetivo). `concluido_em`: se o
            # front mandou um valor explícito (edição manual da data), usa
            # esse; senão carimba hoje na 1ª vez que `feito` vira True, e
            # limpa se o objetivo for reaberto.
            concluido_em_recebido = dados.get("concluido_em")
            feito_novo = dados["feito"]
            if concluido_em_recebido:
                objetivo.concluido_em = concluido_em_recebido
            elif feito_novo and not objetivo.feito:
                objetivo.concluido_em = datetime.now(_FUSO_BR).date().isoformat()
            elif not feito_novo:
                objetivo.concluido_em = ""
            objetivo.feito = feito_novo
            objetivo.prazo_dias = dados.get("prazo_dias")
            atualizados.append(objetivo)

        for objetivo in atuais:
            # Objetivo universal nunca é excluído por aqui, mesmo que o front
            # não o reenvie na lista (ex.: removido da tela antes de salvar) —
            # é obrigatório em todo cliente de Implantação (ver prompt/plano
            # aprovado).
            if objetivo.id not in ids_recebidos and not objetivo.universal:
                sessao.delete(objetivo)
        sessao.flush()
        # Sem impedimentos aqui de propósito: salvar objetivo não muda
        # impedimento nenhum, e buscá-los de novo só pra isso seria 1 SELECT
        # a mais sem necessidade — o próximo GET (listar_objetivos) já traz
        # prazo_ajustado_dias correto.
        resultado = [_objetivo_dict(objetivo) for objetivo in atualizados]
        return resultado
