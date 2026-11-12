"""Persistência do diagnóstico de prontidão do cliente (seção 7 do contexto
de negócio em docs/DOCUMENTACAO_FUNCIONAL.md) — fotografia das condições
iniciais do cliente, não um checklist de tarefas."""
from datetime import datetime, timezone

import db_sql
from models import Cliente, ClienteDiagnosticoProntidao

CAMPOS = (
    "possui_equipamentos",
    "possui_chips",
    "possui_operacao_definida",
    "possui_clientes_proprios",
    "equipe_disponivel_treinamento",
    "estrutura_para_operar",
)


class RegistroNaoEncontradoError(Exception):
    pass


def _diagnostico_dict(cliente_id, diagnostico):
    if diagnostico is None:
        return {
            "cliente_id": cliente_id,
            **{campo: None for campo in CAMPOS},
            "observacoes": "",
            "classificacao": "nao_avaliado",
            "nota": None,
            "atualizado_em": "",
            "atualizado_por": "",
        }
    valores = {campo: getattr(diagnostico, campo) for campo in CAMPOS}
    return {
        "cliente_id": cliente_id,
        **valores,
        "observacoes": diagnostico.observacoes,
        "classificacao": _classificar(valores),
        "nota": _nota(valores),
        "atualizado_em": diagnostico.atualizado_em.isoformat() if diagnostico.atualizado_em else "",
        "atualizado_por": diagnostico.atualizado_por,
    }


def _classificar(valores):
    """"Pronto"/"parcialmente preparado"/"não preparado" (seção 7) — não
    avaliado (todo campo None) não é "não preparado": é falta de dado, não
    julgamento negativo do cliente."""
    respondidos = [v for v in valores.values() if v is not None]
    if not respondidos:
        return "nao_avaliado"
    if all(v is True for v in respondidos) and len(respondidos) == len(valores):
        return "pronto"
    if all(v is False for v in respondidos) and len(respondidos) == len(valores):
        return "nao_preparado"
    return "parcial"


def _nota(valores):
    """Nota de 0 a 10 — proporção de "Sim" entre as perguntas respondidas
    (campo None não entra na conta, nem a favor nem contra). Serve de apoio
    pro CS num eventual churn: mostra, com um número, que as condições de
    entrada do cliente já eram frágeis desde o diagnóstico inicial — não é
    recalculada depois, continua refletindo o que foi respondido."""
    respondidos = [v for v in valores.values() if v is not None]
    if not respondidos:
        return None
    return round(10 * sum(1 for v in respondidos if v is True) / len(respondidos), 1)


def buscar(cliente_id):
    with db_sql.obter_sessao_leitura() as sessao:
        diagnostico = sessao.get(ClienteDiagnosticoProntidao, cliente_id)
        return _diagnostico_dict(cliente_id, diagnostico)


def salvar(cliente_id, dados, usuario_nome=""):
    with db_sql.obter_sessao() as sessao:
        if sessao.get(Cliente, cliente_id) is None:
            raise RegistroNaoEncontradoError()
        diagnostico = sessao.get(ClienteDiagnosticoProntidao, cliente_id)
        if diagnostico is None:
            diagnostico = ClienteDiagnosticoProntidao(cliente_id=cliente_id)
            sessao.add(diagnostico)
        for campo in CAMPOS:
            if campo in dados:
                setattr(diagnostico, campo, dados[campo])
        if "observacoes" in dados:
            diagnostico.observacoes = dados["observacoes"]
        diagnostico.atualizado_por = usuario_nome
        sessao.flush()
        return _diagnostico_dict(cliente_id, diagnostico)
