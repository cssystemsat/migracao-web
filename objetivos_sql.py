"""Persistência de templates e objetivos de Implantação com sub-atividades."""
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy.orm import selectinload

import db_sql
from models import ClienteObjetivo, ClienteObjetivoItem, ObjetivoTemplate, ObjetivoTemplateItem

_FUSO_BR = ZoneInfo("America/Sao_Paulo")


class RegistroNaoEncontradoError(Exception):
    pass


class IdentificadorInvalidoError(Exception):
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
        "itens": [
            {"id": item.id, "texto": item.texto, "ordem": item.ordem}
            for item in template.itens
        ],
    }


def _objetivo_dict(objetivo):
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
    feito = all(item["feito"] for item in itens) if itens else objetivo.feito
    return {
        "id": objetivo.id,
        "nome": objetivo.nome,
        "ordem": objetivo.ordem,
        "feito": feito,
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


def salvar_template(nome, itens, template_id=None):
    with db_sql.obter_sessao() as sessao:
        template = sessao.get(ObjetivoTemplate, template_id) if template_id is not None else None
        if template_id is not None and template is None:
            raise RegistroNaoEncontradoError()
        if template is None:
            template = ObjetivoTemplate(nome=nome)
            sessao.add(template)
            existentes = {}
        else:
            existentes = {item.id: item for item in template.itens}
            template.nome = nome

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
            if not itens_atualizados:
                objetivo.feito = dados["feito"]
            else:
                objetivo.feito = all(item.feito for item in itens_atualizados)
            atualizados.append(objetivo)

        for objetivo in atuais:
            if objetivo.id not in ids_recebidos:
                sessao.delete(objetivo)
        sessao.flush()
        resultado = [_objetivo_dict(objetivo) for objetivo in atualizados]
        return resultado
