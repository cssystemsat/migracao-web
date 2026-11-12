"""Persistência de impedimentos de objetivos de Implantação (ver seção 5 do
contexto de negócio em docs/DOCUMENTACAO_FUNCIONAL.md).

Nunca exclui um impedimento (preserva o histórico de atraso, por decisão
explícita do contexto de negócio) — só cria e edita/resolve."""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.orm import selectinload

import db_sql
from models import Cliente, ClienteObjetivo, ClienteObjetivoImpedimento

_FUSO_BR = ZoneInfo("America/Sao_Paulo")

CATEGORIAS = {
    "cliente": [
        "Falta de equipamentos",
        "Falta de chips/SIM cards",
        "Equipamentos não instalados",
        "Falta de operação definida",
        "Falta de clientes próprios",
        "Falta de informações",
        "Indisponibilidade para treinamento",
        "Falta de retorno",
        "Indefinição operacional",
        "Outro",
    ],
    "systemsat": [
        "Problema na plataforma",
        "Problema de configuração",
        "Dependência do suporte",
        "Dependência de desenvolvimento",
        "Falta de disponibilidade interna",
        "Treinamento pendente",
        "Retrabalho interno",
        "Outro",
    ],
    "terceiro": [
        "Atraso de fornecedor",
        "Problema de operadora",
        "Problema de fabricante",
        "Dependência de instalação terceirizada",
        "Outro",
    ],
}
RESPONSABILIDADES = tuple(CATEGORIAS.keys())
STATUS_VALIDOS = ("ativo", "resolvido")


class RegistroNaoEncontradoError(Exception):
    pass


def _impedimento_dict(impedimento):
    return {
        "id": impedimento.id,
        "cliente_objetivo_id": impedimento.cliente_objetivo_id,
        "categoria": impedimento.categoria,
        "responsabilidade": impedimento.responsabilidade,
        "descricao": impedimento.descricao,
        "data_inicio": impedimento.data_inicio,
        "data_resolucao": impedimento.data_resolucao,
        "status": impedimento.status,
        "impacto": impedimento.impacto,
        "proxima_acao": impedimento.proxima_acao,
        "responsavel": impedimento.responsavel,
    }


def buscar_contexto(impedimento_id):
    """(cliente_id, objetivo_nome) do impedimento, ou None se não existir —
    usado pelas rotas de app.py pra auditoria/timeline e pra validar posse
    sem precisar do cliente_objetivo_id na URL (rotas por impedimento_id)."""
    with db_sql.obter_sessao_leitura() as sessao:
        linha = (
            sessao.query(ClienteObjetivo.cliente_id, ClienteObjetivo.nome)
            .join(ClienteObjetivoImpedimento, ClienteObjetivoImpedimento.cliente_objetivo_id == ClienteObjetivo.id)
            .filter(ClienteObjetivoImpedimento.id == impedimento_id)
            .first()
        )
        return tuple(linha) if linha else None


def listar_impedimentos(cliente_objetivo_id):
    with db_sql.obter_sessao_leitura() as sessao:
        impedimentos = (
            sessao.query(ClienteObjetivoImpedimento)
            .filter(ClienteObjetivoImpedimento.cliente_objetivo_id == cliente_objetivo_id)
            .order_by(ClienteObjetivoImpedimento.criado_em)
            .all()
        )
        return [_impedimento_dict(i) for i in impedimentos]


def criar_impedimento(cliente_objetivo_id, dados):
    with db_sql.obter_sessao() as sessao:
        if sessao.get(ClienteObjetivo, cliente_objetivo_id) is None:
            raise RegistroNaoEncontradoError()
        novo = ClienteObjetivoImpedimento(
            cliente_objetivo_id=cliente_objetivo_id,
            categoria=dados["categoria"],
            responsabilidade=dados["responsabilidade"],
            descricao=dados.get("descricao", ""),
            data_inicio=dados.get("data_inicio") or datetime.now(_FUSO_BR).date().isoformat(),
            impacto=dados.get("impacto", ""),
            proxima_acao=dados.get("proxima_acao", ""),
            responsavel=dados.get("responsavel", ""),
        )
        sessao.add(novo)
        sessao.flush()
        return _impedimento_dict(novo)


