"""Acesso SQL às notificações do sininho (ver models.Notificacao). Sem
pop-up — a tela só mostra o contador de não lidas e a lista ao abrir o
painel; marcar como lida é sempre uma ação explícita de quem está vendo.

`criar_notificacao` nunca levanta erro por `usuario_id` inexistente ou igual
a quem gerou o evento — quem chama decide se deve notificar (ver
_notificar, em app.py)."""
from sqlalchemy import func

from db_sql import obter_sessao, obter_sessao_leitura
from models import Notificacao

NOTIFICACOES_PAGINA = 20


def _notificacao_para_dict(n):
    return {
        "id": n.id,
        "tipo": n.tipo,
        "texto": n.texto,
        "entidade_tipo": n.entidade_tipo,
        "entidade_id": n.entidade_id,
        "origem_usuario_id": n.origem_usuario_id,
        "origem_usuario_nome": n.origem_usuario_nome,
        "lida": n.lida,
        "criado_em": n.criado_em.isoformat(),
    }


def criar_notificacao(usuario_id, tipo, texto, entidade_tipo="", entidade_id=None,
                       origem_usuario_id=None, origem_usuario_nome=""):
    if not usuario_id or usuario_id == origem_usuario_id:
        return None
    nova = Notificacao(
        usuario_id=usuario_id, tipo=tipo, texto=texto,
        entidade_tipo=entidade_tipo, entidade_id=entidade_id,
        origem_usuario_id=origem_usuario_id, origem_usuario_nome=origem_usuario_nome,
    )
    with obter_sessao() as sessao:
        sessao.add(nova)
        sessao.flush()
        return _notificacao_para_dict(nova)


def ja_existe(usuario_id, tipo, entidade_tipo, entidade_id):
    """Dedup pros tipos gerados por job periódico (tarefa_prazo_*, nps) —
    chamar antes de criar_notificacao pra não duplicar a cada vez que o job
    roda (ver docstring de models.Notificacao)."""
    with obter_sessao_leitura() as sessao:
        existe = (
            sessao.query(Notificacao.id)
            .filter_by(usuario_id=usuario_id, tipo=tipo, entidade_tipo=entidade_tipo, entidade_id=entidade_id)
            .first()
        )
        return existe is not None


def listar(usuario_id, limite=NOTIFICACOES_PAGINA, somente_nao_lidas=False):
    with obter_sessao_leitura() as sessao:
        consulta = sessao.query(Notificacao).filter(Notificacao.usuario_id == usuario_id)
        if somente_nao_lidas:
            consulta = consulta.filter(Notificacao.lida.is_(False))
        notificacoes = consulta.order_by(Notificacao.criado_em.desc()).limit(limite).all()
        return [_notificacao_para_dict(n) for n in notificacoes]


def contar_nao_lidas(usuario_id):
    with obter_sessao_leitura() as sessao:
        return sessao.query(func.count(Notificacao.id)).filter(
            Notificacao.usuario_id == usuario_id, Notificacao.lida.is_(False)
        ).scalar()


def marcar_lida(notificacao_id, usuario_id):
    """Só marca se a notificação for de quem está pedindo — evita marcar a
    de outro usuário sabendo só o id."""
    with obter_sessao() as sessao:
        alvo = sessao.get(Notificacao, notificacao_id)
        if not alvo or alvo.usuario_id != usuario_id:
            return False
        alvo.lida = True
        return True


def marcar_todas_lidas(usuario_id):
    with obter_sessao() as sessao:
        sessao.query(Notificacao).filter(
            Notificacao.usuario_id == usuario_id, Notificacao.lida.is_(False)
        ).update({"lida": True})
