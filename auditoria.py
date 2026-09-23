"""Helpers de auditoria/histórico: ponto único de escrita nas tabelas SQL
log_auditoria/log_auditoria_mudanca/historico_cliente a partir das rotas de
CRUD de clientes e tarefas em app.py (Fase 1 do plano de auditoria/histórico).

Roda em paralelo ao Firestore — nunca é a fonte de verdade da ação em si,
só o rastro. Por isso "melhor esforço": se a escrita aqui falhar, a ação
principal no Firestore (que já rodou antes de chamar isto) continua valendo.
"""
import logging

from flask import session

from db_sql import obter_sessao
from models import HistoricoCliente, LogAuditoria, LogAuditoriaMudanca

logger = logging.getLogger(__name__)

# Rótulo de exibição em historico_cliente.origem, por entidade que originou a ação.
ORIGEM_HISTORICO_POR_ENTIDADE = {"cliente": "Cliente", "tarefa": "Tarefa"}


def diff_campos(doc_atual: dict, doc_novo: dict, rotulos: dict) -> list:
    """Compara campo a campo (só os presentes em `rotulos`) e retorna a lista
    de mudanças no formato que LogAuditoriaMudanca espera. Ignora campos
    iguais — é assim que se descobre "o que mudou de fato" num editar_cliente,
    que faz doc_ref.set() do dict inteiro, não um update parcial."""
    mudancas = []
    for campo, rotulo in rotulos.items():
        valor_de = doc_atual.get(campo)
        valor_para = doc_novo.get(campo)
        if valor_de == valor_para:
            continue
        mudancas.append({
            "campo": campo,
            "rotulo": rotulo,
            "valor_de": "" if valor_de is None else str(valor_de),
            "valor_para": "" if valor_para is None else str(valor_para),
        })
    return mudancas


def _resumo_mudancas(mudancas):
    return "; ".join(f"{m['rotulo']}: {m['valor_de']!r} → {m['valor_para']!r}" for m in mudancas)


def registrar_acao(*, acao, entidade_tipo, entidade_id, entidade_nome="",
                    mudancas=None, titulo, cliente_id=None, idcentral="",
                    cliente_nome="", tipo_historico="auditoria", tarefa_id=None):
    """Escreve LogAuditoria (+ LogAuditoriaMudanca) sempre; se cliente_id for
    passado, escreve também um HistoricoCliente (autor = usuário da sessão).
    Tudo numa única `with obter_sessao()` (atômico entre as duas tabelas).

    Nunca propaga exceção — melhor esforço confirmado com a usuária: se o
    Postgres estiver fora do ar, a ação no Firestore (já concluída antes
    desta chamada) não pode ser derrubada por causa do log. Só loga o erro.
    """
    usuario_id = session.get("app_usuario_id", "")
    usuario_nome = session.get("app_usuario_nome", "")

    try:
        with obter_sessao() as sessao:
            log = LogAuditoria(
                usuario_id=usuario_id,
                usuario_nome=usuario_nome,
                acao=acao,
                entidade_tipo=entidade_tipo,
                entidade_id=entidade_id,
                entidade_nome=entidade_nome,
            )
            if mudancas:
                log.mudancas = [
                    LogAuditoriaMudanca(
                        campo=m["campo"],
                        rotulo=m.get("rotulo", ""),
                        valor_de=m.get("valor_de"),
                        valor_para=m.get("valor_para"),
                    )
                    for m in mudancas
                ]
            sessao.add(log)
            sessao.flush()  # popula log.id pra referenciar em HistoricoCliente.log_auditoria_id

            if cliente_id:
                sessao.add(HistoricoCliente(
                    cliente_id=cliente_id,
                    idcentral=idcentral,
                    cliente_nome=cliente_nome,
                    tipo=tipo_historico,
                    origem=ORIGEM_HISTORICO_POR_ENTIDADE.get(entidade_tipo, "Sistema"),
                    titulo=titulo,
                    descricao=_resumo_mudancas(mudancas) if mudancas else None,
                    autor_id=usuario_id,
                    autor_nome=usuario_nome,
                    tarefa_id=tarefa_id,
                    log_auditoria_id=log.id,
                    editavel=False,
                ))
    except Exception:
        logger.exception(
            "Falha ao registrar auditoria (acao=%s, entidade=%s/%s) - Firestore ja foi "
            "atualizado, so o rastro em SQL que nao gravou.",
            acao, entidade_tipo, entidade_id,
        )