def atualizar_impedimento(impedimento_id, dados):
    """Edita os campos descritivos — não usado pra mudar `status`/
    `data_resolucao` (ver `resolver_impedimento`/`reabrir_impedimento`)."""
    with db_sql.obter_sessao() as sessao:
        impedimento = sessao.get(ClienteObjetivoImpedimento, impedimento_id)
        if impedimento is None:
            raise RegistroNaoEncontradoError()
        for campo in ("categoria", "responsabilidade", "descricao", "data_inicio", "impacto", "proxima_acao", "responsavel"):
            if campo in dados:
                setattr(impedimento, campo, dados[campo])
        return _impedimento_dict(impedimento)


def resolver_impedimento(impedimento_id, data_resolucao=None):
    with db_sql.obter_sessao() as sessao:
        impedimento = sessao.get(ClienteObjetivoImpedimento, impedimento_id)
        if impedimento is None:
            raise RegistroNaoEncontradoError()
        impedimento.status = "resolvido"
        impedimento.data_resolucao = data_resolucao or datetime.now(_FUSO_BR).date().isoformat()
        return _impedimento_dict(impedimento)


def reabrir_impedimento(impedimento_id):
    with db_sql.obter_sessao() as sessao:
        impedimento = sessao.get(ClienteObjetivoImpedimento, impedimento_id)
        if impedimento is None:
            raise RegistroNaoEncontradoError()
        impedimento.status = "ativo"
        impedimento.data_resolucao = ""
        return _impedimento_dict(impedimento)


