"""Persistência de templates e objetivos de Implantação com sub-atividades."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import selectinload

import db_sql
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


def _template_dict(template):
    return {
        "id": template.id,
        "nome": template.nome,
        "prazo_dias": template.prazo_dias,
        "itens": [
            {"id": item.id, "texto": item.texto, "ordem": item.ordem}
            for item in template.itens
        ],
    }


def _objetivo_dict(objetivo):
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
    return {
        "id": objetivo.id,
        "nome": objetivo.nome,
        "ordem": objetivo.ordem,
        "feito": objetivo.feito,
        "concluido_em": objetivo.concluido_em,
        "prazo_dias": objetivo.prazo_dias,
        "criado_em": objetivo.criado_em.date().isoformat() if objetivo.criado_em else "",
        "origem_template_id": objetivo.origem_template_id,
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
        sessao.delete(template)


def listar_objetivos(cliente_id):
    with db_sql.obter_sessao_leitura() as sessao:
        objetivos = (
            sessao.query(ClienteObjetivo)
            .options(selectinload(ClienteObjetivo.itens))
            .filter(ClienteObjetivo.cliente_id == cliente_id)
            .order_by(ClienteObjetivo.ordem, ClienteObjetivo.id)
            .all()
        )
        return [_objetivo_dict(objetivo) for objetivo in objetivos]


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
    objetivos_por_cliente = {}  # cliente_id -> [ClienteObjetivo, ...]
    progresso_por_cliente = {}  # cliente_id -> [concluidos, total]
    por_nome = {}  # nome -> {usados, concluidos, pendentes, atrasados, _tempos: []}
    total_objetivos = 0
    total_objetivos_concluidos = 0
    total_objetivos_atrasados = 0
    total_objetivos_sem_data_retroativa = 0
    total_objetivos_iniciados_periodo = 0
    tempos_conclusao = []  # dias, só objetivos com concluido_em válido

    for objetivo in objetivos:
        total_objetivos += 1
        clientes_com_objetivo.add(objetivo.cliente_id)
        objetivos_por_cliente.setdefault(objetivo.cliente_id, []).append(objetivo)
        contagem_cliente = progresso_por_cliente.setdefault(objetivo.cliente_id, [0, 0])
        contagem_cliente[1] += 1

        criado_em = objetivo.criado_em.date() if objetivo.criado_em else None
        concluido_em = _data_iso(objetivo.concluido_em)
        prevista = criado_em + timedelta(days=objetivo.prazo_dias) if (criado_em and objetivo.prazo_dias) else None
        atrasado = bool(not objetivo.feito and prevista and hoje > prevista)

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
            if objetivo.id not in ids_recebidos:
                sessao.delete(objetivo)
        sessao.flush()
        resultado = [_objetivo_dict(objetivo) for objetivo in atualizados]
        return resultado
