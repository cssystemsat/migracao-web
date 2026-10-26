"""Acesso SQL a ClienteEvento (timeline por setor da Ficha)."""
from db_sql import obter_sessao
from models import Cliente, ClienteEvento


def _evento_para_dict(e):
    return {
        "id": e.id,
        "setor": e.setor,
        "titulo": e.titulo,
        "descricao": e.descricao,
        "data": e.data,
        "responsavel": e.responsavel,
        "tag": e.tag,
    }


def cliente_existe(cliente_id):
    with obter_sessao() as sessao:
        return sessao.get(Cliente, cliente_id) is not None


def listar_eventos(cliente_id):
    with obter_sessao() as sessao:
        eventos = sessao.query(ClienteEvento).filter(ClienteEvento.cliente_id == cliente_id).all()
        return [_evento_para_dict(e) for e in eventos]


def criar_evento(cliente_id, dados):
    novo = ClienteEvento(cliente_id=cliente_id, **dados)
    with obter_sessao() as sessao:
        sessao.add(novo)
        sessao.flush()
        return _evento_para_dict(novo)


def editar_evento(cliente_id, evento_id, dados):
    with obter_sessao() as sessao:
        alvo = sessao.get(ClienteEvento, evento_id)
        if not alvo or alvo.cliente_id != cliente_id:
            return None
        for campo, valor in dados.items():
            setattr(alvo, campo, valor)
        return _evento_para_dict(alvo)


def excluir_evento(cliente_id, evento_id):
    with obter_sessao() as sessao:
        alvo = sessao.get(ClienteEvento, evento_id)
        if not alvo or alvo.cliente_id != cliente_id:
            return False
        sessao.delete(alvo)
        return True


def recalcular_ultima_acao(cliente_id):
    """Denormaliza o evento mais recente (maior "data") direto no Cliente —
    mesmo racional de antes, agora com ORDER BY SQL em vez de order_by do
    Firestore."""
    with obter_sessao() as sessao:
        cliente = sessao.get(Cliente, cliente_id)
        if not cliente:
            return
        ultimo = (
            sessao.query(ClienteEvento)
            .filter(ClienteEvento.cliente_id == cliente_id)
            .order_by(ClienteEvento.data.desc())
            .first()
        )
        if ultimo:
            cliente.ultima_acao = f"[{ultimo.setor}] {ultimo.titulo}"
            cliente.ultima_acao_data = ultimo.data or ""
        else:
            cliente.ultima_acao = ""
            cliente.ultima_acao_data = ""
