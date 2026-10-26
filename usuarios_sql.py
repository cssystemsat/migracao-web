"""Acesso SQL a login/usuários (Postgres) — substitui o que antes lia/escrevia
direto na coleção "app_usuarios" do Firestore em app.py (ver
docs/HISTORICO_DECISOES.md).

Cada função devolve dict no mesmo formato que os docs do Firestore tinham
(chave "id" incluída), pra manter sem mudança o que app.py já faz com esse
dict (_perfil_de_usuario, _perfil_pessoal, _sessao_login_app, etc.).

Foto do perfil fica em tabela própria (UsuarioFoto) — só é buscada nas
funções de usuário único (buscar_usuario/buscar_usuario_por_id), nunca nas
listagens em massa, pra não carregar esse blob onde não precisa.
"""
import uuid

from sqlalchemy import func
from werkzeug.security import generate_password_hash

from db_sql import obter_sessao, obter_sessao_leitura
from models import Usuario, UsuarioFoto


def _usuario_para_dict(usuario, foto=None):
    return {
        "id": usuario.id,
        "usuario": usuario.usuario,
        "usuario_norm": usuario.usuario_norm,
        "senha_hash": usuario.senha_hash,
        "perfil": usuario.perfil,
        "area": usuario.area,
        "nome_responsavel": usuario.nome_responsavel,
        "nome": usuario.nome,
        "sobrenome": usuario.sobrenome,
        "aniversario": usuario.aniversario,
        "telefone_profissional": usuario.telefone_profissional,
        "email": usuario.email,
        "aniversario_post_em": usuario.aniversario_post_em,
        "foto": foto or "",
    }


def sem_usuarios_cadastrados():
    with obter_sessao_leitura() as sessao:
        return sessao.query(Usuario.id).first() is None


def buscar_usuario(usuario):
    """Por usuario_norm — usado no login."""
    usuario_norm = usuario.strip().lower()
    with obter_sessao_leitura() as sessao:
        alvo = sessao.query(Usuario).filter_by(usuario_norm=usuario_norm).first()
        if not alvo:
            return None
        foto = sessao.get(UsuarioFoto, alvo.id)
        return _usuario_para_dict(alvo, foto.foto if foto else None)


def buscar_usuario_por_id(usuario_id):
    if not usuario_id:
        return None
    with obter_sessao_leitura() as sessao:
        alvo = sessao.get(Usuario, usuario_id)
        if not alvo:
            return None
        foto = sessao.get(UsuarioFoto, usuario_id)
        return _usuario_para_dict(alvo, foto.foto if foto else None)


def contar_admins(excluir_id=None):
    with obter_sessao_leitura() as sessao:
        consulta = sessao.query(func.count(Usuario.id)).filter(Usuario.perfil == "adm")
        if excluir_id:
            consulta = consulta.filter(Usuario.id != excluir_id)
        return consulta.scalar()


def criar_usuario(usuario, senha, perfil, area=None, nome_responsavel=""):
    novo = Usuario(
        id=uuid.uuid4().hex,
        usuario=usuario,
        usuario_norm=usuario.strip().lower(),
        senha_hash=generate_password_hash(senha),
        perfil=perfil,
        area=area or None,
        nome_responsavel=nome_responsavel,
    )
    with obter_sessao() as sessao:
        sessao.add(novo)
        return _usuario_para_dict(novo)


def atualizar_usuario(usuario_id, **campos):
    """Seta só os atributos passados em `campos` (substitui o doc_ref.set()
    do Firestore, que reescrevia o documento inteiro). Nunca toca a foto."""
    with obter_sessao() as sessao:
        alvo = sessao.get(Usuario, usuario_id)
        if not alvo:
            return None
        for campo, valor in campos.items():
            setattr(alvo, campo, valor)
        foto = sessao.get(UsuarioFoto, usuario_id)
        return _usuario_para_dict(alvo, foto.foto if foto else None)


def excluir_usuario(usuario_id):
    """A linha de usuario_foto (se existir) some sozinha via ON DELETE CASCADE."""
    with obter_sessao() as sessao:
        alvo = sessao.get(Usuario, usuario_id)
        if not alvo:
            return False
        sessao.delete(alvo)
        return True


def atualizar_senha(usuario_id, senha_nova):
    with obter_sessao() as sessao:
        alvo = sessao.get(Usuario, usuario_id)
        if not alvo:
            return False
        alvo.senha_hash = generate_password_hash(senha_nova)
        return True


def atualizar_perfil_pessoal(usuario_id, campos):
    """nome/sobrenome/aniversario/telefone_profissional/email — nunca foto
    (ver definir_foto)."""
    with obter_sessao() as sessao:
        alvo = sessao.get(Usuario, usuario_id)
        if not alvo:
            return None
        for campo, valor in campos.items():
            setattr(alvo, campo, valor)
        foto = sessao.get(UsuarioFoto, usuario_id)
        return _usuario_para_dict(alvo, foto.foto if foto else None)


def definir_foto(usuario_id, foto):
    """Sem linha = sem foto: string vazia apaga a linha em vez de gravar vazio."""
    with obter_sessao() as sessao:
        existente = sessao.get(UsuarioFoto, usuario_id)
        if foto:
            if existente:
                existente.foto = foto
            else:
                sessao.add(UsuarioFoto(usuario_id=usuario_id, foto=foto))
        elif existente:
            sessao.delete(existente)


def obter_foto(usuario_id):
    with obter_sessao_leitura() as sessao:
        existente = sessao.get(UsuarioFoto, usuario_id)
        return existente.foto if existente else None


def listar_usuarios():
    """Sem foto — não é usada na listagem de Gerenciar Usuários."""
    with obter_sessao_leitura() as sessao:
        return [
            {
                "id": u.id,
                "usuario": u.usuario,
                "perfil": u.perfil,
                "area": u.area or "",
                "nome_responsavel": u.nome_responsavel,
            }
            for u in sessao.query(Usuario).all()
        ]


def listar_usuarios_opcoes(area="", area_prefix=""):
    with obter_sessao_leitura() as sessao:
        lista = []
        for u in sessao.query(Usuario).all():
            area_usuario = u.area or ""
            if area and area_usuario != area:
                continue
            if area_prefix and not area_usuario.startswith(area_prefix):
                continue
            lista.append({"id": u.id, "nome": (u.nome_responsavel or u.usuario or "")})
        lista.sort(key=lambda x: x["nome"].lower())
        return lista


def telefones_profissionais_por_nome():
    with obter_sessao_leitura() as sessao:
        mapa = {}
        for u in sessao.query(Usuario).all():
            nome = u.nome_responsavel or u.usuario or ""
            telefone = u.telefone_profissional or ""
            if nome and telefone:
                mapa.setdefault(nome, telefone)
        return mapa


def usuarios_aniversariantes_hoje(hoje_mm_dd):
    """Sem foto — só usada pra montar o post do feed."""
    with obter_sessao_leitura() as sessao:
        usuarios = sessao.query(Usuario).filter(Usuario.aniversario == hoje_mm_dd).all()
        return [_usuario_para_dict(u) for u in usuarios]


def marcar_aniversario_postado(usuario_id, hoje_iso):
    with obter_sessao() as sessao:
        alvo = sessao.get(Usuario, usuario_id)
        if alvo:
            alvo.aniversario_post_em = hoje_iso
