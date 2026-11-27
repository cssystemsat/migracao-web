"""Acesso SQL a Tarefa. `responsavel_id`/`criado_por` são FK pra Usuario,
`cliente_id` FK pra Cliente (ON DELETE CASCADE — ver clientes_sql.excluir_cliente,
que lê as tarefas antes de apagar o cliente pra registrar auditoria, já que o
cascade em si não loga nada)."""
from db_sql import obter_sessao
from models import Tarefa


def _tarefa_para_dict(t):
    return {
        "id": t.id,
        "titulo": t.titulo,
        "descricao": t.descricao,
        "data_limite": t.data_limite,
        "cliente_id": t.cliente_id,
        "idcentral": t.idcentral,
        "cliente_nome": t.cliente_nome,
        "responsavel_id": t.responsavel_id,
        "responsavel_nome": t.responsavel_nome,
        "concluida": t.concluida,
        "concluida_em": t.concluida_em,
        "criado_por": t.criado_por,
        "criado_por_nome": t.criado_por_nome,
        "criado_em": t.criado_em,
        "resultado": t.resultado,
        "resultado_descricao": t.resultado_descricao,
        "finalizada_por_nome": t.finalizada_por_nome,
    }


def listar_por_cliente(cliente_id):
    with obter_sessao() as sessao:
        tarefas = sessao.query(Tarefa).filter(Tarefa.cliente_id == cliente_id).all()
        return [_tarefa_para_dict(t) for t in tarefas]


def listar_apenas_minhas(usuario_id):
    with obter_sessao() as sessao:
        tarefas = sessao.query(Tarefa).filter(Tarefa.responsavel_id == usuario_id).all()
        return [_tarefa_para_dict(t) for t in tarefas]


def listar_minhas_e_criadas(usuario_id):
    with obter_sessao() as sessao:
        tarefas = sessao.query(Tarefa).filter(
            (Tarefa.responsavel_id == usuario_id) | (Tarefa.criado_por == usuario_id)
        ).all()
        return [_tarefa_para_dict(t) for t in tarefas]


def listar_nao_concluidas():
    """Usado pelo job de notificação de prazo (ver app.py) — varre todas as
    tarefas abertas pra achar as que estão perto do vencimento ou atrasadas.
    Tabela de tarefas é pequena (uso interno da equipe), não precisa de filtro
    de data no SQL."""
    with obter_sessao() as sessao:
        tarefas = sessao.query(Tarefa).filter(Tarefa.concluida.is_(False)).all()
        return [_tarefa_para_dict(t) for t in tarefas]


def buscar_tarefa(tarefa_id):
    with obter_sessao() as sessao:
        t = sessao.get(Tarefa, tarefa_id)
        return _tarefa_para_dict(t) if t else None


def criar_tarefa(campos):
    nova = Tarefa(**campos)
    with obter_sessao() as sessao:
        sessao.add(nova)
        sessao.flush()
        return _tarefa_para_dict(nova)


def editar_tarefa(tarefa_id, campos):
    with obter_sessao() as sessao:
        alvo = sessao.get(Tarefa, tarefa_id)
        if not alvo:
            return None
        for campo, valor in campos.items():
            setattr(alvo, campo, valor)
        return _tarefa_para_dict(alvo)


def concluir_tarefa(tarefa_id, resultado, descricao, finalizada_por_nome, concluida_em):
    with obter_sessao() as sessao:
        alvo = sessao.get(Tarefa, tarefa_id)
        if not alvo:
            return None
        alvo.concluida = True
        alvo.concluida_em = concluida_em
        alvo.resultado = resultado
        alvo.resultado_descricao = descricao
        alvo.finalizada_por_nome = finalizada_por_nome
        return _tarefa_para_dict(alvo)


def reabrir_tarefa(tarefa_id):
    with obter_sessao() as sessao:
        alvo = sessao.get(Tarefa, tarefa_id)
        if not alvo:
            return None
        alvo.concluida = False
        alvo.concluida_em = ""
        alvo.resultado = ""
        alvo.resultado_descricao = ""
        alvo.finalizada_por_nome = ""
        return _tarefa_para_dict(alvo)


def excluir_tarefa(tarefa_id):
    with obter_sessao() as sessao:
        alvo = sessao.get(Tarefa, tarefa_id)
        if not alvo:
            return False
        sessao.delete(alvo)
        return True


def listar_entre(usuario_a, usuario_b):
    """Tarefas que um passou pro outro (nos dois sentidos) — página da Equipe."""
    with obter_sessao() as sessao:
        tarefas = sessao.query(Tarefa).filter(
            ((Tarefa.responsavel_id == usuario_a) & (Tarefa.criado_por == usuario_b))
            | ((Tarefa.responsavel_id == usuario_b) & (Tarefa.criado_por == usuario_a))
        ).all()
        return [_tarefa_para_dict(t) for t in tarefas]
