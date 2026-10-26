"""Acesso SQL ao Feed interno: posts, curtidas (N:N via FeedPostCurtida — era
um array `curtidas` no Firestore) e comentários.

`curtido_por_mim`/`pode_excluir` dependem de quem está vendo (sessão) —
por isso `listar_feed` recebe `usuario_atual_id`/`sou_admin` e já devolve o
dict pronto pra jsonify, no mesmo formato que `_feed_serializar_post` já
produzia."""
from sqlalchemy import func

from db_sql import obter_sessao
from models import FeedComentario, FeedPost, FeedPostCurtida


def listar_feed(antes_de, limite, usuario_atual_id, sou_admin):
    with obter_sessao() as sessao:
        consulta = sessao.query(FeedPost)
        if antes_de is not None:
            consulta = consulta.filter(FeedPost.criado_em < antes_de)
        posts = consulta.order_by(FeedPost.criado_em.desc()).limit(limite).all()
        post_ids = [p.id for p in posts]

        curtidas_totais = {}
        curtidos_por_mim = set()
        if post_ids:
            curtidas_totais = dict(
                sessao.query(FeedPostCurtida.post_id, func.count(FeedPostCurtida.usuario_id))
                .filter(FeedPostCurtida.post_id.in_(post_ids))
                .group_by(FeedPostCurtida.post_id)
                .all()
            )
            if usuario_atual_id:
                curtidos_por_mim = {
                    pid for (pid,) in sessao.query(FeedPostCurtida.post_id)
                    .filter(FeedPostCurtida.post_id.in_(post_ids), FeedPostCurtida.usuario_id == usuario_atual_id)
                    .all()
                }

        return [
            {
                "id": p.id, "texto": p.texto, "autor_id": p.autor_id, "autor_nome": p.autor_nome,
                "cliente_id": p.cliente_id, "cliente_nome": p.cliente_nome, "tipo": p.tipo,
                "criado_em": p.criado_em.isoformat(),
                "curtidas_total": curtidas_totais.get(p.id, 0),
                "curtido_por_mim": p.id in curtidos_por_mim,
                "comentarios_total": p.comentarios_total,
                "pode_excluir": (p.autor_id == usuario_atual_id) or sou_admin,
            }
            for p in posts
        ]


def criar_post(texto, autor_id, autor_nome, cliente_id, cliente_nome, tipo=""):
    novo = FeedPost(
        texto=texto, autor_id=autor_id, autor_nome=autor_nome,
        cliente_id=cliente_id or None, cliente_nome=cliente_nome, tipo=tipo,
    )
    with obter_sessao() as sessao:
        sessao.add(novo)
        sessao.flush()
        return {
            "id": novo.id, "texto": novo.texto, "autor_id": novo.autor_id, "autor_nome": novo.autor_nome,
            "cliente_id": novo.cliente_id, "cliente_nome": novo.cliente_nome, "tipo": novo.tipo,
            "criado_em": novo.criado_em.isoformat(), "curtidas_total": 0, "curtido_por_mim": False,
            "comentarios_total": 0, "pode_excluir": True,  # quem cria sempre pode excluir o próprio post
        }


def buscar_post(post_id):
    with obter_sessao() as sessao:
        p = sessao.get(FeedPost, post_id)
        if not p:
            return None
        return {
            "id": p.id, "autor_id": p.autor_id, "texto": p.texto,
            "cliente_id": p.cliente_id, "cliente_nome": p.cliente_nome,
        }


def excluir_post(post_id):
    """Comentários e curtidas somem junto via ON DELETE CASCADE."""
    with obter_sessao() as sessao:
        alvo = sessao.get(FeedPost, post_id)
        if not alvo:
            return False
        sessao.delete(alvo)
        return True


def alternar_curtida(post_id, usuario_id):
    """Retorna (curtido_por_mim, curtidas_total) depois de alternar."""
    with obter_sessao() as sessao:
        existente = sessao.get(FeedPostCurtida, {"post_id": post_id, "usuario_id": usuario_id})
        if existente:
            sessao.delete(existente)
            curtido = False
        else:
            sessao.add(FeedPostCurtida(post_id=post_id, usuario_id=usuario_id))
            curtido = True
        sessao.flush()
        total = sessao.query(func.count(FeedPostCurtida.usuario_id)).filter(
            FeedPostCurtida.post_id == post_id
        ).scalar()
        return curtido, total


def _comentario_para_dict(c):
    return {
        "id": c.id, "post_id": c.post_id, "texto": c.texto,
        "autor_id": c.autor_id, "autor_nome": c.autor_nome, "criado_em": c.criado_em.isoformat(),
    }


def listar_comentarios(post_id):
    with obter_sessao() as sessao:
        comentarios = (
            sessao.query(FeedComentario)
            .filter(FeedComentario.post_id == post_id)
            .order_by(FeedComentario.criado_em)
            .all()
        )
        return [_comentario_para_dict(c) for c in comentarios]


def criar_comentario(post_id, texto, autor_id, autor_nome):
    novo = FeedComentario(post_id=post_id, texto=texto, autor_id=autor_id, autor_nome=autor_nome)
    with obter_sessao() as sessao:
        sessao.add(novo)
        sessao.flush()
        post = sessao.get(FeedPost, post_id)
        if post:
            post.comentarios_total = (post.comentarios_total or 0) + 1
        return _comentario_para_dict(novo)


def buscar_comentario(comentario_id):
    with obter_sessao() as sessao:
        c = sessao.get(FeedComentario, comentario_id)
        return {"id": c.id, "post_id": c.post_id, "autor_id": c.autor_id} if c else None


def excluir_comentario(comentario_id):
    with obter_sessao() as sessao:
        alvo = sessao.get(FeedComentario, comentario_id)
        if not alvo:
            return False
        post_id = alvo.post_id
        sessao.delete(alvo)
        post = sessao.get(FeedPost, post_id)
        if post:
            post.comentarios_total = max(0, (post.comentarios_total or 0) - 1)
        return True
