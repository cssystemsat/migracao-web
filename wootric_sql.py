"""Acesso SQL às avaliações de NPS da Wootric persistidas localmente (ver
models.WootricAvaliacao / wootric_api.py). A Ficha lê só daqui — nunca
chama a API da Wootric na hora de abrir a tela; quem alimenta a tabela é a
sincronização incremental (ver sincronizar_avaliacoes_wootric em app.py)."""
from datetime import datetime, timezone

from sqlalchemy import func

from db_sql import obter_sessao
from models import WootricAvaliacao


def _avaliacao_para_dict(a):
    return {
        "wootric_id": a.wootric_id,
        "score": a.score,
        "text": a.texto,
        "email": a.email,
        "created_at": a.criado_em_wootric.isoformat() if a.criado_em_wootric else None,
    }


def listar_por_idcentral(idcentral):
    idcentral = (idcentral or "").strip()
    if not idcentral:
        return []
    with obter_sessao() as sessao:
        avaliacoes = (
            sessao.query(WootricAvaliacao)
            .filter(WootricAvaliacao.idcentral == idcentral)
            .order_by(WootricAvaliacao.criado_em_wootric.desc())
            .all()
        )
        return [_avaliacao_para_dict(a) for a in avaliacoes]


def data_mais_recente():
    """Timestamp (timezone-aware) da avaliação mais recente já salva, ou
    None se a tabela estiver vazia — usado como cursor da sincronização
    incremental."""
    with obter_sessao() as sessao:
        valor = sessao.query(func.max(WootricAvaliacao.criado_em_wootric)).scalar()
        if valor is None:
            return None
        return valor if valor.tzinfo else valor.replace(tzinfo=timezone.utc)


def upsert_respostas(respostas):
    """`respostas` = lista de dicts já normalizados por
    `wootric_api._normalizar_resposta` (wootric_id, idcentral, score, texto,
    email, criado_em_wootric). Ignora as sem idcentral (não dá pra achar o
    cliente — fica só fora da tabela, não é erro). Devolve
    (novas, atualizadas, sem_idcentral).

    Busca os existentes de uma vez só (1 SELECT com IN, não 1 por resposta)
    — na primeira sincronização (tabela vazia, até 1500 respostas de carga
    inicial) um SELECT por item deixaria isso lento de verdade contra um
    Postgres remoto (é round-trip de rede, não processamento)."""
    com_idcentral = [r for r in respostas if r["idcentral"]]
    sem_idcentral = len(respostas) - len(com_idcentral)
    if not com_idcentral:
        return 0, 0, sem_idcentral

    agora = datetime.now(timezone.utc)
    novas = atualizadas = 0
    with obter_sessao() as sessao:
        ids = [r["wootric_id"] for r in com_idcentral]
        existentes = {
            row.wootric_id: row
            for row in sessao.query(WootricAvaliacao).filter(WootricAvaliacao.wootric_id.in_(ids)).all()
        }
        for r in com_idcentral:
            existente = existentes.get(r["wootric_id"])
            if existente:
                existente.idcentral = r["idcentral"]
                existente.score = r["score"]
                existente.texto = r["texto"]
                existente.email = r["email"]
                existente.criado_em_wootric = r["criado_em_wootric"]
                existente.sincronizado_em = agora
                atualizadas += 1
            else:
                sessao.add(WootricAvaliacao(
                    wootric_id=r["wootric_id"],
                    idcentral=r["idcentral"],
                    score=r["score"],
                    texto=r["texto"],
                    email=r["email"],
                    criado_em_wootric=r["criado_em_wootric"],
                    sincronizado_em=agora,
                ))
                novas += 1
    return novas, atualizadas, sem_idcentral