def _data_iso(valor):
    if not valor:
        return None
    try:
        return datetime.strptime(valor, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def dias_impedimento_objetivo(impedimentos, hoje=None):
    """Soma os dias de impedimento de um objetivo, mesclando períodos que se
    sobrepõem (nunca descontar o mesmo dia duas vezes — ver seção 5.2 do
    contexto de negócio). `impedimentos` é a lista de dicts já carregada
    (`_impedimento_dict`); impedimento ainda `ativo` conta até hoje."""
    hoje = hoje or datetime.now(_FUSO_BR).date()
    intervalos = []
    for imp in impedimentos:
        inicio = _data_iso(imp["data_inicio"])
        if inicio is None:
            continue
        fim = _data_iso(imp["data_resolucao"]) if imp["status"] == "resolvido" else hoje
        if fim is None or fim < inicio:
            continue
        intervalos.append((inicio, fim))
    if not intervalos:
        return 0
    intervalos.sort()
    mesclados = [intervalos[0]]
    for inicio, fim in intervalos[1:]:
        ultimo_inicio, ultimo_fim = mesclados[-1]
        if inicio <= ultimo_fim + timedelta(days=1):
            mesclados[-1] = (ultimo_inicio, max(ultimo_fim, fim))
        else:
            mesclados.append((inicio, fim))
    return sum((fim - inicio).days + 1 for inicio, fim in mesclados)


def listar_por_filtro(responsabilidade=None, categoria=None):
    """Drill-down dos blocos "Por responsabilidade"/"Maiores categorias" do
    Dashboard — lista os impedimentos (com cliente/objetivo) que batem com o
    filtro, mais recentes primeiro."""
    with db_sql.obter_sessao_leitura() as sessao:
        consulta = (
            sessao.query(
                ClienteObjetivoImpedimento, ClienteObjetivo.nome, Cliente.idcentral, Cliente.cliente,
            )
            .join(ClienteObjetivo, ClienteObjetivo.id == ClienteObjetivoImpedimento.cliente_objetivo_id)
            .join(Cliente, Cliente.id == ClienteObjetivo.cliente_id)
        )
        if responsabilidade:
            consulta = consulta.filter(ClienteObjetivoImpedimento.responsabilidade == responsabilidade)
        if categoria:
            consulta = consulta.filter(ClienteObjetivoImpedimento.categoria == categoria)
        linhas = consulta.order_by(ClienteObjetivoImpedimento.criado_em.desc()).all()
    return [
        {
            **_impedimento_dict(imp),
            "objetivo_nome": objetivo_nome,
            "idcentral": idcentral,
            "cliente_nome": cliente_nome,
        }
        for imp, objetivo_nome, idcentral, cliente_nome in linhas
    ]


def estatisticas_dashboard_impedimentos(limite_clientes=10, hoje=None):
    """Bloco "Impedimentos e gargalos" do Dashboard de Implantação (seção 8.5
    do contexto de negócio): quantidade ativa, tempo médio de resolução,
    ranking por categoria/responsabilidade e os clientes com mais dias de
    atraso ATIVO por impedimento agora (não soma histórico já resolvido —
    "cliente que tá 60 dias atrasado" é sobre o que ainda está bloqueando
    hoje, reaproveitando `dias_impedimento_objetivo` por objetivo, somado por
    cliente quando ele tem mais de um objetivo com impedimento ativo)."""
    hoje = hoje or datetime.now(_FUSO_BR).date()
    with db_sql.obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(
                ClienteObjetivoImpedimento, ClienteObjetivo.id, ClienteObjetivo.cliente_id,
                ClienteObjetivo.nome, Cliente.idcentral, Cliente.cliente,
            )
            .join(ClienteObjetivo, ClienteObjetivo.id == ClienteObjetivoImpedimento.cliente_objetivo_id)
            .join(Cliente, Cliente.id == ClienteObjetivo.cliente_id)
            .all()
        )

    total_ativos = 0
    total_resolvidos = 0
    tempos_resolvidos = []
    por_responsabilidade = {resp: {"total": 0, "ativos": 0} for resp in RESPONSABILIDADES}
    por_categoria = {}  # (responsabilidade, categoria) -> {"total": 0, "ativos": 0}
    por_objetivo = {}  # objetivo_id -> {cliente_id, objetivo_nome, idcentral, cliente_nome, impedimentos: [dict,...]}

    for imp, objetivo_id, cliente_id, objetivo_nome, idcentral, cliente_nome in linhas:
        d = _impedimento_dict(imp)
        por_objetivo.setdefault(objetivo_id, {
            "cliente_id": cliente_id, "objetivo_nome": objetivo_nome,
            "idcentral": idcentral, "cliente_nome": cliente_nome, "impedimentos": [],
        })["impedimentos"].append(d)

        resp = por_responsabilidade.setdefault(imp.responsabilidade, {"total": 0, "ativos": 0})
        resp["total"] += 1
        cat = por_categoria.setdefault((imp.responsabilidade, imp.categoria), {"total": 0, "ativos": 0})
        cat["total"] += 1
        if imp.status == "ativo":
            total_ativos += 1
            resp["ativos"] += 1
            cat["ativos"] += 1
        else:
            total_resolvidos += 1
            inicio = _data_iso(imp.data_inicio)
            fim = _data_iso(imp.data_resolucao)
            if inicio and fim and fim >= inicio:
                tempos_resolvidos.append((fim - inicio).days)

    dias_por_cliente = {}  # cliente_id -> {cliente_id, idcentral, cliente_nome, dias, objetivos: [...]}
    for objetivo_id, info in por_objetivo.items():
        ativos = [i for i in info["impedimentos"] if i["status"] == "ativo"]
        if not ativos:
            continue
        dias = dias_impedimento_objetivo(ativos, hoje=hoje)
        if dias <= 0:
            continue
        cliente = dias_por_cliente.setdefault(info["cliente_id"], {
            "cliente_id": info["cliente_id"], "idcentral": info["idcentral"],
            "cliente_nome": info["cliente_nome"], "dias": 0, "objetivos": [],
        })
        cliente["dias"] += dias
        cliente["objetivos"].append({"objetivo_id": objetivo_id, "objetivo_nome": info["objetivo_nome"], "dias": dias})

    clientes_mais_atrasados = sorted(dias_por_cliente.values(), key=lambda c: c["dias"], reverse=True)[:limite_clientes]

    ranking_categorias = sorted(
        (
            {"responsabilidade": resp, "categoria": cat, **valores}
            for (resp, cat), valores in por_categoria.items()
        ),
        key=lambda c: c["total"], reverse=True,
    )[:10]

    return {
        "total_ativos": total_ativos,
        "total_resolvidos": total_resolvidos,
        "tempo_medio_resolucao_dias": round(sum(tempos_resolvidos) / len(tempos_resolvidos)) if tempos_resolvidos else None,
        "por_responsabilidade": por_responsabilidade,
        "ranking_categorias": ranking_categorias,
        "clientes_mais_atrasados": clientes_mais_atrasados,
    }


def listar_impedimentos_por_objetivos(cliente_objetivo_ids):
    """Carrega os impedimentos de vários objetivos de uma vez (dashboard/
    cálculo em lote) — evita 1 SELECT por objetivo."""
    if not cliente_objetivo_ids:
        return {}
    with db_sql.obter_sessao_leitura() as sessao:
        impedimentos = (
            sessao.query(ClienteObjetivoImpedimento)
            .filter(ClienteObjetivoImpedimento.cliente_objetivo_id.in_(cliente_objetivo_ids))
            .order_by(ClienteObjetivoImpedimento.criado_em)
            .all()
        )
    por_objetivo = {}
    for imp in impedimentos:
        por_objetivo.setdefault(imp.cliente_objetivo_id, []).append(_impedimento_dict(imp))
    return por_objetivo
