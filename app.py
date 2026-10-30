import base64
import io
import json
import os
import re
import secrets
import threading
import time
import unicodedata
import uuid
import zipfile
import zlib
from datetime import datetime
from functools import wraps
from zoneinfo import ZoneInfo

import firebase_admin
import openpyxl
import pandas as pd
import requests
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from googleapiclient.errors import HttpError
from flask import Flask, Response, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from sqlalchemy.exc import IntegrityError, SQLAlchemyError

import cliente_documentos_sql
import cliente_eventos_sql
import clientes_sql
import conversor_clientes
import conversor_veiculos
import conversor_rastreadores
import conversor_simcards
import conversor_areas
import conversor_uo
import conversor_colaboradores
import conversorkml
import credenciais_sql
import feed_sql
import migracoes_sql
import municipios_sql
import planilha_migracao
import ssx_veiculos_sync
import ssx_http
import ssxdesk_api
import tarefas_sql
import usuarios_sql
import wootric_api
import wootric_sql
import validador_importacao
from auditoria import diff_campos, registrar_acao

app = Flask(__name__)
app.secret_key = os.environ.get("MIGRACAO_SECRET_KEY", os.urandom(24))
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
# Relê templates/index.html do disco quando ele muda — sem isso (debug
# desligado) o template fica cacheado e só aparecia depois de reiniciar o
# servidor, e cada reinício custava leitura no Firestore (login + Dashboard).
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True

# Sobe 0.1 a cada edição publicada (3.0 -> 3.1 -> 3.2 ...); só sobe o inteiro quando pedido.
APP_VERSION = "4.0"

BASE_URL = "https://integration.systemsatx.com.br"

# "aniversario" (Minha Conta) é "MM-DD" sem fuso — compara sempre contra o
# dia civil em Brasília, não o UTC do servidor (virada de dia diferente perto
# da meia-noite senão).
FUSO_BR = ZoneInfo("America/Sao_Paulo")


def _hoje_mm_dd():
    return datetime.now(FUSO_BR).strftime("%m-%d")


def _hoje_iso():
    return datetime.now(FUSO_BR).strftime("%Y-%m-%d")

# --- FIREBASE / FIRESTORE (banco de dados) ---
# Credencial vem inteira (o JSON da chave de serviço) numa única variável de
# ambiente, tanto local quanto no Render, pra não depender de upload de arquivo.
_FIREBASE_CRED_JSON = os.environ.get("FIREBASE_CREDENTIALS_JSON")
if not _FIREBASE_CRED_JSON:
    raise RuntimeError(
        "Variável de ambiente FIREBASE_CREDENTIALS_JSON não definida. "
        "Configure-a com o conteúdo do arquivo de chave de serviço do Firebase."
    )
_firebase_cred = credentials.Certificate(json.loads(_FIREBASE_CRED_JSON))
firebase_admin.initialize_app(_firebase_cred)
db = firestore.client()

# --- CONTAS DE ACESSO À PRÓPRIA FERRAMENTA (protege o app quando publicado na internet) ---
# Login/usuários são Postgres (ver usuarios_sql.py e docs/HISTORICO_DECISOES.md).
# APP_USUARIOS_COLLECTION continua existindo só porque migrar_usuarios_para_postgres.py
# ainda lê o Firestore como ORIGEM da cópia de dados — a coleção em si fica intacta lá,
# sem uso pelo app, como backup sem prazo de remoção.
#
# Cada usuário tem: usuário, hash de senha (nunca a senha em texto puro), um "perfil": adm
# (acesso total, único que gerencia outros usuários), analista (opera só nos clientes da
# própria carteira) ou visualizacao (só lê, nenhuma ação), e uma "area":
# CS/Treinamento/Suporte/Comercial (quem tem area="Comercial" entra no select de Consultor
# Comercial do cadastro do cliente). Sem nenhum usuário cadastrado ainda, a tela de login
# vira um assistente de primeiro acesso que cria o usuário administrador inicial.
APP_USUARIOS_COLLECTION = "app_usuarios"
PERFIS_USUARIO = ["adm", "analista", "visualizacao"]
PERFIL_PADRAO = "analista"
AREAS_USUARIO = ["CS - Implantação", "CS - Onboarding", "CS - Ongoing", "Treinamento", "Suporte", "Comercial"]


def _perfil_de_usuario(dados_usuario):
    """Lê o perfil de um dict de usuário. Compatível com docs antigos (de antes da
    migração pro Postgres) que só têm a flag booleana 'admin': admin=True vira 'adm',
    o resto vira o perfil padrão. Toda linha no Postgres já tem 'perfil' resolvido
    (o script de migração de dados já aplicou esse fallback na cópia)."""
    perfil = dados_usuario.get("perfil")
    if perfil in PERFIS_USUARIO:
        return perfil
    return "adm" if dados_usuario.get("admin") else PERFIL_PADRAO


def _sessao_login_app(usuario_doc):
    session["app_ok"] = True
    session["app_usuario_id"] = usuario_doc["id"]
    session["app_usuario_nome"] = usuario_doc["usuario"]
    session["app_usuario_perfil"] = _perfil_de_usuario(usuario_doc)
    # Liga o usuário logado a um nome da lista de Responsável (Duda/Juan/João Pedro)
    # dos clientes de Implantação/Migração — é o que permite o toggle "Minha
    # Carteira" saber quais clientes filtrar. Vazio = sem carteira própria.
    session["app_usuario_responsavel"] = usuario_doc.get("nome_responsavel", "")
    # A sessão do Flask é um cookie assinado guardado no navegador (sem backend
    # server-side configurado) — cookies têm teto de ~4KB no navegador. Guardar a
    # foto (base64, pode passar de 6KB) direto aqui fazia o cookie de sessão inteiro
    # ser descartado silenciosamente pelo navegador, e o login parecia "voltar pra
    # tela de login" mesmo com usuário/senha corretos. Por isso só a flag aqui — a
    # foto em si é servida por /api/app-usuario/foto, lida do Postgres por request.
    _marcar_foto_na_sessao(usuario_doc.get("foto") or "")


def _sou_admin():
    return session.get("app_usuario_perfil") == "adm"


def _posso_operar():
    """Perfil 'visualizacao' é só leitura — nenhuma ação (importar, deletar,
    associar rastreador, enviar/gerenciar comando). 'analista' e 'adm' operam
    normalmente. Consultas/Listagens continuam liberadas pra todo mundo, por
    não mexerem em nada — só esse helper não cobre elas."""
    return session.get("app_usuario_perfil") != "visualizacao"


def requer_operador(view):
    """Decorator pras rotas de ação de Ferramentas Auxiliares (Importação,
    Deletar veículos, Associar rastreadores, Comandos — tanto o envio SMS
    quanto os modelos salvos) — barra o perfil 'visualizacao' antes de
    qualquer outra checagem da rota."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not _posso_operar():
            return jsonify(ok=False, error="Perfil de visualização não pode executar essa ação — apenas consultar."), 403
        return view(*args, **kwargs)
    return wrapper


@app.before_request
def exigir_login_app():
    if request.endpoint in ("login_app", "logout_app", "static"):
        return
    if not session.get("app_ok"):
        return redirect(url_for("login_app"))
    # Sessão aberta antes da v4.0 só tem "app_usuario_admin" (sem perfil) —
    # sem isso o admin logado desde antes do deploy vira não-admin até sair e
    # entrar de novo. Recarrega do Postgres uma vez e completa a sessão.
    if "app_usuario_perfil" not in session:
        usuario_doc = usuarios_sql.buscar_usuario_por_id(session.get("app_usuario_id"))
        if not usuario_doc:
            session.clear()
            return redirect(url_for("login_app"))
        _sessao_login_app(usuario_doc)


@app.route("/login-app", methods=["GET", "POST"])
def login_app():
    # Sessão ainda válida (ex.: usuário clicou "Voltar" no navegador e caiu aqui) —
    # manda direto pro app em vez de reexibir o formulário de login.
    if session.get("app_ok"):
        return redirect(url_for("index"))
    modo_setup = usuarios_sql.sem_usuarios_cadastrados()
    erro = None
    if request.method == "POST":
        usuario = request.form.get("usuario", "").strip()
        senha = request.form.get("senha", "")

        if modo_setup:
            confirmar = request.form.get("confirmar_senha", "")
            if not usuario or not senha:
                erro = "Informe usuário e senha."
            elif senha != confirmar:
                erro = "As senhas não conferem."
            elif len(senha) < 4:
                erro = "A senha deve ter pelo menos 4 caracteres."
            else:
                try:
                    novo = usuarios_sql.criar_usuario(usuario, senha, perfil="adm")
                except IntegrityError:
                    # Alguém mais rápido já concluiu o primeiro acesso nesse meio-tempo
                    # (banco vazio só acontece uma vez na vida do sistema).
                    erro = "Alguém já concluiu o primeiro acesso agora — faça login normalmente."
                else:
                    _sessao_login_app(novo)
                    return redirect(url_for("index"))
        else:
            doc = usuarios_sql.buscar_usuario(usuario) if usuario else None
            if doc and check_password_hash(doc["senha_hash"], senha):
                _sessao_login_app(doc)
                return redirect(url_for("index"))
            erro = "Usuário ou senha incorretos."

    return render_template("login_app.html", erro=erro, app_version=APP_VERSION, modo_setup=modo_setup)


@app.route("/logout-app")
def logout_app():
    session.pop("app_ok", None)
    session.pop("app_usuario_id", None)
    session.pop("app_usuario_nome", None)
    session.pop("app_usuario_perfil", None)
    session.pop("app_usuario_responsavel", None)
    session.pop("app_usuario_tem_foto", None)
    return redirect(url_for("login_app"))


@app.route("/api/app-usuarios", methods=["GET"])
def listar_app_usuarios():
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem gerenciar usuários."), 403
    return jsonify(ok=True, usuarios=usuarios_sql.listar_usuarios())


@app.route("/api/app-usuarios/opcoes", methods=["GET"])
def listar_app_usuarios_opcoes():
    """Versão enxuta de listar_app_usuarios pra popular dropdown: responsável de
    tarefa, ?area=Comercial pro Consultor Comercial do cliente, ou
    ?area_prefix=CS pro Responsável (Implantação/Migração) — casa qualquer área
    que comece com "CS" ("CS - Implantação"/"CS - Onboarding"/"CS - Ongoing"),
    já que qualquer uma delas pode ter carteira própria. Não é admin-only como
    a rota acima, porque qualquer usuário logado precisa poder escolher, não só
    administradores."""
    area = request.args.get("area", "").strip()
    area_prefix = request.args.get("area_prefix", "").strip()
    lista = usuarios_sql.listar_usuarios_opcoes(area=area, area_prefix=area_prefix)
    return jsonify(ok=True, usuarios=lista)


@app.route("/api/app-usuarios", methods=["POST"])
def criar_app_usuario():
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem gerenciar usuários."), 403
    data = request.get_json(force=True) or {}
    usuario = str(data.get("usuario", "")).strip()
    senha = str(data.get("senha", ""))
    perfil = str(data.get("perfil", "")).strip()
    if perfil not in PERFIS_USUARIO:
        perfil = PERFIL_PADRAO
    area = str(data.get("area", "")).strip()
    if area not in AREAS_USUARIO:
        area = None
    nome_responsavel = str(data.get("nome_responsavel", "")).strip()
    if not usuario or not senha:
        return jsonify(ok=False, error="Informe usuário e senha."), 400
    if len(senha) < 4:
        return jsonify(ok=False, error="A senha deve ter pelo menos 4 caracteres."), 400
    if usuarios_sql.buscar_usuario(usuario):
        return jsonify(ok=False, error="Já existe um usuário com esse nome."), 400
    novo = usuarios_sql.criar_usuario(usuario, senha, perfil=perfil, area=area, nome_responsavel=nome_responsavel)
    return jsonify(ok=True, usuario=dict(
        id=novo["id"], usuario=novo["usuario"], perfil=novo["perfil"], area=novo["area"] or "",
        nome_responsavel=novo["nome_responsavel"],
    ))


def _slug_usuario(nome):
    """Deriva um login a partir do nome completo (ex.: "João da Silva" ->
    "joao.da.silva") — usado só na criação em massa, onde não faz sentido
    pedir um login por pessoa (ex.: importar a lista do Comercial)."""
    sem_acento = unicodedata.normalize("NFKD", nome).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", ".", sem_acento).strip(".").lower()
    return slug or "usuario"


@app.route("/api/app-usuarios/lote", methods=["POST"])
def criar_app_usuarios_lote():
    """Cria vários usuários de uma vez a partir só do nome (ex.: colar a
    lista inteira do Comercial) — login e senha são gerados automaticamente,
    já que essas pessoas não vão acessar a ferramenta por enquanto; a
    finalidade imediata é só aparecerem nos selects de Responsável/Consultor
    Comercial (ver listar_app_usuarios_opcoes). Quando alguém da lista
    precisar logar de verdade, um admin edita o usuário e define a senha
    pela tela normal."""
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem gerenciar usuários."), 403
    data = request.get_json(silent=True) or {}
    nomes = [str(n).strip() for n in (data.get("nomes") or []) if str(n).strip()]
    if not nomes:
        return jsonify(ok=False, error="Informe pelo menos um nome."), 400
    perfil = str(data.get("perfil", "")).strip()
    if perfil not in PERFIS_USUARIO:
        perfil = "visualizacao"
    area = str(data.get("area", "")).strip()
    if area not in AREAS_USUARIO:
        area = None

    criados = []
    for nome in nomes:
        base = _slug_usuario(nome)
        candidato = base
        sufixo = 2
        while usuarios_sql.buscar_usuario(candidato):
            candidato = f"{base}{sufixo}"
            sufixo += 1
        novo = usuarios_sql.criar_usuario(
            candidato, secrets.token_urlsafe(12), perfil=perfil, area=area, nome_responsavel=nome,
        )
        criados.append({"usuario": novo["usuario"], "nome_responsavel": nome})
    return jsonify(ok=True, criados=criados)


@app.route("/api/app-usuarios/<usuario_id>", methods=["PUT"])
def editar_app_usuario(usuario_id):
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem gerenciar usuários."), 403
    data = request.get_json(force=True) or {}
    atual = usuarios_sql.buscar_usuario_por_id(usuario_id)
    if not atual:
        return jsonify(ok=False, error="Usuário não encontrado."), 404

    novo_nome = str(data.get("usuario", atual["usuario"])).strip()
    nova_senha = str(data.get("senha", "")).strip()
    perfil_atual = _perfil_de_usuario(atual)
    novo_perfil = str(data.get("perfil", perfil_atual)).strip()
    if novo_perfil not in PERFIS_USUARIO:
        novo_perfil = perfil_atual
    nova_area = str(data.get("area", atual.get("area") or "")).strip()
    # Área antiga fora da lista atual (ex.: "CS") continua valendo enquanto
    # ninguém trocar — senão qualquer edição do usuário apagava a área dele.
    if nova_area not in AREAS_USUARIO and nova_area != (atual.get("area") or ""):
        nova_area = None
    nova_area = nova_area or None
    novo_responsavel = str(data.get("nome_responsavel", atual.get("nome_responsavel", ""))).strip()

    if not novo_nome:
        return jsonify(ok=False, error="Informe o nome do usuário."), 400
    if nova_senha and len(nova_senha) < 4:
        return jsonify(ok=False, error="A senha deve ter pelo menos 4 caracteres."), 400

    outro = usuarios_sql.buscar_usuario(novo_nome)
    if outro and outro["id"] != usuario_id:
        return jsonify(ok=False, error="Já existe um usuário com esse nome."), 400

    # Não deixa remover o último administrador (senão ninguém mais gerencia usuários).
    if perfil_atual == "adm" and novo_perfil != "adm":
        if usuarios_sql.contar_admins(excluir_id=usuario_id) == 0:
            return jsonify(ok=False, error="Precisa existir pelo menos um administrador."), 400

    campos = {
        "usuario": novo_nome,
        "usuario_norm": novo_nome.lower(),
        "perfil": novo_perfil,
        "area": nova_area,
        "nome_responsavel": novo_responsavel,
    }
    # Update parcial (só os atributos passados) — ao contrário do antigo doc_ref.set()
    # do Firestore, não precisa recopiar nome/sobrenome/aniversario/telefone/email pra
    # não apagar os campos de perfil pessoal (ver /api/app-usuario/perfil); e nunca
    # toca a foto, que fica em tabela própria.
    if nova_senha:
        campos["senha_hash"] = generate_password_hash(nova_senha)

    usuarios_sql.atualizar_usuario(usuario_id, **campos)

    if usuario_id == session.get("app_usuario_id"):
        session["app_usuario_nome"] = novo_nome
        session["app_usuario_perfil"] = novo_perfil
        session["app_usuario_responsavel"] = novo_responsavel

    return jsonify(ok=True, usuario=dict(
        id=usuario_id, usuario=novo_nome, perfil=novo_perfil, area=nova_area or "",
        nome_responsavel=novo_responsavel,
    ))


@app.route("/api/app-usuarios/<usuario_id>", methods=["DELETE"])
def excluir_app_usuario(usuario_id):
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem gerenciar usuários."), 403
    if usuario_id == session.get("app_usuario_id"):
        return jsonify(ok=False, error="Você não pode excluir o próprio usuário enquanto está logado."), 400
    atual = usuarios_sql.buscar_usuario_por_id(usuario_id)
    if not atual:
        return jsonify(ok=False, error="Usuário não encontrado."), 404
    if _perfil_de_usuario(atual) == "adm":
        if usuarios_sql.contar_admins(excluir_id=usuario_id) == 0:
            return jsonify(ok=False, error="Precisa existir pelo menos um administrador."), 400
    try:
        usuarios_sql.excluir_usuario(usuario_id)
    except IntegrityError:
        # FK RESTRICT de tarefas.responsavel_id — não apaga silenciosamente
        # tarefa nenhuma, só avisa que precisa reatribuir antes.
        return jsonify(ok=False, error="Esse usuário tem tarefas atribuídas — reatribua antes de excluir."), 400
    return jsonify(ok=True)


@app.route("/api/app-usuario/senha", methods=["POST"])
def trocar_minha_senha_app():
    usuario_id = session.get("app_usuario_id")
    if not usuario_id:
        return jsonify(ok=False, error="Não autenticado."), 401
    data = request.get_json(force=True) or {}
    senha_atual = str(data.get("senha_atual", ""))
    senha_nova = str(data.get("senha_nova", ""))
    if len(senha_nova) < 4:
        return jsonify(ok=False, error="A nova senha deve ter pelo menos 4 caracteres."), 400
    atual = usuarios_sql.buscar_usuario_por_id(usuario_id)
    if not atual:
        return jsonify(ok=False, error="Usuário não encontrado."), 404
    if not check_password_hash(atual["senha_hash"], senha_atual):
        return jsonify(ok=False, error="Senha atual incorreta."), 400
    usuarios_sql.atualizar_senha(usuario_id, senha_nova)
    return jsonify(ok=True)


def _perfil_pessoal(usuario_doc):
    """Campos de "Minha Conta" — nunca inclui senha_hash/usuario_norm (uso interno)."""
    return {
        "usuario": usuario_doc.get("usuario", ""),
        "nome": usuario_doc.get("nome", ""),
        "sobrenome": usuario_doc.get("sobrenome", ""),
        "aniversario": usuario_doc.get("aniversario", ""),
        "aniversario_hoje": bool(usuario_doc.get("aniversario")) and usuario_doc.get("aniversario") == _hoje_mm_dd(),
        "telefone_profissional": usuario_doc.get("telefone_profissional", ""),
        "email": usuario_doc.get("email", ""),
        "foto": usuario_doc.get("foto", ""),
    }


# Folga confortável abaixo do limite de ~1MB por documento do Firestore — a foto
# já chega redimensionada/comprimida pelo navegador (ver script.js), isso aqui é
# só um teto de segurança contra um upload gigante escapar do redimensionamento.
FOTO_PERFIL_MAX_CHARS = 700_000


@app.route("/api/app-usuario/perfil", methods=["GET"])
def obter_meu_perfil():
    usuario_id = session.get("app_usuario_id")
    if not usuario_id:
        return jsonify(ok=False, error="Não autenticado."), 401
    usuario_doc = usuarios_sql.buscar_usuario_por_id(usuario_id)
    if not usuario_doc:
        return jsonify(ok=False, error="Usuário não encontrado."), 404
    return jsonify(ok=True, perfil=_perfil_pessoal(usuario_doc))


@app.route("/api/app-usuario/perfil", methods=["PUT"])
def editar_meu_perfil():
    usuario_id = session.get("app_usuario_id")
    if not usuario_id:
        return jsonify(ok=False, error="Não autenticado."), 401

    data = request.get_json(force=True) or {}

    aniversario = str(data.get("aniversario", "")).strip()
    if aniversario and not re.fullmatch(r"(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])", aniversario):
        return jsonify(ok=False, error="Data de aniversário inválida."), 400

    foto = str(data.get("foto") or "")
    erro_foto = _validar_foto_perfil(foto)
    if erro_foto:
        return jsonify(ok=False, error=erro_foto), 400

    if not usuarios_sql.buscar_usuario_por_id(usuario_id):
        return jsonify(ok=False, error="Usuário não encontrado."), 404

    dados = {
        "nome": str(data.get("nome", "")).strip(),
        "sobrenome": str(data.get("sobrenome", "")).strip(),
        "aniversario": aniversario,
        "telefone_profissional": str(data.get("telefone_profissional", "")).strip(),
        "email": str(data.get("email", "")).strip(),
    }
    usuarios_sql.atualizar_perfil_pessoal(usuario_id, dados)
    usuarios_sql.definir_foto(usuario_id, foto)
    _marcar_foto_na_sessao(foto)
    return jsonify(ok=True, perfil=_perfil_pessoal(dict(dados, usuario=session.get("app_usuario_nome", ""), foto=foto)))


def _validar_foto_perfil(foto):
    """Devolve a mensagem de erro, ou None se a foto (data URL) for aceitável."""
    if foto and not foto.startswith("data:image/"):
        return "Foto inválida."
    if len(foto) > FOTO_PERFIL_MAX_CHARS:
        return "Foto muito grande — tente uma imagem menor."
    return None


def _marcar_foto_na_sessao(foto):
    # A versão entra na URL da foto (?v=...) no template: /api/app-usuario/foto
    # vai com cache de 5 min, então sem ela o navegador continuaria mostrando a
    # foto antiga no topbar depois de trocar e recarregar a página.
    session["app_usuario_tem_foto"] = bool(foto)
    session["app_usuario_foto_versao"] = zlib.crc32(foto.encode()) if foto else 0


@app.route("/api/app-usuario/foto", methods=["PUT"])
def salvar_minha_foto():
    """Só a foto — gravada assim que a pessoa confirma o ajuste (Minha conta >
    Trocar foto > Usar esta foto), sem depender do Salvar do formulário."""
    usuario_id = session.get("app_usuario_id")
    if not usuario_id:
        return jsonify(ok=False, error="Não autenticado."), 401
    foto = str((request.get_json(force=True) or {}).get("foto") or "")
    erro = _validar_foto_perfil(foto)
    if erro:
        return jsonify(ok=False, error=erro), 400
    if not usuarios_sql.buscar_usuario_por_id(usuario_id):
        return jsonify(ok=False, error="Usuário não encontrado."), 404
    usuarios_sql.definir_foto(usuario_id, foto)
    _marcar_foto_na_sessao(foto)
    return jsonify(ok=True)


@app.route("/api/app-usuario/foto")
def foto_meu_perfil():
    """Serve a foto de perfil como imagem de verdade (não fica na sessão —
    ver comentário em _sessao_login_app sobre o limite de 4KB do cookie)."""
    usuario_id = session.get("app_usuario_id")
    if not usuario_id:
        return "", 401
    foto = usuarios_sql.obter_foto(usuario_id)
    if not foto or not foto.startswith("data:"):
        return "", 404
    cabecalho, _, b64 = foto.partition(",")
    mimetype = cabecalho.split(":")[1].split(";")[0] if ":" in cabecalho else "image/jpeg"
    return Response(base64.b64decode(b64), mimetype=mimetype, headers={"Cache-Control": "private, max-age=300"})


# --- DEFINIÇÃO DE TIPOS CONFORME DOCUMENTAÇÃO SSX ---
# Comparado pelo caminho COMPLETO do parâmetro (com dot notation), não só pelo nome
# final, para não confundir campos com o mesmo nome em contextos diferentes
# (ex.: "PhoneNumber" do Cliente é texto, mas "Tracker1.Simcard1.PhoneNumber" é int32).
INT_FIELDS = [
    "ModelYear", "FabricationYear", "Fuel", "IdMapIcon", "IdMapIconColor",
    "IgnitionStatus", "OperationalStatus", "GPSStatus", "WarningStatus",
    "IdModelTracker", "TypeOrganizationalUnit", "Language", "Country", "TimeZone",
    "Tracker1.Simcard1.CountryCode", "Tracker1.Simcard1.AreaCode", "Tracker1.Simcard1.PhoneNumber",
    "Tracker1.Simcard2.CountryCode", "Tracker1.Simcard2.AreaCode", "Tracker1.Simcard2.PhoneNumber",
    "Tracker2.Simcard1.CountryCode", "Tracker2.Simcard1.AreaCode", "Tracker2.Simcard1.PhoneNumber",
    "Tracker2.Simcard2.CountryCode", "Tracker2.Simcard2.AreaCode", "Tracker2.Simcard2.PhoneNumber",
    "BillingCylcleEndDay",
    "Type", "Tolerance",
    "IdentifierType", "AccessCodeType", "ConsolidationType", "LicenseRegistrationType",
]
BOOL_FIELDS = ["Active", "ChangePasswordNextLogin", "SendPasswordEmail", "DaylightSaving"]
# Campos de ponto flutuante (number/double no Swagger) — só surgiram com
# SimCard/Insert (Price, MegabyteLimit); nenhum campo anterior precisava
# dessa coerção (os já existentes eram todos int ou bool).
FLOAT_FIELDS = ["Price", "MegabyteLimit"]

PARAMS = {
    "cliente": {
        "titulo": "Cliente",
        "endpoint": "/Administration/Client/Insert",
        "defaults": {"Language": 1, "Country": 29, "TimeZone": 31},
        "campos": [
            "ClientIntegrationCode", "ClientTemplateIntegrationCode",
            "OrganizationalUnitIntegrationCode", "Code", "ClientType",
            "TradingName", "CompanyName", "DocumentNumber", "RegisterNumber",
            "CustomerSupportProcedure", "UserName", "Login", "Password",
            "UserProfileTemplateIntegrationCode", "PhoneNumber", "CellPhoneNumber",
        ],
    },
    # Campos confirmados no Swagger (schema OrganizationalUnitInsertParameter,
    # additionalProperties:false) em 2026-10-20 — a lista anterior ("Note",
    # "Active", "ExternalIntegrationCode") não existe nesse schema e faltava
    # "Description"; corrigido pra bater exatamente com a API real.
    "uo": {
        "titulo": "UO",
        "endpoint": "/Administration/OrganizationalUnit/Insert",
        "defaults": {},
        "campos": [
            "OrganizationalUnitIntegrationCode", "Name", "TypeOrganizationalUnit",
            "ParentOrganizationalUnitIntegrationCode", "ClientIntegrationCode", "Description",
        ],
    },
    "usuario": {
        "titulo": "Usuário",
        "endpoint": "/Administration/User/Insert",
        "defaults": {},
        "campos": [
            "Name", "Login", "Password", "Email", "ClientIntegrationCode",
            "OrganizationalUnitIntegrationCode", "ProfileTemplateIntegrationCode",
            "UserIntegrationCode", "Active", "Note", "ExternalIntegrationCode",
            "ChangePasswordNextLogin", "SendPasswordEmail", "PhoneNumber",
            "DocumentNumber", "Language", "TimeZone", "UserType",
        ],
    },
    "veiculo": {
        "titulo": "Veículo",
        "endpoint": "/Administration/Vehicle/Insert",
        "defaults": {"IgnitionStatus": 1, "OperationalStatus": 1, "GPSStatus": 1, "WarningStatus": 1},
        "campos": [
            "VehicleIntegrationCode", "ClientIntegrationCode", "Identification",
            "LicensePlate", "ChassiNumber", "RenavamNumber", "Color",
            "FederalState", "City", "ModelYear", "FabricationYear", "Fuel",
            "QRCode", "FipeCode", "IdMapIcon", "IdMapIconColor",
            "ClientVehicleIntegrationCode",
            "Tracker1.TrackerIntegrationCode", "Tracker1.IdTracker",
            "Tracker1.TrackerTemplateIntegrationCode", "Tracker1.TrackerIMEI",
            "Tracker1.Simcard1.ICCID", "Tracker1.Simcard1.APN",
            "Tracker1.Simcard1.CountryCode", "Tracker1.Simcard1.AreaCode",
            "Tracker1.Simcard1.PhoneNumber",
        ],
    },
    "rastreador": {
        "titulo": "Rastreador",
        "endpoint": "/Administration/Tracker/Insert",
        "defaults": {},
        "campos": [
            "TrackerIntegrationCode", "IdTracker", "AuxiliaryId",
            "TrackerTemplateIntegrationCode", "StatusIntegrationCode",
            "ClientIntegrationCode", "AcquisitionDate", "ICCID1", "ICCID2", "IMEI",
        ],
    },
    "simcard": {
        "titulo": "SIM Card",
        "endpoint": "/Administration/SimCard/Insert",
        "defaults": {},
        "campos": [
            "ICCID", "APNDomain", "CountryCallingCode", "AreaCallingCode", "PhoneNumber",
            "BillingCylcleEndDay", "Price", "MegabyteLimit", "PIN", "PUK",
        ],
    },
    # Geography/Insert não aceita "ColorCode" (cor é só do arquivo de
    # importação/KML, não da API REST — confirmado no Swagger) e exige
    # "Tolerance" sempre, mesmo pra Área/Rota (o manual de arquivo só exige
    # pra Ponto) — ver conversor_areas_usar_como_upload, que preenche 0
    # quando a planilha deixou em branco.
    "area": {
        "titulo": "Área",
        "endpoint": "/Administration/Geography/Insert",
        "defaults": {},
        "campos": [
            "GeographyIntegrationCode", "Name", "Description", "Type", "Area",
            "Tolerance", "GroupIntegrationCode", "ListCategoryIntegrationCode",
        ],
    },
    # Person/InsertPerson não tem campo pra "Passageiro ou motorista" (só
    # existe no layout de arquivo) e "OrganizationUnitIntegrationCode" aqui
    # é SEM o "al" de "Organizational" — nome diferente do campo
    # equivalente em OrganizationalUnit/Insert, confirmado no Swagger (mesma
    # pegadinha de nomenclatura já vista entre outros endpoints da SSX).
    "colaborador": {
        "titulo": "Colaborador",
        "endpoint": "/Administration/Person/InsertPerson",
        "defaults": {},
        "campos": [
            "PersonIntegrationCode", "OrganizationUnitIntegrationCode", "Name", "Email",
            "CountryCode", "AreaCode", "CellPhoneNumber", "PhoneNumber", "IDCard", "CPF",
            "DateOfBirth", "Gender", "IdentifierType", "AccessCodeType", "AccessCode",
            "TimeZone", "DaylightSaving", "Language", "Country",
            "PersonRoleIntegrationCode", "WorkScheduleIntegrationCode", "ConsolidationType",
            "Registration", "LicenseDriver", "ExpirationDateLicenseDriver",
            "EmissionDateLicenseDriver", "FirstDateLicenseDriver", "LicenseRegistrationType",
            "UserProfileTemplateIntegrationCode", "Login", "Password",
        ],
    },
}

# Rótulos amigáveis exibidos para o usuário no mapeamento de colunas.
# A chamada da API sempre usa o nome interno (chave do PARAMS["campos"]);
# aqui só trocamos o texto mostrado na tela. Campo sem entrada aqui usa o nome interno.
LABELS = {
    "cliente": {
        "ClientIntegrationCode": "Código de integração do cliente",
        "ClientTemplateIntegrationCode": "Template do cliente",
        "OrganizationalUnitIntegrationCode": "Código da Unidade organizacional",
        "Code": "Código do cliente",
        "ClientType": "Tipo do cliente",
        "TradingName": "Nome do cliente",
        "CompanyName": "Razão Social",
        "DocumentNumber": "CPF/CNPJ",
        "RegisterNumber": "IE / RG",
        "CustomerSupportProcedure": "Procedimento de atendimento",
        "UserName": "Nome do Usuário master",
        "Login": "Login do Cliente",
        "Password": "Senha do Cliente",
        "UserProfileTemplateIntegrationCode": "Template de perfil de acesso",
        "PhoneNumber": "Telefone do Cliente",
        "CellPhoneNumber": "Celular do Cliente",
    },
    "veiculo": {
        "VehicleIntegrationCode": "Código de integração do veículo",
        "ClientIntegrationCode": "Código de integração do cliente",
        "Identification": "Identificação do Veículo",
        "LicensePlate": "Placa",
        "ChassiNumber": "Chassi",
        "RenavamNumber": "Renavam",
        "Color": "Cor",
        "FederalState": "Estado do veículo",
        "City": "Cidade",
        "ModelYear": "Ano do Modelo",
        "FabricationYear": "Ano de fabricação",
        "Fuel": "Combustível",
        "QRCode": "QRCode",
        "FipeCode": "Número da Fipe",
        "IdMapIcon": "Ícone do mapa",
        "IdMapIconColor": "Cor do Ícone",
        "ClientVehicleIntegrationCode": "Código de integração veículo do cliente",
        "Tracker1.TrackerIntegrationCode": "Código de integração Rastreador",
        "Tracker1.IdTracker": "ID do rastreador",
        "Tracker1.TrackerTemplateIntegrationCode": "Template do rastreador",
        "Tracker1.TrackerIMEI": "Imei do Rastreador",
        "Tracker1.Simcard1.ICCID": "ICCID do Chip",
        "Tracker1.Simcard1.APN": "APN do Chip",
        "Tracker1.Simcard1.CountryCode": "DDI",
        "Tracker1.Simcard1.AreaCode": "DDD",
        "Tracker1.Simcard1.PhoneNumber": "Número da linha",
    },
    "rastreador": {
        "TrackerIntegrationCode": "Código de integração",
        "IdTracker": "Identificação",
        "AuxiliaryId": "Identificação auxiliar",
        "TrackerTemplateIntegrationCode": "Template do rastreador",
        "StatusIntegrationCode": "Status do rastreador",
        "ClientIntegrationCode": "Código de integração do cliente",
        "AcquisitionDate": "Data de aquisição",
        "ICCID1": "ICCID 1",
        "ICCID2": "ICCID 2",
        "IMEI": "IMEI",
    },
    "simcard": {
        "ICCID": "ICCID",
        "APNDomain": "Domínio da APN",
        "CountryCallingCode": "DDI",
        "AreaCallingCode": "DDD",
        "PhoneNumber": "Telefone",
        "BillingCylcleEndDay": "Dia de corte",
        "Price": "Valor do plano",
        "MegabyteLimit": "Limite de megabytes",
        "PIN": "PIN",
        "PUK": "PUK",
    },
    "uo": {
        "OrganizationalUnitIntegrationCode": "Código de integração",
        "Name": "Nome",
        "TypeOrganizationalUnit": "Tipo da Unidade Organizacional",
        "ParentOrganizationalUnitIntegrationCode": "Código de integração da Unidade Organizacional pai",
        "ClientIntegrationCode": "Código de integração do cliente",
        "Description": "Descrição",
    },
    "usuario": {},
    "area": {
        "GeographyIntegrationCode": "Código de integração",
        "Name": "Nome",
        "Description": "Descrição",
        "Type": "Tipo",
        "Area": "Coordenadas",
        "Tolerance": "Tolerância",
        "GroupIntegrationCode": "Grupo",
        "ListCategoryIntegrationCode": "Categoria",
    },
    "colaborador": {
        "PersonIntegrationCode": "Código de integração",
        "OrganizationUnitIntegrationCode": "Código de integração da unidade organizacional",
        "Name": "Nome",
        "Email": "E-mail",
        "CountryCode": "DDI",
        "AreaCode": "DDD",
        "CellPhoneNumber": "Celular",
        "PhoneNumber": "Telefone",
        "IDCard": "Identidade",
        "CPF": "CPF",
        "DateOfBirth": "Data de nascimento",
        "Gender": "Sexo",
        "IdentifierType": "Tipo do identificador",
        "AccessCodeType": "Tipo de código do identificador",
        "AccessCode": "Código de acesso do identificador",
        "TimeZone": "GMT",
        "DaylightSaving": "Horário de verão",
        "Language": "Idioma",
        "Country": "País",
        "PersonRoleIntegrationCode": "Código de integração do cargo",
        "WorkScheduleIntegrationCode": "Código de integração da escala",
        "ConsolidationType": "Tipo de consolidação da jornada",
        "Registration": "Matrícula",
        "LicenseDriver": "CNH",
        "ExpirationDateLicenseDriver": "Validade da CNH",
        "EmissionDateLicenseDriver": "Emissão da CNH",
        "FirstDateLicenseDriver": "1ª Habilitação",
        "LicenseRegistrationType": "Categoria da CNH",
        "UserProfileTemplateIntegrationCode": "Perfil de acesso do usuário",
        "Login": "Login",
        "Password": "Senha",
    },
}

# Correspondência entre os campos do Conversor de Clientes (chave de
# validador_importacao/tipo_cliente.py CAMPOS_CLIENTE) e os aceitos pela API
# de importação (PARAMS["cliente"]) — usada só pra pré-selecionar o
# mapeamento quando "Importar via API" reaproveita os dados já carregados no
# Conversor (ver /api/conversor-clientes/usar-como-upload). É correspondência
# de SIGNIFICADO, não de nome parecido — "registro" = "IE / RG" e "perfil_acesso"
# = "Template de perfil de acesso" não têm nenhuma palavra em comum, por isso
# fica explícita aqui em vez de depender do auto-mapeamento por texto do
# modal genérico. Campo do Conversor sem entrada aqui (status, bloqueado,
# endereço, idioma, código integração pessoa, ...) não existe na API — fica
# de fora do mapeamento sugerido, a pessoa decide se usa API ou CSV.
CONVERSOR_CLIENTES_PARA_API = {
    "codigo_integracao": "ClientIntegrationCode",
    "template_cliente": "ClientTemplateIntegrationCode",
    "unidade_organizacional": "OrganizationalUnitIntegrationCode",
    "codigo": "Code",
    "cliente_tipo": "ClientType",
    "nome": "TradingName",
    "razao_social": "CompanyName",
    "cpf_cnpj": "DocumentNumber",
    "registro": "RegisterNumber",
    "procedimento_atendimento": "CustomerSupportProcedure",
    "nome_usuario": "UserName",
    "login": "Login",
    "senha": "Password",
    "perfil_acesso": "UserProfileTemplateIntegrationCode",
    "telefone": "PhoneNumber",
    "celular": "CellPhoneNumber",
}

# Mesma ideia de CONVERSOR_CLIENTES_PARA_API, mas pro Conversor de Veículos:
# chave de validador_importacao/tipo_veiculo.py CAMPOS_VEICULO -> campo
# aceito pela API de importação (PARAMS["veiculo"]). A API só aceita o
# Rastreador 1 com 1 SIM card (Tracker1.Simcard1.*) — sem os campos de status
# do mapa (têm default fixo no Insert), responsável, motorista, rastreador 2
# nem o 2º SIM card do rastreador 1: esses ficam de fora do mapeamento
# sugerido, só saem pelo arquivo .txt (que leva o layout completo).
CONVERSOR_VEICULOS_PARA_API = {
    "codigo_integracao_veiculo": "VehicleIntegrationCode",
    "codigo_integracao_cliente": "ClientIntegrationCode",
    "identificacao": "Identification",
    "placa": "LicensePlate",
    "chassi": "ChassiNumber",
    "renavam": "RenavamNumber",
    "cor": "Color",
    "uf": "FederalState",
    "cidade": "City",
    "ano_modelo": "ModelYear",
    "ano_fabricacao": "FabricationYear",
    "combustivel": "Fuel",
    "qr_code": "QRCode",
    "codigo_fipe": "FipeCode",
    "icone_mapa": "IdMapIcon",
    "cor_icone_mapa": "IdMapIconColor",
    "veiculo_cliente": "ClientVehicleIntegrationCode",
    "rastreador1_codigo_integracao": "Tracker1.TrackerIntegrationCode",
    "rastreador1_identificacao": "Tracker1.IdTracker",
    "rastreador1_template": "Tracker1.TrackerTemplateIntegrationCode",
    "rastreador1_imei": "Tracker1.TrackerIMEI",
    "rastreador1_iccid1": "Tracker1.Simcard1.ICCID",
    "rastreador1_apn1": "Tracker1.Simcard1.APN",
    "rastreador1_ddi1": "Tracker1.Simcard1.CountryCode",
    "rastreador1_ddd1": "Tracker1.Simcard1.AreaCode",
    "rastreador1_telefone1": "Tracker1.Simcard1.PhoneNumber",
}

# Idem, mas pro Conversor de Rastreadores: chave de
# validador_importacao/tipo_rastreador.py CAMPOS_RASTREADOR -> campo aceito
# por PARAMS["rastreador"] (Tracker/Insert). Domínio pequeno o bastante pra
# mapear TODOS os 10 campos do layout oficial, diferente de Cliente/Veículo.
CONVERSOR_RASTREADORES_PARA_API = {
    "codigo_integracao": "TrackerIntegrationCode",
    "identificacao": "IdTracker",
    "identificacao_auxiliar": "AuxiliaryId",
    "template": "TrackerTemplateIntegrationCode",
    "status": "StatusIntegrationCode",
    "codigo_integracao_cliente": "ClientIntegrationCode",
    "data_aquisicao": "AcquisitionDate",
    "iccid1": "ICCID1",
    "iccid2": "ICCID2",
    "imei": "IMEI",
}

# Idem, mas pro Conversor de SIM Cards: chave de
# validador_importacao/tipo_simcard.py CAMPOS_SIMCARD -> campo aceito por
# PARAMS["simcard"] (SimCard/Insert). Também cobre os 10 campos do layout
# oficial inteiro.
CONVERSOR_SIMCARDS_PARA_API = {
    "iccid": "ICCID",
    "apn_dominio": "APNDomain",
    "ddi": "CountryCallingCode",
    "ddd": "AreaCallingCode",
    "telefone": "PhoneNumber",
    "dia_corte": "BillingCylcleEndDay",
    "valor_plano": "Price",
    "limite_megabytes": "MegabyteLimit",
    "pin": "PIN",
    "puk": "PUK",
}

# Idem, mas pro Conversor de Áreas: chave de
# validador_importacao/tipo_area.py CAMPOS_AREA -> campo aceito por
# PARAMS["area"] (Geography/Insert). "Cor" fica de fora (API não aceita);
# "Tipo" precisa virar código (1/2/3) e "Tolerância" precisa de um default
# quando vazia — os dois ajustes acontecem em
# conversor_areas_usar_como_upload, não aqui (este dict só mapeia NOMES de
# campo, não transforma valores).
CONVERSOR_AREAS_PARA_API = {
    "codigo_integracao": "GeographyIntegrationCode",
    "nome": "Name",
    "descricao": "Description",
    "tipo": "Type",
    "coordenadas": "Area",
    "tolerancia": "Tolerance",
    "grupo": "GroupIntegrationCode",
    "categoria": "ListCategoryIntegrationCode",
}

# Idem, mas pro Conversor de Unidades Organizacionais: chave de
# validador_importacao/tipo_uo.py CAMPOS_UO -> campo aceito por PARAMS["uo"]
# (OrganizationalUnit/Insert). Cobertura completa (6/6) — mesma situação de
# Rastreador/SIM Card, diferente de Veículo.
CONVERSOR_UO_PARA_API = {
    "codigo_integracao": "OrganizationalUnitIntegrationCode",
    "nome": "Name",
    "tipo": "TypeOrganizationalUnit",
    "unidade_pai": "ParentOrganizationalUnitIntegrationCode",
    "codigo_integracao_cliente": "ClientIntegrationCode",
    "descricao": "Description",
}

# Idem, mas pro Conversor de Colaboradores: chave de
# validador_importacao/tipo_colaborador.py CAMPOS_COLABORADOR -> campo
# aceito por PARAMS["colaborador"] (Person/InsertPerson). "is_passageiro"
# fica de fora (API não tem esse campo, só existe no layout de arquivo).
CONVERSOR_COLABORADORES_PARA_API = {
    "codigo_integracao": "PersonIntegrationCode",
    "unidade_organizacional": "OrganizationUnitIntegrationCode",
    "nome": "Name",
    "email": "Email",
    "ddi": "CountryCode",
    "ddd": "AreaCode",
    "celular": "CellPhoneNumber",
    "telefone": "PhoneNumber",
    "identidade": "IDCard",
    "cpf": "CPF",
    "data_nascimento": "DateOfBirth",
    "sexo": "Gender",
    "tipo_identificador": "IdentifierType",
    "tipo_codigo_acesso": "AccessCodeType",
    "codigo_acesso": "AccessCode",
    "gmt": "TimeZone",
    "horario_verao": "DaylightSaving",
    "idioma": "Language",
    "pais": "Country",
    "cargo": "PersonRoleIntegrationCode",
    "escala": "WorkScheduleIntegrationCode",
    "tipo_consolidacao_jornada": "ConsolidationType",
    "matricula": "Registration",
    "cnh": "LicenseDriver",
    "data_validade_cnh": "ExpirationDateLicenseDriver",
    "data_emissao_cnh": "EmissionDateLicenseDriver",
    "data_primeira_habilitacao": "FirstDateLicenseDriver",
    "categoria_cnh": "LicenseRegistrationType",
    "perfil_acesso": "UserProfileTemplateIntegrationCode",
    "login": "Login",
    "senha": "Password",
}

LISTAGENS = {
    "clientes": dict(
        endpoint="/Administration/Client/List",
        payload=[{"PropertyName": "Active", "Condition": "Equal", "Value": True}],
        headers=["COD", "NOME", "DOC", "LOGIN"],
        campos=["ClientIntegrationCode", "TradingName", "DocumentNumber", "Login"],
    ),
    "veiculos": dict(
        endpoint="/Administration/Vehicle/List",
        payload=None,
        headers=["CLIENTE", "IDENTIFICAÇÃO", "ID DO RASTREADOR", "MODELO DO RASTREADOR", "TELEFONE DO CHIP"],
        campos=["ClientTradingName", "Identification", "IdTracker", "IdModelTracker", "PhoneNumber"],
    ),
    "rastreadores": dict(
        endpoint="/Administration/Tracker/List",
        payload=None,
        headers=["ID", "COD", "MODELO"],
        campos=["IdTracker", "TrackerIntegrationCode", "IdTrackerModel"],
    ),
    "pessoas": dict(
        endpoint="/Administration/Person/ListPerson",
        payload=None,
        headers=["CLIENTE", "LOGIN", "ATIVO"],
        campos=["ClientName", "Login", "IsActivatedClient"],
    ),
    "desatualizados": dict(
        # payload=None (sem filtro) traz TODOS os desatualizados — o filtro
        # antigo (EventDate Equal None) não era um bug, é um recorte válido
        # de "nunca comunicou", mas restrito demais pra esta listagem geral
        # (confirmado contra a API real: com filtro, só os que nunca tiveram
        # EventDate; sem filtro, todos os desatualizados).
        endpoint="/Administration/Tracker/ListOutdatedTrackedUnits",
        payload=None,
        headers=["CLIENTE", "TRACKER", "UNIT"],
        campos=["ClientTradingName", "Tracker", "TrackedUnit"],
    ),
    "atualizados": dict(
        endpoint="/Administration/Tracker/ListMonitoredTrackedUnits",
        payload=None,
        headers=["CLIENTE", "TRACKER", "UNIT"],
        campos=["ClientTradingName", "Tracker", "TrackedUnit"],
    ),
    "uos": dict(
        endpoint="/Administration/OrganizationalUnit/List",
        payload=None,
        headers=["NOME", "COD", "TIPO"],
        campos=["Name", "OrganizationalUnitIntegrationCode", "TypeOrganizationalUnit"],
    ),
    # Usadas por conversor_veiculos_verificar_duplicidade pra conferir se as
    # referências da planilha (template do rastreador, APN, responsável) já
    # estão cadastradas na SSX (ver doc oficial em
    # https://integration.systemsatx.com.br — spec "Administration").
    "templates_rastreador": dict(
        endpoint="/Administration/Tracker/ListTemplate",
        payload=None,
        headers=["NOME", "CÓDIGO DE INTEGRAÇÃO"],
        campos=["Name", "TrackerTemplateIntegrationCode"],
    ),
    "simcards": dict(
        endpoint="/Administration/SimCard/List",
        payload=None,
        headers=["ICCID", "APN", "TELEFONE"],
        campos=["ICCID", "APNDomain", "PhoneNumber"],
    ),
    # Usada por conversor_rastreadores_verificar_duplicidade/listar_templates
    # pra conferir se o "Status do rastreador" da planilha já está
    # cadastrado na SSX (campo não existe pra Veículo, só surgiu aqui).
    "status_rastreador": dict(
        endpoint="/Administration/Tracker/ListStatusTracker",
        payload=None,
        headers=["NOME", "CÓDIGO DE INTEGRAÇÃO"],
        campos=["Name", "TrackerStatusIntegrationCode"],
    ),
    # Idem, pro Conversor de Clientes (template do cliente, perfil de acesso).
    "templates_cliente": dict(
        endpoint="/Administration/Client/ListTemplate",
        payload=None,
        headers=["NOME", "CÓDIGO DE INTEGRAÇÃO"],
        campos=["Name", "ClientTemplateIntegrationCode"],
    ),
    "perfis_acesso": dict(
        endpoint="/Administration/Client/ListProfileTemplate",
        payload=None,
        headers=["NOME", "CÓDIGO DE INTEGRAÇÃO"],
        campos=["Name", "ClientProfileTemplateIntegrationCode"],
    ),
    # Usadas por conversor_areas_verificar_referencias/listar_categorias_e_grupos
    # pra conferir se Categoria/Grupo da planilha já estão cadastrados na SSX.
    # Não existe "Geography/List" no Swagger (só Insert/Update/Delete) — por
    # isso o Conversor de Áreas não tem checagem de duplicidade contra a SSX,
    # diferente dos outros 4 conversores.
    "categorias_area": dict(
        endpoint="/Administration/Geography/ListCategories",
        payload=None,
        headers=["NOME", "CÓDIGO DE INTEGRAÇÃO"],
        campos=["CategoryName", "CategoryIntegrationCode"],
    ),
    "grupos_area": dict(
        endpoint="/Administration/Geography/ListGroups",
        payload=None,
        headers=["NOME", "CÓDIGO DE INTEGRAÇÃO"],
        campos=["GroupName", "GroupIntegrationCode"],
    ),
}

# Armazenamento em memória dos Excel enviados (uso local, um usuário por vez)
UPLOADS = {}
UPLOADS_LOCK = threading.Lock()


def tratar_valor(caminho_completo, valor):
    """Trata o valor de acordo com o tipo esperado pelo campo (caminho completo, dot notation)."""
    v_str = str(valor).strip()
    if v_str.lower() == "nan" or v_str == "":
        return None
    if caminho_completo in INT_FIELDS:
        try:
            return int(float(v_str))
        except ValueError:
            return 0
    if caminho_completo in BOOL_FIELDS:
        return v_str.lower() in ["true", "1", "sim", "yes", "ativo"]
    if caminho_completo in FLOAT_FIELDS:
        try:
            return float(v_str.replace(",", "."))
        except ValueError:
            return None
    return v_str


def set_nested_value(d, keys, value, caminho_completo):
    """Define valores em dicionários aninhados usando dot notation."""
    for key in keys[:-1]:
        d = d.setdefault(key, {})
    val_tratado = tratar_valor(caminho_completo, value)
    if val_tratado is not None:
        d[keys[-1]] = val_tratado


def montar_payload(tipo_config, mapping, row):
    payload = dict(tipo_config.get("defaults", {}))
    for param, col_excel in mapping.items():
        valor = row[col_excel]
        if "." in param:
            set_nested_value(payload, param.split("."), valor, param)
        else:
            val = tratar_valor(param, valor)
            if val is not None:
                payload[param] = val
    return payload


def requisicao_padrao(endpoint, payload, token, timeout=20, retries=0):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    return ssx_http.post_json(
        f"{BASE_URL}{endpoint}",
        payload if payload is not None else [],
        headers,
        timeout=timeout,
        retries=retries,
    )


def _renderizar_shell():
    return render_template(
        "index.html",
        app_version=APP_VERSION,
        app_usuario=session.get("app_usuario_nome"),
        app_usuario_id=session.get("app_usuario_id", ""),
        app_usuario_perfil=session.get("app_usuario_perfil", "adm"),
        app_usuario_responsavel=session.get("app_usuario_responsavel", ""),
        app_usuario_tem_foto=session.get("app_usuario_tem_foto", False),
        app_usuario_foto_versao=session.get("app_usuario_foto_versao", 0),
        checklist_marcos_padrao=IMPLANTACAO_CHECKLIST_PADRAO,
    )


@app.route("/")
def index():
    return _renderizar_shell()


# As 3 rotas abaixo servem o mesmo shell de "/" — quem decide o que mostrar é o
# JS, lendo window.location.pathname (ver "NAVEGAÇÃO PRINCIPAL" em
# static/script.js). É isso que faz o botão Voltar/Avançar do navegador
# funcionar entre as telas em vez de cair na tela de login. Cada uma tem seu
# próprio endpoint (em vez de todas empilhadas em "index") pra não confundir
# os "url_for('index')" já usados nos redirects de login.
@app.route("/implantacao")
def tela_implantacao():
    return _renderizar_shell()


@app.route("/migracao")
def tela_migracao():
    return _renderizar_shell()


@app.route("/ferramentas")
def tela_ferramentas():
    return _renderizar_shell()


@app.route("/minha-conta")
def tela_minha_conta():
    return _renderizar_shell()


@app.route("/configuracoes")
def tela_configuracoes():
    # Página só pra admin — quem não é cai de volta no Dashboard (o próprio
    # menu do avatar já esconde o link pra quem não é admin, isso aqui é só
    # pra barrar acesso direto pela URL).
    if not _sou_admin():
        return redirect(url_for("index"))
    return _renderizar_shell()


@app.route("/feed")
def tela_feed():
    return _renderizar_shell()


# Sub-telas de Ferramentas Auxiliares (cards -> Área de Importação e Consulta /
# Envio de Comandos) — mesmo racional das rotas acima, quem decide o conteúdo é
# o JS lendo o path; <sub> nem precisa ser validado aqui.
@app.route("/ferramentas/<sub>")
def tela_ferramentas_sub(sub):
    return _renderizar_shell()


@app.route("/cliente/<idcentral>")
def tela_ficha_cliente(idcentral):
    return _renderizar_shell()


@app.route("/api/status")
def status():
    return jsonify(authenticated=bool(session.get("token")), idcentral=session.get("token_idcentral"))


def _autenticar_ssx(usuario, senha):
    """Troca login/senha por um token de acesso da SSX. Retorna (token, None)
    ou (None, mensagem_de_erro) — nunca levanta exceção."""
    try:
        r = requests.post(f"{BASE_URL}/Login", data={"Username": usuario, "Password": senha}, timeout=10)
        r.raise_for_status()
        token = r.json().get("AccessToken")
        if not token:
            return None, "Resposta sem token de acesso."
        return token, None
    except requests.exceptions.RequestException as e:
        return None, f"Falha ao autenticar: {e}"


def _claims_do_token(token):
    """O endpoint `/Login` da SSX (confirmado no Swagger) só devolve
    AccessToken + ExpiresIn — nenhum campo de "nome da base/central" nem
    endpoint separado de "dados da conta atual". Mas o AccessToken é um JWT
    (3 partes separadas por "."), e o nome da base pode estar codificado
    ali dentro como claim — decodifica só a 2ª parte (payload), sem validar
    assinatura (não precisa: a gente só está LENDO um token que a própria
    SSX acabou de emitir pra essa sessão, não confiando nele pra autorizar
    nada). Devolve {} se não for um JWT ou não der pra decodificar — nunca
    levanta exceção."""
    try:
        partes = token.split(".")
        if len(partes) != 3:
            return {}
        payload = partes[1]
        payload += "=" * (-len(payload) % 4)  # padding do base64url
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True) or {}
    usuario = str(data.get("login", "")).strip()
    senha = str(data.get("senha", ""))
    if not usuario or not senha:
        return jsonify(ok=False, error="Informe login e senha."), 400
    token, erro = _autenticar_ssx(usuario, senha)
    if erro:
        return jsonify(ok=False, error=erro), 400
    session["token"] = token
    claims = _claims_do_token(token)
    # Login manual (avulso) nunca fica vinculado a um cliente específico —
    # mesmo que a sessão já estivesse vinculada a um antes.
    session.pop("token_idcentral", None)
    # "claims" só pra telas que queiram mostrar algo além do login digitado
    # (ex.: nome da base, se existir como claim no JWT) — ver
    # _claims_do_token. Pode vir {} se o token não for um JWT decodificável.
    return jsonify(ok=True, claims=claims)


def _token_para(idcentral_solicitado):
    """Confere se o token da sessão pode ser usado pra esta chamada.
    idcentral_solicitado=None => chamada avulsa (Ferramentas Auxiliares).
    Retorna (token, None, None) se ok, ou (None, resposta_jsonify, status) se não —
    é essa checagem que garante que uma ação nunca roda pro cliente errado,
    mesmo com sessão desatualizada (aba antiga, outra aba autenticou outro
    cliente, etc.)."""
    token = session.get("token")
    if not token:
        return None, jsonify(ok=False, error="Autentique-se primeiro."), 401
    vinculado = session.get("token_idcentral")
    if idcentral_solicitado:
        if vinculado != idcentral_solicitado:
            return None, jsonify(
                ok=False,
                error="Sessão não corresponde a este cliente — autentique novamente na Ficha.",
            ), 409
    elif vinculado:
        return None, jsonify(
            ok=False,
            error="Sessão está vinculada a um cliente específico. Reautentique em Ferramentas Auxiliares > Autenticação.",
        ), 409
    return token, None, None


def _token_para_cliente(cliente_id):
    """Autentica na SSX usando a credencial já salva no cliente
    (`CredencialCliente` — Ficha do Cliente > Credencial SSX), sem depender
    de sessão nem de um login manual avulso. Usado pelas rotas de
    Sincronização de Veículos/Verificação de Comunicação, que rodam dentro da
    Ficha de um cliente específico — diferente de `_token_para`, que serve
    Ferramentas Auxiliares (login avulso, sem cliente fixo).
    Retorna (token, None, None) se ok, ou (None, resposta_jsonify, status) se não."""
    cred = credenciais_sql.obter_credencial_cliente(cliente_id)
    if not cred or not cred.get("login") or not cred.get("senha"):
        return None, jsonify(
            ok=False,
            error="Esse cliente ainda não tem uma credencial SSX salva (Ficha do Cliente > Credencial SSX).",
        ), 400
    token, erro = _autenticar_ssx(cred["login"], cred["senha"])
    if erro:
        return None, jsonify(ok=False, error=f"Falha ao autenticar com a credencial salva: {erro}"), 502
    return token, None, None


@app.route("/api/logout-avulso", methods=["POST"])
def logout_avulso():
    # Limpa só o token de login avulso (Área de Importação e Consulta), ao sair
    # da tela. Nunca mexe numa sessão vinculada a cliente (token_idcentral
    # setado, de um jeito que hoje nada mais seta), e diferente de /api/logout
    # (botão "Sair"), NÃO desloga da ferramenta em si.
    if not session.get("token_idcentral"):
        session.pop("token", None)
    return jsonify(ok=True)


@app.route("/api/ficha/<idcentral>/credencial", methods=["PUT"])
def ficha_salvar_credencial(idcentral):
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem alterar a credencial da SSX do cliente."), 403
    cliente = clientes_sql.buscar_cliente_por_idcentral(idcentral)
    if not cliente:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    data = request.get_json(force=True) or {}
    login_novo = str(data.get("login", "")).strip()
    senha_nova = str(data.get("senha", ""))
    if not login_novo:
        return jsonify(ok=False, error="Informe o login."), 400
    dados_atuais = credenciais_sql.obter_credencial_cliente(cliente["id"]) or {}
    # Senha em branco = mantém a que já estava salva (mesmo padrão da senha de
    # usuário em "Gerenciar usuários" — não obriga redigitar pra só trocar o login).
    senha_final = senha_nova if senha_nova else dados_atuais.get("senha", "")
    if not senha_final:
        return jsonify(ok=False, error="Informe a senha."), 400
    credenciais_sql.salvar_credencial_cliente(cliente["id"], login_novo, senha_final)
    return jsonify(ok=True, login=login_novo, credencial_configurada=True)


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(ok=True)


# --- LOGINS SALVOS (para trocar de cliente rapidamente) ---
# Guardados no Firestore (coleção "credenciais"), sobrevive a redeploys.
# Admin-only: são senhas em texto puro, e essa lista não é vinculada a um
# cliente/dono específico — restrito assim pra não expor senha de terceiros
# a qualquer perfil logado. A lista também inclui (origem="cliente") as
# credenciais cadastradas na configuração de cada cliente — ver
# credenciais_sql.listar_credenciais_clientes_para_logins_salvos; essas só
# podem ser editadas/excluídas pela Ficha, não pelos endpoints de edição abaixo.
@app.route("/api/credenciais", methods=["GET"])
def listar_credenciais():
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem ver os logins salvos."), 403
    lista = [dict(c, origem="manual") for c in credenciais_sql.listar_credenciais_manuais()]
    lista.extend(credenciais_sql.listar_credenciais_clientes_para_logins_salvos())
    lista.sort(key=lambda c: c.get("nome") or "")
    return jsonify(ok=True, credenciais=lista)


@app.route("/api/credenciais", methods=["POST"])
def criar_credencial():
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem cadastrar logins salvos."), 403
    data = request.get_json(force=True) or {}
    nome = str(data.get("nome", "")).strip()
    login = str(data.get("login", "")).strip()
    senha = str(data.get("senha", ""))
    if not nome or not login or not senha:
        return jsonify(ok=False, error="Informe nome, login e senha."), 400
    credencial = credenciais_sql.criar_credencial(nome, login, senha)
    return jsonify(ok=True, credencial=credencial)


@app.route("/api/credenciais/<int:cred_id>", methods=["PUT"])
def editar_credencial(cred_id):
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem editar logins salvos."), 403
    data = request.get_json(force=True) or {}
    nome = str(data.get("nome", "")).strip()
    login = str(data.get("login", "")).strip()
    senha = str(data.get("senha", ""))
    if not nome or not login or not senha:
        return jsonify(ok=False, error="Informe nome, login e senha."), 400
    credencial = credenciais_sql.editar_credencial(cred_id, nome, login, senha)
    if not credencial:
        return jsonify(ok=False, error="Login não encontrado."), 404
    return jsonify(ok=True, credencial=credencial)


@app.route("/api/credenciais/<int:cred_id>", methods=["DELETE"])
def excluir_credencial(cred_id):
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem excluir logins salvos."), 403
    if not credenciais_sql.excluir_credencial(cred_id):
        return jsonify(ok=False, error="Login não encontrado."), 404
    return jsonify(ok=True)


# --- CATÁLOGO DE COMANDOS DE RASTREADORES (Ferramentas > Envio de Comandos) ---
# 4 entidades, guardadas no Firestore:
#   Fabricantes -> Modelos de rastreador -> Modelos de comando (templates)
#   Parâmetros de comando (catálogo à parte, referenciado pelos templates)
# Um "modelo de comando" tem um `template` com placeholders tipo "{porta}" e uma
# lista `modelosRastreadorIds` — o mesmo comando pode se aplicar a vários
# modelos de rastreador de uma vez (evita recadastrar o mesmo template repetido
# pra cada modelo). Substitui o antigo par comando_modelos/comando_itens e as
# listas fixas MODELOS_RASTREADOR/COMANDOS_POR_MODELO que viviam no JS.
#
# ATENÇÃO — existe um sistema PARECIDO mas separado: cada cliente em migração
# já tem sua própria subcoleção "modelos_comando" (migracao_clientes/<id>/
# modelos_comando — ver _preencher_comandos_por_modelo mais abaixo), usada só
# pra preencher a coluna "Comando" da planilha batendo o "Equipamento" digitado
# com um modelo cadastrado NAQUELE cliente. É simples (só o placeholder
# "{porta}", via .replace(), sem catálogo de parâmetro nenhum) e funciona hoje.
# Esse catálogo GLOBAL aqui é o que a Duda pediu pra unificar Envio de Comando +
# Gerenciar modelos — os dois sistemas ficam separados por enquanto (não mexi
# no de migração), a ideia de um alimentar o outro é planejamento pra depois.
FABRICANTES_COLLECTION = "fabricantes"
MODELOS_RASTREADOR_COLLECTION = "modelos_rastreador"
PARAMETROS_COMANDO_COLLECTION = "parametros_comando"
MODELOS_COMANDO_COLLECTION = "catalogo_comandos"
TIPOS_PARAMETRO_COMANDO = ["texto", "select"]


def _parametros_do_template(template):
    """Extrai as chaves {chave} usadas num template, na ordem em que aparecem."""
    return re.findall(r"\{(\w+)\}", template or "")


def preencher_template_comando(template, valores):
    """Substitui {chave} do template pelos valores informados — chave sem valor
    vira string vazia (nunca estoura erro por faltar campo no formulário)."""
    valores_seguros = {chave: str(valores.get(chave) or "") for chave in _parametros_do_template(template)}
    try:
        return template.format(**valores_seguros)
    except (KeyError, ValueError, IndexError):
        return None


@app.route("/api/fabricantes", methods=["GET"])
def listar_fabricantes():
    docs = db.collection(FABRICANTES_COLLECTION).stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    return jsonify(ok=True, fabricantes=lista)


@app.route("/api/fabricantes", methods=["POST"])
@requer_operador
def criar_fabricante():
    data = request.get_json(force=True) or {}
    nome = str(data.get("nome", "")).strip()
    if not nome:
        return jsonify(ok=False, error="Informe o nome do fabricante."), 400
    doc_ref = db.collection(FABRICANTES_COLLECTION).document()
    dados = {"nome": nome}
    doc_ref.set(dados)
    return jsonify(ok=True, fabricante=dict(dados, id=doc_ref.id))


@app.route("/api/fabricantes/<fabricante_id>", methods=["PUT"])
@requer_operador
def editar_fabricante(fabricante_id):
    data = request.get_json(force=True) or {}
    nome = str(data.get("nome", "")).strip()
    if not nome:
        return jsonify(ok=False, error="Informe o nome do fabricante."), 400
    doc_ref = db.collection(FABRICANTES_COLLECTION).document(fabricante_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Fabricante não encontrado."), 404
    dados = {"nome": nome}
    doc_ref.set(dados)
    return jsonify(ok=True, fabricante=dict(dados, id=fabricante_id))


@app.route("/api/fabricantes/<fabricante_id>", methods=["DELETE"])
@requer_operador
def excluir_fabricante(fabricante_id):
    doc_ref = db.collection(FABRICANTES_COLLECTION).document(fabricante_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Fabricante não encontrado."), 404
    # Não apaga os modelos de rastreador desse fabricante — só solta o vínculo,
    # pra nunca derrubar comandos já cadastrados por engano.
    modelos = db.collection(MODELOS_RASTREADOR_COLLECTION).where(
        filter=FieldFilter("fabricanteId", "==", fabricante_id)
    ).stream()
    for m in modelos:
        m.reference.update({"fabricanteId": None})
    doc_ref.delete()
    return jsonify(ok=True)


@app.route("/api/modelos-rastreador", methods=["GET"])
def listar_modelos_rastreador():
    docs = db.collection(MODELOS_RASTREADOR_COLLECTION).stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    return jsonify(ok=True, modelos=lista)


@app.route("/api/modelos-rastreador", methods=["POST"])
@requer_operador
def criar_modelo_rastreador():
    data = request.get_json(force=True) or {}
    nome = str(data.get("nome", "")).strip()
    fabricante_id = str(data.get("fabricanteId") or "").strip() or None
    if not nome:
        return jsonify(ok=False, error="Informe o nome do modelo."), 400
    doc_ref = db.collection(MODELOS_RASTREADOR_COLLECTION).document()
    dados = {"nome": nome, "fabricanteId": fabricante_id}
    doc_ref.set(dados)
    return jsonify(ok=True, modelo=dict(dados, id=doc_ref.id))


@app.route("/api/modelos-rastreador/<modelo_id>", methods=["PUT"])
@requer_operador
def editar_modelo_rastreador(modelo_id):
    data = request.get_json(force=True) or {}
    nome = str(data.get("nome", "")).strip()
    fabricante_id = str(data.get("fabricanteId") or "").strip() or None
    if not nome:
        return jsonify(ok=False, error="Informe o nome do modelo."), 400
    doc_ref = db.collection(MODELOS_RASTREADOR_COLLECTION).document(modelo_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Modelo não encontrado."), 404
    dados = {"nome": nome, "fabricanteId": fabricante_id}
    doc_ref.set(dados)
    return jsonify(ok=True, modelo=dict(dados, id=modelo_id))


@app.route("/api/modelos-rastreador/<modelo_id>", methods=["DELETE"])
@requer_operador
def excluir_modelo_rastreador(modelo_id):
    doc_ref = db.collection(MODELOS_RASTREADOR_COLLECTION).document(modelo_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Modelo não encontrado."), 404
    # Tira esse modelo de qualquer "modelo de comando" que o referencie — sem
    # apagar o comando em si, que pode se aplicar a outros modelos também.
    comandos = db.collection(MODELOS_COMANDO_COLLECTION).where(
        filter=FieldFilter("modelosRastreadorIds", "array_contains", modelo_id)
    ).stream()
    for c in comandos:
        ids_restantes = [i for i in (c.to_dict() or {}).get("modelosRastreadorIds", []) if i != modelo_id]
        c.reference.update({"modelosRastreadorIds": ids_restantes})
    doc_ref.delete()
    return jsonify(ok=True)


@app.route("/api/parametros-comando", methods=["GET"])
def listar_parametros_comando():
    docs = db.collection(PARAMETROS_COMANDO_COLLECTION).stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    return jsonify(ok=True, parametros=lista)


def _validar_parametro_comando(data, chave_atual_id=None):
    chave = str(data.get("chave", "")).strip().lower()
    label = str(data.get("label", "")).strip()
    tipo = str(data.get("tipo", "")).strip()
    if not chave or not re.fullmatch(r"[a-z][a-z0-9_]*", chave):
        return None, "Chave inválida — use letras minúsculas, números e _ (ex.: apn, id_esn)."
    if not label:
        return None, "Informe o nome (label) do parâmetro."
    if tipo not in TIPOS_PARAMETRO_COMANDO:
        return None, "Tipo inválido — use 'texto' ou 'select'."
    opcoes = []
    if tipo == "select":
        for o in data.get("opcoes") or []:
            ol = str(o.get("label", "")).strip()
            ov = str(o.get("valor", "")).strip()
            if ol and ov:
                opcoes.append({"label": ol, "valor": ov})
        if not opcoes:
            return None, "Parâmetro do tipo 'select' precisa de pelo menos uma opção."
    outros = db.collection(PARAMETROS_COMANDO_COLLECTION).where(filter=FieldFilter("chave", "==", chave)).stream()
    if any(o.id != chave_atual_id for o in outros):
        return None, f"Já existe um parâmetro com a chave '{chave}'."
    return {"chave": chave, "label": label, "tipo": tipo, "opcoes": opcoes}, None


@app.route("/api/parametros-comando", methods=["POST"])
@requer_operador
def criar_parametro_comando():
    dados, erro = _validar_parametro_comando(request.get_json(force=True) or {})
    if erro:
        return jsonify(ok=False, error=erro), 400
    doc_ref = db.collection(PARAMETROS_COMANDO_COLLECTION).document()
    doc_ref.set(dados)
    return jsonify(ok=True, parametro=dict(dados, id=doc_ref.id))


@app.route("/api/parametros-comando/<parametro_id>", methods=["PUT"])
@requer_operador
def editar_parametro_comando(parametro_id):
    doc_ref = db.collection(PARAMETROS_COMANDO_COLLECTION).document(parametro_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Parâmetro não encontrado."), 404
    dados, erro = _validar_parametro_comando(request.get_json(force=True) or {}, chave_atual_id=parametro_id)
    if erro:
        return jsonify(ok=False, error=erro), 400
    doc_ref.set(dados)
    return jsonify(ok=True, parametro=dict(dados, id=parametro_id))


@app.route("/api/parametros-comando/<parametro_id>", methods=["DELETE"])
@requer_operador
def excluir_parametro_comando(parametro_id):
    doc_ref = db.collection(PARAMETROS_COMANDO_COLLECTION).document(parametro_id)
    doc = doc_ref.get()
    if not doc.exists:
        return jsonify(ok=False, error="Parâmetro não encontrado."), 404
    chave = (doc.to_dict() or {}).get("chave", "")
    # Barra a exclusão se algum template ainda usa essa chave — evita quebrar
    # comando já cadastrado sem avisar.
    em_uso = [
        c.to_dict().get("nome", "?")
        for c in db.collection(MODELOS_COMANDO_COLLECTION).stream()
        if chave in _parametros_do_template((c.to_dict() or {}).get("template", ""))
    ]
    if em_uso:
        return jsonify(ok=False, error=f"Parâmetro em uso nos comandos: {', '.join(em_uso)}."), 409
    doc_ref.delete()
    return jsonify(ok=True)


@app.route("/api/modelos-comando", methods=["GET"])
def listar_modelos_comando():
    docs = db.collection(MODELOS_COMANDO_COLLECTION).stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    return jsonify(ok=True, comandos=lista)


def _validar_modelo_comando(data):
    nome = str(data.get("nome", "")).strip()
    template = str(data.get("template", "")).strip()
    modelos_ids = [str(i).strip() for i in (data.get("modelosRastreadorIds") or []) if str(i).strip()]
    if not nome or not template:
        return None, "Informe nome e template do comando."
    return {"nome": nome, "template": template, "modelosRastreadorIds": modelos_ids}, None


@app.route("/api/modelos-comando", methods=["POST"])
@requer_operador
def criar_modelo_comando():
    dados, erro = _validar_modelo_comando(request.get_json(force=True) or {})
    if erro:
        return jsonify(ok=False, error=erro), 400
    doc_ref = db.collection(MODELOS_COMANDO_COLLECTION).document()
    doc_ref.set(dados)
    return jsonify(ok=True, comando=dict(dados, id=doc_ref.id))


@app.route("/api/modelos-comando/<comando_id>", methods=["PUT"])
@requer_operador
def editar_modelo_comando(comando_id):
    doc_ref = db.collection(MODELOS_COMANDO_COLLECTION).document(comando_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Comando não encontrado."), 404
    dados, erro = _validar_modelo_comando(request.get_json(force=True) or {})
    if erro:
        return jsonify(ok=False, error=erro), 400
    doc_ref.set(dados)
    return jsonify(ok=True, comando=dict(dados, id=comando_id))


@app.route("/api/modelos-comando/<comando_id>", methods=["DELETE"])
@requer_operador
def excluir_modelo_comando(comando_id):
    doc_ref = db.collection(MODELOS_COMANDO_COLLECTION).document(comando_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Comando não encontrado."), 404
    doc_ref.delete()
    return jsonify(ok=True)


# --- CLIENTES EM IMPLANTAÇÃO (menu "Implantação") ---
# Cadastro simples e independente do resto do app: acompanha clientes que estão
# entrando na base (data de entrada, objetivo, valor do contrato, CSM responsável).
# Cada cliente tem uma subcoleção "eventos" (a linha do tempo por setor); a
# "última ação" exibida na listagem é sempre calculada a partir dela, nunca
# digitada — é só o acontecimento mais recente entre os 4 setores.
IMPLANTACAO_CLIENTES_COLLECTION = "implantacao_clientes"
# "NPS" segue o mesmo racional de "Suporte": setor normal (aparece no filtro
# e é selecionável num acontecimento manual), mas na prática é atribuído
# automaticamente aos eventos sintéticos de avaliação da Wootric — ver
# construirEventosSinteticosWootric em script.js. Ordem precisa bater com
# IMPLANTACAO_SETORES em script.js.
IMPLANTACAO_SETORES = ["Implantação", "Migração", "Suporte", "Comercial", "Treinamento", "Financeiro", "NPS"]
# Tag opcional do acontecimento — colore a bolinha na Timeline da Ficha
# (aba Histórico). Mesma lista/cores do "Acompanhamento de cliente" do
# kanban_dashboard_dev, replicada aqui pra manter o mesmo formato visual.
# "Suporte"/"NPS" NÃO entram aqui de propósito: são atribuídas
# automaticamente só aos eventos sintéticos (chamados do ssxdesk/avaliações
# da Wootric), nunca escolhidas à mão — ver construirEventosSinteticosChamados
# e construirEventosSinteticosWootric em script.js.
EVENTO_TAGS = [
    "Operação", "Migração", "Fricção", "Sugestão de desenvolvimento", "Travamento", "Problema",
    "Comercial", "Treinamento", "Financeiro",
]
# Etapas oficiais do Kanban de Implantação (Fase 1 só usa o campo pra guardar/exibir;
# a visão em Kanban propriamente dita é de uma fase seguinte).
IMPLANTACAO_ETAPAS = ["marco-1", "marco-2", "marco-3", "marco-4", "marco-5", "concluido"]
IMPLANTACAO_ETAPA_PADRAO = "marco-1"
# Marcos "marcáveis" (checkbox) — "concluido" fica de fora por ser o estado
# derivado quando os 5 abaixo estão marcados, não um marco em si.
IMPLANTACAO_MARCOS = ["marco-1", "marco-2", "marco-3", "marco-4", "marco-5"]

# Checklist padrão de cada marco — vale pra todo cliente. O "id" é o que fica
# salvo em marcos_itens_feitos, então NÃO mude o id de um item que já está em
# uso (só o texto); item novo = id novo. Cada cliente ainda pode ter itens
# extras só dele (marcos_itens_extras), editados pelo modal de Marcos.
# Itens tirados do "Plano de Sucesso do Cliente — Jornada de 180 Dias". O
# Marco 2 (Quick Win) é quase todo montado por cliente: as prioridades
# acordadas no kick-off, cada uma com suas subtarefas (marcos_prioridades).
# Textos = "Definition of Done" do Playbook SSX (seção 16). Onde o sentido do
# item antigo continuou o mesmo, o id foi mantido (quem já marcou continua
# marcado); item com sentido novo ganhou id novo. Itens de passagem pro
# Onboarding saíram do Marco 3 de propósito (vão virar formulário próprio).
IMPLANTACAO_CHECKLIST_PADRAO = {
    "marco-1": [
        {"id": "m1-parametrizacao", "texto": "Base preparada"},
        {"id": "m1-acessos", "texto": "Acessos liberados"},
        {"id": "m1-ativacao", "texto": "Usuários-chave conseguiram acessar"},
        {"id": "m1-kickoff", "texto": "Boas-vindas/Kick-off realizado"},
        {"id": "m1-prioridades", "texto": "Expectativas, Quick Win e próximos passos alinhados"},
    ],
    "marco-2": [
        {"id": "m2-quickwin", "texto": "Quick Win definida"},
        {"id": "m2-mao-na-massa", "texto": "Treinamento “Mão na Massa” realizado"},
        {"id": "m2-execucao", "texto": "Cenário/ação executado pelo cliente"},
        {"id": "m2-valor", "texto": "Primeiro valor percebido e validado"},
        {"id": "m2-continuidade", "texto": "Continuidade definida"},
    ],
    "marco-3": [
        {"id": "m3-operacao", "texto": "Uso recorrente estabelecido"},
        {"id": "m3-alem-quickwin", "texto": "Funcionalidades além da Quick Win utilizadas"},
        {"id": "m3-cenarios", "texto": "Cenários adicionais aplicáveis à operação"},
        {"id": "m3-oportunidades", "texto": "Novas oportunidades de uso identificadas"},
        {"id": "m3-adocao", "texto": "Evolução da adoção evidenciada"},
    ],
    "marco-4": [
        {"id": "m4-proficiente", "texto": "Uso consolidado e proficiente"},
        {"id": "m4-qbr", "texto": "Business Review/QBR realizada"},
        {"id": "m4-otimizacoes", "texto": "Gargalos e oportunidades identificados"},
        {"id": "m4-ganhos", "texto": "Otimizações implementadas e/ou ganhos mensurados"},
        {"id": "m4-continuidade", "texto": "Plano de continuidade definido"},
    ],
    "marco-5": [
        {"id": "m5-autonomo", "texto": "Cliente autônomo"},
        {"id": "m5-roi", "texto": "Percepção de valor/ROI validada"},
        {"id": "m5-nps", "texto": "Satisfação avaliada"},
        {"id": "m5-estrategia", "texto": "Estratégia de longo prazo definida"},
        {"id": "m5-upsell", "texto": "Oportunidades de expansão e advocacy avaliadas"},
    ],
}

# Motivo do atraso — árvore de decisão do Playbook (seção 17, "Cliente não
# está avançando"). A ação sugerida mora no front (MOTIVOS_ATRASO).
MOTIVOS_ATRASO = ["nao_executa", "nao_entende", "sem_estrutura", "nao_responde", "problema_tecnico", "expectativa"]
# Marco onde ficam as prioridades acordadas com o cliente (Quick Win).
IMPLANTACAO_MARCO_PRIORIDADES = "marco-2"


def _etapa_a_partir_dos_marcos(marcos_concluidos):
    for marco in IMPLANTACAO_MARCOS:
        if marco not in marcos_concluidos:
            return marco
    return "concluido"


def _marcos_concluidos_derivados(itens_feitos, itens_extras, concluidos_manual, prioridades=()):
    """Marco conclui sozinho quando todos os itens dele (padrão + extras do
    cliente + subtarefas das prioridades, no Marco 2) estão feitos, ou quando
    foi marcado como concluído manualmente."""
    feitos = set(itens_feitos)
    concluidos = []
    for marco in IMPLANTACAO_MARCOS:
        ids = [i["id"] for i in IMPLANTACAO_CHECKLIST_PADRAO.get(marco, [])]
        ids += [i["id"] for i in itens_extras.get(marco, [])]
        if marco == IMPLANTACAO_MARCO_PRIORIDADES:
            ids += [i["id"] for p in prioridades for i in p["itens"]]
        if marco in concluidos_manual or (ids and all(i in feitos for i in ids)):
            concluidos.append(marco)
    return concluidos


def _dados_implantacao_cliente(data):
    cliente = str(data.get("cliente", "")).strip()
    if not cliente:
        return None
    try:
        valor_contrato = float(data.get("valor_contrato") or 0)
    except (TypeError, ValueError):
        valor_contrato = 0
    etapa = str(data.get("etapa", "")).strip()
    if etapa not in IMPLANTACAO_ETAPAS:
        etapa = IMPLANTACAO_ETAPA_PADRAO
    return {
        "idcentral": str(data.get("idcentral", "")).strip(),
        "cliente": cliente,
        "data_entrada": str(data.get("data_entrada", "")).strip(),
        "objetivo": str(data.get("objetivo", "")).strip(),
        "valor_contrato": valor_contrato,
        "csm": str(data.get("csm", "")).strip(),
        "etapa": etapa,
    }


def _dados_implantacao_evento(data):
    setor = str(data.get("setor", "")).strip()
    titulo = str(data.get("titulo", "")).strip()
    if not titulo or setor not in IMPLANTACAO_SETORES:
        return None
    tag = str(data.get("tag", "")).strip()
    if tag not in EVENTO_TAGS:
        tag = ""
    return {
        "setor": setor,
        "titulo": titulo,
        "descricao": str(data.get("descricao", "")).strip(),
        "data": str(data.get("data", "")).strip(),
        "responsavel": str(data.get("responsavel", "")).strip(),
        "tag": tag,
    }


def _recalcular_ultima_acao_implantacao(cliente_id):
    """Denormaliza o acontecimento mais recente (entre os 4 setores) direto no
    doc do cliente, pra a listagem não precisar de uma consulta extra à
    subcoleção "eventos" por cliente (era o gargalo do carregamento da tela).
    Chamado sempre que um evento é criado/editado/excluído."""
    doc_ref = db.collection(IMPLANTACAO_CLIENTES_COLLECTION).document(cliente_id)
    ultimo = list(
        doc_ref.collection("eventos")
        .order_by("data", direction=firestore.Query.DESCENDING)
        .limit(1)
        .stream()
    )
    if ultimo:
        ev = ultimo[0].to_dict()
        doc_ref.update({
            "ultima_acao": f"[{ev.get('setor')}] {ev.get('titulo')}",
            "ultima_acao_data": ev.get("data") or "",
        })
    else:
        doc_ref.update({"ultima_acao": "", "ultima_acao_data": ""})


@app.route("/api/implantacao/clientes", methods=["GET"])
def listar_implantacao_clientes():
    docs = list(db.collection(IMPLANTACAO_CLIENTES_COLLECTION).stream())
    lista = []
    for d in docs:
        cliente = dict(d.to_dict(), id=d.id)
        cliente.setdefault("etapa", IMPLANTACAO_ETAPA_PADRAO)
        # ultima_acao/ultima_acao_data são denormalizados no doc (ver
        # _recalcular_ultima_acao_implantacao) — evita 1 consulta extra por
        # cliente aqui, que era o gargalo do carregamento desta tela.
        cliente.setdefault("ultima_acao", "")
        cliente.setdefault("ultima_acao_data", "")
        lista.append(cliente)

    # Mais recente primeiro; "" (sem eventos ainda) sempre por último.
    lista.sort(key=lambda c: c["ultima_acao_data"], reverse=True)
    return jsonify(ok=True, clientes=lista)


@app.route("/api/implantacao/clientes", methods=["POST"])
def criar_implantacao_cliente():
    data = request.get_json(force=True) or {}
    dados = _dados_implantacao_cliente(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o nome do cliente."), 400
    doc_ref = db.collection(IMPLANTACAO_CLIENTES_COLLECTION).document()
    doc_ref.set(dados)
    return jsonify(ok=True, cliente=dict(dados, id=doc_ref.id))


@app.route("/api/implantacao/clientes/<cliente_id>", methods=["PUT"])
def editar_implantacao_cliente(cliente_id):
    data = request.get_json(force=True) or {}
    dados = _dados_implantacao_cliente(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o nome do cliente."), 400
    doc_ref = db.collection(IMPLANTACAO_CLIENTES_COLLECTION).document(cliente_id)
    doc_atual = doc_ref.get()
    if not doc_atual.exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    doc_atual_dict = doc_atual.to_dict() or {}
    if not _sou_admin():
        # IdCentral é a chave que liga Implantação e Migração — só admin altera
        # um valor já existente (edição). Ignora silenciosamente, mantém o resto.
        dados["idcentral"] = doc_atual_dict.get("idcentral", "")
    # dados (do formulário) não inclui ultima_acao/ultima_acao_data — como este
    # set() substitui o doc inteiro, precisa carregar esses dois campos adiante
    # explicitamente pra não apagar o denormalizado por _recalcular_ultima_acao_implantacao.
    dados["ultima_acao"] = doc_atual_dict.get("ultima_acao", "")
    dados["ultima_acao_data"] = doc_atual_dict.get("ultima_acao_data", "")
    doc_ref.set(dados)
    return jsonify(ok=True, cliente=dict(dados, id=cliente_id))


@app.route("/api/implantacao/clientes/<cliente_id>", methods=["DELETE"])
def excluir_implantacao_cliente(cliente_id):
    doc_ref = db.collection(IMPLANTACAO_CLIENTES_COLLECTION).document(cliente_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    for ev in doc_ref.collection("eventos").stream():
        ev.reference.delete()
    doc_ref.delete()
    return jsonify(ok=True)


@app.route("/api/implantacao/clientes/<cliente_id>/eventos", methods=["GET"])
def listar_implantacao_eventos(cliente_id):
    doc_ref = db.collection(IMPLANTACAO_CLIENTES_COLLECTION).document(cliente_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    docs = doc_ref.collection("eventos").stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    return jsonify(ok=True, eventos=lista)


@app.route("/api/implantacao/clientes/<cliente_id>/eventos", methods=["POST"])
def criar_implantacao_evento(cliente_id):
    doc_ref = db.collection(IMPLANTACAO_CLIENTES_COLLECTION).document(cliente_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    data = request.get_json(force=True) or {}
    dados = _dados_implantacao_evento(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o setor e o título."), 400
    evento_ref = doc_ref.collection("eventos").document()
    evento_ref.set(dados)
    _recalcular_ultima_acao_implantacao(cliente_id)
    return jsonify(ok=True, evento=dict(dados, id=evento_ref.id))


@app.route("/api/implantacao/clientes/<cliente_id>/eventos/<evento_id>", methods=["PUT"])
def editar_implantacao_evento(cliente_id, evento_id):
    data = request.get_json(force=True) or {}
    dados = _dados_implantacao_evento(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o setor e o título."), 400
    evento_ref = db.collection(IMPLANTACAO_CLIENTES_COLLECTION).document(cliente_id).collection("eventos").document(evento_id)
    if not evento_ref.get().exists:
        return jsonify(ok=False, error="Acontecimento não encontrado."), 404
    evento_ref.set(dados)
    _recalcular_ultima_acao_implantacao(cliente_id)
    return jsonify(ok=True, evento=dict(dados, id=evento_id))


@app.route("/api/implantacao/clientes/<cliente_id>/eventos/<evento_id>", methods=["DELETE"])
def excluir_implantacao_evento(cliente_id, evento_id):
    evento_ref = db.collection(IMPLANTACAO_CLIENTES_COLLECTION).document(cliente_id).collection("eventos").document(evento_id)
    if not evento_ref.get().exists:
        return jsonify(ok=False, error="Acontecimento não encontrado."), 404
    evento_ref.delete()
    _recalcular_ultima_acao_implantacao(cliente_id)
    return jsonify(ok=True)


# Etapas oficiais do Kanban interno de uma tentativa de migração (mesmo racional
# das etapas de Implantação acima) — usado tanto pela coleção antiga quanto pela
# tentativa nova (definido aqui, antes das duas, pra não dar NameError em nenhuma).
MIGRACAO_ETAPAS = ["analise", "importacao", "comandos", "concluido"]
MIGRACAO_ETAPA_PADRAO = "analise"


# --- CLIENTES (lista única, Postgres — ver clientes_sql.py) ---
# Cada cliente tem um "estagio" (Implantação -> Onboarding -> Ongoing,
# sequencial, um só por vez). Migração NÃO é um estágio — é uma condição
# paralela com histórico de tentativas (ver "migracoes_sql.py").
# "implantacao_clientes" (Firestore, legado) continua rodando à parte — não
# foi migrado nesta rodada (ver docs/HISTORICO_DECISOES.md).
ESTAGIOS_CLIENTE = ["implantacao", "onboarding", "ongoing"]
ESTAGIO_CLIENTE_PADRAO = "implantacao"

# Campos complementares (só aparecem na tela de Editar/Configurar, não no
# cadastro rápido de "Criar Cliente").
MOMENTO_CLIENTE_OPCOES = [
    "Starter", "Capacitação", "Consultorias", "Maturação", "Operando", "Sumido",
    "Ir para o Ongoing", "Protestado", "Cancelado", "Implantado",
    "Travado por Infraestrutura", "Possível Cancelamento",
]
FLAG_CLIENTE_OPCOES = ["Yellow Flag", "Red Flag", "Black Flag"]
PERSONA_CLIENTE_OPCOES = [
    "Associação", "Central de alarme", "Cliente final", "Empreendedor",
    "Central de rastreamento", "Lobo solitário", "Provedor de internet",
]

# Estados do Brasil — fixo (não muda), por isso não depende de chamada
# externa nenhuma. Município já é o oposto (~5600 cidades, muda de vez em
# quando) — esse sim busca na API de Localidades do IBGE, com cache em
# memória (ver /api/localidades/municipios/<uf> mais abaixo).
ESTADOS_BRASIL = [
    {"sigla": "AC", "nome": "Acre"}, {"sigla": "AL", "nome": "Alagoas"},
    {"sigla": "AP", "nome": "Amapá"}, {"sigla": "AM", "nome": "Amazonas"},
    {"sigla": "BA", "nome": "Bahia"}, {"sigla": "CE", "nome": "Ceará"},
    {"sigla": "DF", "nome": "Distrito Federal"}, {"sigla": "ES", "nome": "Espírito Santo"},
    {"sigla": "GO", "nome": "Goiás"}, {"sigla": "MA", "nome": "Maranhão"},
    {"sigla": "MT", "nome": "Mato Grosso"}, {"sigla": "MS", "nome": "Mato Grosso do Sul"},
    {"sigla": "MG", "nome": "Minas Gerais"}, {"sigla": "PA", "nome": "Pará"},
    {"sigla": "PB", "nome": "Paraíba"}, {"sigla": "PR", "nome": "Paraná"},
    {"sigla": "PE", "nome": "Pernambuco"}, {"sigla": "PI", "nome": "Piauí"},
    {"sigla": "RJ", "nome": "Rio de Janeiro"}, {"sigla": "RN", "nome": "Rio Grande do Norte"},
    {"sigla": "RS", "nome": "Rio Grande do Sul"}, {"sigla": "RO", "nome": "Rondônia"},
    {"sigla": "RR", "nome": "Roraima"}, {"sigla": "SC", "nome": "Santa Catarina"},
    {"sigla": "SP", "nome": "São Paulo"}, {"sigla": "SE", "nome": "Sergipe"},
    {"sigla": "TO", "nome": "Tocantins"},
]
SIGLAS_ESTADOS_BRASIL = {e["sigla"] for e in ESTADOS_BRASIL}

# Rótulos amigáveis dos campos editáveis de cliente, usados só pro diff que
# vai pro histórico (auditoria.diff_campos) — etapa/marcos_concluidos ficam
# de fora porque editar_cliente sempre restaura o valor já salvo (só mudam
# pelo endpoint dedicado de marcos, que registra a própria ação).
ROTULOS_CLIENTE = {
    "idcentral": "IdCentral",
    "cliente": "Nome do cliente",
    "data_entrada": "Data de entrada",
    "objetivo": "Objetivo",
    "valor_contrato": "Valor do contrato",
    "csm": "CSM",
    "estagio": "Estágio",
    "momento": "Momento do cliente",
    "flag": "Flag",
    "vendedor": "Vendedor",
    "persona": "Persona",
    "decisor_nome": "Nome do decisor",
    "decisor_whatsapp": "WhatsApp do decisor",
    "decisor_estado": "Estado do decisor",
    "decisor_cidade": "Cidade do decisor",
    "codigo_idcentral": "Código IdCentral",
}


def _dados_cliente(data):
    idcentral = str(data.get("idcentral", "")).strip()
    if not idcentral:
        return None
    cliente = str(data.get("cliente", "")).strip()
    try:
        valor_contrato = float(data.get("valor_contrato") or 0)
    except (TypeError, ValueError):
        valor_contrato = 0
    etapa = str(data.get("etapa", "")).strip()
    if etapa not in IMPLANTACAO_ETAPAS:
        etapa = IMPLANTACAO_ETAPA_PADRAO
    estagio = str(data.get("estagio", "")).strip()
    if estagio not in ESTAGIOS_CLIENTE:
        estagio = ESTAGIO_CLIENTE_PADRAO
    momento = str(data.get("momento", "")).strip()
    if momento not in MOMENTO_CLIENTE_OPCOES:
        momento = ""
    flag = str(data.get("flag", "")).strip()
    if flag not in FLAG_CLIENTE_OPCOES:
        flag = ""
    persona = str(data.get("persona", "")).strip()
    if persona not in PERSONA_CLIENTE_OPCOES:
        persona = ""
    decisor_estado = str(data.get("decisor_estado", "")).strip().upper()
    if decisor_estado not in SIGLAS_ESTADOS_BRASIL:
        decisor_estado = ""
    return {
        "idcentral": idcentral,
        "cliente": cliente,
        # False só quando o cliente nasceu pela tela de Migração e não tem par
        # na Implantação (ver POST /api/clientes chamado por lá) — controla o
        # menu enxuto da Ficha (sem Implantação/Marcos) e some do Kanban de
        # Implantação. Cliente criado pela Implantação de verdade nunca manda
        # esse campo, então cai no default True.
        "tem_implantacao": bool(data.get("tem_implantacao", True)),
        "data_entrada": str(data.get("data_entrada", "")).strip(),
        "objetivo": str(data.get("objetivo", "")).strip(),
        "valor_contrato": valor_contrato,
        "csm": str(data.get("csm", "")).strip(),
        "etapa": etapa,
        # Só é escrito de verdade pelo endpoint de marcos (PUT .../marcos) —
        # aqui o padrão é [] num cliente novo; editar_cliente restaura o
        # valor já salvo pra não resetar o progresso a cada edição comum.
        "marcos_concluidos": [m for m in (data.get("marcos_concluidos") or []) if m in IMPLANTACAO_MARCOS],
        "estagio": estagio,
        "momento": momento,
        "flag": flag,
        # Vendedor ainda é texto livre — vira lista suspensa quando a base de
        # funcionários com a tag "Comercial" for integrada (ainda não existe).
        "vendedor": str(data.get("vendedor", "")).strip(),
        "persona": persona,
        "decisor_nome": str(data.get("decisor_nome", "")).strip(),
        "decisor_whatsapp": str(data.get("decisor_whatsapp", "")).strip(),
        "decisor_estado": decisor_estado,
        # Cidade não é validada contra uma lista fixa — vem da API do IBGE,
        # filtrada pelo estado, mas o valor final salvo é só o nome mesmo.
        "decisor_cidade": str(data.get("decisor_cidade", "")).strip(),
        # Código de associação usado por sistemas externos (ex. Suporte) —
        # só perfil adm pode gravar (trava aplicada na rota de editar, não
        # aqui: aqui só extrai o que veio no payload).
        "codigo_idcentral": str(data.get("codigo_idcentral", "")).strip(),
    }


# Cache curto de respostas de listagem. No Firestore cada documento lido é uma
# leitura cobrada: a lista de clientes inteira era lida a cada abertura do
# Dashboard (tela inicial), de Implantação e da busca. Com 60s de validade, as
# aberturas seguidas saem da memória. Qualquer escrita em /api/ zera o cache do
# processo (ver _cache_api_invalidar), então ninguém vê dado velho depois de
# salvar. Com mais de um worker do gunicorn, cada um tem o seu — o TTL limita o
# atraso entre eles.
CACHE_API_TTL_SEGUNDOS = 60
_CACHE_API = {}
_CACHE_API_LOCK = threading.Lock()


def _cache_api_obter(chave, carregar, ttl=CACHE_API_TTL_SEGUNDOS):
    agora = time.time()
    with _CACHE_API_LOCK:
        entrada = _CACHE_API.get(chave)
        if entrada and agora - entrada[0] < ttl:
            return entrada[1]
    valor = carregar()
    with _CACHE_API_LOCK:
        _CACHE_API[chave] = (time.time(), valor)
    return valor


@app.after_request
def _cache_api_invalidar(resposta):
    if request.method != "GET" and request.path.startswith("/api/"):
        with _CACHE_API_LOCK:
            _CACHE_API.clear()
    return resposta


@app.route("/api/clientes", methods=["GET"])
def listar_clientes():
    return jsonify(ok=True, clientes=_cache_api_obter("clientes", clientes_sql.listar_clientes))


@app.route("/api/clientes", methods=["POST"])
def criar_cliente():
    data = request.get_json(force=True) or {}
    dados = _dados_cliente(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o IdCentral do cliente."), 400
    try:
        cliente = clientes_sql.criar_cliente(dados)
    except clientes_sql.IdCentralEmUsoError:
        return jsonify(ok=False, error="Já existe um cliente com esse IdCentral."), 400
    registrar_acao(
        acao="criar", entidade_tipo="cliente", entidade_id=cliente["id"],
        entidade_nome=cliente["cliente"], titulo="Cliente criado",
        cliente_id=cliente["id"], idcentral=cliente["idcentral"], cliente_nome=cliente["cliente"],
    )
    return jsonify(ok=True, cliente=cliente)


@app.route("/api/clientes/<int:cliente_id>", methods=["PUT"])
def editar_cliente(cliente_id):
    data = request.get_json(force=True) or {}
    dados = _dados_cliente(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o IdCentral do cliente."), 400
    atual = clientes_sql.buscar_cliente_por_id(cliente_id)
    if not atual:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    if not _sou_admin():
        dados["idcentral"] = atual["idcentral"]
        # Código de associação externa (Suporte) — só admin grava (decisão
        # explícita da usuária).
        dados["codigo_idcentral"] = atual["codigo_idcentral"] or ""
    # Etapa/marcos só mudam pelo endpoint dedicado (PUT .../marcos) — o
    # formulário geral não manda mais esses campos, então sem isso qualquer
    # edição comum (nome, objetivo...) resetaria o progresso pro Marco 1.
    dados["etapa"] = atual["etapa"]
    dados["marcos_concluidos"] = atual["marcos_concluidos"]
    mudancas = diff_campos(atual, dados, ROTULOS_CLIENTE)
    try:
        cliente = clientes_sql.atualizar_cliente(cliente_id, dados)
    except clientes_sql.IdCentralEmUsoError:
        return jsonify(ok=False, error="Já existe um cliente com esse IdCentral."), 400
    if mudancas:
        registrar_acao(
            acao="editar", entidade_tipo="cliente", entidade_id=cliente_id,
            entidade_nome=cliente["cliente"], mudancas=mudancas, titulo="Cliente editado",
            cliente_id=cliente_id, idcentral=cliente["idcentral"], cliente_nome=cliente["cliente"],
        )
    return jsonify(ok=True, cliente=cliente)


@app.route("/api/clientes/<int:cliente_id>/marcos", methods=["PUT"])
def salvar_marcos_cliente(cliente_id):
    data = request.get_json(force=True) or {}
    doc_atual_dict = clientes_sql.buscar_cliente_por_id(cliente_id)
    if not doc_atual_dict:
        return jsonify(ok=False, error="Cliente não encontrado."), 404

    # Extras: só texto não vazio, id único; itens feitos: só ids que existem
    # (padrão ou extra) — evita lixo de id de item extra já removido.
    itens_extras = {}
    ids_extras = set()
    for marco in IMPLANTACAO_MARCOS:
        lista = []
        for item in (data.get("itens_extras") or {}).get(marco) or []:
            item_id = str((item or {}).get("id", "")).strip()
            texto = str((item or {}).get("texto", "")).strip()[:200]
            if item_id and texto and item_id not in ids_extras:
                ids_extras.add(item_id)
                lista.append({"id": item_id, "texto": texto})
        if lista:
            itens_extras[marco] = lista
    # Prioridades da Quick Win (Marco 2): nome não vazio; subtarefas com o
    # mesmo filtro dos extras. Ids únicos no cliente todo (extras + prioridades
    # + subtarefas), já que "feitos" é uma lista só.
    prioridades = []
    for prio in data.get("prioridades") or []:
        prio_id = str((prio or {}).get("id", "")).strip()
        nome = str((prio or {}).get("nome", "")).strip()[:100]
        if not prio_id or not nome or prio_id in ids_extras:
            continue
        ids_extras.add(prio_id)
        itens = []
        for item in (prio or {}).get("itens") or []:
            item_id = str((item or {}).get("id", "")).strip()
            texto = str((item or {}).get("texto", "")).strip()[:200]
            if item_id and texto and item_id not in ids_extras:
                ids_extras.add(item_id)
                itens.append({"id": item_id, "texto": texto})
        prioridades.append({"id": prio_id, "nome": nome, "itens": itens})
    ids_validos = ids_extras | {i["id"] for itens in IMPLANTACAO_CHECKLIST_PADRAO.values() for i in itens}
    itens_feitos = [i for i in dict.fromkeys(data.get("itens_feitos") or []) if i in ids_validos]
    concluidos_manual = [m for m in IMPLANTACAO_MARCOS if m in (data.get("concluidos_manual") or [])]

    marcos_concluidos = _marcos_concluidos_derivados(itens_feitos, itens_extras, concluidos_manual, prioridades)
    etapa = _etapa_a_partir_dos_marcos(marcos_concluidos)
    hoje = time.strftime("%Y-%m-%d")
    # Data em que cada marco ficou concluído (base do TTV e do tempo por
    # marco). Grava só na transição; reabrir apaga; marco que continua
    # concluído mantém a data original. Conclusões anteriores a isso não têm data.
    concluidos_em = {
        m: d for m, d in (doc_atual_dict.get("marcos_concluidos_em") or {}).items()
        if m in marcos_concluidos
    }
    concluidos_antes = set(doc_atual_dict.get("marcos_concluidos") or [])
    for m in marcos_concluidos:
        if m not in concluidos_antes:
            concluidos_em[m] = hoje
    campos = {
        "marcos_itens_feitos": itens_feitos,
        "marcos_itens_extras": itens_extras,
        "marcos_prioridades": prioridades,
        "marcos_concluidos_manual": concluidos_manual,
        "marcos_concluidos": marcos_concluidos,
        "marcos_concluidos_em": concluidos_em,
        # Qualquer salvamento do checklist conta como atividade — junto com
        # ultima_acao_data (acontecimentos) define "implantação parada".
        "marcos_atualizado_em": hoje,
        "etapa": etapa,
    }
    # Data de implantação = quando os 5 marcos ficaram concluídos. Só grava na
    # transição (entrar em "concluido"); reabrir um marco apaga, e concluir de
    # novo grava a data nova. Clientes já concluídos antes disso ficam sem data.
    etapa_antes = doc_atual_dict.get("etapa") or IMPLANTACAO_ETAPA_PADRAO
    if etapa == "concluido" and etapa_antes != "concluido":
        campos["concluido_em"] = time.strftime("%Y-%m-%d")
        campos["concluido_por"] = session.get("app_usuario_responsavel") or session.get("app_usuario_nome", "")
    elif etapa != "concluido" and etapa_antes == "concluido":
        campos["concluido_em"] = ""
        campos["concluido_por"] = ""
    clientes_sql.atualizar_cliente(cliente_id, campos)

    antes = set(doc_atual_dict.get("marcos_concluidos") or [])
    depois = set(marcos_concluidos)
    partes = [f"{m.replace('marco-', 'Marco ')} concluído" for m in IMPLANTACAO_MARCOS if m in depois - antes]
    partes += [f"{m.replace('marco-', 'Marco ')} reaberto" for m in IMPLANTACAO_MARCOS if m in antes - depois]
    if etapa == "concluido" and etapa_antes != "concluido":
        partes.append("Implantação concluída (5 marcos)")
    registrar_acao(
        acao="marco_concluido", entidade_tipo="cliente", entidade_id=cliente_id,
        entidade_nome=doc_atual_dict.get("cliente", ""),
        titulo=", ".join(partes) if partes else "Checklist dos marcos atualizado",
        cliente_id=cliente_id, idcentral=doc_atual_dict.get("idcentral", ""),
        cliente_nome=doc_atual_dict.get("cliente", ""),
    )
    return jsonify(
        ok=True, marcos_concluidos=marcos_concluidos, etapa=etapa,
        marcos_itens_feitos=itens_feitos, marcos_itens_extras=itens_extras,
        marcos_prioridades=prioridades, marcos_concluidos_manual=concluidos_manual,
        concluido_em=campos.get("concluido_em", doc_atual_dict.get("concluido_em", "")),
        concluido_por=campos.get("concluido_por", doc_atual_dict.get("concluido_por", "")),
        marcos_concluidos_em=concluidos_em, marcos_atualizado_em=hoje,
    )


@app.route("/api/clientes/<int:cliente_id>/motivo-atraso", methods=["PUT"])
def salvar_motivo_atraso_cliente(cliente_id):
    """Por que o cliente está atrasado no marco atual (árvore de decisão do
    Playbook). Fica preso ao marco em que foi registrado — quando o cliente
    avança, o motivo antigo deixa de valer (o front compara com a etapa)."""
    data = request.get_json(force=True) or {}
    motivo = str(data.get("motivo", "")).strip()
    if motivo not in MOTIVOS_ATRASO:
        return jsonify(ok=False, error="Motivo inválido."), 400
    doc_atual_dict = clientes_sql.buscar_cliente_por_id(cliente_id)
    if not doc_atual_dict:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    motivo_atraso = {
        "marco": doc_atual_dict.get("etapa") or IMPLANTACAO_ETAPA_PADRAO,
        "motivo": motivo,
        "obs": str(data.get("obs", "")).strip()[:300],
        "em": time.strftime("%Y-%m-%d"),
        "por": session.get("app_usuario_responsavel") or session.get("app_usuario_nome", ""),
    }
    clientes_sql.atualizar_cliente(cliente_id, {"motivo_atraso": motivo_atraso})
    registrar_acao(
        acao="editar", entidade_tipo="cliente", entidade_id=cliente_id,
        entidade_nome=doc_atual_dict.get("cliente", ""),
        titulo="Motivo do atraso registrado",
        cliente_id=cliente_id, idcentral=doc_atual_dict.get("idcentral", ""),
        cliente_nome=doc_atual_dict.get("cliente", ""),
    )
    return jsonify(ok=True, motivo_atraso=motivo_atraso)


@app.route("/api/clientes/<int:cliente_id>/implantado", methods=["PUT"])
def salvar_implantado_cliente(cliente_id):
    """Switch "Implantado" — decisão da equipe, de propósito independente dos
    marcos (a regra de "quando conta como implantado" ainda não está fechada;
    a tela só sugere ligar quando o Marco 3/passagem conclui). Guarda quando e
    quem ligou; desligar limpa os dois."""
    data = request.get_json(force=True) or {}
    doc_atual_dict = clientes_sql.buscar_cliente_por_id(cliente_id)
    if not doc_atual_dict:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    implantado = bool(data.get("implantado"))
    if implantado == bool(doc_atual_dict.get("implantado")):
        return jsonify(ok=True, implantado=implantado,
                       implantado_em=doc_atual_dict.get("implantado_em", ""),
                       implantado_por=doc_atual_dict.get("implantado_por", ""))
    campos = {
        "implantado": implantado,
        "implantado_em": time.strftime("%Y-%m-%d") if implantado else "",
        "implantado_por": (session.get("app_usuario_responsavel") or session.get("app_usuario_nome", "")) if implantado else "",
    }
    clientes_sql.atualizar_cliente(cliente_id, campos)
    registrar_acao(
        acao="editar", entidade_tipo="cliente", entidade_id=cliente_id,
        entidade_nome=doc_atual_dict.get("cliente", ""),
        titulo="Cliente marcado como implantado" if implantado else "Cliente desmarcado como implantado",
        cliente_id=cliente_id, idcentral=doc_atual_dict.get("idcentral", ""),
        cliente_nome=doc_atual_dict.get("cliente", ""),
    )
    return jsonify(ok=True, **campos)


@app.route("/api/clientes/<int:cliente_id>", methods=["DELETE"])
def excluir_cliente(cliente_id):
    doc_atual_dict = clientes_sql.buscar_cliente_por_id(cliente_id)
    if not doc_atual_dict:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    # Eventos/migrações(+veículos/modelos)/credencial somem sozinhos via ON
    # DELETE CASCADE. Tarefas também têm CASCADE no banco, mas isso não gera
    # log nenhum sozinho — lê a lista ANTES de excluir só pra registrar a
    # auditoria de cada uma (mesmo comportamento de antes).
    for tarefa in tarefas_sql.listar_por_cliente(cliente_id):
        registrar_acao(
            acao="excluir", entidade_tipo="tarefa", entidade_id=tarefa["id"],
            entidade_nome=tarefa.get("titulo", ""), titulo="Tarefa excluída (cliente removido)",
            cliente_id=cliente_id, idcentral=doc_atual_dict.get("idcentral", ""),
            cliente_nome=doc_atual_dict.get("cliente", ""), tipo_historico="tarefa", tarefa_id=tarefa["id"],
        )
    clientes_sql.excluir_cliente(cliente_id)
    registrar_acao(
        acao="excluir", entidade_tipo="cliente", entidade_id=cliente_id,
        entidade_nome=doc_atual_dict.get("cliente", ""), titulo="Cliente excluído",
        cliente_id=cliente_id, idcentral=doc_atual_dict.get("idcentral", ""),
        cliente_nome=doc_atual_dict.get("cliente", ""),
    )
    return jsonify(ok=True)


# --- SINCRONIZAÇÃO COM A PLANILHA DE CS (Google Sheets) ---
# A operação de CS ainda controla um monte de informação só na planilha
# (contato, saúde, consumo, etc.) — enquanto isso não migra de vez pro app,
# esse botão (Ferramentas Auxiliares > Sincronizar Planilha) puxa a planilha
# e ATUALIZA os campos que também existem no cadastro do cliente aqui.
# Fluxo pedido pelo usuário: "tudo que bater, a planilha manda" (sobrescreve
# o que tiver no app pros campos em comum, mesmo indo pra vazio) + botão
# manual com prévia antes de aplicar (mesmo padrão de preview/confirmar já
# usado em preview_import_clientes/confirmar_import_clientes, mais abaixo).
#
# Só lê a planilha (exportação CSV pública) — não escreve nada nela.
PLANILHA_CS_URL = (
    "https://docs.google.com/spreadsheets/d/1EJnd8R_3dSSBn9ERl3nRcYcBZWJJiI16tkuaT026Hhc"
    "/export?format=csv&gid=0"
)

# Nomes exatos das colunas na planilha real (cabeçalhos numerados e às vezes
# com typo — "Rasteadores", "clientee" — copiados como estão de lá; se a
# planilha for reorganizada e o TEXTO do cabeçalho mudar, o campo correspondente
# some do relatório de sincronização até alguém atualizar esse mapa aqui).
COLUNAS_PLANILHA_CS = {
    "cliente": "2 - Cliente",
    "csm": "3 - CS",
    "data_entrada": "4 - Entrada",
    "momento": "14 - Momento do cliente",
    "flag": "15 - Flag",
    "idcentral": "Id central",
    "vendedor": "24 - Vendedor atualizado",
    "vendedor_alt": "23 - vendedor Hunter",
    "persona": "25 - Persona real",
    "objetivo": "27 - Objetivos do cliente",
    "decisor_nome": "31 - Decisor",
    "decisor_whatsapp": "32 - Contato",
    "decisor_cidade": "35 - Cidade",
    "decisor_estado": "36 - Estado",
    "valor_contrato": "55 - Valor de contrato",
}

# (campo, rótulo de exibição) — na ordem que aparece no relatório de mudanças.
CAMPOS_SYNC_PLANILHA = [
    ("cliente", "Cliente"),
    ("csm", "CS/Responsável"),
    ("data_entrada", "Data de entrada"),
    ("momento", "Momento do cliente"),
    ("flag", "Flag"),
    ("vendedor", "Vendedor"),
    ("persona", "Persona"),
    ("objetivo", "Objetivo"),
    ("decisor_nome", "Decisor"),
    ("decisor_whatsapp", "WhatsApp do decisor"),
    ("decisor_cidade", "Cidade do decisor"),
    ("decisor_estado", "Estado do decisor"),
    ("valor_contrato", "Valor de contrato"),
]

SYNC_PLANILHA_CACHE = {}
SYNC_PLANILHA_LOCK = threading.Lock()

# Só o "Travado por infra" precisa de apelido manual — as outras variações
# batem por normalização (sem acento/maiúscula) com MOMENTO_CLIENTE_OPCOES.
MOMENTO_ALIAS_PLANILHA = {
    "travado por infra": "Travado por Infraestrutura",
}


def _normalizar_texto_planilha(txt):
    txt = unicodedata.normalize("NFKD", str(txt or "")).encode("ascii", "ignore").decode("ascii")
    return txt.strip().lower()


def _mapear_momento_planilha(txt):
    """"1 - Capacitação" -> "Capacitação". Rótulo que não bate com nenhuma opção
    conhecida (nem por apelido) volta "" — tratado como "não sincronizar esse
    campo" mais abaixo, pra um rótulo novo/desconhecido na planilha não apagar
    silenciosamente o Momento já cadastrado no cliente."""
    txt = re.sub(r"^\d+\s*-\s*", "", str(txt or "").strip())
    if not txt:
        return ""
    norm = _normalizar_texto_planilha(txt)
    if norm in MOMENTO_ALIAS_PLANILHA:
        return MOMENTO_ALIAS_PLANILHA[norm]
    for opcao in MOMENTO_CLIENTE_OPCOES:
        if _normalizar_texto_planilha(opcao) == norm:
            return opcao
    return ""


def _parse_data_planilha(txt):
    """"22/07/2026" -> "2026-07-22" (formato que o resto do app usa)."""
    partes = str(txt or "").strip().split("/")
    if len(partes) != 3:
        return ""
    dia, mes, ano = partes
    if not (dia.isdigit() and mes.isdigit() and ano.isdigit() and len(ano) == 4):
        return ""
    return f"{ano}-{mes.zfill(2)}-{dia.zfill(2)}"


def _parse_valor_planilha(txt):
    """"R$ 1.234,56" -> 1234.56. "-" ou vazio -> 0.0."""
    txt = str(txt or "").strip()
    if not txt or txt == "-":
        return 0.0
    negativo = txt.startswith("-")
    limpo = txt.replace("R$", "").replace("-", "").strip().replace(".", "").replace(",", ".")
    try:
        valor = float(limpo)
    except ValueError:
        return 0.0
    return -valor if negativo else valor


def _buscar_planilha_cs():
    r = requests.get(PLANILHA_CS_URL, timeout=20)
    r.raise_for_status()
    return pd.read_csv(io.BytesIO(r.content), dtype=str, keep_default_na=False)


def _linha_planilha_para_dados(row):
    """Já devolve os valores normalizados/validados do jeito que _dados_cliente()
    também validaria (mesma regra de enum pra flag/persona/estado) — se isso não
    for feito aqui, um valor inválido na planilha (ex.: UF "BH", que não é sigla
    de estado) bateria diferente na hora de CRIAR (passa por _dados_cliente, vira
    "") do que na hora de ATUALIZAR (ia direto pro Firestore, ficava "BH") e o
    item nunca saía do relatório de sincronização — sempre "mudou" de novo."""
    vendedor = str(row.get(COLUNAS_PLANILHA_CS["vendedor"], "")).strip()
    if not vendedor:
        vendedor = str(row.get(COLUNAS_PLANILHA_CS["vendedor_alt"], "")).strip()

    flag = str(row.get(COLUNAS_PLANILHA_CS["flag"], "")).strip()
    if flag not in FLAG_CLIENTE_OPCOES:
        flag = ""
    persona = str(row.get(COLUNAS_PLANILHA_CS["persona"], "")).strip()
    if persona not in PERSONA_CLIENTE_OPCOES:
        persona = ""
    decisor_estado = str(row.get(COLUNAS_PLANILHA_CS["decisor_estado"], "")).strip().upper()
    if decisor_estado not in SIGLAS_ESTADOS_BRASIL:
        decisor_estado = ""

    return {
        "idcentral": str(row.get(COLUNAS_PLANILHA_CS["idcentral"], "")).strip(),
        "cliente": str(row.get(COLUNAS_PLANILHA_CS["cliente"], "")).strip(),
        "csm": str(row.get(COLUNAS_PLANILHA_CS["csm"], "")).strip(),
        "data_entrada": _parse_data_planilha(row.get(COLUNAS_PLANILHA_CS["data_entrada"], "")),
        "momento": _mapear_momento_planilha(row.get(COLUNAS_PLANILHA_CS["momento"], "")),
        "flag": flag,
        "vendedor": vendedor,
        "persona": persona,
        "objetivo": str(row.get(COLUNAS_PLANILHA_CS["objetivo"], "")).strip(),
        "decisor_nome": str(row.get(COLUNAS_PLANILHA_CS["decisor_nome"], "")).strip(),
        "decisor_whatsapp": str(row.get(COLUNAS_PLANILHA_CS["decisor_whatsapp"], "")).strip(),
        "decisor_cidade": str(row.get(COLUNAS_PLANILHA_CS["decisor_cidade"], "")).strip(),
        "decisor_estado": decisor_estado,
        "valor_contrato": _parse_valor_planilha(row.get(COLUNAS_PLANILHA_CS["valor_contrato"], "")),
    }


def _montar_relatorio_sync_planilha():
    df = _buscar_planilha_cs()
    primeira_coluna = df.columns[0] if len(df.columns) else None

    clientes_por_idcentral = {
        c["idcentral"]: (c["id"], c) for c in clientes_sql.listar_clientes() if c["idcentral"]
    }

    itens = []
    sem_idcentral = []
    vistos = set()
    for _, row in df.iterrows():
        novo = _linha_planilha_para_dados(row)
        if not novo["idcentral"]:
            if novo["cliente"]:
                sem_idcentral.append(novo["cliente"])
            continue
        if novo["idcentral"] in vistos:
            continue  # Id central duplicado na planilha - fica só a primeira ocorrência
        vistos.add(novo["idcentral"])

        linha_raw = {
            ("_chave_planilha" if col == primeira_coluna else col): str(valor)
            for col, valor in row.items()
        }

        existente = clientes_por_idcentral.get(novo["idcentral"])
        if existente is None:
            mudancas = [
                {"campo": campo, "rotulo": rotulo, "de": "", "para": novo[campo]}
                for campo, rotulo in CAMPOS_SYNC_PLANILHA if novo[campo]
            ]
            itens.append({
                "idcentral": novo["idcentral"], "cliente": novo["cliente"], "cliente_id": None,
                "acao": "criar", "mudancas": mudancas, "novo": novo, "linha_raw": linha_raw,
            })
            continue

        cliente_id, dados_atuais = existente
        mudancas = []
        for campo, rotulo in CAMPOS_SYNC_PLANILHA:
            valor_novo = novo[campo]
            if campo == "momento" and not valor_novo:
                continue  # rótulo não reconhecido na planilha - não mexe no que já tá no app
            valor_atual = dados_atuais.get(campo, 0.0 if campo == "valor_contrato" else "")
            if campo == "valor_contrato":
                diferente = round(float(valor_atual or 0), 2) != round(float(valor_novo or 0), 2)
            else:
                diferente = str(valor_atual or "").strip() != str(valor_novo or "").strip()
            if diferente:
                mudancas.append({"campo": campo, "rotulo": rotulo, "de": valor_atual, "para": valor_novo})

        if mudancas:
            itens.append({
                "idcentral": novo["idcentral"], "cliente": novo["cliente"], "cliente_id": cliente_id,
                "acao": "atualizar", "mudancas": mudancas, "novo": novo, "linha_raw": linha_raw,
            })

    return {
        "itens": itens,
        "sem_idcentral": sem_idcentral,
        "total_linhas": int(len(df)),
        "resumo": {
            "criar": sum(1 for i in itens if i["acao"] == "criar"),
            "atualizar": sum(1 for i in itens if i["acao"] == "atualizar"),
            "sem_idcentral": len(sem_idcentral),
        },
    }


@app.route("/api/clientes/sync-planilha/preview", methods=["GET"])
def preview_sync_planilha():
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem sincronizar com a planilha."), 403
    try:
        relatorio = _montar_relatorio_sync_planilha()
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Não foi possível acessar a planilha: {e}"), 502
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao processar a planilha: {e}"), 400

    sync_id = uuid.uuid4().hex
    with SYNC_PLANILHA_LOCK:
        SYNC_PLANILHA_CACHE[sync_id] = relatorio["itens"]

    return jsonify(
        ok=True,
        sync_id=sync_id,
        itens=[
            {k: v for k, v in item.items() if k not in ("novo", "linha_raw")}
            for item in relatorio["itens"]
        ],
        sem_idcentral=relatorio["sem_idcentral"],
        total_linhas=relatorio["total_linhas"],
        resumo=relatorio["resumo"],
    )


@app.route("/api/clientes/sync-planilha/aplicar", methods=["POST"])
def aplicar_sync_planilha():
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem sincronizar com a planilha."), 403
    body = request.get_json(force=True) or {}
    with SYNC_PLANILHA_LOCK:
        itens = SYNC_PLANILHA_CACHE.pop(body.get("sync_id"), None)
    if itens is None:
        return jsonify(ok=False, error="Prévia não encontrada ou expirada — busque de novo."), 400

    criados, atualizados, ignorados = _aplicar_itens_sync_planilha(itens)
    return jsonify(ok=True, criados=criados, atualizados=atualizados, ignorados=ignorados)


def _aplicar_itens_sync_planilha(itens):
    existentes = clientes_sql.idcentrals_existentes()
    campos_chaves = [c for c, _ in CAMPOS_SYNC_PLANILHA]
    criados, atualizados = 0, 0
    ignorados = []

    for item in itens:
        novo = item["novo"]
        if item["acao"] == "criar":
            if novo["idcentral"] in existentes:
                ignorados.append({"idcentral": novo["idcentral"], "cliente": novo["cliente"],
                                   "motivo": "Já existe um cliente com esse IdCentral (criado nesse meio tempo)."})
                continue
            dados = _dados_cliente(novo)
            if dados is None:
                ignorados.append({"idcentral": novo["idcentral"], "cliente": novo["cliente"],
                                   "motivo": "IdCentral inválido."})
                continue
            dados["dados_planilha"] = item["linha_raw"]
            try:
                clientes_sql.criar_cliente(dados)
            except clientes_sql.IdCentralEmUsoError:
                ignorados.append({"idcentral": novo["idcentral"], "cliente": novo["cliente"],
                                   "motivo": "Já existe um cliente com esse IdCentral (criado nesse meio tempo)."})
                continue
            existentes.add(novo["idcentral"])
            criados += 1
        else:
            campos = {c: novo[c] for c in campos_chaves if not (c == "momento" and not novo[c])}
            campos["dados_planilha"] = item["linha_raw"]
            if clientes_sql.atualizar_cliente(item["cliente_id"], campos) is None:
                ignorados.append({"idcentral": novo["idcentral"], "cliente": novo["cliente"],
                                   "motivo": "Cliente foi removido nesse meio tempo."})
                continue
            atualizados += 1

    return criados, atualizados, ignorados


# --- IMPORTAÇÃO DE CLIENTES POR PLANILHA (Implantação) ---
# Cadastro em massa direto no Firestore (sem chamada nenhuma pra SSX, ao
# contrário da Área de Importação de Ferramentas Auxiliares) — por isso não
# precisa da fila/polling em thread separada que aquela usa: grava tudo num
# único request, síncrono.
COLUNAS_IMPORT_CLIENTES = {
    "idcentral": "IdCentral",
    "cliente": "Cliente",
    "data_entrada": "Data de entrada",
    "etapa": "Etapa",
    "csm": "Responsável",
    "objetivo": "Objetivo",
    "valor_contrato": "Valor de contrato",
    "momento": "Momento do Cliente",
    "flag": "Flag",
    "vendedor": "Vendedor",
    "persona": "Persona",
    "decisor_nome": "Nome do Decisor",
    "decisor_whatsapp": "WhatsApp do Decisor",
    "decisor_estado": "Estado do Decisor",
    "decisor_cidade": "Cidade do Decisor",
}

IMPORT_CLIENTES_UPLOADS = {}
IMPORT_CLIENTES_LOCK = threading.Lock()


def _planilha_clientes_para_linhas(df):
    """Converte o DataFrame lido do Excel numa lista de dicts no formato que
    _dados_cliente espera, casando os cabeçalhos da planilha por nome (sem
    diferenciar maiúsculas/minúsculas nem espaço nas pontas) — coluna
    desconhecida é ignorada, coluna esperada ausente vira vazio."""
    colunas_normalizadas = {str(c).strip().lower(): c for c in df.columns}
    linhas = []
    for _, row in df.iterrows():
        linha = {}
        for campo, rotulo in COLUNAS_IMPORT_CLIENTES.items():
            col_original = colunas_normalizadas.get(rotulo.lower())
            valor = row[col_original] if col_original is not None else ""
            linha[campo] = "" if pd.isna(valor) else str(valor).strip()
        linhas.append(linha)
    return linhas


@app.route("/api/clientes/importar/modelo")
def modelo_import_clientes():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(list(COLUNAS_IMPORT_CLIENTES.values()))
    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return Response(
        buffer.getvalue(),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="modelo_importacao_clientes.xlsx"'},
    )


@app.route("/api/clientes/importar/preview", methods=["POST"])
@requer_operador
def preview_import_clientes():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    try:
        df = pd.read_excel(request.files["arquivo"], dtype=str)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler Excel: {e}"), 400

    existentes = clientes_sql.idcentrals_existentes()
    vistos_no_arquivo = set()
    resultado = []
    for pos, linha in enumerate(_planilha_clientes_para_linhas(df)):
        dados = _dados_cliente(linha)
        if dados is None:
            erro = "IdCentral é obrigatório."
        elif dados["idcentral"] in vistos_no_arquivo:
            erro = "IdCentral repetido nesta planilha."
        elif dados["idcentral"] in existentes:
            erro = "Já existe um cliente cadastrado com esse IdCentral."
        else:
            erro = None
            vistos_no_arquivo.add(dados["idcentral"])
        # Linha 1 da planilha é o cabeçalho — "linha" aqui é o número que a
        # pessoa vê se abrir o arquivo no Excel.
        resultado.append({"linha": pos + 2, "dados": dados, "erro": erro})

    file_id = uuid.uuid4().hex
    with IMPORT_CLIENTES_LOCK:
        IMPORT_CLIENTES_UPLOADS[file_id] = resultado

    prontos = sum(1 for r in resultado if r["erro"] is None)
    return jsonify(
        ok=True, file_id=file_id, linhas=resultado,
        total=len(resultado), prontos=prontos, com_erro=len(resultado) - prontos,
    )


@app.route("/api/clientes/importar/confirmar", methods=["POST"])
@requer_operador
def confirmar_import_clientes():
    body = request.get_json(force=True) or {}
    with IMPORT_CLIENTES_LOCK:
        resultado = IMPORT_CLIENTES_UPLOADS.pop(body.get("file_id"), None)
    if resultado is None:
        return jsonify(ok=False, error="Prévia não encontrada — suba o arquivo de novo."), 400

    sucessos, erros = _gravar_import_clientes(resultado)
    return jsonify(ok=True, sucessos=sucessos, erros=erros)


def _gravar_import_clientes(resultado):
    # Revalida os IdCentrals na hora de gravar (pode ter mudado desde o
    # preview — ex.: outra pessoa importando ao mesmo tempo).
    existentes = clientes_sql.idcentrals_existentes()
    vistos_no_arquivo = set()
    sucessos = 0
    erros = []
    for linha in resultado:
        dados = linha["dados"]
        if linha["erro"] or dados is None:
            erros.append({"linha": linha["linha"], "motivo": linha["erro"] or "IdCentral é obrigatório."})
            continue
        if dados["idcentral"] in vistos_no_arquivo or dados["idcentral"] in existentes:
            erros.append({"linha": linha["linha"], "motivo": "Já existe um cliente com esse IdCentral."})
            continue
        vistos_no_arquivo.add(dados["idcentral"])
        try:
            clientes_sql.criar_cliente(dados)
        except clientes_sql.IdCentralEmUsoError:
            erros.append({"linha": linha["linha"], "motivo": "Já existe um cliente com esse IdCentral."})
            continue
        sucessos += 1

    return sucessos, erros


# --- LOCALIDADES (Estado/Cidade do Decisor) ---
# Estado é lista fixa (nunca muda). Município vem da API de Localidades do
# IBGE, mas essa rota NUNCA chama o IBGE direto — lê só do cache em banco
# (ver models.MunicipioIbge/municipios_sql.py). Quem alimenta a tabela é
# sincronizar_municipios_ibge.py (seed inicial) ou a rota de sincronizar
# abaixo (quando o IBGE incluir/alterar algum município) — nunca a cada
# Ficha/tela aberta, que era o que sobrecarregava a instância antes.


@app.route("/api/localidades/estados")
def listar_estados_brasil():
    return jsonify(ok=True, estados=ESTADOS_BRASIL)


@app.route("/api/localidades/municipios/<uf>")
def listar_municipios_ibge(uf):
    uf = uf.strip().upper()
    if uf not in SIGLAS_ESTADOS_BRASIL:
        return jsonify(ok=False, error="UF inválida."), 400
    return jsonify(ok=True, municipios=municipios_sql.listar_por_uf(uf))


@app.route("/api/localidades/municipios/<uf>/sincronizar", methods=["POST"])
@requer_operador
def sincronizar_municipios_ibge(uf):
    """Única rota que bate na API do IBGE — usada só quando o IBGE incluir/
    alterar um município e precisar atualizar o cache em banco antes do
    próximo seed manual. Não é chamada automaticamente em nenhum fluxo."""
    uf = uf.strip().upper()
    if uf not in SIGLAS_ESTADOS_BRASIL:
        return jsonify(ok=False, error="UF inválida."), 400
    try:
        r = requests.get(
            f"https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios",
            timeout=10,
        )
        r.raise_for_status()
        municipios = sorted(m["nome"] for m in r.json())
    except (requests.exceptions.RequestException, ValueError, KeyError):
        return jsonify(ok=False, error="Não foi possível atualizar os municípios agora. Tente novamente."), 502
    municipios_sql.substituir_municipios_uf(uf, municipios)
    return jsonify(ok=True, municipios=municipios)


@app.route("/api/clientes/<int:cliente_id>/eventos", methods=["GET"])
def listar_eventos_cliente(cliente_id):
    if not cliente_eventos_sql.cliente_existe(cliente_id):
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    return jsonify(ok=True, eventos=cliente_eventos_sql.listar_eventos(cliente_id))


@app.route("/api/clientes/<int:cliente_id>/eventos", methods=["POST"])
def criar_evento_cliente(cliente_id):
    if not cliente_eventos_sql.cliente_existe(cliente_id):
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    data = request.get_json(force=True) or {}
    dados = _dados_implantacao_evento(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o setor e o título."), 400
    evento = cliente_eventos_sql.criar_evento(cliente_id, dados)
    cliente_eventos_sql.recalcular_ultima_acao(cliente_id)
    return jsonify(ok=True, evento=evento)


@app.route("/api/clientes/<int:cliente_id>/eventos/<int:evento_id>", methods=["PUT"])
def editar_evento_cliente(cliente_id, evento_id):
    data = request.get_json(force=True) or {}
    dados = _dados_implantacao_evento(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o setor e o título."), 400
    evento = cliente_eventos_sql.editar_evento(cliente_id, evento_id, dados)
    if not evento:
        return jsonify(ok=False, error="Acontecimento não encontrado."), 404
    cliente_eventos_sql.recalcular_ultima_acao(cliente_id)
    return jsonify(ok=True, evento=evento)


@app.route("/api/clientes/<int:cliente_id>/eventos/<int:evento_id>", methods=["DELETE"])
def excluir_evento_cliente(cliente_id, evento_id):
    if not cliente_eventos_sql.excluir_evento(cliente_id, evento_id):
        return jsonify(ok=False, error="Acontecimento não encontrado."), 404
    cliente_eventos_sql.recalcular_ultima_acao(cliente_id)
    return jsonify(ok=True)


_CAMPOS_CHAMADO_RESUMO = (
    "id", "ticketNumber", "title", "description", "status", "priority", "category", "createdAt", "updatedAt",
)


@app.route("/api/clientes/<int:cliente_id>/chamados", methods=["GET"])
def listar_chamados_cliente(cliente_id):
    """Chamados de suporte do ssxdesk pro cliente — "abertos" alimenta o
    bloco de pendências da Visão Geral da Ficha, "concluidos" a sub-aba
    Suporte do Histórico. Carregado pelo front em segundo plano, DEPOIS da
    Ficha já estar aberta — uma falha ou demora aqui nunca deve travar o
    resto da Ficha.

    Busca pelo `codigo_idcentral` quando o cliente tiver um preenchido —
    é exatamente pra isso que esse campo existe ("código de associação
    usado por sistemas externos (ex. Suporte) que não têm API pra resolver
    isso a partir do idcentral", ver models.py) — e cai pro `idcentral`
    normal quando não tiver (a maioria dos clientes bate direto por ali)."""
    try:
        cliente = clientes_sql.buscar_cliente_por_id(cliente_id)
    except SQLAlchemyError:
        app.logger.exception("Falha ao buscar cliente %s para consultar chamados do ssxdesk", cliente_id)
        return jsonify(
            ok=False,
            error="Não foi possível consultar os dados do cliente no banco agora. Tente novamente em instantes.",
        ), 503
    if not cliente:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    idcentral_busca = cliente.get("codigo_idcentral") or cliente["idcentral"]
    try:
        chamados = ssxdesk_api.listar_chamados_por_idcentral(idcentral_busca)
    except ssxdesk_api.SsxDeskApiError as err:
        return jsonify(ok=False, error=str(err)), 502
    abertos, concluidos = ssxdesk_api.separar_abertos_e_concluidos(chamados)
    resumir = lambda c: {campo: c.get(campo) for campo in _CAMPOS_CHAMADO_RESUMO}
    return jsonify(ok=True, abertos=[resumir(c) for c in abertos], concluidos=[resumir(c) for c in concluidos])


# Sincronização da Wootric: roda em thread de fundo, no máximo uma vez a
# cada _WOOTRIC_SYNC_INTERVALO_SEGUNDOS por processo (gunicorn tem vários
# workers — cada um sincroniza por conta própria, o intervalo evita que
# todos batam na API da Wootric ao mesmo tempo a cada Ficha aberta). Uma
# trava evita duas sincronizações simultâneas no mesmo worker.
_WOOTRIC_SYNC_INTERVALO_SEGUNDOS = 300  # 5 min
_wootric_sync_estado = {"ultima_vez": 0.0, "em_andamento": False}
_wootric_sync_lock = threading.Lock()


def sincronizar_avaliacoes_wootric():
    """Busca na Wootric só o que mudou desde a última sincronização (cursor =
    avaliação mais recente já salva, com 5 min de folga pra cobrir respostas
    "updated" depois de criadas) e grava em wootric_avaliacoes. Tabela vazia
    (primeira vez) = sem cursor, traz o que der dentro do teto de 1500
    respostas da API (ver docstring de wootric_api.buscar_respostas_desde)."""
    ultima = wootric_sql.data_mais_recente()
    cursor = (ultima.timestamp() - 300) if ultima else None
    respostas = wootric_api.buscar_respostas_desde(cursor)
    novas, atualizadas, sem_idcentral = wootric_sql.upsert_respostas(respostas)
    return {"buscadas": len(respostas), "novas": novas, "atualizadas": atualizadas, "sem_idcentral": sem_idcentral}


def _disparar_sync_wootric_em_segundo_plano():
    """Não bloqueia quem chamou — dispara a thread e devolve na hora. Erro de
    sincronização só fica pra próxima tentativa (próxima Ficha aberta depois
    do intervalo), nunca aparece pra quem está vendo a Ficha agora (ela já
    está lendo dados da tabela local, que continuam os últimos sincronizados
    com sucesso)."""
    def _rodar():
        try:
            sincronizar_avaliacoes_wootric()
        except wootric_api.WootricApiError:
            pass  # próxima tentativa tenta de novo sozinha; não há quem avisar aqui
        finally:
            with _wootric_sync_lock:
                _wootric_sync_estado["em_andamento"] = False
                _wootric_sync_estado["ultima_vez"] = time.time()

    with _wootric_sync_lock:
        if _wootric_sync_estado["em_andamento"]:
            return
        if time.time() - _wootric_sync_estado["ultima_vez"] < _WOOTRIC_SYNC_INTERVALO_SEGUNDOS:
            return
        _wootric_sync_estado["em_andamento"] = True
    threading.Thread(target=_rodar, daemon=True).start()


@app.route("/api/clientes/<int:cliente_id>/wootric", methods=["GET"])
def listar_avaliacoes_wootric_cliente(cliente_id):
    """Avaliações de NPS (Wootric) do cliente — bloco "Avaliações NPS" da
    Visão Geral da Ficha. Lê só da tabela local (wootric_avaliacoes, ver
    wootric_sql.py) — nunca chama a API da Wootric na hora de abrir a Ficha,
    só dispara (em segundo plano, sem esperar) uma sincronização incremental
    se já faz tempo que não roda uma. Usa o mesmo fallback
    codigo_idcentral -> idcentral da integração ssxdesk, porque é o mesmo
    "código de associação usado por sistemas externos" (ver models.py) — é o
    código que aparece no e-mail do end_user na Wootric."""
    cliente = clientes_sql.buscar_cliente_por_id(cliente_id)
    if not cliente:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    idcentral_busca = cliente.get("codigo_idcentral") or cliente["idcentral"]
    _disparar_sync_wootric_em_segundo_plano()
    avaliacoes = wootric_sql.listar_por_idcentral(idcentral_busca)
    return jsonify(ok=True, avaliacoes=avaliacoes)


# --- TAREFAS (vinculadas a um cliente, atribuídas a um usuário do app) ---
# Coleção top-level (não subcoleção de clientes) de propósito: precisa ser
# consultada tanto por cliente_id (Ficha > Visão Geral) quanto por
# responsavel_id (Minha Conta > Tarefas) sem duplicar dado em dois lugares.
# cliente_nome/responsavel_nome ficam denormalizados no próprio doc da tarefa
# (mesmo racional de "ultima_acao" no cadastro do cliente) pra Minha Conta
# não precisar de 1 fetch extra por cliente diferente na lista.
TAREFA_RESULTADOS = ["concluida", "cancelada"]


def _data_valida(data_str):
    partes = str(data_str or "").strip().split("-")
    return len(partes) == 3 and all(p.isdigit() for p in partes) and len(partes[0]) == 4


def _dados_tarefa(data):
    titulo = str(data.get("titulo", "")).strip()
    data_limite = str(data.get("data_limite", "")).strip()
    if not titulo or not _data_valida(data_limite):
        return None
    return {
        "titulo": titulo,
        "descricao": str(data.get("descricao", "")).strip(),
        "data_limite": data_limite,
    }


# Rótulos amigáveis pro diff de edição de tarefa (auditoria.diff_campos).
ROTULOS_TAREFA = {
    "titulo": "Título",
    "descricao": "Descrição",
    "data_limite": "Data limite",
    "responsavel_nome": "Responsável",
    "cliente_nome": "Cliente vinculado",
}


@app.route("/api/tarefas", methods=["GET"])
def listar_tarefas():
    """Sempre filtrado no SQL, nunca a tabela inteira — evita ler tarefa de
    todo mundo só pra montar a lista de 1 cliente ou de 1 usuário."""
    cliente_id_raw = request.args.get("cliente_id", "").strip()
    apenas_minhas = request.args.get("apenas_minhas") == "1"
    minhas_e_criadas = request.args.get("minhas_e_criadas") == "1"
    usuario_id = session.get("app_usuario_id", "")
    if cliente_id_raw:
        if not cliente_id_raw.isdigit():
            return jsonify(ok=True, tarefas=[])
        lista = tarefas_sql.listar_por_cliente(int(cliente_id_raw))
    elif apenas_minhas:
        lista = tarefas_sql.listar_apenas_minhas(usuario_id)
    elif minhas_e_criadas:
        lista = tarefas_sql.listar_minhas_e_criadas(usuario_id)
    else:
        return jsonify(ok=False, error="Informe cliente_id, apenas_minhas=1 ou minhas_e_criadas=1."), 400
    lista.sort(key=lambda t: (bool(t.get("concluida")), t.get("data_limite", "")))
    return jsonify(ok=True, tarefas=lista)


@app.route("/api/tarefas", methods=["POST"])
@requer_operador
def criar_tarefa():
    data = request.get_json(force=True) or {}
    dados = _dados_tarefa(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o título e uma data limite válida."), 400

    # Cliente é opcional — sem ele, a tarefa só aparece em Minha Conta de quem
    # for o responsável (nunca cai em nenhuma Ficha, já que lá a lista vem
    # filtrada por cliente_id).
    cliente_id_raw = str(data.get("cliente_id", "")).strip()
    cliente_id = None
    cliente_dados = {}
    if cliente_id_raw:
        if not cliente_id_raw.isdigit():
            return jsonify(ok=False, error="Cliente não encontrado."), 404
        cliente_id = int(cliente_id_raw)
        cliente_dados = clientes_sql.buscar_cliente_por_id(cliente_id)
        if not cliente_dados:
            return jsonify(ok=False, error="Cliente não encontrado."), 404

    responsavel_id = str(data.get("responsavel_id", "")).strip()
    responsavel_dados = usuarios_sql.buscar_usuario_por_id(responsavel_id)
    if not responsavel_dados:
        return jsonify(ok=False, error="Responsável não encontrado."), 404

    dados.update({
        "cliente_id": cliente_id,
        "idcentral": cliente_dados.get("idcentral", ""),
        "cliente_nome": cliente_dados.get("cliente", ""),
        "responsavel_id": responsavel_id,
        "responsavel_nome": responsavel_dados.get("nome_responsavel") or responsavel_dados.get("usuario") or "",
        "concluida": False,
        "concluida_em": "",
        "criado_por": session.get("app_usuario_id", ""),
        # Mesmo critério de nome do responsavel_nome (nome_responsavel, senão login).
        "criado_por_nome": session.get("app_usuario_responsavel") or session.get("app_usuario_nome", ""),
        "criado_em": time.strftime("%Y-%m-%d"),
    })
    tarefa = tarefas_sql.criar_tarefa(dados)
    registrar_acao(
        acao="criar", entidade_tipo="tarefa", entidade_id=tarefa["id"],
        entidade_nome=tarefa["titulo"], titulo="Tarefa criada",
        cliente_id=tarefa["cliente_id"] or None, idcentral=tarefa["idcentral"],
        cliente_nome=tarefa["cliente_nome"], tipo_historico="tarefa", tarefa_id=tarefa["id"],
    )
    return jsonify(ok=True, tarefa=tarefa)


@app.route("/api/tarefas/<int:tarefa_id>", methods=["PUT"])
@requer_operador
def editar_tarefa(tarefa_id):
    atual = tarefas_sql.buscar_tarefa(tarefa_id)
    if not atual:
        return jsonify(ok=False, error="Tarefa não encontrada."), 404
    data = request.get_json(force=True) or {}
    dados = _dados_tarefa(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o título e uma data limite válida."), 400

    responsavel_id = str(data.get("responsavel_id", "")).strip()
    if responsavel_id:
        responsavel_dados = usuarios_sql.buscar_usuario_por_id(responsavel_id)
        if not responsavel_dados:
            return jsonify(ok=False, error="Responsável não encontrado."), 404
        dados["responsavel_id"] = responsavel_id
        dados["responsavel_nome"] = responsavel_dados.get("nome_responsavel") or responsavel_dados.get("usuario") or ""

    # Cliente é opcional — o formulário só deixa trocar quando a tarefa ainda
    # não tinha cliente (uma vez vinculada, o campo fica travado no modal), mas
    # aceita tanto "adicionar cliente" numa tarefa solta quanto reenviar o
    # mesmo id (o que também atualiza idcentral/cliente_nome se o cliente foi
    # renomeado desde então).
    if "cliente_id" in data:
        cliente_id_raw = str(data.get("cliente_id", "")).strip()
        if cliente_id_raw:
            if not cliente_id_raw.isdigit():
                return jsonify(ok=False, error="Cliente não encontrado."), 404
            cliente_dados = clientes_sql.buscar_cliente_por_id(int(cliente_id_raw))
            if not cliente_dados:
                return jsonify(ok=False, error="Cliente não encontrado."), 404
            dados["cliente_id"] = int(cliente_id_raw)
            dados["idcentral"] = cliente_dados.get("idcentral", "")
            dados["cliente_nome"] = cliente_dados.get("cliente", "")
        else:
            dados["cliente_id"] = None
            dados["idcentral"] = ""
            dados["cliente_nome"] = ""

    tarefa_completa = tarefas_sql.editar_tarefa(tarefa_id, dados)
    mudancas = diff_campos(atual, tarefa_completa, ROTULOS_TAREFA)
    if mudancas:
        registrar_acao(
            acao="editar", entidade_tipo="tarefa", entidade_id=tarefa_id,
            entidade_nome=tarefa_completa.get("titulo", ""), mudancas=mudancas, titulo="Tarefa editada",
            cliente_id=tarefa_completa.get("cliente_id") or None, idcentral=tarefa_completa.get("idcentral", ""),
            cliente_nome=tarefa_completa.get("cliente_nome", ""), tipo_historico="tarefa", tarefa_id=tarefa_id,
        )
    return jsonify(ok=True, tarefa=tarefa_completa)


@app.route("/api/tarefas/<int:tarefa_id>/concluir", methods=["POST"])
@requer_operador
def concluir_tarefa(tarefa_id):
    dados_atuais = tarefas_sql.buscar_tarefa(tarefa_id)
    if not dados_atuais:
        return jsonify(ok=False, error="Tarefa não encontrada."), 404
    # "concluida" continua significando "encerrada" (sai da lista de pendentes)
    # — o desfecho de verdade fica em "resultado": concluída ou cancelada
    # (não pôde ser feita). Cancelar exige descrição, pra quem criou a tarefa
    # entender o porquê. Tarefa antiga encerrada sem "resultado" = concluída.
    data = request.get_json(silent=True) or {}
    resultado = data.get("resultado") if data.get("resultado") in TAREFA_RESULTADOS else "concluida"
    descricao = str(data.get("descricao", "")).strip()[:1000]
    if resultado == "cancelada" and not descricao:
        return jsonify(ok=False, error="Descreva por que a tarefa foi cancelada."), 400
    tarefas_sql.concluir_tarefa(
        tarefa_id, resultado, descricao,
        session.get("app_usuario_responsavel") or session.get("app_usuario_nome", ""),
        time.strftime("%Y-%m-%d"),
    )
    registrar_acao(
        acao="concluir" if resultado == "concluida" else "cancelar", entidade_tipo="tarefa", entidade_id=tarefa_id,
        entidade_nome=dados_atuais.get("titulo", ""),
        titulo="Tarefa concluída" if resultado == "concluida" else "Tarefa cancelada",
        cliente_id=dados_atuais.get("cliente_id") or None, idcentral=dados_atuais.get("idcentral", ""),
        cliente_nome=dados_atuais.get("cliente_nome", ""), tipo_historico="tarefa", tarefa_id=tarefa_id,
    )
    return jsonify(ok=True)


@app.route("/api/tarefas/<int:tarefa_id>/reabrir", methods=["POST"])
@requer_operador
def reabrir_tarefa(tarefa_id):
    dados_atuais = tarefas_sql.buscar_tarefa(tarefa_id)
    if not dados_atuais:
        return jsonify(ok=False, error="Tarefa não encontrada."), 404
    tarefas_sql.reabrir_tarefa(tarefa_id)
    registrar_acao(
        acao="reabrir", entidade_tipo="tarefa", entidade_id=tarefa_id,
        entidade_nome=dados_atuais.get("titulo", ""), titulo="Tarefa reaberta",
        cliente_id=dados_atuais.get("cliente_id") or None, idcentral=dados_atuais.get("idcentral", ""),
        cliente_nome=dados_atuais.get("cliente_nome", ""), tipo_historico="tarefa", tarefa_id=tarefa_id,
    )
    return jsonify(ok=True)


@app.route("/api/tarefas/<int:tarefa_id>", methods=["DELETE"])
@requer_operador
def excluir_tarefa(tarefa_id):
    dados_atuais = tarefas_sql.buscar_tarefa(tarefa_id)
    if not dados_atuais:
        return jsonify(ok=False, error="Tarefa não encontrada."), 404
    tarefas_sql.excluir_tarefa(tarefa_id)
    registrar_acao(
        acao="excluir", entidade_tipo="tarefa", entidade_id=tarefa_id,
        entidade_nome=dados_atuais.get("titulo", ""), titulo="Tarefa excluída",
        cliente_id=dados_atuais.get("cliente_id") or None, idcentral=dados_atuais.get("idcentral", ""),
        cliente_nome=dados_atuais.get("cliente_nome", ""), tipo_historico="tarefa", tarefa_id=tarefa_id,
    )
    return jsonify(ok=True)


# --- MIGRAÇÃO COMO TENTATIVA DO CLIENTE (clientes/<id>/migracoes/<migracao_id>) ---
# Cada tentativa tem início/fim/status/motivo — é o que falta hoje pra rastrear
# migração cancelada ou incompleta (o motivo em si ainda não tem tela pra
# preencher; o campo já existe pronto pra quando essa tela for construída).
STATUS_MIGRACAO_VALIDOS = ["em_andamento", "concluida", "cancelada", "incompleta"]
STATUS_MIGRACAO_PADRAO = "em_andamento"
CAMPOS_MIGRACAO_ATTEMPT_PADRAO = {
    "plataforma_origem": "",
    "link_planilha": "",
    # Acesso que o cliente passa pra gente exportar os dados dele da plataforma
    # de origem (ex.: outro rastreador) — usado no card de acesso rápido da
    # aba Migração da Ficha (botão "Abrir plataforma" + copiar login/senha).
    "link_acesso_origem": "",
    "login_acesso_origem": "",
    "senha_acesso_origem": "",
    "qtd_clientes": 0,
    "qtd_placas": 0,
    "percentual_migracao": 0,
    "etapa": MIGRACAO_ETAPA_PADRAO,
    "status": STATUS_MIGRACAO_PADRAO,
    "data_inicio": "",
    "data_fim": "",
    "motivo": "",
}


def _migracao_atual(migracoes):
    """De uma lista de tentativas de migração de um cliente (mais recente
    primeiro), escolhe a "atual": a que está em_andamento, senão a mais
    recente. None se a lista for vazia. Mesma regra usada na Ficha do Cliente
    e na listagem da tela de Migração — um cliente só aparece com UMA
    tentativa mesmo tendo histórico de tentativas antigas/canceladas."""
    migracoes_ordenadas = sorted(migracoes, key=lambda m: m.get("data_inicio") or "", reverse=True)
    atual = next((m for m in migracoes_ordenadas if m.get("status") == "em_andamento"), None)
    if atual is None and migracoes_ordenadas:
        atual = migracoes_ordenadas[0]
    return atual


@app.route("/api/clientes/<int:cliente_id>/migracoes", methods=["GET"])
def listar_migracoes_cliente(cliente_id):
    if not clientes_sql.buscar_cliente_por_id(cliente_id):
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    return jsonify(ok=True, migracoes=migracoes_sql.listar_migracoes(cliente_id))


@app.route("/api/clientes/<int:cliente_id>/migracoes", methods=["POST"])
def iniciar_migracao_cliente(cliente_id):
    """Cria uma nova tentativa de migração — é o que o toggle "Tem Migração?
    Sim" do cadastro do cliente chama. Recusa se já existir uma em andamento."""
    if not clientes_sql.buscar_cliente_por_id(cliente_id):
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    if migracoes_sql.tem_migracao_em_andamento(cliente_id):
        return jsonify(ok=False, error="Esse cliente já tem uma migração em andamento."), 400
    data = request.get_json(force=True) or {}
    migracao = migracoes_sql.iniciar_migracao(
        cliente_id,
        str(data.get("plataforma_origem", "")).strip(),
        str(data.get("link_planilha", "")).strip(),
        time.strftime("%Y-%m-%d"),
    )
    return jsonify(ok=True, migracao=migracao)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>", methods=["PUT"])
def editar_migracao_cliente(cliente_id, migracao_id):
    atual = migracoes_sql.buscar_migracao(migracao_id)
    if not atual or atual["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    data = request.get_json(force=True) or {}
    atualizacoes = {
        "plataforma_origem": str(data.get("plataforma_origem", atual.get("plataforma_origem", ""))).strip(),
        "link_planilha": str(data.get("link_planilha", atual.get("link_planilha", ""))).strip(),
        "link_acesso_origem": str(data.get("link_acesso_origem", atual.get("link_acesso_origem", ""))).strip(),
        "login_acesso_origem": str(data.get("login_acesso_origem", atual.get("login_acesso_origem", ""))).strip(),
        "senha_acesso_origem": str(data.get("senha_acesso_origem", atual.get("senha_acesso_origem", ""))).strip(),
        "qtd_clientes": _para_int(data.get("qtd_clientes", atual.get("qtd_clientes", 0))),
        "qtd_placas": _para_int(data.get("qtd_placas", atual.get("qtd_placas", 0))),
        "percentual_migracao": _para_float(data.get("percentual_migracao", atual.get("percentual_migracao", 0))),
    }
    etapa = str(data.get("etapa", "")).strip()
    if etapa in MIGRACAO_ETAPAS:
        atualizacoes["etapa"] = etapa
    migracao = migracoes_sql.editar_migracao(migracao_id, atualizacoes)
    return jsonify(ok=True, dados=migracao)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/finalizar", methods=["POST"])
def finalizar_migracao_cliente(cliente_id, migracao_id):
    """Ação simples de "terminou": marca concluída com a data de hoje. Se
    tiver planilha vinculada, também renomeia (" - FINALIZADA") e move ela
    pra Migrações/Finalizadas no Drive — mas isso é best-effort: se o Drive
    falhar (ex.: planilha apagada manualmente), a migração é finalizada do
    mesmo jeito, só sem mexer no arquivo."""
    atual = migracoes_sql.buscar_migracao(migracao_id)
    if not atual or atual["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    migracao = migracoes_sql.finalizar_migracao(migracao_id, time.strftime("%Y-%m-%d"))
    link_planilha = atual.get("link_planilha")
    aviso_planilha = None
    if link_planilha:
        try:
            planilha_migracao.finalizar_planilha_migracao(link_planilha)
        except Exception as err:
            aviso_planilha = f"Migração finalizada, mas não consegui mover/renomear a planilha no Drive: {err}"
    resposta = dict(ok=True, status=migracao["status"], data_fim=migracao["data_fim"])
    if aviso_planilha:
        resposta["aviso"] = aviso_planilha
    return jsonify(**resposta)


def _criar_planilha_migracao_ou_erro(nome_cliente):
    """Chama planilha_migracao.criar_planilha_migracao e traduz os erros
    possíveis (credencial não configurada, modelo não compartilhado com a
    conta de serviço, etc.) numa mensagem que dá pra mostrar na tela.
    Devolve (link, None) ou (None, mensagem_de_erro)."""
    try:
        resultado = planilha_migracao.criar_planilha_migracao(nome_cliente)
    except planilha_migracao.PlanilhaMigracaoError as err:
        return None, str(err)
    except HttpError as err:
        return None, f"Erro do Google Drive ao copiar a planilha-modelo: {err}"
    except Exception as err:
        # Credencial malformada/sem permissão, timeout, etc. — qualquer coisa
        # que não seja um erro já tratado acima, mas não deve derrubar o request.
        return None, f"Erro ao conectar com o Google Drive: {err}"
    return resultado.get("webViewLink", ""), None


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/criar-planilha", methods=["POST"])
def criar_planilha_migracao_cliente(cliente_id, migracao_id):
    cliente = clientes_sql.buscar_cliente_por_id(cliente_id)
    if not cliente:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    # Trava também no servidor (não só escondendo o botão no front) — evita
    # criar uma planilha nova (e duplicar no Drive) por causa de clique
    # repetido/retry. "substituir" é o que o botão "Liberar edição" manda.
    data = request.get_json(silent=True) or {}
    if migracao.get("link_planilha") and not data.get("substituir"):
        return jsonify(
            ok=False,
            error="Essa migração já tem uma planilha vinculada. Libere a edição antes de criar outra.",
        ), 409
    link, erro = _criar_planilha_migracao_ou_erro(cliente.get("cliente", ""))
    if erro:
        return jsonify(ok=False, error=erro), 502
    migracoes_sql.atualizar_link_planilha(migracao_id, link)
    return jsonify(ok=True, link=link)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/cancelar", methods=["POST"])
def cancelar_migracao_cliente(cliente_id, migracao_id):
    """Cancela uma migração em andamento — só existe esse caminho (pela Ficha,
    Configurações de Migração); o cadastro do cliente não deixa mais editar ou
    remover uma migração já ativa, só ver e iniciar quando não houver nenhuma."""
    atual = migracoes_sql.buscar_migracao(migracao_id)
    if not atual or atual["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    # silent=True (não force=True): a tela de Controle de Migração chama essa
    # rota sem corpo nenhum pra cancelar rápido (sem motivo) — force=True
    # estourava 400 do próprio Flask ao tentar decodificar corpo vazio como
    # JSON, antes mesmo de chegar aqui.
    data = request.get_json(silent=True) or {}
    migracao = migracoes_sql.cancelar_migracao(
        migracao_id, time.strftime("%Y-%m-%d"), str(data.get("motivo", "")).strip(),
    )
    return jsonify(ok=True, status=migracao["status"], data_fim=migracao["data_fim"], motivo=migracao["motivo"])


def _para_int(valor):
    try:
        return int(float(valor))
    except (TypeError, ValueError):
        return 0


def _para_float(valor):
    try:
        return float(valor)
    except (TypeError, ValueError):
        return 0.0


STATUS_VEICULO_VALIDOS = ["Aguardando", "Enviar", "Enviado", "Migrado", "Cancelado", "Sem rastreador"]
STATUS_VEICULO_PADRAO = "Aguardando"


_PERCENTUAL_TTL_SEGUNDOS = 300
_PERCENTUAL_EM_ATUALIZACAO = set()
_PERCENTUAL_LOCK = threading.Lock()


def _atualizar_percentual_migracao(cliente_id, migracao_id, link_planilha):
    try:
        valor = planilha_migracao.calcular_progresso_migracao(link_planilha)
        if valor is not None:
            migracoes_sql.atualizar_percentual(migracao_id, valor, time.time())
    except Exception:
        app.logger.exception("Falha ao atualizar progresso da migração %s pela planilha", migracao_id)
    finally:
        with _PERCENTUAL_LOCK:
            _PERCENTUAL_EM_ATUALIZACAO.discard(migracao_id)


def _percentual_migracao_para_lista(cliente_id, migracao_id, link_planilha, guardado, atualizado_em):
    """Devolve o % guardado na hora e, se estiver velho, dispara a atualização
    pela planilha em segundo plano — o Kanban nunca espera a planilha."""
    if not link_planilha:
        return guardado
    if atualizado_em and time.time() - atualizado_em < _PERCENTUAL_TTL_SEGUNDOS:
        return guardado
    with _PERCENTUAL_LOCK:
        if migracao_id in _PERCENTUAL_EM_ATUALIZACAO:
            return guardado
        _PERCENTUAL_EM_ATUALIZACAO.add(migracao_id)
    threading.Thread(
        target=_atualizar_percentual_migracao,
        args=(cliente_id, migracao_id, link_planilha),
        daemon=True,
    ).start()
    return guardado


@app.route("/api/migracao/clientes", methods=["GET"])
def listar_clientes_migracao():
    return jsonify(ok=True, clientes=_cache_api_obter("migracao_clientes", _carregar_clientes_migracao))


def _carregar_clientes_migracao():
    """Um item por cliente que tem alguma tentativa de migração — a "atual"
    (em_andamento, senão a mais recente). Coleção legada (migracao_clientes)
    foi descontinuada (nunca mais recebia cliente novo de verdade — ver
    docs/HISTORICO_DECISOES.md).

    Busca as migrações de TODOS os clientes numa única consulta (ver
    `listar_migracoes_todas_por_cliente`) em vez de 1 SELECT por cliente
    dentro do loop — isso é o que fazia essa listagem ficar lenta em bases
    com muitos clientes."""
    lista = []
    migracoes_por_cliente = migracoes_sql.listar_migracoes_todas_por_cliente()
    for cliente in clientes_sql.listar_clientes_resumo():
        # Um cliente com dado inesperado (migração órfã, campo em formato
        # errado etc.) não pode derrubar a listagem inteira pra todo mundo —
        # pula só esse cliente e loga, pra investigar sem tirar o painel do
        # ar pros outros.
        try:
            migracoes = migracoes_por_cliente.get(cliente["id"], [])
            m = _migracao_atual(migracoes)
            if m is None:
                continue
            lista.append({
                "id": m["id"],
                # Mantido fixo (não há mais "legado") só pra não quebrar o front,
                # que usa c.origem === "unificado" pra habilitar funcionalidades
                # completas (IdCentral travado, editar veículos/modelos etc.).
                "origem": "unificado",
                "cliente_id": cliente["id"],
                "migracao_id": m["id"],
                "nome": cliente["cliente"],
                "idcentral": cliente["idcentral"],
                "cs": cliente["csm"],
                "tem_implantacao": cliente["tem_implantacao"],
                "etapa": m.get("etapa") or MIGRACAO_ETAPA_PADRAO,
                "plataforma_origem": m.get("plataforma_origem", ""),
                "link_planilha": m.get("link_planilha", ""),
                "link_acesso_origem": m.get("link_acesso_origem", ""),
                "login_acesso_origem": m.get("login_acesso_origem", ""),
                "senha_acesso_origem": m.get("senha_acesso_origem", ""),
                "qtd_clientes": m.get("qtd_clientes", 0),
                "qtd_placas": m.get("qtd_placas", 0),
                "percentual_migracao": _percentual_migracao_para_lista(
                    cliente["id"], m["id"], m.get("link_planilha", ""),
                    m.get("percentual_migracao", 0), m.get("percentual_atualizado_em"),
                ),
                "data_inicio": m.get("data_inicio", ""),
                "data_fim": m.get("data_fim", ""),
            })
        except Exception:
            app.logger.exception(
                "Falha ao montar item do painel de Migração pro cliente %s — pulado, não derruba a lista.",
                cliente.get("id"),
            )
    lista.sort(key=lambda c: (c.get("nome") or "").lower())
    return lista


@app.route("/api/ficha/<idcentral>")
def obter_ficha_cliente(idcentral):
    """Busca o cliente único por IdCentral, junto com o histórico de
    tentativas de migração dele. Mantém a chave "implantacao" (nome de antes
    da reestruturação) e uma "migracao" (singular = tentativa atual/mais
    recente) pra não precisar reescrever toda a Ficha de uma vez; "migracoes"
    (plural) é a lista completa, pro histórico."""
    implantacao = clientes_sql.buscar_cliente_por_idcentral(idcentral)
    if not implantacao:
        return jsonify(ok=False, error="Nenhum cliente encontrado com esse IdCentral."), 404

    # WhatsApp do CS e do Comercial: usa a FK quando resolvida (sem precisar
    # casar por nome); cai pro casamento por nome só quando não tem FK (CS
    # sem login, ou carga antiga da planilha). `telefones` só é buscado (1
    # SELECT de toda a tabela usuarios) se pelo menos um dos dois precisar —
    # e no máximo uma vez, nunca 1x por prefixo.
    telefones = None
    for prefixo, usuario_id_campo in (("csm", "responsavel_usuario_id"), ("vendedor", "vendedor_usuario_id")):
        usuario_id = implantacao.get(usuario_id_campo)
        usuario = usuarios_sql.buscar_usuario_por_id(usuario_id) if usuario_id else None
        if usuario:
            implantacao[f"{prefixo}_whatsapp"] = usuario.get("telefone_profissional", "")
        else:
            if telefones is None:
                telefones = usuarios_sql.telefones_profissionais_por_nome()
            implantacao[f"{prefixo}_whatsapp"] = telefones.get(implantacao.get(prefixo) or "", "")

    migracoes = migracoes_sql.listar_migracoes(implantacao["id"])
    migracao_atual = _migracao_atual(migracoes)

    dados_cred = credenciais_sql.obter_credencial_cliente(implantacao["id"])
    credencial_configurada = bool(dados_cred and dados_cred.get("login") and dados_cred.get("senha"))
    documentos = cliente_documentos_sql.listar_metadados(implantacao["id"])
    resposta = dict(
        ok=True,
        idcentral=idcentral,
        implantacao=implantacao,
        migracao=migracao_atual,
        migracoes=migracoes,
        credencial_configurada=credencial_configurada,
        documentos=documentos,
    )
    # O login em si só aparece pra admin (é quem cadastra/edita); pro resto dos
    # perfis, só o booleano "configurada" — o suficiente pra habilitar o botão
    # Autenticar sem expor a credencial.
    if _sou_admin() and dados_cred:
        resposta["credencial_login"] = dados_cred.get("login", "")
    return jsonify(**resposta)


# --- DOCUMENTOS DA FICHA (ficha de entrada assinada, contrato) ---
# PDF anexado ao cadastro do cliente, guardado em base64 no Postgres (mesmo
# padrão de UsuarioFoto) — sem servidor de arquivo próprio, nada a provisionar
# a mais no Render. Teto de tamanho generoso (PDF não passa pelo redimensionamento
# que a foto de perfil tem no navegador): 12MB de arquivo cru vira ~16M
# caracteres em base64.
TIPOS_DOCUMENTO_CLIENTE = {"ficha_entrada": "Ficha de entrada", "contrato": "Contrato"}
DOCUMENTO_CLIENTE_MAX_CHARS = 16_000_000


def _validar_documento_cliente(tipo, nome_arquivo, conteudo):
    if tipo not in TIPOS_DOCUMENTO_CLIENTE:
        return "Tipo de documento inválido."
    if not nome_arquivo:
        return "Informe o nome do arquivo."
    if not conteudo or not conteudo.startswith("data:application/pdf"):
        return "O arquivo precisa ser um PDF."
    if len(conteudo) > DOCUMENTO_CLIENTE_MAX_CHARS:
        return "Arquivo muito grande — tente um PDF menor (até 12MB)."
    return None


@app.route("/api/clientes/<int:cliente_id>/documentos/<tipo>", methods=["POST"])
@requer_operador
def salvar_documento_cliente(cliente_id, tipo):
    atual = clientes_sql.buscar_cliente_por_id(cliente_id)
    if not atual:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    data = request.get_json(force=True) or {}
    nome_arquivo = str(data.get("nome_arquivo", "")).strip()
    conteudo = str(data.get("conteudo", ""))
    erro = _validar_documento_cliente(tipo, nome_arquivo, conteudo)
    if erro:
        return jsonify(ok=False, error=erro), 400
    # Tamanho real do arquivo (bytes) vem do front (File.size) — só cai pro
    # tamanho do base64 (~33% maior) se por algum motivo não vier.
    tamanho = int(data.get("tamanho") or 0) or len(conteudo)
    enviado_por = session.get("app_usuario_responsavel") or session.get("app_usuario_nome", "")
    meta = cliente_documentos_sql.salvar_documento(
        cliente_id, tipo, nome_arquivo, conteudo, tamanho,
        time.strftime("%Y-%m-%d"), enviado_por,
    )
    registrar_acao(
        acao="editar", entidade_tipo="cliente", entidade_id=cliente_id,
        entidade_nome=atual.get("cliente", ""),
        titulo=f"Documento anexado: {TIPOS_DOCUMENTO_CLIENTE[tipo]}",
        cliente_id=cliente_id, idcentral=atual.get("idcentral", ""), cliente_nome=atual.get("cliente", ""),
    )
    return jsonify(ok=True, documento=meta)


@app.route("/api/clientes/<int:cliente_id>/documentos/<tipo>", methods=["DELETE"])
@requer_operador
def excluir_documento_cliente(cliente_id, tipo):
    atual = clientes_sql.buscar_cliente_por_id(cliente_id)
    if not atual:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    if tipo not in TIPOS_DOCUMENTO_CLIENTE:
        return jsonify(ok=False, error="Tipo de documento inválido."), 400
    if not cliente_documentos_sql.excluir_documento(cliente_id, tipo):
        return jsonify(ok=False, error="Documento não encontrado."), 404
    registrar_acao(
        acao="editar", entidade_tipo="cliente", entidade_id=cliente_id,
        entidade_nome=atual.get("cliente", ""),
        titulo=f"Documento removido: {TIPOS_DOCUMENTO_CLIENTE[tipo]}",
        cliente_id=cliente_id, idcentral=atual.get("idcentral", ""), cliente_nome=atual.get("cliente", ""),
    )
    return jsonify(ok=True)


@app.route("/api/clientes/<int:cliente_id>/documentos/<tipo>/arquivo", methods=["GET"])
def servir_documento_cliente(cliente_id, tipo):
    if tipo not in TIPOS_DOCUMENTO_CLIENTE:
        return jsonify(ok=False, error="Tipo de documento inválido."), 400
    doc = cliente_documentos_sql.obter_arquivo(cliente_id, tipo)
    if not doc or not doc["conteudo"].startswith("data:"):
        return jsonify(ok=False, error="Documento não encontrado."), 404
    _, _, b64 = doc["conteudo"].partition(",")
    resposta = Response(base64.b64decode(b64), mimetype="application/pdf")
    nome = (doc["nome_arquivo"] or f"{tipo}.pdf").replace('"', "'")
    resposta.headers["Content-Disposition"] = f'inline; filename="{nome}"'
    return resposta


# --- MODELOS DE RASTREADOR POR MIGRAÇÃO (padroniza o Comando pelo Equipamento) ---
# Cada tentativa de migração tem sua própria tabela de {modelo, porta, comando_template}.
# O comando_template usa o placeholder literal "{porta}", substituído pela porta
# cadastrada pra esse modelo nessa migração — ex.: "ip,200.152.62.20,{porta}" com
# porta "123456" vira "ip,200.152.62.20,123456".
def _dados_modelo_comando(data):
    modelo = str(data.get("modelo", "")).strip()
    if not modelo:
        return None
    return {
        "modelo": modelo,
        "porta": str(data.get("porta", "")).strip(),
        "comando_template": str(data.get("comando_template", "")).strip(),
    }


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/modelos", methods=["GET"])
def listar_modelos_comando_cliente(cliente_id, migracao_id):
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    return jsonify(ok=True, modelos=migracoes_sql.listar_modelos(migracao_id))


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/modelos", methods=["POST"])
def criar_modelo_comando_cliente(cliente_id, migracao_id):
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    dados = _dados_modelo_comando(request.get_json(force=True) or {})
    if dados is None:
        return jsonify(ok=False, error="Informe o modelo do rastreador."), 400
    modelo, atualizados = migracoes_sql.salvar_modelo(migracao_id, None, dados)
    return jsonify(ok=True, modelo=modelo, veiculos_atualizados=atualizados)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/modelos/<int:modelo_id>", methods=["PUT"])
def editar_modelo_comando_cliente(cliente_id, migracao_id, modelo_id):
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    dados = _dados_modelo_comando(request.get_json(force=True) or {})
    if dados is None:
        return jsonify(ok=False, error="Informe o modelo do rastreador."), 400
    resultado = migracoes_sql.salvar_modelo(migracao_id, modelo_id, dados)
    if resultado is None:
        return jsonify(ok=False, error="Modelo não encontrado."), 404
    modelo, atualizados = resultado
    return jsonify(ok=True, modelo=modelo, veiculos_atualizados=atualizados)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/modelos/<int:modelo_id>", methods=["DELETE"])
def excluir_modelo_comando_cliente(cliente_id, migracao_id, modelo_id):
    if not migracoes_sql.excluir_modelo(modelo_id):
        return jsonify(ok=False, error="Modelo não encontrado."), 404
    return jsonify(ok=True)


CAMPOS_VEICULO_ATUALIZAVEIS = [
    "comando", "apn", "ls_apn", "ultima_comunicacao", "equipamento", "id_equipamento", "numero_linha",
]


VEICULOS_POR_PAGINA_PADRAO = 100
VEICULOS_POR_PAGINA_MAXIMO = 500
# Mesma lista de migracoes_sql._COLUNAS_FILTRAVEIS_POR_COLUNA — cada uma vira
# um query param "col_<campo>" (caixa de filtro "contém" estilo Excel, ver
# trFiltros em script.js).
VEICULOS_COLUNAS_FILTRAVEIS = [
    "cliente", "veiculo", "equipamento", "id_equipamento", "apn", "ls_apn",
    "numero_linha", "comando", "ultima_comunicacao",
]


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/veiculos", methods=["GET"])
def listar_veiculos_cliente(cliente_id, migracao_id):
    """Filtra/ordena/pagina no banco — a tela pedia a lista inteira da
    migração de uma vez (ok pra planilhas pequenas, mas travava a abertura em
    central grande como a Cartracking, com busca/ordenação feitas em memória
    no front sobre tudo). `resumo` traz as contagens agregadas (chips de
    status + "migrado/total" por cliente) que antes vinham de somar a lista
    inteira no JS."""
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    try:
        pagina = max(int(request.args.get("pagina", 0)), 0)
    except ValueError:
        pagina = 0
    try:
        tamanho = min(max(int(request.args.get("tamanho", VEICULOS_POR_PAGINA_PADRAO)), 1), VEICULOS_POR_PAGINA_MAXIMO)
    except ValueError:
        tamanho = VEICULOS_POR_PAGINA_PADRAO
    busca = request.args.get("busca", "").strip()
    status = request.args.get("status", "").strip()
    ordenar_por = request.args.get("ordenar_por") or None
    ordem_asc = request.args.get("ordem", "asc") != "desc"
    filtros_coluna = {
        campo: valor
        for campo in VEICULOS_COLUNAS_FILTRAVEIS
        if (valor := request.args.get(f"col_{campo}", "").strip())
    }
    veiculos, total = migracoes_sql.listar_veiculos_pagina(
        migracao_id, pagina=pagina, tamanho=tamanho, busca=busca, status=status,
        ordenar_por=ordenar_por, ordem_asc=ordem_asc, filtros_coluna=filtros_coluna,
    )
    resumo = migracoes_sql.calcular_resumo_veiculos(migracao_id)
    return jsonify(ok=True, veiculos=veiculos, total=total, pagina=pagina, tamanho=tamanho, resumo=resumo)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/veiculos/<int:veiculo_id>", methods=["PUT"])
def atualizar_veiculo_cliente(cliente_id, migracao_id, veiculo_id):
    data = request.get_json(force=True) or {}
    campos = {c: str(data.get(c, "")) for c in CAMPOS_VEICULO_ATUALIZAVEIS if c in data}
    if "status" in data:
        status = str(data.get("status", "")).strip()
        if status not in STATUS_VEICULO_VALIDOS:
            return jsonify(ok=False, error="Status inválido."), 400
        campos["status"] = status
    if not campos:
        return jsonify(ok=False, error="Nada para atualizar."), 400
    veiculo = migracoes_sql.atualizar_veiculo(veiculo_id, campos)
    if not veiculo:
        return jsonify(ok=False, error="Veículo não encontrado."), 404
    migracoes_sql.recalcular_e_persistir_progresso(migracao_id)
    return jsonify(ok=True, **veiculo)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/veiculos/<int:veiculo_id>", methods=["DELETE"])
def excluir_veiculo_cliente(cliente_id, migracao_id, veiculo_id):
    migracoes_sql.excluir_veiculo(veiculo_id)
    migracoes_sql.recalcular_e_persistir_progresso(migracao_id)
    return jsonify(ok=True)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/veiculos/item", methods=["POST"])
def salvar_item_veiculo_cliente(cliente_id, migracao_id):
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    resultado = migracoes_sql.salvar_item_veiculo(migracao_id, request.get_json(force=True) or {})
    if resultado is None:
        return jsonify(ok=False, error="Informe cliente e veículo."), 400
    migracoes_sql.recalcular_e_persistir_progresso(migracao_id)
    return jsonify(ok=True, veiculo=resultado)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/resumo-planilha", methods=["GET"])
def resumo_planilha_migracao_cliente(cliente_id, migracao_id):
    """Calcula o resumo por modelo e o % de progresso em cima de
    `migracao_veiculos`, normalizando status e contagens para a Ficha.
    (pedido do usuário — a tabela agora é alimentada pela API da SSX, não
    precisa mais ler a planilha do Google pra isso; `ler_resumo_modelos_planilha_migracao`
    ficou sem uso aqui, mas continua existindo pro fluxo de importação manual
    antigo). % vem da linha "Total" do resumo por modelo (Comunicou/Total)."""
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    migracoes_sql.recalcular_e_persistir_progresso(migracao_id)
    resumo_modelos = migracoes_sql.calcular_resumo_modelos_local(migracao_id)
    total_linha = next((r for r in resumo_modelos if r["modelo"].strip().lower() == "total"), None)
    percentual_migracao = None
    if total_linha:
        try:
            comunicou = float(total_linha.get("comunicou") or 0)
            total = float(total_linha.get("total") or 0)
            percentual_migracao = round(100 * comunicou / total) if total else 0
        except ValueError:
            percentual_migracao = None
    return jsonify(ok=True, resumo_modelos=resumo_modelos, percentual_migracao=percentual_migracao)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/importar-planilha", methods=["POST"])
def importar_veiculos_planilha_cliente(cliente_id, migracao_id):
    """Lê a aba "Migração" da planilha vinculada e faz upsert dos veículos por
    (cliente, veículo) — reimportar atualiza quem já existe em vez de
    duplicar. Diferente de salvar_item_veiculo (que preserva o status ao
    editar manualmente), aqui o status SEMPRE vem da planilha — é lá que o
    time marca Aguardando/Enviar/Enviado/Comunicou, então reimportar deve
    refletir isso."""
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    link_planilha = migracao.get("link_planilha")
    if not link_planilha:
        return jsonify(ok=False, error="Essa migração não tem planilha vinculada."), 400
    try:
        veiculos = planilha_migracao.ler_veiculos_planilha_migracao(link_planilha)
    except planilha_migracao.PlanilhaMigracaoError as err:
        return jsonify(ok=False, error=str(err)), 502
    except HttpError as err:
        return jsonify(ok=False, error=f"Erro do Google Sheets ao ler a planilha: {err}"), 502
    migracoes_sql.importar_veiculos_planilha(migracao_id, veiculos)
    contagens = migracoes_sql.recalcular_e_persistir_progresso(migracao_id)
    qtd_clientes = contagens["qtd_clientes"]
    qtd_placas = contagens["qtd_placas"]
    percentual_migracao = contagens["percentual_migracao"]
    resumo_modelos = migracoes_sql.calcular_resumo_modelos_local(migracao_id)
    return jsonify(
        ok=True, importados=len(veiculos), qtd_clientes=qtd_clientes, qtd_placas=qtd_placas,
        percentual_migracao=percentual_migracao, resumo_modelos=resumo_modelos,
    )


# --- Sincronização de Veículos SSX + Verificação de Comunicação ---
# Mesmo padrão de job/thread/polling de deletar_veiculos_executar/
# _executar_deletar_veiculos (app.py, seção "DELETAR VEÍCULOS EM MASSA") —
# token resolvido na requisição, thread não depende de `session`. Ver plano
# aprovado "Sincronização de Veículos SSX" pro raciocínio completo.
VERIFICAR_COMUNICACAO_SSX_JOBS = {}
VERIFICAR_COMUNICACAO_SSX_JOBS_LOCK = threading.Lock()
SSX_LIST_TIMEOUT_SEGUNDOS = 120
SSX_LIST_RETRIES = 1


def _executar_sincronizar_veiculos_ssx(job_id, migracao_id, token):
    try:
        veiculos_locais = migracoes_sql.listar_veiculos(migracao_id)
        veiculos_ssx = requisicao_padrao(
            "/Administration/Vehicle/List", None, token,
            timeout=SSX_LIST_TIMEOUT_SEGUNDOS, retries=SSX_LIST_RETRIES,
        )
        modelos_rastreador = requisicao_padrao(
            "/Administration/Tracker/ListTrackerModel", None, token,
            timeout=SSX_LIST_TIMEOUT_SEGUNDOS, retries=SSX_LIST_RETRIES,
        )
        diff = ssx_veiculos_sync.calcular_diff_sincronizacao(
            veiculos_locais,
            veiculos_ssx or [],
            modelos_rastreador or [],
        )
        migracoes_sql.atualizar_job_sincronizacao_ssx(job_id, "concluido", diff=diff)
    except requests.exceptions.RequestException as e:
        migracoes_sql.atualizar_job_sincronizacao_ssx(
            job_id, "erro", erro=f"Falha ao consultar a SSX: {e}"
        )
    except Exception as e:
        app.logger.exception("Falha inesperada na sincronização SSX (job %s)", job_id)
        migracoes_sql.atualizar_job_sincronizacao_ssx(
            job_id, "erro", erro=f"Falha ao processar a sincronização: {e}"
        )


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/veiculos/sincronizar", methods=["POST"])
@requer_operador
def sincronizar_veiculos_ssx_iniciar(cliente_id, migracao_id):
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    token, erro_resp, status = _token_para_cliente(cliente_id)
    if erro_resp:
        return erro_resp, status

    job_id = uuid.uuid4().hex
    migracoes_sql.criar_job_sincronizacao_ssx(migracao_id, job_id)
    threading.Thread(
        target=_executar_sincronizar_veiculos_ssx,
        args=(job_id, migracao_id, token),
        daemon=True,
    ).start()
    return jsonify(ok=True, job_id=job_id)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/veiculos/sincronizar/status/<job_id>")
def sincronizar_veiculos_ssx_status(cliente_id, migracao_id, job_id):
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    resultado = migracoes_sql.buscar_job_sincronizacao_ssx(migracao_id, job_id)
    if not resultado:
        return jsonify(ok=False, error="Job não encontrado."), 404
    return jsonify(ok=True, **resultado)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/veiculos/sincronizar/aplicar/<job_id>", methods=["POST"])
@requer_operador
def sincronizar_veiculos_ssx_aplicar(cliente_id, migracao_id, job_id):
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    resultado, erro = migracoes_sql.aplicar_job_sincronizacao_ssx(migracao_id, job_id)
    if erro == "nao_encontrado":
        return jsonify(ok=False, error="Job não encontrado para esta migração."), 404
    if erro:
        return jsonify(ok=False, error="Resultado da sincronização não encontrado. Rode a sincronização novamente."), 400
    return jsonify(ok=True, **resultado)


def _executar_verificar_comunicacao_ssx(job_id, migracao_id, token):
    try:
        veiculos_locais = migracoes_sql.listar_veiculos(migracao_id)
        monitorados = requisicao_padrao(
            "/Administration/Tracker/ListMonitoredTrackedUnits", None, token,
            timeout=SSX_LIST_TIMEOUT_SEGUNDOS, retries=SSX_LIST_RETRIES,
        ) or []
        desatualizados = requisicao_padrao(
            "/Administration/Tracker/ListOutdatedTrackedUnits", None, token,
            timeout=SSX_LIST_TIMEOUT_SEGUNDOS, retries=SSX_LIST_RETRIES,
        ) or []
        resultado = ssx_veiculos_sync.calcular_status_comunicacao(
            veiculos_locais,
            monitorados,
            desatualizados,
        )
        migracoes_sql.aplicar_status_comunicacao_ssx(resultado)
        migracoes_sql.recalcular_e_persistir_progresso(migracao_id)
        # Dado bruto da SSX (`detalhe`) não precisa ir pro front, que só
        # pinta status + mostra o marco já persistido no banco.
        status_por_veiculo = {vid: r["status"] for vid, r in resultado.items()}
        with VERIFICAR_COMUNICACAO_SSX_JOBS_LOCK:
            VERIFICAR_COMUNICACAO_SSX_JOBS[job_id] = {"status": "concluido", "status_por_veiculo": status_por_veiculo}
    except requests.exceptions.RequestException as e:
        with VERIFICAR_COMUNICACAO_SSX_JOBS_LOCK:
            VERIFICAR_COMUNICACAO_SSX_JOBS[job_id] = {"status": "erro", "erro": f"Falha ao consultar a SSX: {e}"}
    except Exception as e:
        app.logger.exception("Falha inesperada na verificação de comunicação SSX (job %s)", job_id)
        with VERIFICAR_COMUNICACAO_SSX_JOBS_LOCK:
            VERIFICAR_COMUNICACAO_SSX_JOBS[job_id] = {"status": "erro", "erro": f"Falha ao processar a verificação de comunicação: {e}"}


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/veiculos/verificar-comunicacao", methods=["POST"])
@requer_operador
def verificar_comunicacao_ssx_iniciar(cliente_id, migracao_id):
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    token, erro_resp, status = _token_para_cliente(cliente_id)
    if erro_resp:
        return erro_resp, status

    job_id = uuid.uuid4().hex
    with VERIFICAR_COMUNICACAO_SSX_JOBS_LOCK:
        VERIFICAR_COMUNICACAO_SSX_JOBS[job_id] = {"status": "rodando"}
    threading.Thread(
        target=_executar_verificar_comunicacao_ssx,
        args=(job_id, migracao_id, token),
        daemon=True,
    ).start()
    return jsonify(ok=True, job_id=job_id)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>/veiculos/verificar-comunicacao/status/<job_id>")
def verificar_comunicacao_ssx_status(cliente_id, migracao_id, job_id):
    with VERIFICAR_COMUNICACAO_SSX_JOBS_LOCK:
        job = VERIFICAR_COMUNICACAO_SSX_JOBS.get(job_id)
        if not job:
            return jsonify(ok=False, error="Job não encontrado."), 404
        resultado = dict(job)
    return jsonify(ok=True, **resultado)


@app.route("/api/clientes/<int:cliente_id>/migracoes/<int:migracao_id>", methods=["PATCH"])
def atualizar_contagens_migracao_cliente(cliente_id, migracao_id):
    """Recalcula os totais no servidor após criação ou exclusão de um veículo."""
    migracao = migracoes_sql.buscar_migracao(migracao_id)
    if not migracao or migracao["cliente_id"] != cliente_id:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    contagens = migracoes_sql.recalcular_e_persistir_progresso(migracao_id)
    return jsonify(ok=True, **contagens)


def _contar(query):
    """Contagem agregada do Firestore (count()) — custa 1 leitura a cada 1.000
    documentos contados, em vez de 1 leitura por documento como .stream()."""
    return int(query.count().get()[0][0].value)


@app.route("/api/dashboard")
def dashboard_indicadores():
    # Dashboard é a tela inicial: o resultado fica 5 min em cache (ver
    # _cache_api_obter). Sem isso, cada abertura refazia as contagens.
    return jsonify(**_cache_api_obter("dashboard", _carregar_dashboard, ttl=300))


def _carregar_dashboard():
    # Implantação (Postgres, tabela clientes) — contagem direto no banco.
    # Antes lia a coleção Firestore legada (IMPLANTACAO_CLIENTES_COLLECTION),
    # que parou de receber cliente novo desde a virada pra Postgres e ficava
    # com número parado/errado.
    total_implantacao, implantacao_ativos = clientes_sql.contar_clientes_implantacao()

    # Migração (modelo unificado, Postgres) — mesma métrica de antes
    # (total de tentativas rastreadas vs. quantas já concluíram todas as
    # etapas), só que agora só sobre o Postgres (a coleção legada
    # "migracao_clientes" foi descontinuada).
    por_etapa_migracao, total_clientes = migracoes_sql.contar_por_etapa(MIGRACAO_ETAPAS, MIGRACAO_ETAPA_PADRAO)
    migracao_ativos = total_clientes - por_etapa_migracao.get("concluido", 0)

    por_status, total_veiculos = migracoes_sql.contar_veiculos_por_status(STATUS_VEICULO_VALIDOS, STATUS_VEICULO_PADRAO)

    por_estagio, _ = clientes_sql.contar_por_estagio(ESTAGIOS_CLIENTE, ESTAGIO_CLIENTE_PADRAO)
    migracoes_por_status, _ = migracoes_sql.contar_por_status(STATUS_MIGRACAO_VALIDOS, STATUS_MIGRACAO_PADRAO)
    migracoes_em_andamento = migracoes_por_status["em_andamento"]

    return dict(
        ok=True,
        total_clientes=total_clientes,
        total_veiculos=total_veiculos,
        por_status=por_status,
        total_implantacao=total_implantacao,
        implantacao_ativos=implantacao_ativos,
        migracao_ativos=migracao_ativos,
        por_estagio=por_estagio,
        migracoes_em_andamento=migracoes_em_andamento,
    )


@app.route("/api/list/<tipo>")
def listar(tipo):
    idcentral_solicitado = request.args.get("idcentral") or None
    token, erro_resp, status = _token_para(idcentral_solicitado)
    if erro_resp:
        return erro_resp, status
    config = LISTAGENS.get(tipo)
    if not config:
        return jsonify(ok=False, error="Listagem desconhecida."), 404
    try:
        data = requisicao_padrao(config["endpoint"], config["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha na consulta: {e}"), 400
    rows = [[item.get(c) for c in config["campos"]] for item in (data or [])]
    return jsonify(ok=True, headers=config["headers"], rows=rows)


# Exportação genérica: recebe o headers/rows já carregado em tela (qualquer uma
# das Consultas/Listagens) e devolve como planilha, sem precisar consultar a SSX de novo.
@app.route("/api/exportar-excel", methods=["POST"])
def exportar_excel():
    data = request.get_json(force=True) or {}
    headers = data.get("headers") or []
    rows = data.get("rows") or []
    nome = "".join(c for c in str(data.get("nome") or "") if c.isalnum() or c in "_-") or "exportacao"

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append(row)

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)

    return Response(
        buffer.getvalue(),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{nome}.xlsx"'},
    )


@app.route("/api/import/params/<tipo>")
def import_params(tipo):
    config = PARAMS.get(tipo)
    if not config:
        return jsonify(ok=False, error="Tipo desconhecido."), 404
    labels = LABELS.get(tipo, {})
    campos = [{"nome": c, "rotulo": labels.get(c, c)} for c in config["campos"]]
    return jsonify(ok=True, titulo=config["titulo"], campos=campos)


@app.route("/api/import/upload", methods=["POST"])
@requer_operador
def import_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]
    try:
        df = pd.read_excel(arquivo, dtype=str)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler Excel: {e}"), 400
    file_id = uuid.uuid4().hex
    with UPLOADS_LOCK:
        UPLOADS[file_id] = df
    return jsonify(ok=True, file_id=file_id, colunas=list(df.columns), total_linhas=len(df))


# Importação roda em thread separada, pelo mesmo motivo do envio de comando em
# massa: uma importação grande facilmente passa dos ~30s que o Render/gunicorn
# tolera num único request parado, cortando a importação no meio.
IMPORT_JOBS = {}
IMPORT_JOBS_LOCK = threading.Lock()


def _executar_import(job_id, tipo_config, mapping, df, endpoint, token):
    sucessos = erros = 0
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    for pos, (index, row) in enumerate(df.iterrows()):
        payload = montar_payload(tipo_config, mapping, row)
        try:
            resp = requests.post(f"{BASE_URL}{endpoint}", json=payload, headers=headers, timeout=20)
            if resp.status_code in (200, 201):
                sucessos += 1
            else:
                erros += 1
                with IMPORT_JOBS_LOCK:
                    IMPORT_JOBS[job_id]["logs"].append(f"Erro linha {pos + 1}: {resp.text}")
        except requests.exceptions.RequestException as e:
            erros += 1
            with IMPORT_JOBS_LOCK:
                IMPORT_JOBS[job_id]["logs"].append(f"Erro linha {pos + 1}: {e}")

        with IMPORT_JOBS_LOCK:
            job = IMPORT_JOBS[job_id]
            job["atual"] = pos + 1
            job["sucessos"] = sucessos
            job["erros"] = erros

    with IMPORT_JOBS_LOCK:
        IMPORT_JOBS[job_id]["status"] = "concluido"
        IMPORT_JOBS[job_id]["planilha"] = None


@app.route("/api/import/run", methods=["POST"])
@requer_operador
def import_run():
    body = request.get_json(force=True) or {}
    token, erro_resp, status = _token_para(body.get("idcentral"))
    if erro_resp:
        return erro_resp, status

    tipo = body.get("tipo")
    file_id = body.get("file_id")
    mapping = body.get("mapping") or {}

    tipo_config = PARAMS.get(tipo)
    if not tipo_config:
        return jsonify(ok=False, error="Tipo desconhecido."), 404
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna."), 400

    with UPLOADS_LOCK:
        df = UPLOADS.pop(file_id, None)
    if df is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400

    endpoint = tipo_config["endpoint"]
    total = len(df)

    job_id = uuid.uuid4().hex
    with IMPORT_JOBS_LOCK:
        IMPORT_JOBS[job_id] = {
            "status": "rodando", "atual": 0, "total": total,
            "sucessos": 0, "erros": 0, "logs": [], "planilha": None,
        }

    threading.Thread(
        target=_executar_import,
        args=(job_id, tipo_config, mapping, df, endpoint, token),
        daemon=True,
    ).start()

    return jsonify(ok=True, job_id=job_id, total=total)


@app.route("/api/import/run/status/<job_id>")
def import_run_status(job_id):
    with IMPORT_JOBS_LOCK:
        job = IMPORT_JOBS.get(job_id)
        if not job:
            return jsonify(ok=False, error="Job não encontrado."), 404
        resultado = dict(job)
    return jsonify(ok=True, **resultado)


# --- VALIDADOR DE PLANILHA DE IMPORTAÇÃO ---
# Confere a planilha contra as regras documentadas de cada tipo de importação
# da SSX (validador_importacao/) ANTES de importar de verdade — não chama a
# API da SSX, só lê o arquivo enviado, por isso roda síncrono (sem thread/job
# como a Área de Importação, que precisa fazer 1 request por linha na SSX).
VALIDADOR_UPLOADS = {}
VALIDADOR_UPLOADS_LOCK = threading.Lock()


def _tentar_ler_csv(bruto, encoding):
    for sep in (";", ","):
        try:
            df = pd.read_csv(io.BytesIO(bruto), dtype=str, sep=sep, encoding=encoding)
        except UnicodeDecodeError:
            return None  # erro é de encoding, não de separador — tentar outro sep não ajuda
        except Exception:
            continue
        if len(df.columns) > 1:
            return df
    return None


def _ler_planilha_validador(arquivo):
    nome = (arquivo.filename or "").lower()
    if not nome.endswith(".csv"):
        return pd.read_excel(arquivo, dtype=str)

    bruto = arquivo.read()
    # Excel no Windows em pt-BR normalmente salva "CSV" em ANSI (cp1252), não
    # UTF-8 — sem esse fallback, cabeçalho com acento (Código, Razão...) quebra
    # a leitura. cp1252 nunca falha por decodificação (é de 1 byte), então
    # tentamos UTF-8 primeiro pra não interpretar um UTF-8 de verdade errado.
    for encoding in ("utf-8-sig", "cp1252"):
        df = _tentar_ler_csv(bruto, encoding)
        if df is not None:
            return df
    return pd.read_csv(io.BytesIO(bruto), dtype=str, sep=";", encoding="cp1252")


@app.route("/api/validador/tipos")
def validador_tipos():
    tipos = [{"chave": chave, "titulo": tipo.titulo} for chave, tipo in validador_importacao.TIPOS.items()]
    return jsonify(ok=True, tipos=tipos)


@app.route("/api/validador/campos/<tipo>")
def validador_campos(tipo):
    try:
        tipo_spec = validador_importacao.obter_tipo(tipo)
    except KeyError:
        return jsonify(ok=False, error="Tipo desconhecido."), 404
    campos = []
    for campo in tipo_spec.campos:
        obrigatorio = "condicional" if callable(campo.obrigatorio) else bool(campo.obrigatorio)
        campos.append({"chave": campo.chave, "rotulo": campo.rotulo, "obrigatorio": obrigatorio})
    return jsonify(ok=True, titulo=tipo_spec.titulo, campos=campos)


@app.route("/api/validador/upload", methods=["POST"])
def validador_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]
    try:
        df = _ler_planilha_validador(arquivo)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler o arquivo: {e}"), 400
    file_id = uuid.uuid4().hex
    with VALIDADOR_UPLOADS_LOCK:
        VALIDADOR_UPLOADS[file_id] = df
    return jsonify(ok=True, file_id=file_id, colunas=list(df.columns), total_linhas=len(df))


@app.route("/api/validador/rodar", methods=["POST"])
def validador_rodar():
    body = request.get_json(force=True) or {}
    tipo = body.get("tipo")
    file_id = body.get("file_id")

    try:
        tipo_spec = validador_importacao.obter_tipo(tipo)
    except KeyError:
        return jsonify(ok=False, error="Tipo desconhecido."), 404

    with VALIDADOR_UPLOADS_LOCK:
        df = VALIDADOR_UPLOADS.get(file_id)
    if df is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400

    # A importação da SSX é posicional: a planilha precisa ter as colunas na
    # MESMA ordem do layout oficial (mesmo os campos não obrigatórios têm que
    # ocupar sua posição). Por isso o campo N da planilha vira o campo N do
    # tipo — não tem mapeamento por nome de coluna.
    campos = tipo_spec.campos
    if len(df.columns) != len(campos):
        return jsonify(
            ok=False,
            error=(
                f"A planilha tem {len(df.columns)} coluna(s), mas o layout de {tipo_spec.titulo} "
                f"tem {len(campos)} — confira se todas as posições (mesmo as não obrigatórias) "
                "estão presentes, na ordem oficial do manual da SSX."
            ),
        ), 400

    colunas = list(df.columns)
    linhas = (
        {campo.chave: row[colunas[i]] for i, campo in enumerate(campos)}
        for _, row in df.iterrows()
    )
    erros = validador_importacao.validar_planilha(tipo_spec, linhas)

    por_categoria = {}
    linhas_com_erro = set()
    for erro in erros:
        por_categoria[erro.categoria] = por_categoria.get(erro.categoria, 0) + 1
        linhas_com_erro.add(erro.linha)

    return jsonify(
        ok=True,
        total_linhas=len(df),
        total_erros=len(erros),
        linhas_com_erro=len(linhas_com_erro),
        por_categoria=por_categoria,
        erros=[{"linha": e.linha, "campo": e.campo, "categoria": e.categoria, "mensagem": e.mensagem} for e in erros],
    )


# --- CONVERSOR DE PLANILHA DE CLIENTES (importação para a SSX) ---
# Fluxo completo (upload -> mapear colunas -> editar/transformar -> validar ->
# exportar) rodando no servidor, reaproveitando validador_importacao/ como
# única fonte de verdade das regras (ver conversor_clientes.py) e
# _ler_planilha_validador/_tentar_ler_csv já usados pelo Validador acima.
# Não chama a API da SSX nem grava nada — só lê o arquivo enviado e devolve
# planilha/arquivo pra download, por isso roda síncrono como o Validador.
CONVERSOR_CLIENTES_UPLOADS = {}
CONVERSOR_CLIENTES_LOCK = threading.Lock()


@app.route("/api/conversor-clientes/campos")
def conversor_clientes_campos():
    campos = []
    for campo in conversor_clientes.CAMPOS_CLIENTE:
        obrigatorio = "condicional" if callable(campo.obrigatorio) else bool(campo.obrigatorio)
        campos.append({
            "chave": campo.chave, "rotulo": campo.rotulo, "obrigatorio": obrigatorio,
            "tipo": campo.tipo, "tamanho_max": campo.tamanho_max,
        })
    return jsonify(ok=True, campos=campos)


@app.route("/api/conversor-clientes/upload", methods=["POST"])
def conversor_clientes_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]
    try:
        df = _ler_planilha_validador(arquivo)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler o arquivo: {e}"), 400
    if df.empty:
        return jsonify(ok=False, error="A planilha está vazia."), 400

    file_id = uuid.uuid4().hex
    nome_base = os.path.splitext(arquivo.filename or "clientes")[0]
    with CONVERSOR_CLIENTES_LOCK:
        CONVERSOR_CLIENTES_UPLOADS[file_id] = {"df": df, "nome_base": nome_base, "registros": None}
    return jsonify(ok=True, file_id=file_id, colunas=list(df.columns), total_linhas=len(df))


@app.route("/api/conversor-clientes/mapear", methods=["POST"])
def conversor_clientes_mapear():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    mapping = body.get("mapping") or {}  # {chave_destino: coluna_origem}

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
    if entry is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna antes de continuar."), 400

    df = entry["df"]
    colunas_validas = set(df.columns)
    mapping_valido = {chave: col for chave, col in mapping.items() if col in colunas_validas}

    registros = []
    for pos, row in enumerate(df.itertuples(index=False), start=1):
        row_dict = dict(zip(df.columns, row))
        dados = {}
        for chave, col in mapping_valido.items():
            valor = row_dict.get(col)
            dados[chave] = "" if (valor is None or str(valor).strip().lower() == "nan") else str(valor).strip()
        registros.append({"indice": pos, "original": dict(dados), "dados": dict(dados)})

    with CONVERSOR_CLIENTES_LOCK:
        entry["registros"] = registros

    return jsonify(ok=True, total=len(registros), registros=registros)


@app.route("/api/conversor-clientes/usar-como-upload", methods=["POST"])
def conversor_clientes_usar_como_upload():
    """Transforma os registros JÁ carregados/editados no Conversor de Clientes
    num "upload" do modal de importação genérico (UPLOADS, o mesmo dict usado
    por /api/import/upload) — pro botão "Importar via API" não obrigar a
    pessoa a exportar e re-enviar o arquivo que ela já tem na tela. Colunas do
    DataFrame = rótulo oficial (CAMPOS_CLIENTE) de cada campo que entrou no
    mapeamento aplicado, só os que foram usados. Também devolve o mapeamento
    já pronto (CONVERSOR_CLIENTES_PARA_API) — não dá pra confiar só no
    auto-mapeamento por texto do modal genérico pra esses campos (ver
    comentário da constante). "Senha" vazia manda "0" — só nesse caminho da
    API, o .txt exportado continua em branco (mesmo ajuste de "Tolerance" em
    conversor_areas_usar_como_upload)."""
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Carregue e mapeie uma planilha no Conversor de Clientes antes."), 400

    registros = entry["registros"]
    rotulo_por_chave = {c.chave: c.rotulo for c in conversor_clientes.CAMPOS_CLIENTE}
    chaves = list(registros[0]["dados"].keys())
    colunas = [rotulo_por_chave.get(chave, chave) for chave in chaves]

    linhas = []
    for r in registros:
        dados = dict(r["dados"])
        if "senha" in dados and not str(dados.get("senha", "")).strip():
            dados["senha"] = "0"
        linhas.append({rotulo_por_chave.get(chave, chave): dados.get(chave, "") for chave in chaves})
    df = pd.DataFrame(linhas, columns=colunas, dtype=str)

    novo_file_id = uuid.uuid4().hex
    with UPLOADS_LOCK:
        UPLOADS[novo_file_id] = df

    mapeamento_sugerido = {}
    for chave in chaves:
        campo_api = CONVERSOR_CLIENTES_PARA_API.get(chave)
        if campo_api:
            mapeamento_sugerido[campo_api] = rotulo_por_chave.get(chave, chave)

    return jsonify(
        ok=True, file_id=novo_file_id, colunas=colunas, total_linhas=len(df),
        mapeamento_sugerido=mapeamento_sugerido,
    )


@app.route("/api/conversor-clientes/editar", methods=["POST"])
def conversor_clientes_editar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")
    campo = body.get("campo")
    valor = body.get("valor", "")

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
    campos_validos = {c.chave for c in conversor_clientes.CAMPOS_CLIENTE}
    if campo not in campos_validos:
        return jsonify(ok=False, error="Campo desconhecido."), 400

    registro = next((r for r in entry["registros"] if r["indice"] == indice), None)
    if registro is None:
        return jsonify(ok=False, error="Registro não encontrado."), 404
    registro["dados"][campo] = str(valor).strip()
    return jsonify(ok=True)


@app.route("/api/conversor-clientes/excluir-linha", methods=["POST"])
def conversor_clientes_excluir_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
        if entry is None or not entry.get("registros"):
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if r["indice"] != indice]
        if len(entry["registros"]) == tamanho_antes:
            return jsonify(ok=False, error="Linha não encontrada."), 404
    return jsonify(ok=True)


@app.route("/api/conversor-clientes/adicionar-linha", methods=["POST"])
def conversor_clientes_adicionar_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        proximo_indice = max((r["indice"] for r in registros), default=0) + 1
        # Copia as mesmas chaves (campos mapeados) de uma linha já existente,
        # todas vazias — não dá pra saber aqui quais campos foram mapeados
        # (isso só existe no JS/estado da tela), então usa o molde do que já
        # está em memória; planilha vazia (0 linhas) cai no CAMPOS_CLIENTE
        # inteiro como última alternativa.
        chaves = list(registros[0]["dados"].keys()) if registros else [c.chave for c in conversor_clientes.CAMPOS_CLIENTE]
        dados_vazios = {chave: "" for chave in chaves}
        novo = {"indice": proximo_indice, "original": dict(dados_vazios), "dados": dict(dados_vazios)}
        registros.append(novo)
    return jsonify(ok=True, registro=novo)


@app.route("/api/conversor-clientes/limpar-vazias", methods=["POST"])
def conversor_clientes_limpar_vazias():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if any((v or "").strip() for v in r["dados"].values())]
        removidos = tamanho_antes - len(entry["registros"])
    return jsonify(ok=True, removidos=removidos)


@app.route("/api/conversor-clientes/transformar", methods=["POST"])
def conversor_clientes_transformar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    acao = body.get("acao")
    params = body.get("params") or {}
    indices_alvo = body.get("indices")  # lista de int, ou None/omitido = todas as linhas

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]
    alterados = set()
    extra = {}

    if acao == "limpar_documentos":
        for r in alvo:
            anterior = r["dados"].get("cpf_cnpj", "")
            novo = conversor_clientes.limpar_cpf_cnpj(anterior)
            if novo != anterior:
                r["dados"]["cpf_cnpj"] = novo
                alterados.add(r["indice"])

    elif acao == "separar_endereco":
        extra = conversor_clientes.separar_endereco(alvo, alterados)

    elif acao == "ajustar_telefones":
        ddd_padrao = "".join(c for c in str(params.get("ddd_padrao") or "55") if c.isdigit()) or "55"
        if len(ddd_padrao) != 2:
            return jsonify(ok=False, error="Informe um DDD padrão com 2 dígitos."), 400
        extra = conversor_clientes.ajustar_telefones(alvo, alterados, ddd_padrao)

    elif acao == "repetir_nome_usuario":
        extra = conversor_clientes.repetir_campo(alvo, alterados, "nome", "nome_usuario")

    elif acao == "repetir_codigo_integracao_pessoa":
        extra = conversor_clientes.repetir_campo(alvo, alterados, "codigo_integracao", "codigo_integracao_pessoa")

    elif acao == "preencher_template_cliente":
        valor = (params.get("valor") or "").strip()
        if not valor:
            return jsonify(ok=False, error="Informe o template do cliente a ser preenchido."), 400
        extra = conversor_clientes.preencher_campo_todas_linhas(alvo, alterados, "template_cliente", valor)

    elif acao == "preencher_perfil_acesso":
        valor = (params.get("valor") or "").strip()
        if not valor:
            return jsonify(ok=False, error="Informe o perfil de acesso a ser preenchido."), 400
        extra = conversor_clientes.preencher_campo_todas_linhas(alvo, alterados, "perfil_acesso", valor)

    elif acao == "gerar_emails":
        dominio = (params.get("dominio") or "").strip()
        if not dominio:
            return jsonify(ok=False, error="Informe o domínio pra gerar os e-mails."), 400
        # "Login" é o campo usado como e-mail de acesso do cliente no manual da
        # SSX (não existe um campo "E-mail" separado) — só preenche quem está
        # vazio, nunca sobrescreve um login real já informado.
        usados = {r["dados"].get("login", "") for r in registros if r["dados"].get("login")}
        for r in alvo:
            if r["dados"].get("login"):
                continue
            novo = conversor_clientes.gerar_email(r["dados"].get("nome", ""), dominio, usados)
            r["dados"]["login"] = novo
            usados.add(novo)
            alterados.add(r["indice"])

    elif acao == "preencher_senhas":
        senha = params.get("senha") or ""
        sobrescrever = bool(params.get("sobrescrever"))
        if not senha:
            return jsonify(ok=False, error="Informe a senha a ser preenchida."), 400
        for r in alvo:
            anterior = r["dados"].get("senha", "")
            novo = conversor_clientes.preencher_senha(anterior, senha, sobrescrever)
            if novo != anterior:
                r["dados"]["senha"] = novo
                alterados.add(r["indice"])

    elif acao == "ajustar_tipo_pessoa":
        extra = conversor_clientes.ajustar_tipo_pessoa(alvo, alterados)

    else:
        return jsonify(ok=False, error="Ação de transformação desconhecida."), 400

    registros_alterados = [r for r in registros if r["indice"] in alterados]
    resposta = dict(ok=True, total_alterados=len(alterados), registros=registros_alterados)
    resposta.update(extra)
    return jsonify(**resposta)


@app.route("/api/conversor-clientes/validar", methods=["POST"])
def conversor_clientes_validar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    por_posicao = conversor_clientes.validar_registros(registros)
    # Duplicidade de Nome/CPF-CNPJ/Login dentro da PRÓPRIA planilha (não
    # contra a SSX — isso é o botão separado "Verificar na SSX") — por_posicao
    # é indexado por posição (erro.linha - 2), essa aqui por "indice" do
    # registro, então mescla na hora de montar a resposta, não dentro de
    # validar_registros.
    por_indice_interna = conversor_clientes.verificar_duplicidade_interna(registros)

    problemas = []
    n_erro = 0
    for pos, registro in enumerate(registros):
        problema = por_posicao.get(pos, {"erros": [], "avisos": []})
        extra = por_indice_interna.get(registro["indice"])
        erros = list(problema["erros"])
        avisos = list(problema["avisos"]) + (extra["avisos"] if extra else [])
        if not erros and not avisos:
            continue
        if erros:
            n_erro += 1
        problemas.append({"indice": registro["indice"], "erros": erros, "avisos": avisos})

    return jsonify(ok=True, total=len(registros), n_ok=len(registros) - n_erro, n_erro=n_erro, problemas=problemas)


# Verificação de duplicidade na SSX (opcional — exige login na própria API,
# diferente de "Validar planilha" acima, que é local/offline): reaproveita
# _token_para/requisicao_padrao/LISTAGENS["clientes"] já usados pela Área de
# Importação e Consulta, então login feito aqui ou lá vale nos dois lugares
# (mesma sessão avulsa). Só clientes ATIVOS entram na comparação — é o único
# filtro de listagem confirmado hoje (ver LISTAGENS["clientes"]).
@app.route("/api/conversor-clientes/verificar-duplicidade", methods=["POST"])
def conversor_clientes_verificar_duplicidade():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indices_alvo = body.get("indices")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]

    config = LISTAGENS["clientes"]
    try:
        clientes_ssx = requisicao_padrao(config["endpoint"], config["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar clientes na SSX: {e}"), 400

    por_indice = conversor_clientes.verificar_duplicidade_ssx(alvo, clientes_ssx)
    problemas = [{"indice": idx, "erros": p["erros"], "avisos": p["avisos"]} for idx, p in por_indice.items()]
    return jsonify(
        ok=True, total_verificados=len(alvo), total_duplicados=len(problemas), problemas=problemas,
    )


# Botão "Templates" (Conversor de Clientes): checklist do que a planilha usa
# de Template de cliente, Unidade organizacional e Perfil de acesso do
# usuário — cadastros que precisam existir na SSX ANTES da importação
# funcionar — com quem já está cadastrado e quem falta. Mesma sessão/token
# de "Verificar na SSX". Mesmo padrão de
# conversor_veiculos_listar_templates_apns.
@app.route("/api/conversor-clientes/listar-templates-perfis", methods=["POST"])
def conversor_clientes_listar_templates_perfis():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    try:
        templates_ssx = requisicao_padrao(LISTAGENS["templates_cliente"]["endpoint"], LISTAGENS["templates_cliente"]["payload"], token)
        uos_ssx = requisicao_padrao(LISTAGENS["uos"]["endpoint"], LISTAGENS["uos"]["payload"], token)
        perfis_ssx = requisicao_padrao(LISTAGENS["perfis_acesso"]["endpoint"], LISTAGENS["perfis_acesso"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    resultado = conversor_clientes.listar_templates_uo_perfis(entry["registros"], templates_ssx, uos_ssx, perfis_ssx)
    return jsonify(ok=True, **resultado)


@app.route("/api/conversor-clientes/exportar/<file_id>/<modo>")
def conversor_clientes_exportar(file_id, modo):
    if modo not in ("todos", "validos"):
        return jsonify(ok=False, error="Modo inválido."), 400

    with CONVERSOR_CLIENTES_LOCK:
        entry = CONVERSOR_CLIENTES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    if modo == "validos":
        por_posicao = conversor_clientes.validar_registros(registros)
        posicoes_com_erro = {pos for pos, p in por_posicao.items() if p["erros"]}
        registros_exportar = [r for i, r in enumerate(registros) if i not in posicoes_com_erro]
    else:
        registros_exportar = registros

    conteudo = conversor_clientes.gerar_arquivo_oficial(registros_exportar).encode("ascii", errors="ignore")
    nome_arquivo = f"{entry['nome_base']}_SSX_Clientes_{modo}.txt"
    return Response(
        conteudo,
        mimetype="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{nome_arquivo}"'},
    )


# --- CONVERSOR DE PLANILHA DE VEÍCULOS (importação para a SSX) ---
# Mesmo fluxo e mesmo molde do bloco "CONVERSOR DE PLANILHA DE CLIENTES"
# acima (upload -> mapear colunas -> editar/transformar -> validar ->
# exportar), reaproveitando validador_importacao/ (TIPO_VEICULO) como única
# fonte de verdade das regras (ver conversor_veiculos.py). Não chama a API da
# SSX nem grava nada — só lê o arquivo enviado e devolve planilha/arquivo pra
# download, por isso roda síncrono, igual o Conversor de Clientes.
CONVERSOR_VEICULOS_UPLOADS = {}
CONVERSOR_VEICULOS_LOCK = threading.Lock()

# Campos liberados pra "preencher pra todas as linhas" (ícone/cor do mapa —
# a frota inteira costuma usar o mesmo). Checado no servidor pra não aceitar
# um "campo" qualquer vindo do corpo da requisição.
CONVERSOR_VEICULOS_CAMPOS_PREENCHIVEIS = {"icone_mapa", "cor_icone_mapa"}
# Pares liberados pra "repetir campo" — mesma ideia (lista fechada em vez de
# aceitar origem/destino livres do corpo da requisição).
CONVERSOR_VEICULOS_PARES_REPETIVEIS = {
    ("codigo_integracao_veiculo", "veiculo_cliente"),
    ("placa", "identificacao"),
    ("placa", "codigo_integracao_veiculo"),
    ("rastreador1_identificacao", "rastreador1_codigo_integracao"),
}


@app.route("/api/conversor-veiculos/campos")
def conversor_veiculos_campos():
    campos = []
    for campo in conversor_veiculos.CAMPOS_VEICULO:
        obrigatorio = "condicional" if callable(campo.obrigatorio) else bool(campo.obrigatorio)
        campos.append({
            "chave": campo.chave, "rotulo": campo.rotulo, "obrigatorio": obrigatorio,
            "tipo": campo.tipo, "tamanho_max": campo.tamanho_max,
        })
    return jsonify(ok=True, campos=campos)


@app.route("/api/conversor-veiculos/upload", methods=["POST"])
def conversor_veiculos_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]
    try:
        df = _ler_planilha_validador(arquivo)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler o arquivo: {e}"), 400
    if df.empty:
        return jsonify(ok=False, error="A planilha está vazia."), 400

    file_id = uuid.uuid4().hex
    nome_base = os.path.splitext(arquivo.filename or "veiculos")[0]
    with CONVERSOR_VEICULOS_LOCK:
        CONVERSOR_VEICULOS_UPLOADS[file_id] = {"df": df, "nome_base": nome_base, "registros": None}
    return jsonify(ok=True, file_id=file_id, colunas=list(df.columns), total_linhas=len(df))


@app.route("/api/conversor-veiculos/mapear", methods=["POST"])
def conversor_veiculos_mapear():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    mapping = body.get("mapping") or {}  # {chave_destino: coluna_origem}

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
    if entry is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna antes de continuar."), 400

    df = entry["df"]
    colunas_validas = set(df.columns)
    mapping_valido = {chave: col for chave, col in mapping.items() if col in colunas_validas}

    registros = []
    for pos, row in enumerate(df.itertuples(index=False), start=1):
        row_dict = dict(zip(df.columns, row))
        dados = {}
        for chave, col in mapping_valido.items():
            valor = row_dict.get(col)
            dados[chave] = "" if (valor is None or str(valor).strip().lower() == "nan") else str(valor).strip()
        registros.append({"indice": pos, "original": dict(dados), "dados": dict(dados)})

    with CONVERSOR_VEICULOS_LOCK:
        entry["registros"] = registros

    return jsonify(ok=True, total=len(registros), registros=registros)


@app.route("/api/conversor-veiculos/usar-como-upload", methods=["POST"])
def conversor_veiculos_usar_como_upload():
    """Transforma os registros JÁ carregados/editados no Conversor de
    Veículos num "upload" do modal de importação genérico (UPLOADS, o mesmo
    dict usado por /api/import/upload) — pro botão "Importar via API" não
    obrigar a pessoa a exportar e re-enviar o arquivo que ela já tem na tela.
    Mesmo padrão de conversor_clientes_usar_como_upload (ver esse pro
    contexto completo)."""
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Carregue e mapeie uma planilha no Conversor de Veículos antes."), 400

    registros = entry["registros"]
    rotulo_por_chave = {c.chave: c.rotulo for c in conversor_veiculos.CAMPOS_VEICULO}
    chaves = list(registros[0]["dados"].keys())
    colunas = [rotulo_por_chave.get(chave, chave) for chave in chaves]

    linhas = [
        {rotulo_por_chave.get(chave, chave): r["dados"].get(chave, "") for chave in chaves}
        for r in registros
    ]
    df = pd.DataFrame(linhas, columns=colunas, dtype=str)

    novo_file_id = uuid.uuid4().hex
    with UPLOADS_LOCK:
        UPLOADS[novo_file_id] = df

    mapeamento_sugerido = {}
    for chave in chaves:
        campo_api = CONVERSOR_VEICULOS_PARA_API.get(chave)
        if campo_api:
            mapeamento_sugerido[campo_api] = rotulo_por_chave.get(chave, chave)

    return jsonify(
        ok=True, file_id=novo_file_id, colunas=colunas, total_linhas=len(df),
        mapeamento_sugerido=mapeamento_sugerido,
    )


@app.route("/api/conversor-veiculos/editar", methods=["POST"])
def conversor_veiculos_editar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")
    campo = body.get("campo")
    valor = body.get("valor", "")

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
    campos_validos = {c.chave for c in conversor_veiculos.CAMPOS_VEICULO}
    if campo not in campos_validos:
        return jsonify(ok=False, error="Campo desconhecido."), 400

    registro = next((r for r in entry["registros"] if r["indice"] == indice), None)
    if registro is None:
        return jsonify(ok=False, error="Registro não encontrado."), 404
    registro["dados"][campo] = str(valor).strip()
    return jsonify(ok=True)


@app.route("/api/conversor-veiculos/excluir-linha", methods=["POST"])
def conversor_veiculos_excluir_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
        if entry is None or not entry.get("registros"):
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if r["indice"] != indice]
        if len(entry["registros"]) == tamanho_antes:
            return jsonify(ok=False, error="Linha não encontrada."), 404
    return jsonify(ok=True)


@app.route("/api/conversor-veiculos/adicionar-linha", methods=["POST"])
def conversor_veiculos_adicionar_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        proximo_indice = max((r["indice"] for r in registros), default=0) + 1
        chaves = list(registros[0]["dados"].keys()) if registros else [c.chave for c in conversor_veiculos.CAMPOS_VEICULO]
        dados_vazios = {chave: "" for chave in chaves}
        novo = {"indice": proximo_indice, "original": dict(dados_vazios), "dados": dict(dados_vazios)}
        registros.append(novo)
    return jsonify(ok=True, registro=novo)


@app.route("/api/conversor-veiculos/limpar-vazias", methods=["POST"])
def conversor_veiculos_limpar_vazias():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if any((v or "").strip() for v in r["dados"].values())]
        removidos = tamanho_antes - len(entry["registros"])
    return jsonify(ok=True, removidos=removidos)


@app.route("/api/conversor-veiculos/transformar", methods=["POST"])
def conversor_veiculos_transformar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    acao = body.get("acao")
    params = body.get("params") or {}
    indices_alvo = body.get("indices")  # lista de int, ou None/omitido = todas as linhas

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]
    alterados = set()
    extra = {}

    if acao == "limpar_campo":
        campo = params.get("campo")
        if campo not in conversor_veiculos._CAMPOS_ALFANUMERICOS_LIMPAVEIS:
            return jsonify(ok=False, error="Campo inválido para limpeza."), 400
        extra = conversor_veiculos.limpar_campo_alfanumerico(alvo, alterados, campo)

    elif acao == "ajustar_chips":
        ddd_padrao = "".join(c for c in str(params.get("ddd_padrao") or "55") if c.isdigit()) or "55"
        if len(ddd_padrao) != 2:
            return jsonify(ok=False, error="Informe um DDD padrão com 2 dígitos."), 400
        extra = conversor_veiculos.ajustar_chips(alvo, alterados, ddd_padrao)

    elif acao == "repetir_campo":
        origem, destino = params.get("origem"), params.get("destino")
        if (origem, destino) not in CONVERSOR_VEICULOS_PARES_REPETIVEIS:
            return jsonify(ok=False, error="Par de campos inválido para repetição."), 400
        extra = conversor_veiculos.repetir_campo(alvo, alterados, origem, destino)

    elif acao == "preencher_campo":
        campo = params.get("campo")
        valor = (params.get("valor") or "").strip()
        if campo not in CONVERSOR_VEICULOS_CAMPOS_PREENCHIVEIS:
            return jsonify(ok=False, error="Campo inválido para preenchimento em massa."), 400
        if not valor:
            return jsonify(ok=False, error="Informe o valor a ser preenchido."), 400
        extra = conversor_veiculos.preencher_campo_todas_linhas(alvo, alterados, campo, valor)

    elif acao == "preencher_status":
        # Sem nenhum campo marcado, preenche os 4 com "0" — ver
        # conversor_veiculos.preencher_status_mapa (lista vazia não é erro,
        # só significa "nenhum marcado", e o próprio helper cobre esse caso).
        campos = params.get("campos") or []
        campos_validos = [c for c in campos if c in conversor_veiculos.CAMPOS_STATUS_MAPA]
        extra = conversor_veiculos.preencher_status_mapa(alvo, alterados, campos_validos)

    elif acao == "aplicar_gt06":
        templates = [t for t in (params.get("templates") or []) if isinstance(t, str) and t.strip()]
        if not templates:
            return jsonify(ok=False, error="Selecione ao menos um template antes de aplicar o padrão GT06."), 400
        extra = conversor_veiculos.aplicar_padrao_gt06(alvo, alterados, templates)

    elif acao == "limpar_gt06":
        # Lista vazia = TODOS os templates (ver limpar_padrao_gt06) — a
        # confirmação pra esse caso já acontece no front antes de chamar
        # esta rota, não bloqueia aqui.
        templates = [t for t in (params.get("templates") or []) if isinstance(t, str) and t.strip()]
        extra = conversor_veiculos.limpar_padrao_gt06(alvo, alterados, templates)

    else:
        return jsonify(ok=False, error="Ação de transformação desconhecida."), 400

    registros_alterados = [r for r in registros if r["indice"] in alterados]
    resposta = dict(ok=True, total_alterados=len(alterados), registros=registros_alterados)
    resposta.update(extra)
    return jsonify(**resposta)


@app.route("/api/conversor-veiculos/validar", methods=["POST"])
def conversor_veiculos_validar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    por_posicao = conversor_veiculos.validar_registros(registros)
    por_indice_interna = conversor_veiculos.verificar_duplicidade_interna(registros)

    problemas = []
    n_erro = 0
    for pos, registro in enumerate(registros):
        problema = por_posicao.get(pos, {"erros": [], "avisos": []})
        extra = por_indice_interna.get(registro["indice"])
        erros = list(problema["erros"])
        avisos = list(problema["avisos"]) + (extra["avisos"] if extra else [])
        if not erros and not avisos:
            continue
        if erros:
            n_erro += 1
        problemas.append({"indice": registro["indice"], "erros": erros, "avisos": avisos})

    return jsonify(ok=True, total=len(registros), n_ok=len(registros) - n_erro, n_erro=n_erro, problemas=problemas)


# Verificação na SSX (opcional — exige login na própria API): duas checagens
# na mesma sessão/token — mesmo padrão de
# conversor_clientes_verificar_duplicidade (ver esse pro contexto completo).
# 1) Duplicidade (verificar_duplicidade_ssx): código/placa que NÃO deveriam
#    já existir. 2) Referências (verificar_referencias_ssx): cliente,
#    template de rastreador, APN e responsável que DEVERIAM já existir —
#    senão a SSX rejeita a linha na importação de verdade.
@app.route("/api/conversor-veiculos/verificar-duplicidade", methods=["POST"])
def conversor_veiculos_verificar_duplicidade():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indices_alvo = body.get("indices")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]

    try:
        veiculos_ssx = requisicao_padrao(LISTAGENS["veiculos"]["endpoint"], LISTAGENS["veiculos"]["payload"], token)
        clientes_ssx = requisicao_padrao(LISTAGENS["clientes"]["endpoint"], LISTAGENS["clientes"]["payload"], token)
        templates_ssx = requisicao_padrao(LISTAGENS["templates_rastreador"]["endpoint"], LISTAGENS["templates_rastreador"]["payload"], token)
        simcards_ssx = requisicao_padrao(LISTAGENS["simcards"]["endpoint"], LISTAGENS["simcards"]["payload"], token)
        pessoas_ssx = requisicao_padrao(LISTAGENS["pessoas"]["endpoint"], LISTAGENS["pessoas"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    por_indice_dup = conversor_veiculos.verificar_duplicidade_ssx(alvo, veiculos_ssx)
    por_indice_ref = conversor_veiculos.verificar_referencias_ssx(alvo, clientes_ssx, templates_ssx, simcards_ssx, pessoas_ssx)

    por_indice = {}
    for origem in (por_indice_dup, por_indice_ref):
        for idx, p in origem.items():
            entrada = por_indice.setdefault(idx, {"erros": [], "avisos": []})
            entrada["erros"].extend(p["erros"])
            entrada["avisos"].extend(p["avisos"])

    problemas = [{"indice": idx, "erros": p["erros"], "avisos": p["avisos"]} for idx, p in por_indice.items()]
    return jsonify(
        ok=True, total_verificados=len(alvo), total_duplicados=len(problemas), problemas=problemas,
    )


# Botão "Templates": checklist do que a planilha usa de Template de
# rastreador/APN — os 2 cadastros que precisam existir na SSX ANTES da
# importação funcionar — com quem já está cadastrado e quem falta. Mesma
# sessão/token de "Verificar na SSX", mas não roda a checagem pesada de
# duplicidade/referência linha a linha, só compara as listas distintas.
@app.route("/api/conversor-veiculos/listar-templates-apns", methods=["POST"])
def conversor_veiculos_listar_templates_apns():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    try:
        templates_ssx = requisicao_padrao(LISTAGENS["templates_rastreador"]["endpoint"], LISTAGENS["templates_rastreador"]["payload"], token)
        simcards_ssx = requisicao_padrao(LISTAGENS["simcards"]["endpoint"], LISTAGENS["simcards"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    resultado = conversor_veiculos.listar_templates_e_apns(entry["registros"], templates_ssx, simcards_ssx)
    return jsonify(ok=True, **resultado)


@app.route("/api/conversor-veiculos/exportar/<file_id>/<modo>")
def conversor_veiculos_exportar(file_id, modo):
    if modo not in ("todos", "validos"):
        return jsonify(ok=False, error="Modo inválido."), 400

    with CONVERSOR_VEICULOS_LOCK:
        entry = CONVERSOR_VEICULOS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    if modo == "validos":
        por_posicao = conversor_veiculos.validar_registros(registros)
        posicoes_com_erro = {pos for pos, p in por_posicao.items() if p["erros"]}
        registros_exportar = [r for i, r in enumerate(registros) if i not in posicoes_com_erro]
    else:
        registros_exportar = registros

    conteudo = conversor_veiculos.gerar_arquivo_oficial(registros_exportar).encode("ascii", errors="ignore")
    nome_arquivo = f"{entry['nome_base']}_SSX_Veiculos_{modo}.txt"
    return Response(
        conteudo,
        mimetype="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{nome_arquivo}"'},
    )


# --- CONVERSOR DE PLANILHA DE RASTREADORES (importação para a SSX) ---
# Mesmo fluxo e mesmo molde do bloco "CONVERSOR DE PLANILHA DE VEÍCULOS"
# acima (upload -> mapear colunas -> editar/transformar -> validar ->
# exportar), reaproveitando validador_importacao/ (TIPO_RASTREADOR) como
# única fonte de verdade das regras (ver conversor_rastreadores.py).
CONVERSOR_RASTREADORES_UPLOADS = {}
CONVERSOR_RASTREADORES_LOCK = threading.Lock()

# Campos liberados pra "preencher pra todas as linhas" (Template/Status/
# Cliente — uma leva de rastreadores importada de uma vez costuma usar o
# mesmo template e pertencer ao mesmo cliente). Checado no servidor pra não
# aceitar um "campo" qualquer vindo do corpo da requisição.
CONVERSOR_RASTREADORES_CAMPOS_PREENCHIVEIS = {"template", "status", "codigo_integracao_cliente"}
# Pares liberados pra "repetir campo" — mesma ideia (lista fechada em vez de
# aceitar origem/destino livres do corpo da requisição).
CONVERSOR_RASTREADORES_PARES_REPETIVEIS = {
    ("identificacao", "codigo_integracao"),
}


@app.route("/api/conversor-rastreadores/campos")
def conversor_rastreadores_campos():
    campos = []
    for campo in conversor_rastreadores.CAMPOS_RASTREADOR:
        obrigatorio = "condicional" if callable(campo.obrigatorio) else bool(campo.obrigatorio)
        campos.append({
            "chave": campo.chave, "rotulo": campo.rotulo, "obrigatorio": obrigatorio,
            "tipo": campo.tipo, "tamanho_max": campo.tamanho_max,
        })
    return jsonify(ok=True, campos=campos)


@app.route("/api/conversor-rastreadores/upload", methods=["POST"])
def conversor_rastreadores_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]
    try:
        df = _ler_planilha_validador(arquivo)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler o arquivo: {e}"), 400
    if df.empty:
        return jsonify(ok=False, error="A planilha está vazia."), 400

    file_id = uuid.uuid4().hex
    nome_base = os.path.splitext(arquivo.filename or "rastreadores")[0]
    with CONVERSOR_RASTREADORES_LOCK:
        CONVERSOR_RASTREADORES_UPLOADS[file_id] = {"df": df, "nome_base": nome_base, "registros": None}
    return jsonify(ok=True, file_id=file_id, colunas=list(df.columns), total_linhas=len(df))


@app.route("/api/conversor-rastreadores/mapear", methods=["POST"])
def conversor_rastreadores_mapear():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    mapping = body.get("mapping") or {}  # {chave_destino: coluna_origem}

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
    if entry is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna antes de continuar."), 400

    df = entry["df"]
    colunas_validas = set(df.columns)
    mapping_valido = {chave: col for chave, col in mapping.items() if col in colunas_validas}

    registros = []
    for pos, row in enumerate(df.itertuples(index=False), start=1):
        row_dict = dict(zip(df.columns, row))
        dados = {}
        for chave, col in mapping_valido.items():
            valor = row_dict.get(col)
            dados[chave] = "" if (valor is None or str(valor).strip().lower() == "nan") else str(valor).strip()
        registros.append({"indice": pos, "original": dict(dados), "dados": dict(dados)})

    with CONVERSOR_RASTREADORES_LOCK:
        entry["registros"] = registros

    return jsonify(ok=True, total=len(registros), registros=registros)


@app.route("/api/conversor-rastreadores/usar-como-upload", methods=["POST"])
def conversor_rastreadores_usar_como_upload():
    """Transforma os registros JÁ carregados/editados no Conversor de
    Rastreadores num "upload" do modal de importação genérico (UPLOADS, o
    mesmo dict usado por /api/import/upload) — pro botão "Importar via API"
    não obrigar a pessoa a exportar e re-enviar o arquivo que ela já tem na
    tela. Mesmo padrão de conversor_veiculos_usar_como_upload."""
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Carregue e mapeie uma planilha no Conversor de Rastreadores antes."), 400

    registros = entry["registros"]
    rotulo_por_chave = {c.chave: c.rotulo for c in conversor_rastreadores.CAMPOS_RASTREADOR}
    chaves = list(registros[0]["dados"].keys())
    colunas = [rotulo_por_chave.get(chave, chave) for chave in chaves]

    linhas = [
        {rotulo_por_chave.get(chave, chave): r["dados"].get(chave, "") for chave in chaves}
        for r in registros
    ]
    df = pd.DataFrame(linhas, columns=colunas, dtype=str)

    novo_file_id = uuid.uuid4().hex
    with UPLOADS_LOCK:
        UPLOADS[novo_file_id] = df

    mapeamento_sugerido = {}
    for chave in chaves:
        campo_api = CONVERSOR_RASTREADORES_PARA_API.get(chave)
        if campo_api:
            mapeamento_sugerido[campo_api] = rotulo_por_chave.get(chave, chave)

    return jsonify(
        ok=True, file_id=novo_file_id, colunas=colunas, total_linhas=len(df),
        mapeamento_sugerido=mapeamento_sugerido,
    )


@app.route("/api/conversor-rastreadores/editar", methods=["POST"])
def conversor_rastreadores_editar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")
    campo = body.get("campo")
    valor = body.get("valor", "")

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
    campos_validos = {c.chave for c in conversor_rastreadores.CAMPOS_RASTREADOR}
    if campo not in campos_validos:
        return jsonify(ok=False, error="Campo desconhecido."), 400

    registro = next((r for r in entry["registros"] if r["indice"] == indice), None)
    if registro is None:
        return jsonify(ok=False, error="Registro não encontrado."), 404
    registro["dados"][campo] = str(valor).strip()
    return jsonify(ok=True)


@app.route("/api/conversor-rastreadores/excluir-linha", methods=["POST"])
def conversor_rastreadores_excluir_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
        if entry is None or not entry.get("registros"):
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if r["indice"] != indice]
        if len(entry["registros"]) == tamanho_antes:
            return jsonify(ok=False, error="Linha não encontrada."), 404
    return jsonify(ok=True)


@app.route("/api/conversor-rastreadores/adicionar-linha", methods=["POST"])
def conversor_rastreadores_adicionar_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        proximo_indice = max((r["indice"] for r in registros), default=0) + 1
        chaves = list(registros[0]["dados"].keys()) if registros else [c.chave for c in conversor_rastreadores.CAMPOS_RASTREADOR]
        dados_vazios = {chave: "" for chave in chaves}
        novo = {"indice": proximo_indice, "original": dict(dados_vazios), "dados": dict(dados_vazios)}
        registros.append(novo)
    return jsonify(ok=True, registro=novo)


@app.route("/api/conversor-rastreadores/limpar-vazias", methods=["POST"])
def conversor_rastreadores_limpar_vazias():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if any((v or "").strip() for v in r["dados"].values())]
        removidos = tamanho_antes - len(entry["registros"])
    return jsonify(ok=True, removidos=removidos)


@app.route("/api/conversor-rastreadores/transformar", methods=["POST"])
def conversor_rastreadores_transformar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    acao = body.get("acao")
    params = body.get("params") or {}
    indices_alvo = body.get("indices")  # lista de int, ou None/omitido = todas as linhas

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]
    alterados = set()
    extra = {}

    if acao == "limpar_campo":
        campo = params.get("campo")
        if campo not in conversor_rastreadores._CAMPOS_NUMERICOS_LIMPAVEIS:
            return jsonify(ok=False, error="Campo inválido para limpeza."), 400
        extra = conversor_rastreadores.limpar_campo_numerico(alvo, alterados, campo)

    elif acao == "repetir_campo":
        origem, destino = params.get("origem"), params.get("destino")
        if (origem, destino) not in CONVERSOR_RASTREADORES_PARES_REPETIVEIS:
            return jsonify(ok=False, error="Par de campos inválido para repetição."), 400
        extra = conversor_rastreadores.repetir_campo(alvo, alterados, origem, destino)

    elif acao == "preencher_campo":
        campo = params.get("campo")
        valor = (params.get("valor") or "").strip()
        if campo not in CONVERSOR_RASTREADORES_CAMPOS_PREENCHIVEIS:
            return jsonify(ok=False, error="Campo inválido para preenchimento em massa."), 400
        if not valor:
            return jsonify(ok=False, error="Informe o valor a ser preenchido."), 400
        extra = conversor_rastreadores.preencher_campo_todas_linhas(alvo, alterados, campo, valor)

    elif acao == "aplicar_gt06":
        templates = [t for t in (params.get("templates") or []) if isinstance(t, str) and t.strip()]
        if not templates:
            return jsonify(ok=False, error="Selecione ao menos um template antes de aplicar o padrão GT06."), 400
        extra = conversor_rastreadores.aplicar_padrao_gt06(alvo, alterados, templates)

    elif acao == "limpar_gt06":
        # Lista vazia = TODOS os templates (ver limpar_padrao_gt06) — a
        # confirmação pra esse caso já acontece no front antes de chamar
        # esta rota, não bloqueia aqui.
        templates = [t for t in (params.get("templates") or []) if isinstance(t, str) and t.strip()]
        extra = conversor_rastreadores.limpar_padrao_gt06(alvo, alterados, templates)

    else:
        return jsonify(ok=False, error="Ação de transformação desconhecida."), 400

    registros_alterados = [r for r in registros if r["indice"] in alterados]
    resposta = dict(ok=True, total_alterados=len(alterados), registros=registros_alterados)
    resposta.update(extra)
    return jsonify(**resposta)


@app.route("/api/conversor-rastreadores/validar", methods=["POST"])
def conversor_rastreadores_validar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    por_posicao = conversor_rastreadores.validar_registros(registros)
    por_indice_interna = conversor_rastreadores.verificar_duplicidade_interna(registros)

    problemas = []
    n_erro = 0
    for pos, registro in enumerate(registros):
        problema = por_posicao.get(pos, {"erros": [], "avisos": []})
        extra = por_indice_interna.get(registro["indice"])
        erros = list(problema["erros"])
        avisos = list(problema["avisos"]) + (extra["avisos"] if extra else [])
        if not erros and not avisos:
            continue
        if erros:
            n_erro += 1
        problemas.append({"indice": registro["indice"], "erros": erros, "avisos": avisos})

    return jsonify(ok=True, total=len(registros), n_ok=len(registros) - n_erro, n_erro=n_erro, problemas=problemas)


# Verificação na SSX (opcional — exige login na própria API): duas checagens
# na mesma sessão/token — mesmo padrão de
# conversor_veiculos_verificar_duplicidade. 1) Duplicidade
# (verificar_duplicidade_ssx): código/identificação que NÃO deveriam já
# existir. 2) Referências (verificar_referencias_ssx): template, status,
# cliente e os dois ICCID que DEVERIAM já existir — senão a SSX rejeita a
# linha na importação de verdade.
@app.route("/api/conversor-rastreadores/verificar-duplicidade", methods=["POST"])
def conversor_rastreadores_verificar_duplicidade():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indices_alvo = body.get("indices")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]

    try:
        rastreadores_ssx = requisicao_padrao(LISTAGENS["rastreadores"]["endpoint"], LISTAGENS["rastreadores"]["payload"], token)
        templates_ssx = requisicao_padrao(LISTAGENS["templates_rastreador"]["endpoint"], LISTAGENS["templates_rastreador"]["payload"], token)
        status_ssx = requisicao_padrao(LISTAGENS["status_rastreador"]["endpoint"], LISTAGENS["status_rastreador"]["payload"], token)
        clientes_ssx = requisicao_padrao(LISTAGENS["clientes"]["endpoint"], LISTAGENS["clientes"]["payload"], token)
        simcards_ssx = requisicao_padrao(LISTAGENS["simcards"]["endpoint"], LISTAGENS["simcards"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    por_indice_dup = conversor_rastreadores.verificar_duplicidade_ssx(alvo, rastreadores_ssx)
    por_indice_ref = conversor_rastreadores.verificar_referencias_ssx(alvo, templates_ssx, status_ssx, clientes_ssx, simcards_ssx)

    por_indice = {}
    for origem in (por_indice_dup, por_indice_ref):
        for idx, p in origem.items():
            entrada = por_indice.setdefault(idx, {"erros": [], "avisos": []})
            entrada["erros"].extend(p["erros"])
            entrada["avisos"].extend(p["avisos"])

    problemas = [{"indice": idx, "erros": p["erros"], "avisos": p["avisos"]} for idx, p in por_indice.items()]
    return jsonify(
        ok=True, total_verificados=len(alvo), total_duplicados=len(problemas), problemas=problemas,
    )


# Botão "Templates": checklist do que a planilha usa de Template/Status de
# rastreador — os 2 cadastros que precisam existir na SSX ANTES da
# importação funcionar — com quem já está cadastrado e quem falta. Mesma
# sessão/token de "Verificar na SSX", mas não roda a checagem pesada de
# duplicidade/referência linha a linha, só compara as listas distintas.
@app.route("/api/conversor-rastreadores/listar-templates-status", methods=["POST"])
def conversor_rastreadores_listar_templates_status():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    try:
        templates_ssx = requisicao_padrao(LISTAGENS["templates_rastreador"]["endpoint"], LISTAGENS["templates_rastreador"]["payload"], token)
        status_ssx = requisicao_padrao(LISTAGENS["status_rastreador"]["endpoint"], LISTAGENS["status_rastreador"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    resultado = conversor_rastreadores.listar_templates_e_status(entry["registros"], templates_ssx, status_ssx)
    return jsonify(ok=True, **resultado)


@app.route("/api/conversor-rastreadores/exportar/<file_id>/<modo>")
def conversor_rastreadores_exportar(file_id, modo):
    if modo not in ("todos", "validos"):
        return jsonify(ok=False, error="Modo inválido."), 400

    with CONVERSOR_RASTREADORES_LOCK:
        entry = CONVERSOR_RASTREADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    if modo == "validos":
        por_posicao = conversor_rastreadores.validar_registros(registros)
        posicoes_com_erro = {pos for pos, p in por_posicao.items() if p["erros"]}
        registros_exportar = [r for i, r in enumerate(registros) if i not in posicoes_com_erro]
    else:
        registros_exportar = registros

    conteudo = conversor_rastreadores.gerar_arquivo_oficial(registros_exportar).encode("ascii", errors="ignore")
    nome_arquivo = f"{entry['nome_base']}_SSX_Rastreadores_{modo}.txt"
    return Response(
        conteudo,
        mimetype="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{nome_arquivo}"'},
    )


# --- CONVERSOR DE PLANILHA DE SIM CARDS (importação para a SSX) ---
# Mesmo fluxo e mesmo molde dos blocos acima, reaproveitando
# validador_importacao/ (TIPO_SIMCARD) como única fonte de verdade das
# regras (ver conversor_simcards.py). Domínio sem nenhum campo de
# "referência que deveria já existir" (ver conversor_simcards.py) — por
# isso não tem rota de "listar-templates" nem /verificar-duplicidade faz
# duas checagens, só uma (duplicidade de ICCID).
CONVERSOR_SIMCARDS_UPLOADS = {}
CONVERSOR_SIMCARDS_LOCK = threading.Lock()

# Campos liberados pra "preencher pra todas as linhas" (Domínio da APN/Dia
# de corte — uma leva de chips importada de uma vez costuma ser do mesmo
# plano/operadora). Checado no servidor pra não aceitar um "campo" qualquer
# vindo do corpo da requisição.
CONVERSOR_SIMCARDS_CAMPOS_PREENCHIVEIS = {"apn_dominio", "dia_corte"}


@app.route("/api/conversor-simcards/campos")
def conversor_simcards_campos():
    campos = []
    for campo in conversor_simcards.CAMPOS_SIMCARD:
        obrigatorio = "condicional" if callable(campo.obrigatorio) else bool(campo.obrigatorio)
        campos.append({
            "chave": campo.chave, "rotulo": campo.rotulo, "obrigatorio": obrigatorio,
            "tipo": campo.tipo, "tamanho_max": campo.tamanho_max,
        })
    return jsonify(ok=True, campos=campos)


@app.route("/api/conversor-simcards/upload", methods=["POST"])
def conversor_simcards_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]
    try:
        df = _ler_planilha_validador(arquivo)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler o arquivo: {e}"), 400
    if df.empty:
        return jsonify(ok=False, error="A planilha está vazia."), 400

    file_id = uuid.uuid4().hex
    nome_base = os.path.splitext(arquivo.filename or "simcards")[0]
    with CONVERSOR_SIMCARDS_LOCK:
        CONVERSOR_SIMCARDS_UPLOADS[file_id] = {"df": df, "nome_base": nome_base, "registros": None}
    return jsonify(ok=True, file_id=file_id, colunas=list(df.columns), total_linhas=len(df))


@app.route("/api/conversor-simcards/mapear", methods=["POST"])
def conversor_simcards_mapear():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    mapping = body.get("mapping") or {}  # {chave_destino: coluna_origem}

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
    if entry is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna antes de continuar."), 400

    df = entry["df"]
    colunas_validas = set(df.columns)
    mapping_valido = {chave: col for chave, col in mapping.items() if col in colunas_validas}

    registros = []
    for pos, row in enumerate(df.itertuples(index=False), start=1):
        row_dict = dict(zip(df.columns, row))
        dados = {}
        for chave, col in mapping_valido.items():
            valor = row_dict.get(col)
            dados[chave] = "" if (valor is None or str(valor).strip().lower() == "nan") else str(valor).strip()
        registros.append({"indice": pos, "original": dict(dados), "dados": dict(dados)})

    with CONVERSOR_SIMCARDS_LOCK:
        entry["registros"] = registros

    return jsonify(ok=True, total=len(registros), registros=registros)


@app.route("/api/conversor-simcards/usar-como-upload", methods=["POST"])
def conversor_simcards_usar_como_upload():
    """Transforma os registros JÁ carregados/editados no Conversor de SIM
    Cards num "upload" do modal de importação genérico (UPLOADS, o mesmo
    dict usado por /api/import/upload) — pro botão "Importar via API" não
    obrigar a pessoa a exportar e re-enviar o arquivo que ela já tem na
    tela. Mesmo padrão de conversor_veiculos_usar_como_upload."""
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Carregue e mapeie uma planilha no Conversor de SIM Cards antes."), 400

    registros = entry["registros"]
    rotulo_por_chave = {c.chave: c.rotulo for c in conversor_simcards.CAMPOS_SIMCARD}
    chaves = list(registros[0]["dados"].keys())
    colunas = [rotulo_por_chave.get(chave, chave) for chave in chaves]

    linhas = [
        {rotulo_por_chave.get(chave, chave): r["dados"].get(chave, "") for chave in chaves}
        for r in registros
    ]
    df = pd.DataFrame(linhas, columns=colunas, dtype=str)

    novo_file_id = uuid.uuid4().hex
    with UPLOADS_LOCK:
        UPLOADS[novo_file_id] = df

    mapeamento_sugerido = {}
    for chave in chaves:
        campo_api = CONVERSOR_SIMCARDS_PARA_API.get(chave)
        if campo_api:
            mapeamento_sugerido[campo_api] = rotulo_por_chave.get(chave, chave)

    return jsonify(
        ok=True, file_id=novo_file_id, colunas=colunas, total_linhas=len(df),
        mapeamento_sugerido=mapeamento_sugerido,
    )


@app.route("/api/conversor-simcards/editar", methods=["POST"])
def conversor_simcards_editar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")
    campo = body.get("campo")
    valor = body.get("valor", "")

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
    campos_validos = {c.chave for c in conversor_simcards.CAMPOS_SIMCARD}
    if campo not in campos_validos:
        return jsonify(ok=False, error="Campo desconhecido."), 400

    registro = next((r for r in entry["registros"] if r["indice"] == indice), None)
    if registro is None:
        return jsonify(ok=False, error="Registro não encontrado."), 404
    registro["dados"][campo] = str(valor).strip()
    return jsonify(ok=True)


@app.route("/api/conversor-simcards/excluir-linha", methods=["POST"])
def conversor_simcards_excluir_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
        if entry is None or not entry.get("registros"):
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if r["indice"] != indice]
        if len(entry["registros"]) == tamanho_antes:
            return jsonify(ok=False, error="Linha não encontrada."), 404
    return jsonify(ok=True)


@app.route("/api/conversor-simcards/adicionar-linha", methods=["POST"])
def conversor_simcards_adicionar_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        proximo_indice = max((r["indice"] for r in registros), default=0) + 1
        chaves = list(registros[0]["dados"].keys()) if registros else [c.chave for c in conversor_simcards.CAMPOS_SIMCARD]
        dados_vazios = {chave: "" for chave in chaves}
        novo = {"indice": proximo_indice, "original": dict(dados_vazios), "dados": dict(dados_vazios)}
        registros.append(novo)
    return jsonify(ok=True, registro=novo)


@app.route("/api/conversor-simcards/limpar-vazias", methods=["POST"])
def conversor_simcards_limpar_vazias():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if any((v or "").strip() for v in r["dados"].values())]
        removidos = tamanho_antes - len(entry["registros"])
    return jsonify(ok=True, removidos=removidos)


@app.route("/api/conversor-simcards/transformar", methods=["POST"])
def conversor_simcards_transformar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    acao = body.get("acao")
    params = body.get("params") or {}
    indices_alvo = body.get("indices")  # lista de int, ou None/omitido = todas as linhas

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]
    alterados = set()
    extra = {}

    if acao == "limpar_campo":
        campo = params.get("campo")
        if campo != "iccid":
            return jsonify(ok=False, error="Campo inválido para limpeza."), 400
        extra = conversor_simcards.limpar_campo_iccid(alvo, alterados)

    elif acao == "ajustar_telefone":
        ddd_padrao = "".join(c for c in str(params.get("ddd_padrao") or "55") if c.isdigit()) or "55"
        if len(ddd_padrao) != 2:
            return jsonify(ok=False, error="Informe um DDD padrão com 2 dígitos."), 400
        extra = conversor_simcards.ajustar_telefone(alvo, alterados, ddd_padrao)

    elif acao == "preencher_campo":
        campo = params.get("campo")
        valor = (params.get("valor") or "").strip()
        if campo not in CONVERSOR_SIMCARDS_CAMPOS_PREENCHIVEIS:
            return jsonify(ok=False, error="Campo inválido para preenchimento em massa."), 400
        if not valor:
            return jsonify(ok=False, error="Informe o valor a ser preenchido."), 400
        extra = conversor_simcards.preencher_campo_todas_linhas(alvo, alterados, campo, valor)

    else:
        return jsonify(ok=False, error="Ação de transformação desconhecida."), 400

    registros_alterados = [r for r in registros if r["indice"] in alterados]
    resposta = dict(ok=True, total_alterados=len(alterados), registros=registros_alterados)
    resposta.update(extra)
    return jsonify(**resposta)


@app.route("/api/conversor-simcards/validar", methods=["POST"])
def conversor_simcards_validar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    por_posicao = conversor_simcards.validar_registros(registros)
    por_indice_interna = conversor_simcards.verificar_duplicidade_interna(registros)

    problemas = []
    n_erro = 0
    for pos, registro in enumerate(registros):
        problema = por_posicao.get(pos, {"erros": [], "avisos": []})
        extra = por_indice_interna.get(registro["indice"])
        erros = list(problema["erros"])
        avisos = list(problema["avisos"]) + (extra["avisos"] if extra else [])
        if not erros and not avisos:
            continue
        if erros:
            n_erro += 1
        problemas.append({"indice": registro["indice"], "erros": erros, "avisos": avisos})

    return jsonify(ok=True, total=len(registros), n_ok=len(registros) - n_erro, n_erro=n_erro, problemas=problemas)


# Verificação na SSX (opcional — exige login na própria API): só duplicidade
# de ICCID (ver conversor_simcards.py pra por que não tem checagem de
# referências aqui, diferente de Veículo/Rastreador). Mesmo padrão de
# conversor_veiculos_verificar_duplicidade.
@app.route("/api/conversor-simcards/verificar-duplicidade", methods=["POST"])
def conversor_simcards_verificar_duplicidade():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indices_alvo = body.get("indices")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]

    try:
        simcards_ssx = requisicao_padrao(LISTAGENS["simcards"]["endpoint"], LISTAGENS["simcards"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar SIM cards na SSX: {e}"), 400

    por_indice = conversor_simcards.verificar_duplicidade_ssx(alvo, simcards_ssx)
    problemas = [{"indice": idx, "erros": p["erros"], "avisos": p["avisos"]} for idx, p in por_indice.items()]
    return jsonify(
        ok=True, total_verificados=len(alvo), total_duplicados=len(problemas), problemas=problemas,
    )


@app.route("/api/conversor-simcards/exportar/<file_id>/<modo>")
def conversor_simcards_exportar(file_id, modo):
    if modo not in ("todos", "validos"):
        return jsonify(ok=False, error="Modo inválido."), 400

    with CONVERSOR_SIMCARDS_LOCK:
        entry = CONVERSOR_SIMCARDS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    if modo == "validos":
        por_posicao = conversor_simcards.validar_registros(registros)
        posicoes_com_erro = {pos for pos, p in por_posicao.items() if p["erros"]}
        registros_exportar = [r for i, r in enumerate(registros) if i not in posicoes_com_erro]
    else:
        registros_exportar = registros

    conteudo = conversor_simcards.gerar_arquivo_oficial(registros_exportar).encode("ascii", errors="ignore")
    nome_arquivo = f"{entry['nome_base']}_SSX_SimCards_{modo}.txt"
    return Response(
        conteudo,
        mimetype="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{nome_arquivo}"'},
    )


# --- CONVERSOR DE PLANILHA DE ÁREAS (importação para a SSX) ---
# Mesmo fluxo e mesmo molde dos blocos acima, reaproveitando
# validador_importacao/ (TIPO_AREA) como única fonte de verdade das regras
# (ver conversor_areas.py). Caminho "via planilha" — complementa o
# Conversor KML -> SSX (conversorkml.py, 100% client-side), que cobre o
# caminho "via arquivo de mapa"; os dois exportam o mesmo layout de arquivo.
# Sem rota de duplicidade de verdade contra a SSX: não existe
# "Geography/List" no Swagger (só Insert/Update/Delete/ListCategories/
# ListGroups) — só dá pra conferir se Categoria/Grupo já estão cadastrados
# (verificar_referencias_ssx), não se a própria área já existe.
CONVERSOR_AREAS_UPLOADS = {}
CONVERSOR_AREAS_LOCK = threading.Lock()

# Campos liberados pra "preencher pra todas as linhas" (Categoria/Grupo/Cor
# costumam valer o mesmo pra toda uma leva de áreas importada de uma vez).
# Checado no servidor pra não aceitar um "campo" qualquer vindo do corpo da
# requisição.
CONVERSOR_AREAS_CAMPOS_PREENCHIVEIS = {"categoria", "grupo", "cor", "tolerancia"}


@app.route("/api/conversor-areas/campos")
def conversor_areas_campos():
    campos = []
    for campo in conversor_areas.CAMPOS_AREA:
        obrigatorio = "condicional" if callable(campo.obrigatorio) else bool(campo.obrigatorio)
        campos.append({
            "chave": campo.chave, "rotulo": campo.rotulo, "obrigatorio": obrigatorio,
            "tipo": campo.tipo, "tamanho_max": campo.tamanho_max,
        })
    return jsonify(ok=True, campos=campos)


@app.route("/api/conversor-areas/upload", methods=["POST"])
def conversor_areas_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]
    try:
        df = _ler_planilha_validador(arquivo)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler o arquivo: {e}"), 400
    if df.empty:
        return jsonify(ok=False, error="A planilha está vazia."), 400

    file_id = uuid.uuid4().hex
    nome_base = os.path.splitext(arquivo.filename or "areas")[0]
    with CONVERSOR_AREAS_LOCK:
        CONVERSOR_AREAS_UPLOADS[file_id] = {"df": df, "nome_base": nome_base, "registros": None}
    return jsonify(ok=True, file_id=file_id, colunas=list(df.columns), total_linhas=len(df))


@app.route("/api/conversor-areas/mapear", methods=["POST"])
def conversor_areas_mapear():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    mapping = body.get("mapping") or {}  # {chave_destino: coluna_origem}

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
    if entry is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna antes de continuar."), 400

    df = entry["df"]
    colunas_validas = set(df.columns)
    mapping_valido = {chave: col for chave, col in mapping.items() if col in colunas_validas}

    registros = []
    for pos, row in enumerate(df.itertuples(index=False), start=1):
        row_dict = dict(zip(df.columns, row))
        dados = {}
        for chave, col in mapping_valido.items():
            valor = row_dict.get(col)
            dados[chave] = "" if (valor is None or str(valor).strip().lower() == "nan") else str(valor).strip()
        registros.append({"indice": pos, "original": dict(dados), "dados": dict(dados)})

    with CONVERSOR_AREAS_LOCK:
        entry["registros"] = registros

    return jsonify(ok=True, total=len(registros), registros=registros)


@app.route("/api/conversor-areas/usar-como-upload", methods=["POST"])
def conversor_areas_usar_como_upload():
    """Transforma os registros JÁ carregados/editados no Conversor de Áreas
    num "upload" do modal de importação genérico (UPLOADS, o mesmo dict
    usado por /api/import/upload) — pro botão "Importar via API" não
    obrigar a pessoa a exportar e re-enviar o arquivo que ela já tem na
    tela. Mesmo padrão de conversor_simcards_usar_como_upload, mais dois
    ajustes só deste domínio: a API (Geography/Insert) espera "Type" como
    código (1/2/3), não o rótulo "Área"/"Rota"/"Ponto" editado na tela; e
    exige "Tolerance" sempre, mesmo quando o manual de arquivo só pede pra
    Ponto — linha sem tolerância preenchida manda 0."""
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Carregue e mapeie uma planilha no Conversor de Áreas antes."), 400

    registros = entry["registros"]
    rotulo_por_chave = {c.chave: c.rotulo for c in conversor_areas.CAMPOS_AREA}
    chaves = list(registros[0]["dados"].keys())
    colunas = [rotulo_por_chave.get(chave, chave) for chave in chaves]

    linhas = []
    for r in registros:
        dados = dict(r["dados"])
        dados["tipo"] = conversor_areas._TIPO_PARA_CODIGO.get(dados.get("tipo", ""), dados.get("tipo", ""))
        if not str(dados.get("tolerancia", "")).strip():
            dados["tolerancia"] = "0"
        linhas.append({rotulo_por_chave.get(chave, chave): dados.get(chave, "") for chave in chaves})
    df = pd.DataFrame(linhas, columns=colunas, dtype=str)

    novo_file_id = uuid.uuid4().hex
    with UPLOADS_LOCK:
        UPLOADS[novo_file_id] = df

    mapeamento_sugerido = {}
    for chave in chaves:
        campo_api = CONVERSOR_AREAS_PARA_API.get(chave)
        if campo_api:
            mapeamento_sugerido[campo_api] = rotulo_por_chave.get(chave, chave)

    return jsonify(
        ok=True, file_id=novo_file_id, colunas=colunas, total_linhas=len(df),
        mapeamento_sugerido=mapeamento_sugerido,
    )


@app.route("/api/conversor-areas/editar", methods=["POST"])
def conversor_areas_editar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")
    campo = body.get("campo")
    valor = body.get("valor", "")

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
    campos_validos = {c.chave for c in conversor_areas.CAMPOS_AREA}
    if campo not in campos_validos:
        return jsonify(ok=False, error="Campo desconhecido."), 400

    registro = next((r for r in entry["registros"] if r["indice"] == indice), None)
    if registro is None:
        return jsonify(ok=False, error="Registro não encontrado."), 404
    registro["dados"][campo] = str(valor).strip()
    return jsonify(ok=True)


@app.route("/api/conversor-areas/excluir-linha", methods=["POST"])
def conversor_areas_excluir_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
        if entry is None or not entry.get("registros"):
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if r["indice"] != indice]
        if len(entry["registros"]) == tamanho_antes:
            return jsonify(ok=False, error="Linha não encontrada."), 404
    return jsonify(ok=True)


@app.route("/api/conversor-areas/adicionar-linha", methods=["POST"])
def conversor_areas_adicionar_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        proximo_indice = max((r["indice"] for r in registros), default=0) + 1
        chaves = list(registros[0]["dados"].keys()) if registros else [c.chave for c in conversor_areas.CAMPOS_AREA]
        dados_vazios = {chave: "" for chave in chaves}
        novo = {"indice": proximo_indice, "original": dict(dados_vazios), "dados": dict(dados_vazios)}
        registros.append(novo)
    return jsonify(ok=True, registro=novo)


@app.route("/api/conversor-areas/limpar-vazias", methods=["POST"])
def conversor_areas_limpar_vazias():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if any((v or "").strip() for v in r["dados"].values())]
        removidos = tamanho_antes - len(entry["registros"])
    return jsonify(ok=True, removidos=removidos)


@app.route("/api/conversor-areas/transformar", methods=["POST"])
def conversor_areas_transformar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    acao = body.get("acao")
    params = body.get("params") or {}
    indices_alvo = body.get("indices")  # lista de int, ou None/omitido = todas as linhas

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]
    alterados = set()
    extra = {}

    if acao == "preencher_campo":
        campo = params.get("campo")
        valor = (params.get("valor") or "").strip()
        if campo not in CONVERSOR_AREAS_CAMPOS_PREENCHIVEIS:
            return jsonify(ok=False, error="Campo inválido para preenchimento em massa."), 400
        # "tolerancia" é o único campo onde valor vazio é uma ação válida
        # (limpa a tolerância de todas as linhas) — pedido explícito da
        # usuária, já que Tolerância deixa de ser obrigatória quando o
        # Tipo muda de Ponto pra Área/Rota. Categoria/Grupo/Cor continuam
        # exigindo valor, pra não disparar uma limpeza em massa por engano.
        if not valor and campo != "tolerancia":
            return jsonify(ok=False, error="Informe o valor a ser preenchido."), 400
        extra = conversor_areas.preencher_campo_todas_linhas(alvo, alterados, campo, valor)

    elif acao == "fechar_anel":
        extra = conversor_areas.fechar_anel(alvo, alterados)

    elif acao == "padronizar_coordenadas":
        extra = conversor_areas.padronizar_coordenadas(alvo, alterados)

    elif acao == "inverter_lat_long":
        extra = conversor_areas.inverter_lat_long(alvo, alterados)

    else:
        return jsonify(ok=False, error="Ação de transformação desconhecida."), 400

    registros_alterados = [r for r in registros if r["indice"] in alterados]
    resposta = dict(ok=True, total_alterados=len(alterados), registros=registros_alterados)
    resposta.update(extra)
    return jsonify(**resposta)


@app.route("/api/conversor-areas/validar", methods=["POST"])
def conversor_areas_validar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    por_posicao = conversor_areas.validar_registros(registros)

    problemas = []
    n_erro = 0
    for pos, registro in enumerate(registros):
        problema = por_posicao.get(pos, {"erros": [], "avisos": []})
        erros = list(problema["erros"])
        avisos = list(problema["avisos"])
        if not erros and not avisos:
            continue
        if erros:
            n_erro += 1
        problemas.append({"indice": registro["indice"], "erros": erros, "avisos": avisos})

    return jsonify(ok=True, total=len(registros), n_ok=len(registros) - n_erro, n_erro=n_erro, problemas=problemas)


# Verificação na SSX (opcional — exige login na própria API): só referências
# de Categoria/Grupo (ver conversor_areas.py pra por que não tem checagem de
# duplicidade aqui — não existe Geography/List no Swagger). Mesmo padrão de
# conversor_rastreadores_verificar_duplicidade.
@app.route("/api/conversor-areas/verificar-duplicidade", methods=["POST"])
def conversor_areas_verificar_duplicidade():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indices_alvo = body.get("indices")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]

    try:
        categorias_ssx = requisicao_padrao(LISTAGENS["categorias_area"]["endpoint"], LISTAGENS["categorias_area"]["payload"], token)
        grupos_ssx = requisicao_padrao(LISTAGENS["grupos_area"]["endpoint"], LISTAGENS["grupos_area"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    por_indice = conversor_areas.verificar_referencias_ssx(alvo, categorias_ssx, grupos_ssx)
    problemas = [{"indice": idx, "erros": p["erros"], "avisos": p["avisos"]} for idx, p in por_indice.items()]
    return jsonify(
        ok=True, total_verificados=len(alvo), total_duplicados=len(problemas), problemas=problemas,
    )


# Botão "Categorias/Grupos": checklist do que a planilha usa — os 2
# cadastros que precisam existir na SSX ANTES da importação funcionar —
# com quem já está cadastrado e quem falta. Mesma sessão/token de
# "Verificar na SSX". Mesmo padrão de
# conversor_rastreadores_listar_templates_status.
@app.route("/api/conversor-areas/listar-categorias-grupos", methods=["POST"])
def conversor_areas_listar_categorias_grupos():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    try:
        categorias_ssx = requisicao_padrao(LISTAGENS["categorias_area"]["endpoint"], LISTAGENS["categorias_area"]["payload"], token)
        grupos_ssx = requisicao_padrao(LISTAGENS["grupos_area"]["endpoint"], LISTAGENS["grupos_area"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    resultado = conversor_areas.listar_categorias_e_grupos(entry["registros"], categorias_ssx, grupos_ssx)
    return jsonify(ok=True, **resultado)


@app.route("/api/conversor-areas/exportar/<file_id>/<modo>")
def conversor_areas_exportar(file_id, modo):
    if modo not in ("todos", "validos"):
        return jsonify(ok=False, error="Modo inválido."), 400

    with CONVERSOR_AREAS_LOCK:
        entry = CONVERSOR_AREAS_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    if modo == "validos":
        por_posicao = conversor_areas.validar_registros(registros)
        posicoes_com_erro = {pos for pos, p in por_posicao.items() if p["erros"]}
        registros_exportar = [r for i, r in enumerate(registros) if i not in posicoes_com_erro]
    else:
        registros_exportar = registros

    conteudo = conversor_areas.gerar_arquivo_oficial(registros_exportar).encode("ascii", errors="ignore")
    nome_arquivo = f"{entry['nome_base']}_SSX_Areas_{modo}.csv"
    return Response(
        conteudo,
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{nome_arquivo}"'},
    )


# --- CONVERSOR DE PLANILHA DE UNIDADES ORGANIZACIONAIS (importação para a SSX) ---
# Mesmo fluxo e mesmo molde dos blocos acima, reaproveitando
# validador_importacao/ (TIPO_UO) como única fonte de verdade das regras
# (ver conversor_uo.py). ÚNICO dos 5 conversores SEM rota de "exportar": a
# SSX não tem layout de arquivo pra Unidade Organizacional, só a API
# (`OrganizationalUnit/Insert`, confirmado no Swagger) — por isso "Importar
# via API" é a única forma de concluir aqui, nunca "Baixar arquivo".
CONVERSOR_UO_UPLOADS = {}
CONVERSOR_UO_LOCK = threading.Lock()

# Campos liberados pra "preencher pra todas as linhas" — Tipo, Cliente e
# Unidade pai normalmente valem o mesmo pra toda uma leva de UOs importada
# de uma vez (mesmo cliente/hierarquia). Checado no servidor pra não
# aceitar um "campo" qualquer vindo do corpo da requisição.
CONVERSOR_UO_CAMPOS_PREENCHIVEIS = {"tipo", "codigo_integracao_cliente", "unidade_pai"}


@app.route("/api/conversor-uo/campos")
def conversor_uo_campos():
    campos = []
    for campo in conversor_uo.CAMPOS_UO:
        obrigatorio = "condicional" if callable(campo.obrigatorio) else bool(campo.obrigatorio)
        campos.append({
            "chave": campo.chave, "rotulo": campo.rotulo, "obrigatorio": obrigatorio,
            "tipo": campo.tipo, "tamanho_max": campo.tamanho_max,
        })
    return jsonify(ok=True, campos=campos)


@app.route("/api/conversor-uo/upload", methods=["POST"])
def conversor_uo_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]
    try:
        df = _ler_planilha_validador(arquivo)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler o arquivo: {e}"), 400
    if df.empty:
        return jsonify(ok=False, error="A planilha está vazia."), 400

    file_id = uuid.uuid4().hex
    nome_base = os.path.splitext(arquivo.filename or "unidades_organizacionais")[0]
    with CONVERSOR_UO_LOCK:
        CONVERSOR_UO_UPLOADS[file_id] = {"df": df, "nome_base": nome_base, "registros": None}
    return jsonify(ok=True, file_id=file_id, colunas=list(df.columns), total_linhas=len(df))


@app.route("/api/conversor-uo/mapear", methods=["POST"])
def conversor_uo_mapear():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    mapping = body.get("mapping") or {}  # {chave_destino: coluna_origem}

    with CONVERSOR_UO_LOCK:
        entry = CONVERSOR_UO_UPLOADS.get(file_id)
    if entry is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna antes de continuar."), 400

    df = entry["df"]
    colunas_validas = set(df.columns)
    mapping_valido = {chave: col for chave, col in mapping.items() if col in colunas_validas}

    registros = []
    for pos, row in enumerate(df.itertuples(index=False), start=1):
        row_dict = dict(zip(df.columns, row))
        dados = {}
        for chave, col in mapping_valido.items():
            valor = row_dict.get(col)
            dados[chave] = "" if (valor is None or str(valor).strip().lower() == "nan") else str(valor).strip()
        registros.append({"indice": pos, "original": dict(dados), "dados": dict(dados)})

    with CONVERSOR_UO_LOCK:
        entry["registros"] = registros

    return jsonify(ok=True, total=len(registros), registros=registros)


@app.route("/api/conversor-uo/usar-como-upload", methods=["POST"])
def conversor_uo_usar_como_upload():
    """Transforma os registros JÁ carregados/editados no Conversor de UO
    num "upload" do modal de importação genérico (UPLOADS, o mesmo dict
    usado por /api/import/upload) — pro botão "Importar via API" não
    obrigar a pessoa a exportar e re-enviar o arquivo que ela já tem na
    tela. Mesmo padrão de conversor_rastreadores_usar_como_upload (sem
    nenhum ajuste de valor, diferente de Áreas: todo campo de PARAMS["uo"]
    já nasce no formato que a API espera)."""
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_UO_LOCK:
        entry = CONVERSOR_UO_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Carregue e mapeie uma planilha no Conversor de Unidades Organizacionais antes."), 400

    registros = entry["registros"]
    rotulo_por_chave = {c.chave: c.rotulo for c in conversor_uo.CAMPOS_UO}
    chaves = list(registros[0]["dados"].keys())
    colunas = [rotulo_por_chave.get(chave, chave) for chave in chaves]

    linhas = [
        {rotulo_por_chave.get(chave, chave): r["dados"].get(chave, "") for chave in chaves}
        for r in registros
    ]
    df = pd.DataFrame(linhas, columns=colunas, dtype=str)

    novo_file_id = uuid.uuid4().hex
    with UPLOADS_LOCK:
        UPLOADS[novo_file_id] = df

    mapeamento_sugerido = {}
    for chave in chaves:
        campo_api = CONVERSOR_UO_PARA_API.get(chave)
        if campo_api:
            mapeamento_sugerido[campo_api] = rotulo_por_chave.get(chave, chave)

    return jsonify(
        ok=True, file_id=novo_file_id, colunas=colunas, total_linhas=len(df),
        mapeamento_sugerido=mapeamento_sugerido,
    )


@app.route("/api/conversor-uo/editar", methods=["POST"])
def conversor_uo_editar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")
    campo = body.get("campo")
    valor = body.get("valor", "")

    with CONVERSOR_UO_LOCK:
        entry = CONVERSOR_UO_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
    campos_validos = {c.chave for c in conversor_uo.CAMPOS_UO}
    if campo not in campos_validos:
        return jsonify(ok=False, error="Campo desconhecido."), 400

    registro = next((r for r in entry["registros"] if r["indice"] == indice), None)
    if registro is None:
        return jsonify(ok=False, error="Registro não encontrado."), 404
    registro["dados"][campo] = str(valor).strip()
    return jsonify(ok=True)


@app.route("/api/conversor-uo/excluir-linha", methods=["POST"])
def conversor_uo_excluir_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")

    with CONVERSOR_UO_LOCK:
        entry = CONVERSOR_UO_UPLOADS.get(file_id)
        if entry is None or not entry.get("registros"):
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if r["indice"] != indice]
        if len(entry["registros"]) == tamanho_antes:
            return jsonify(ok=False, error="Linha não encontrada."), 404
    return jsonify(ok=True)


@app.route("/api/conversor-uo/adicionar-linha", methods=["POST"])
def conversor_uo_adicionar_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_UO_LOCK:
        entry = CONVERSOR_UO_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        proximo_indice = max((r["indice"] for r in registros), default=0) + 1
        chaves = list(registros[0]["dados"].keys()) if registros else [c.chave for c in conversor_uo.CAMPOS_UO]
        dados_vazios = {chave: "" for chave in chaves}
        novo = {"indice": proximo_indice, "original": dict(dados_vazios), "dados": dict(dados_vazios)}
        registros.append(novo)
    return jsonify(ok=True, registro=novo)


@app.route("/api/conversor-uo/limpar-vazias", methods=["POST"])
def conversor_uo_limpar_vazias():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_UO_LOCK:
        entry = CONVERSOR_UO_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if any((v or "").strip() for v in r["dados"].values())]
        removidos = tamanho_antes - len(entry["registros"])
    return jsonify(ok=True, removidos=removidos)


@app.route("/api/conversor-uo/transformar", methods=["POST"])
def conversor_uo_transformar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    acao = body.get("acao")
    params = body.get("params") or {}
    indices_alvo = body.get("indices")  # lista de int, ou None/omitido = todas as linhas

    with CONVERSOR_UO_LOCK:
        entry = CONVERSOR_UO_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]
    alterados = set()
    extra = {}

    if acao == "preencher_campo":
        campo = params.get("campo")
        valor = (params.get("valor") or "").strip()
        if campo not in CONVERSOR_UO_CAMPOS_PREENCHIVEIS:
            return jsonify(ok=False, error="Campo inválido para preenchimento em massa."), 400
        if not valor:
            return jsonify(ok=False, error="Informe o valor a ser preenchido."), 400
        extra = conversor_uo.preencher_campo_todas_linhas(alvo, alterados, campo, valor)

    else:
        return jsonify(ok=False, error="Ação de transformação desconhecida."), 400

    registros_alterados = [r for r in registros if r["indice"] in alterados]
    resposta = dict(ok=True, total_alterados=len(alterados), registros=registros_alterados)
    resposta.update(extra)
    return jsonify(**resposta)


@app.route("/api/conversor-uo/validar", methods=["POST"])
def conversor_uo_validar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_UO_LOCK:
        entry = CONVERSOR_UO_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    por_posicao = conversor_uo.validar_registros(registros)

    problemas = []
    n_erro = 0
    for pos, registro in enumerate(registros):
        problema = por_posicao.get(pos, {"erros": [], "avisos": []})
        erros = list(problema["erros"])
        avisos = list(problema["avisos"])
        if not erros and not avisos:
            continue
        if erros:
            n_erro += 1
        problemas.append({"indice": registro["indice"], "erros": erros, "avisos": avisos})

    return jsonify(ok=True, total=len(registros), n_ok=len(registros) - n_erro, n_erro=n_erro, problemas=problemas)


# Verificação na SSX (opcional — exige login na própria API): duas
# checagens na mesma sessão/token — mesmo padrão de
# conversor_rastreadores_verificar_duplicidade. 1) Duplicidade
# (verificar_duplicidade_ssx): código que NÃO deveria já existir. 2)
# Referências (verificar_referencias_ssx): Unidade pai e cliente que
# DEVERIAM já existir — senão a API rejeita a linha na importação de
# verdade ("Tipo" fica de fora: o próprio Swagger documenta criação
# automática, ver conversor_uo.verificar_referencias_ssx).
@app.route("/api/conversor-uo/verificar-duplicidade", methods=["POST"])
def conversor_uo_verificar_duplicidade():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indices_alvo = body.get("indices")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_UO_LOCK:
        entry = CONVERSOR_UO_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]

    try:
        uos_ssx = requisicao_padrao(LISTAGENS["uos"]["endpoint"], LISTAGENS["uos"]["payload"], token)
        clientes_ssx = requisicao_padrao(LISTAGENS["clientes"]["endpoint"], LISTAGENS["clientes"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    por_indice_dup = conversor_uo.verificar_duplicidade_ssx(alvo, uos_ssx)
    por_indice_ref = conversor_uo.verificar_referencias_ssx(alvo, uos_ssx, clientes_ssx)

    por_indice = {}
    for origem in (por_indice_dup, por_indice_ref):
        for idx, p in origem.items():
            entrada = por_indice.setdefault(idx, {"erros": [], "avisos": []})
            entrada["erros"].extend(p["erros"])
            entrada["avisos"].extend(p["avisos"])

    problemas = [{"indice": idx, "erros": p["erros"], "avisos": p["avisos"]} for idx, p in por_indice.items()]
    return jsonify(
        ok=True, total_verificados=len(alvo), total_duplicados=len(problemas), problemas=problemas,
    )


# --- CONVERSOR DE PLANILHA DE COLABORADORES (importação para a SSX) ---
# Mesmo fluxo e mesmo molde dos blocos acima, reaproveitando
# validador_importacao/ (TIPO_COLABORADOR) como única fonte de verdade das
# regras (ver conversor_colaboradores.py). Mesmo molde de "CONVERSOR DE
# PLANILHA DE CLIENTES" — vários botões/ações são diretamente análogos aos
# de lá (ver comentário de conversor_colaboradores.py).
CONVERSOR_COLABORADORES_UPLOADS = {}
CONVERSOR_COLABORADORES_LOCK = threading.Lock()

# Campos liberados pra "preencher pra todas as linhas" — Cargo/Perfil de
# acesso/Unidade organizacional normalmente valem o mesmo pra toda uma leva
# de colaboradores importada de uma vez (mesmo padrão de Template do
# cliente/Perfil de acesso em conversor_clientes). Checado no servidor pra
# não aceitar um "campo" qualquer vindo do corpo da requisição.
CONVERSOR_COLABORADORES_CAMPOS_PREENCHIVEIS = {"cargo", "perfil_acesso", "unidade_organizacional"}


@app.route("/api/conversor-colaboradores/campos")
def conversor_colaboradores_campos():
    campos = []
    for campo in conversor_colaboradores.CAMPOS_COLABORADOR:
        obrigatorio = "condicional" if callable(campo.obrigatorio) else bool(campo.obrigatorio)
        campos.append({
            "chave": campo.chave, "rotulo": campo.rotulo, "obrigatorio": obrigatorio,
            "tipo": campo.tipo, "tamanho_max": campo.tamanho_max,
        })
    return jsonify(ok=True, campos=campos)


@app.route("/api/conversor-colaboradores/upload", methods=["POST"])
def conversor_colaboradores_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]
    try:
        df = _ler_planilha_validador(arquivo)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler o arquivo: {e}"), 400
    if df.empty:
        return jsonify(ok=False, error="A planilha está vazia."), 400

    file_id = uuid.uuid4().hex
    nome_base = os.path.splitext(arquivo.filename or "colaboradores")[0]
    with CONVERSOR_COLABORADORES_LOCK:
        CONVERSOR_COLABORADORES_UPLOADS[file_id] = {"df": df, "nome_base": nome_base, "registros": None}
    return jsonify(ok=True, file_id=file_id, colunas=list(df.columns), total_linhas=len(df))


@app.route("/api/conversor-colaboradores/mapear", methods=["POST"])
def conversor_colaboradores_mapear():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    mapping = body.get("mapping") or {}  # {chave_destino: coluna_origem}

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
    if entry is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna antes de continuar."), 400

    df = entry["df"]
    colunas_validas = set(df.columns)
    mapping_valido = {chave: col for chave, col in mapping.items() if col in colunas_validas}

    registros = []
    for pos, row in enumerate(df.itertuples(index=False), start=1):
        row_dict = dict(zip(df.columns, row))
        dados = {}
        for chave, col in mapping_valido.items():
            valor = row_dict.get(col)
            dados[chave] = "" if (valor is None or str(valor).strip().lower() == "nan") else str(valor).strip()
        registros.append({"indice": pos, "original": dict(dados), "dados": dict(dados)})

    with CONVERSOR_COLABORADORES_LOCK:
        entry["registros"] = registros

    return jsonify(ok=True, total=len(registros), registros=registros)


@app.route("/api/conversor-colaboradores/usar-como-upload", methods=["POST"])
def conversor_colaboradores_usar_como_upload():
    """Transforma os registros JÁ carregados/editados no Conversor de
    Colaboradores num "upload" do modal de importação genérico (UPLOADS, o
    mesmo dict usado por /api/import/upload) — pro botão "Importar via API"
    não obrigar a pessoa a exportar e re-enviar o arquivo que ela já tem na
    tela. Mesmo padrão de conversor_clientes_usar_como_upload — inclusive o
    ajuste de "Senha" vazia virar "0" (só nesse caminho da API, o .txt
    exportado continua em branco)."""
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Carregue e mapeie uma planilha no Conversor de Colaboradores antes."), 400

    registros = entry["registros"]
    rotulo_por_chave = {c.chave: c.rotulo for c in conversor_colaboradores.CAMPOS_COLABORADOR}
    chaves = list(registros[0]["dados"].keys())
    colunas = [rotulo_por_chave.get(chave, chave) for chave in chaves]

    linhas = []
    for r in registros:
        dados = dict(r["dados"])
        if "senha" in dados and not str(dados.get("senha", "")).strip():
            dados["senha"] = "0"
        linhas.append({rotulo_por_chave.get(chave, chave): dados.get(chave, "") for chave in chaves})
    df = pd.DataFrame(linhas, columns=colunas, dtype=str)

    novo_file_id = uuid.uuid4().hex
    with UPLOADS_LOCK:
        UPLOADS[novo_file_id] = df

    mapeamento_sugerido = {}
    for chave in chaves:
        campo_api = CONVERSOR_COLABORADORES_PARA_API.get(chave)
        if campo_api:
            mapeamento_sugerido[campo_api] = rotulo_por_chave.get(chave, chave)

    return jsonify(
        ok=True, file_id=novo_file_id, colunas=colunas, total_linhas=len(df),
        mapeamento_sugerido=mapeamento_sugerido,
    )


@app.route("/api/conversor-colaboradores/editar", methods=["POST"])
def conversor_colaboradores_editar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")
    campo = body.get("campo")
    valor = body.get("valor", "")

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
    campos_validos = {c.chave for c in conversor_colaboradores.CAMPOS_COLABORADOR}
    if campo not in campos_validos:
        return jsonify(ok=False, error="Campo desconhecido."), 400

    registro = next((r for r in entry["registros"] if r["indice"] == indice), None)
    if registro is None:
        return jsonify(ok=False, error="Registro não encontrado."), 404
    registro["dados"][campo] = str(valor).strip()
    return jsonify(ok=True)


@app.route("/api/conversor-colaboradores/excluir-linha", methods=["POST"])
def conversor_colaboradores_excluir_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indice = body.get("indice")

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
        if entry is None or not entry.get("registros"):
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if r["indice"] != indice]
        if len(entry["registros"]) == tamanho_antes:
            return jsonify(ok=False, error="Linha não encontrada."), 404
    return jsonify(ok=True)


@app.route("/api/conversor-colaboradores/adicionar-linha", methods=["POST"])
def conversor_colaboradores_adicionar_linha():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        proximo_indice = max((r["indice"] for r in registros), default=0) + 1
        chaves = list(registros[0]["dados"].keys()) if registros else [c.chave for c in conversor_colaboradores.CAMPOS_COLABORADOR]
        dados_vazios = {chave: "" for chave in chaves}
        novo = {"indice": proximo_indice, "original": dict(dados_vazios), "dados": dict(dados_vazios)}
        registros.append(novo)
    return jsonify(ok=True, registro=novo)


@app.route("/api/conversor-colaboradores/limpar-vazias", methods=["POST"])
def conversor_colaboradores_limpar_vazias():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
        if entry is None or entry.get("registros") is None:
            return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400
        registros = entry["registros"]
        tamanho_antes = len(registros)
        entry["registros"] = [r for r in registros if any((v or "").strip() for v in r["dados"].values())]
        removidos = tamanho_antes - len(entry["registros"])
    return jsonify(ok=True, removidos=removidos)


@app.route("/api/conversor-colaboradores/transformar", methods=["POST"])
def conversor_colaboradores_transformar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    acao = body.get("acao")
    params = body.get("params") or {}
    indices_alvo = body.get("indices")  # lista de int, ou None/omitido = todas as linhas

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]
    alterados = set()
    extra = {}

    if acao == "limpar_cpf":
        for r in alvo:
            anterior = r["dados"].get("cpf", "")
            novo = conversor_colaboradores.limpar_cpf(anterior)
            if novo != anterior:
                r["dados"]["cpf"] = novo
                alterados.add(r["indice"])

    elif acao == "ajustar_telefone":
        ddd_padrao = "".join(c for c in str(params.get("ddd_padrao") or "55") if c.isdigit()) or "55"
        if len(ddd_padrao) != 2:
            return jsonify(ok=False, error="Informe um DDD padrão com 2 dígitos."), 400
        extra = conversor_colaboradores.ajustar_telefone(alvo, alterados, ddd_padrao)

    elif acao == "preencher_campo":
        campo = params.get("campo")
        valor = (params.get("valor") or "").strip()
        if campo not in CONVERSOR_COLABORADORES_CAMPOS_PREENCHIVEIS:
            return jsonify(ok=False, error="Campo inválido para preenchimento em massa."), 400
        if not valor:
            return jsonify(ok=False, error="Informe o valor a ser preenchido."), 400
        extra = conversor_colaboradores.preencher_campo_todas_linhas(alvo, alterados, campo, valor)

    elif acao == "preencher_senhas":
        senha = params.get("senha") or ""
        sobrescrever = bool(params.get("sobrescrever"))
        if not senha:
            return jsonify(ok=False, error="Informe a senha a ser preenchida."), 400
        for r in alvo:
            anterior = r["dados"].get("senha", "")
            novo = conversor_colaboradores.preencher_senha(anterior, senha, sobrescrever)
            if novo != anterior:
                r["dados"]["senha"] = novo
                alterados.add(r["indice"])

    else:
        return jsonify(ok=False, error="Ação de transformação desconhecida."), 400

    registros_alterados = [r for r in registros if r["indice"] in alterados]
    resposta = dict(ok=True, total_alterados=len(alterados), registros=registros_alterados)
    resposta.update(extra)
    return jsonify(**resposta)


@app.route("/api/conversor-colaboradores/validar", methods=["POST"])
def conversor_colaboradores_validar():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    por_posicao = conversor_colaboradores.validar_registros(registros)
    por_indice_interna = conversor_colaboradores.verificar_duplicidade_interna(registros)

    problemas = []
    n_erro = 0
    for pos, registro in enumerate(registros):
        problema = por_posicao.get(pos, {"erros": [], "avisos": []})
        extra = por_indice_interna.get(registro["indice"])
        erros = list(problema["erros"])
        avisos = list(problema["avisos"]) + (extra["avisos"] if extra else [])
        if not erros and not avisos:
            continue
        if erros:
            n_erro += 1
        problemas.append({"indice": registro["indice"], "erros": erros, "avisos": avisos})

    return jsonify(ok=True, total=len(registros), n_ok=len(registros) - n_erro, n_erro=n_erro, problemas=problemas)


# Verificação na SSX (opcional — exige login na própria API): duas
# checagens na mesma sessão/token — mesmo padrão de
# conversor_uo_verificar_duplicidade. 1) Duplicidade
# (verificar_duplicidade_ssx): código/CPF/login que NÃO deveriam já
# existir. 2) Referências (verificar_referencias_ssx): Unidade
# organizacional e Perfil de acesso que DEVERIAM já existir — senão a API
# rejeita a linha na importação de verdade.
@app.route("/api/conversor-colaboradores/verificar-duplicidade", methods=["POST"])
def conversor_colaboradores_verificar_duplicidade():
    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    indices_alvo = body.get("indices")

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    alvo = registros if not indices_alvo else [r for r in registros if r["indice"] in set(indices_alvo)]

    try:
        pessoas_ssx = requisicao_padrao(LISTAGENS["pessoas"]["endpoint"], LISTAGENS["pessoas"]["payload"], token)
        uos_ssx = requisicao_padrao(LISTAGENS["uos"]["endpoint"], LISTAGENS["uos"]["payload"], token)
        perfis_ssx = requisicao_padrao(LISTAGENS["perfis_acesso"]["endpoint"], LISTAGENS["perfis_acesso"]["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    por_indice_dup = conversor_colaboradores.verificar_duplicidade_ssx(alvo, pessoas_ssx)
    por_indice_ref = conversor_colaboradores.verificar_referencias_ssx(alvo, uos_ssx, perfis_ssx)

    por_indice = {}
    for origem in (por_indice_dup, por_indice_ref):
        for idx, p in origem.items():
            entrada = por_indice.setdefault(idx, {"erros": [], "avisos": []})
            entrada["erros"].extend(p["erros"])
            entrada["avisos"].extend(p["avisos"])

    problemas = [{"indice": idx, "erros": p["erros"], "avisos": p["avisos"]} for idx, p in por_indice.items()]
    return jsonify(
        ok=True, total_verificados=len(alvo), total_duplicados=len(problemas), problemas=problemas,
    )


@app.route("/api/conversor-colaboradores/exportar/<file_id>/<modo>")
def conversor_colaboradores_exportar(file_id, modo):
    if modo not in ("todos", "validos"):
        return jsonify(ok=False, error="Modo inválido."), 400

    with CONVERSOR_COLABORADORES_LOCK:
        entry = CONVERSOR_COLABORADORES_UPLOADS.get(file_id)
    if entry is None or not entry.get("registros"):
        return jsonify(ok=False, error="Planilha não encontrada ou ainda não mapeada."), 400

    registros = entry["registros"]
    if modo == "validos":
        por_posicao = conversor_colaboradores.validar_registros(registros)
        posicoes_com_erro = {pos for pos, p in por_posicao.items() if p["erros"]}
        registros_exportar = [r for i, r in enumerate(registros) if i not in posicoes_com_erro]
    else:
        registros_exportar = registros

    conteudo = conversor_colaboradores.gerar_arquivo_oficial(registros_exportar).encode("ascii", errors="ignore")
    nome_arquivo = f"{entry['nome_base']}_SSX_Colaboradores_{modo}.txt"
    return Response(
        conteudo,
        mimetype="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{nome_arquivo}"'},
    )


# --- ATALHOS (OPERAÇÕES EM MASSA, Central de Importação SSX) ---
# Só a etapa de listagem/seleção da Exclusão em massa por enquanto (ver
# pedido original) — reaproveita LISTAGENS/_token_para/requisicao_padrao já
# usados pelos Conversores. Confirmado no Swagger (Delete de cada tipo): só
# dá pra excluir um registro que já tem o campo abaixo preenchido —
# "campo_codigo" é exatamente o que os endpoints Client/Delete,
# Vehicle/Delete, Tracker/Delete e SimCard/Delete pedem (SimCard usa o
# próprio ICCID, não tem um "código de integração" separado). "area" fica
# de fora de propósito: não existe Geography/List no Swagger (só
# Insert/Update/Delete/ListCategories/ListGroups), então não tem como listar
# área nenhuma pra montar o checklist.
ATALHOS_TIPOS = {
    "cliente": {"titulo": "Clientes", "listagem": "clientes", "campo_codigo": "ClientIntegrationCode", "campo_nome": "TradingName", "endpoint_delete": "/Administration/Client/Delete"},
    "veiculo": {"titulo": "Veículos", "listagem": "veiculos", "campo_codigo": "VehicleIntegrationCode", "campo_nome": "Identification", "endpoint_delete": "/Administration/Vehicle/Delete"},
    "rastreador": {"titulo": "Rastreadores", "listagem": "rastreadores", "campo_codigo": "TrackerIntegrationCode", "campo_nome": "IdTracker", "endpoint_delete": "/Administration/Tracker/Delete"},
    "simcard": {"titulo": "SIM Cards", "listagem": "simcards", "campo_codigo": "ICCID", "campo_nome": "ICCID", "endpoint_delete": "/Administration/SimCard/Delete"},
}


@app.route("/api/atalhos/listar/<tipo>", methods=["POST"])
def atalhos_listar(tipo):
    if tipo == "area":
        return jsonify(ok=False, error="Não é possível listar Áreas — a SSX não tem endpoint de consulta (List) pra esse cadastro, só Insert/Update/Delete."), 400
    config = ATALHOS_TIPOS.get(tipo)
    if not config:
        return jsonify(ok=False, error="Tipo desconhecido."), 400

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    listagem = LISTAGENS[config["listagem"]]
    try:
        registros_ssx = requisicao_padrao(listagem["endpoint"], listagem["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar a SSX: {e}"), 400

    registros = []
    for r in registros_ssx or []:
        codigo = str(r.get(config["campo_codigo"]) or "").strip()
        nome = str(r.get(config["campo_nome"]) or "").strip() or "(sem nome)"
        registros.append({"codigo": codigo, "nome": nome, "elegivel": bool(codigo)})

    return jsonify(ok=True, titulo=config["titulo"], total=len(registros), registros=registros)


# Exclusão de verdade: mesmo padrão de job/thread/polling de
# _executar_deletar_veiculos (Área de Importação) — generalizado pros 4
# tipos via ATALHOS_TIPOS["endpoint_delete"], e usando a sessão avulsa desta
# tela (_token_para(None), mesma dos outros endpoints de /api/atalhos/*) em
# vez do idcentral multi-cliente do deletar-veiculos antigo. O corpo de
# cada chamada Delete é o CÓDIGO em si (string crua), não um objeto — assim
# que o Swagger documenta Client/Delete, Vehicle/Delete, Tracker/Delete e
# SimCard/Delete. Uma linha que falha é registrada e não trava as demais.
ATALHOS_EXCLUSAO_JOBS = {}
ATALHOS_EXCLUSAO_JOBS_LOCK = threading.Lock()


def _executar_atalhos_exclusao(job_id, endpoint_delete, codigos, token):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    sucessos = erros = 0
    for i, codigo in enumerate(codigos):
        try:
            r = requests.post(f"{BASE_URL}{endpoint_delete}", json=codigo, headers=headers, timeout=20)
            if r.status_code in (200, 201):
                sucessos += 1
                mensagem = f"{i + 1}/{len(codigos)}: código {codigo} excluído."
            else:
                erros += 1
                mensagem = f"Erro {i + 1}/{len(codigos)} (código {codigo}): HTTP {r.status_code} — {r.text[:200]}"
        except requests.exceptions.RequestException as e:
            erros += 1
            mensagem = f"Erro {i + 1}/{len(codigos)} (código {codigo}): {e}"

        with ATALHOS_EXCLUSAO_JOBS_LOCK:
            job = ATALHOS_EXCLUSAO_JOBS[job_id]
            job["logs"].append(mensagem)
            job["atual"] = i + 1
            job["sucessos"] = sucessos
            job["erros"] = erros

    with ATALHOS_EXCLUSAO_JOBS_LOCK:
        ATALHOS_EXCLUSAO_JOBS[job_id]["status"] = "concluido"


@app.route("/api/atalhos/excluir/executar", methods=["POST"])
def atalhos_excluir_executar():
    body = request.get_json(force=True) or {}
    tipo = body.get("tipo")
    codigos = body.get("codigos") or []

    config = ATALHOS_TIPOS.get(tipo)
    if not config:
        return jsonify(ok=False, error="Tipo inválido para exclusão."), 400
    codigos = [str(c).strip() for c in codigos if str(c).strip()]
    if not codigos:
        return jsonify(ok=False, error="Nenhum código selecionado."), 400

    token, erro_resp, status = _token_para(None)
    if erro_resp:
        return erro_resp, status

    job_id = uuid.uuid4().hex
    with ATALHOS_EXCLUSAO_JOBS_LOCK:
        ATALHOS_EXCLUSAO_JOBS[job_id] = {
            "status": "rodando", "atual": 0, "total": len(codigos),
            "sucessos": 0, "erros": 0, "logs": [],
        }

    threading.Thread(
        target=_executar_atalhos_exclusao,
        args=(job_id, config["endpoint_delete"], codigos, token),
        daemon=True,
    ).start()

    return jsonify(ok=True, job_id=job_id, total=len(codigos))


@app.route("/api/atalhos/excluir/status/<job_id>")
def atalhos_excluir_status(job_id):
    with ATALHOS_EXCLUSAO_JOBS_LOCK:
        job = ATALHOS_EXCLUSAO_JOBS.get(job_id)
        if not job:
            return jsonify(ok=False, error="Job não encontrado."), 404
        resultado = dict(job)
    return jsonify(ok=True, **resultado)


# --- ENVIO DE COMANDO (SMS Market) ---
# Portado do "Configurador de rastreadores V5.0" (tkinter). A lógica de geração
# de comando por modelo/comando e o fluxo de envio (único, livre, em massa)
# foram mantidos fiéis ao programa original, inclusive peculiaridades dele
# (ex.: alguns modelos retornam um texto diferente do exibido na tela original;
# aqui exibimos sempre o texto que é realmente enviado).
SMS_BASE_URL = "https://api.smsmarket.com.br/webservice-rest"

UPLOADS_MASSA = {}
UPLOADS_MASSA_LOCK = threading.Lock()


def _gerar_comando_sms_legado(modelo, comando, id_, apn, loginapn, porta, operadora):
    """Versão antiga (hardcoded), mantida só pra validar a migração dos 23
    modelos pro catálogo novo (ver MIGRACAO_CATALOGO_COMANDOS_LEGADO mais
    abaixo) — comparamos a saída dela com o template.format() novo pra
    garantir que a migração não mudou nenhum comando real por engano antes de
    considerar migrado. Não é mais chamada por nenhuma rota; pode ser apagada
    com segurança assim que a migração for conferida e confirmada."""

    if modelo == "E3/E3+":
        if comando == "REG000000#":
            return "REG000000#"
        if comando == "SMS1":
            return "SMS1"
        if comando == "IP/Porta1":
            return f"IP1#200.152.62.20#{porta}#"
        if comando == "IP/Porta2":
            return f"IP2#200.152.62.20#{porta}#"
        if comando == "SMS0":
            return "SMS0"

    if modelo == "F1/M1":
        if comando == "IP/Porta":
            return f"SERVER,0,200.152.62.20,{porta},0#"
        if comando == "APN":
            return f"APN,{apn},{loginapn},{loginapn}#"
        if comando == "Reset":
            return "#reiniciar,888888#"

    if modelo == "ITR-120/155":
        if comando == "IP/Porta":
            return f"SERVER,0,200.152.62.20,{porta},0#"
        if comando == "APN":
            return f"APN,{apn},{loginapn},{loginapn}#"
        if comando == "Reset":
            return "RESET#"

    if modelo == "JC181":
        if comando == "COREKITSW,0":
            return "COREKITSW,0"
        if comando == "APN":
            return f"APN,{apn},{loginapn},{loginapn}"
        if comando == "URLTYPE,2":
            return "URLTYPE,2"
        if comando == "SERVER":
            return "SERVER,0,200.152.62.22,21122"

    if modelo == "JC450":
        if comando == "URLTYPE,2":
            return "URLTYPE,2"
        if comando == "APN":
            return f"APN,jimi,{apn},,,,,,{loginapn},,{loginapn},,,,,IP,IP,"
        if comando == "SERVER":
            return "SERVER,jimi.systemsatx.com.br,21122,NA,NA,NA,NA"
        if comando == "LOCATEREP":
            return "LOCATEREP,60"
        if comando == "SHUTDOWNTIME":
            return "SHUTDOWNTIME,120"
        if comando == "WAKEMODE":
            return "WAKEMODE,103"

    if modelo in ("VL01/02/03", "LV12", "N4", "J16"):
        if comando == "IP/Porta":
            return f"SERVER,0,200.152.62.20,{porta},0#"
        if comando == "APN":
            return f"APN,{apn},{loginapn},{loginapn}#"
        if comando == "Reset":
            return "RESET#"

    if modelo == "NT20":
        if comando == "IP/Porta":
            return f"SERVER,8520,200.152.62.20,{porta},0#"
        if comando == "APN":
            return f"APN,{apn},{loginapn},{loginapn}#"
        if comando == "Reset":
            return "RESET#"

    if modelo in ("ST40XX", "ST80XX"):
        if comando == "IP/Porta":
            return f"PRG;{id_};10;05#200.152.62.20;06#{porta};08#200.152.62.20;09#{porta}"
        if comando == "APN":
            return f"PRG;{apn};10;00#01;01#{apn};02#{loginapn};03#{loginapn}"
        if comando == "Rede zip":
            return f"PRG;{apn};10;00#01;01#{apn};02#{loginapn};03#{loginapn}"
        if comando == "IG Física":
            return f"PRG;{id_};17;00#01"
        if comando == "Reset":
            return f"CMD;{id_};03;03"

    if modelo == "ST3XX":
        if comando == "IP/Porta":
            if operadora == "Outras":
                return f"ST300NTW;{id_};02;1;{apn};{loginapn};{loginapn};200.152.62.20;{porta};200.152.62.20;{porta};;"
            return f"ST300NTW;{id_};02;0;{apn};{loginapn};{loginapn};200.152.62.20;{porta};200.152.62.20;{porta};;"
        if comando == "Rede zip":
            return f"ST300NTW;{id_};02;1;{apn};{loginapn};{loginapn};200.152.62.20;{porta};200.152.62.20;{porta};;"
        if comando == "Reset":
            return f"ST300CMD;{id_};02;Reboot"

    if modelo == "TK311":
        if comando == "IP/Porta":
            return f"adminip123456 200.152.62.20 {porta}"
        if comando == "Reset":
            return "reset123456"

    if modelo == "JC400AD":
        if comando == "COREKITSW":
            return "COREKITSW,0"
        if comando == "APN":
            return f"APN,SYSTEMSAT,{apn},,,,,,{loginapn},,{loginapn},,,,,IPv4,IPv4,,"
        if comando == "SERVER":
            return "SERVER#1#jimi.systemsatx.com.br#21100"
        if comando == "RSERVICE":
            return "RSERVICE,jimi.systemsatx.com.br:1936/live"
        if comando == "UPLOAD":
            return "UPLOAD,http://jimi.systemsatx.com.br:23010/upload"
        if comando == "FILELIST":
            return "FILELIST,https://jimiapi.systemsatx.com.br/fileList"
        if comando == "Reset":
            return "Reboot"

    if modelo in ("GTK LW", "TR05"):
        if comando == "IP/Porta":
            return f"SERVER,8888,200.152.62.20,{porta}#"
        if comando == "APN":
            return f"APN,{apn},{loginapn},{loginapn}#"
        if comando == "Reset":
            return "RESET#"

    return None


def _consultar_saldo_sms(usuario, senha):
    r = requests.get(f"{SMS_BASE_URL}/balance", params={"user": usuario, "password": senha}, timeout=15)
    r.raise_for_status()
    return r.json().get("balance_2")


def _enviar_sms(numero, conteudo, campaign_id, auth=None):
    # auth explícito é usado pela thread de envio em massa, que roda fora do
    # contexto de requisição e por isso não tem acesso à `session`.
    auth = auth or session.get("sms_auth")
    if not auth:
        return None, "Autentique-se na SMS Market primeiro."
    headers = {"Authorization": f"Basic {auth}"}
    payload = {"number": numero, "content": conteudo, "type": "0", "campaign_id": campaign_id}
    try:
        r = requests.post(f"{SMS_BASE_URL}/send-single.php", data=payload, headers=headers, timeout=20)
        data = r.json()
        return data.get("responseDescription"), None
    except requests.exceptions.RequestException as e:
        return None, str(e)
    except ValueError:
        return None, "Resposta inválida da SMS Market."


@app.route("/api/comando/autenticar", methods=["POST"])
@requer_operador
def comando_autenticar():
    data = request.get_json(force=True) or {}
    usuario = str(data.get("usuario", "")).strip()
    senha = str(data.get("senha", ""))
    if not usuario or not senha:
        return jsonify(ok=False, error="Informe usuário e senha."), 400
    try:
        saldo = _consultar_saldo_sms(usuario, senha)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar saldo: {e}"), 400
    if saldo is None or saldo == "None":
        return jsonify(ok=False, error="Usuário ou senha inválido."), 400
    session["sms_usuario"] = usuario
    session["sms_senha"] = senha
    session["sms_auth"] = base64.b64encode(f"{usuario}:{senha}".encode()).decode()
    return jsonify(ok=True, saldo=saldo)


@app.route("/api/comando/saldo")
def comando_saldo():
    usuario, senha = session.get("sms_usuario"), session.get("sms_senha")
    if not usuario or not senha:
        return jsonify(ok=False, error="Autentique-se na SMS Market primeiro."), 401
    try:
        saldo = _consultar_saldo_sms(usuario, senha)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao consultar saldo: {e}"), 400
    return jsonify(ok=True, saldo=saldo)


@app.route("/api/comando/gerar", methods=["POST"])
@requer_operador
def comando_gerar():
    data = request.get_json(force=True) or {}
    modelo_comando_id = str(data.get("modeloComandoId", "")).strip()
    doc = db.collection(MODELOS_COMANDO_COLLECTION).document(modelo_comando_id).get()
    if not doc.exists:
        return jsonify(ok=False, error="Comando não encontrado no catálogo."), 404
    template = (doc.to_dict() or {}).get("template", "")
    texto = preencher_template_comando(template, data.get("valores") or {})
    if texto is None:
        return jsonify(ok=False, error="Falha ao montar o comando — confira o template cadastrado."), 400
    return jsonify(ok=True, texto=texto)


@app.route("/api/comando/enviar", methods=["POST"])
@requer_operador
def comando_enviar():
    if not session.get("sms_auth"):
        return jsonify(ok=False, error="Autentique-se na SMS Market primeiro."), 401
    data = request.get_json(force=True) or {}
    numero = str(data.get("numero", "")).strip()
    conteudo = str(data.get("conteudo", ""))
    campaign_id = str(data.get("campaign_id", "Envio de comando"))
    if not numero or not conteudo:
        return jsonify(ok=False, error="Informe número e conteúdo."), 400

    resposta, erro = _enviar_sms(numero, conteudo, campaign_id)
    if erro:
        return jsonify(ok=False, error=erro), 400

    saldo = None
    usuario, senha = session.get("sms_usuario"), session.get("sms_senha")
    if usuario and senha:
        try:
            saldo = _consultar_saldo_sms(usuario, senha)
        except requests.exceptions.RequestException:
            pass
    return jsonify(ok=True, resposta=resposta, saldo=saldo)


@app.route("/api/comando/upload-massa", methods=["POST"])
@requer_operador
def comando_upload_massa():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    conteudo = request.files["arquivo"].read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(conteudo))
        # max_row inclui a linha 1 (cabeçalho), que também é enviada como SMS
        # (comportamento original preservado) — refletimos o total real de envios.
        total_linhas = max(wb.active.max_row, 0)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler Excel: {e}"), 400
    file_id = uuid.uuid4().hex
    with UPLOADS_MASSA_LOCK:
        UPLOADS_MASSA[file_id] = conteudo
    return jsonify(ok=True, file_id=file_id, total_linhas=total_linhas)


# Envio em massa roda em thread separada (não presa a um único request HTTP),
# porque o Render/gunicorn mata requisições longas paradas (timeout padrão de
# 30s) — com muitas linhas e intervalo entre SMS's isso facilmente estoura.
# A tela consulta o andamento via polling em /status/<job_id>.
COMANDO_JOBS = {}
COMANDO_JOBS_LOCK = threading.Lock()


def _executar_envio_massa(job_id, coluna1, coluna2, coluna3, intervalo, auth, usuario, senha):
    sucessos = erros = 0
    linha = 1
    total = max(len(coluna1), 1)
    valor_coluna1 = coluna1[1] if len(coluna1) > 1 else "None"

    while valor_coluna1 != "None":
        valor_coluna1 = coluna1[linha - 1] if linha <= len(coluna1) else None
        valor_coluna2 = coluna2[linha - 1] if linha <= len(coluna2) else None
        valor_coluna3 = coluna3[linha - 1] if linha <= len(coluna3) else None

        if valor_coluna1 is None and valor_coluna2 is None:
            break

        resposta, erro = _enviar_sms(valor_coluna2, valor_coluna1, valor_coluna3, auth=auth)
        with COMANDO_JOBS_LOCK:
            job = COMANDO_JOBS[job_id]
            if erro:
                erros += 1
                job["logs"].append(f"Erro linha {linha}: {erro}")
            else:
                sucessos += 1
                job["logs"].append(f"Linha {linha}: {resposta}")
            job["atual"] = linha
            job["sucessos"] = sucessos
            job["erros"] = erros

        time.sleep(intervalo)
        linha += 1

    saldo = None
    if usuario and senha:
        try:
            saldo = _consultar_saldo_sms(usuario, senha)
        except requests.exceptions.RequestException:
            pass

    with COMANDO_JOBS_LOCK:
        COMANDO_JOBS[job_id]["status"] = "concluido"
        COMANDO_JOBS[job_id]["saldo"] = saldo


@app.route("/api/comando/enviar-massa", methods=["POST"])
@requer_operador
def comando_enviar_massa():
    auth = session.get("sms_auth")
    if not auth:
        return jsonify(ok=False, error="Autentique-se na SMS Market primeiro."), 401
    usuario, senha = session.get("sms_usuario"), session.get("sms_senha")

    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    intervalo = _para_int(body.get("intervalo"))

    with UPLOADS_MASSA_LOCK:
        conteudo = UPLOADS_MASSA.pop(file_id, None)
    if conteudo is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400

    wb = openpyxl.load_workbook(io.BytesIO(conteudo))
    sheet = wb.active
    coluna1 = [str(cell.value) for cell in sheet["A"]]
    coluna2 = [str(cell.value) for cell in sheet["B"]]
    coluna3 = [str(cell.value) for cell in sheet["C"]]
    total = max(len(coluna1), 1)

    job_id = uuid.uuid4().hex
    with COMANDO_JOBS_LOCK:
        COMANDO_JOBS[job_id] = {
            "status": "rodando", "atual": 0, "total": total,
            "sucessos": 0, "erros": 0, "logs": [], "saldo": None,
        }

    threading.Thread(
        target=_executar_envio_massa,
        args=(job_id, coluna1, coluna2, coluna3, intervalo, auth, usuario, senha),
        daemon=True,
    ).start()

    return jsonify(ok=True, job_id=job_id, total=total)


@app.route("/api/comando/enviar-massa/status/<job_id>")
def comando_enviar_massa_status(job_id):
    with COMANDO_JOBS_LOCK:
        job = COMANDO_JOBS.get(job_id)
        if not job:
            return jsonify(ok=False, error="Job não encontrado."), 404
        resultado = dict(job)
    return jsonify(ok=True, **resultado)


# --- DELETAR VEÍCULOS EM MASSA (Área de Importação) ---
# Planilha de entrada: uma única coluna (A) com o Código de integração do
# veículo em cada linha. Mesmo padrão de job/thread/polling do envio de
# comando em massa — uma linha que falha é registrada e não trava as demais.
DELETAR_VEICULOS_UPLOADS = {}
DELETAR_VEICULOS_UPLOADS_LOCK = threading.Lock()
DELETAR_VEICULOS_JOBS = {}
DELETAR_VEICULOS_JOBS_LOCK = threading.Lock()


@app.route("/api/deletar-veiculos/upload", methods=["POST"])
@requer_operador
def deletar_veiculos_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    conteudo = request.files["arquivo"].read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(conteudo))
        sheet = wb.active
        # Primeira linha é cabeçalho (mesma convenção das outras importações do app).
        codigos = [
            str(cell.value).strip()
            for cell in list(sheet["A"])[1:]
            if cell.value is not None and str(cell.value).strip()
        ]
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler Excel: {e}"), 400
    if not codigos:
        return jsonify(ok=False, error="Nenhum código de integração encontrado na coluna A (a partir da linha 2)."), 400
    file_id = uuid.uuid4().hex
    with DELETAR_VEICULOS_UPLOADS_LOCK:
        DELETAR_VEICULOS_UPLOADS[file_id] = codigos
    return jsonify(ok=True, file_id=file_id, total_linhas=len(codigos))


def _executar_deletar_veiculos(job_id, codigos, token):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    sucessos = erros = 0
    for i, codigo in enumerate(codigos):
        try:
            r = requests.post(
                f"{BASE_URL}/Administration/Vehicle/Delete",
                json=codigo,
                headers=headers,
                timeout=20,
            )
            if r.status_code in (200, 201):
                sucessos += 1
                mensagem = f"Linha {i + 1}: código {codigo} excluído."
            else:
                erros += 1
                mensagem = f"Erro linha {i + 1} (código {codigo}): HTTP {r.status_code} — {r.text[:200]}"
        except requests.exceptions.RequestException as e:
            erros += 1
            mensagem = f"Erro linha {i + 1} (código {codigo}): {e}"

        with DELETAR_VEICULOS_JOBS_LOCK:
            job = DELETAR_VEICULOS_JOBS[job_id]
            job["logs"].append(mensagem)
            job["atual"] = i + 1
            job["sucessos"] = sucessos
            job["erros"] = erros

    with DELETAR_VEICULOS_JOBS_LOCK:
        DELETAR_VEICULOS_JOBS[job_id]["status"] = "concluido"


@app.route("/api/deletar-veiculos/executar", methods=["POST"])
@requer_operador
def deletar_veiculos_executar():
    body = request.get_json(force=True) or {}
    token, erro_resp, status = _token_para(body.get("idcentral"))
    if erro_resp:
        return erro_resp, status

    file_id = body.get("file_id")

    with DELETAR_VEICULOS_UPLOADS_LOCK:
        codigos = DELETAR_VEICULOS_UPLOADS.pop(file_id, None)
    if codigos is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400

    job_id = uuid.uuid4().hex
    with DELETAR_VEICULOS_JOBS_LOCK:
        DELETAR_VEICULOS_JOBS[job_id] = {
            "status": "rodando", "atual": 0, "total": len(codigos),
            "sucessos": 0, "erros": 0, "logs": [],
        }

    threading.Thread(
        target=_executar_deletar_veiculos,
        args=(job_id, codigos, token),
        daemon=True,
    ).start()

    return jsonify(ok=True, job_id=job_id, total=len(codigos))


@app.route("/api/deletar-veiculos/status/<job_id>")
def deletar_veiculos_status(job_id):
    with DELETAR_VEICULOS_JOBS_LOCK:
        job = DELETAR_VEICULOS_JOBS.get(job_id)
        if not job:
            return jsonify(ok=False, error="Job não encontrado."), 404
        resultado = dict(job)
    return jsonify(ok=True, **resultado)


# --- ASSOCIAR RASTREADORES EM MASSA (Área de Importação) ---
# Planilha de entrada: coluna A = VehicleIntegrationCode, coluna B =
# TrackerIntegrationCode. "Number" (posição do rastreador no veículo) é
# sempre 1 nesse fluxo. Mesmo padrão de job/thread/polling dos outros dois.
ASSOCIAR_RASTREADORES_UPLOADS = {}
ASSOCIAR_RASTREADORES_UPLOADS_LOCK = threading.Lock()
ASSOCIAR_RASTREADORES_JOBS = {}
ASSOCIAR_RASTREADORES_JOBS_LOCK = threading.Lock()


@app.route("/api/associar-rastreadores/upload", methods=["POST"])
@requer_operador
def associar_rastreadores_upload():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    conteudo = request.files["arquivo"].read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(conteudo))
        sheet = wb.active
        # Primeira linha é cabeçalho (mesma convenção das outras importações do app).
        col_a = [cell.value for cell in list(sheet["A"])[1:]]
        col_b = [cell.value for cell in list(sheet["B"])[1:]]
        pares = []
        for veiculo, rastreador in zip(col_a, col_b):
            veiculo = str(veiculo).strip() if veiculo is not None else ""
            rastreador = str(rastreador).strip() if rastreador is not None else ""
            if veiculo and rastreador:
                pares.append((veiculo, rastreador))
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler Excel: {e}"), 400
    if not pares:
        return jsonify(ok=False, error="Nenhum par veículo/rastreador encontrado nas colunas A e B (a partir da linha 2)."), 400
    file_id = uuid.uuid4().hex
    with ASSOCIAR_RASTREADORES_UPLOADS_LOCK:
        ASSOCIAR_RASTREADORES_UPLOADS[file_id] = pares
    return jsonify(ok=True, file_id=file_id, total_linhas=len(pares))


def _executar_associar_rastreadores(job_id, pares, token):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    sucessos = erros = 0
    for i, (veiculo, rastreador) in enumerate(pares):
        try:
            r = requests.post(
                f"{BASE_URL}/Administration/Vehicle/AssociateTracker",
                json={"VehicleIntegrationCode": veiculo, "Number": 1, "TrackerIntegrationCode": rastreador},
                headers=headers,
                timeout=20,
            )
            if r.status_code in (200, 201):
                sucessos += 1
                mensagem = f"Linha {i + 1}: veículo {veiculo} associado ao rastreador {rastreador}."
            else:
                erros += 1
                mensagem = f"Erro linha {i + 1} (veículo {veiculo}, rastreador {rastreador}): HTTP {r.status_code} — {r.text[:200]}"
        except requests.exceptions.RequestException as e:
            erros += 1
            mensagem = f"Erro linha {i + 1} (veículo {veiculo}, rastreador {rastreador}): {e}"

        with ASSOCIAR_RASTREADORES_JOBS_LOCK:
            job = ASSOCIAR_RASTREADORES_JOBS[job_id]
            job["logs"].append(mensagem)
            job["atual"] = i + 1
            job["sucessos"] = sucessos
            job["erros"] = erros

    with ASSOCIAR_RASTREADORES_JOBS_LOCK:
        ASSOCIAR_RASTREADORES_JOBS[job_id]["status"] = "concluido"


@app.route("/api/associar-rastreadores/executar", methods=["POST"])
@requer_operador
def associar_rastreadores_executar():
    body = request.get_json(force=True) or {}
    token, erro_resp, status = _token_para(body.get("idcentral"))
    if erro_resp:
        return erro_resp, status

    file_id = body.get("file_id")

    with ASSOCIAR_RASTREADORES_UPLOADS_LOCK:
        pares = ASSOCIAR_RASTREADORES_UPLOADS.pop(file_id, None)
    if pares is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400

    job_id = uuid.uuid4().hex
    with ASSOCIAR_RASTREADORES_JOBS_LOCK:
        ASSOCIAR_RASTREADORES_JOBS[job_id] = {
            "status": "rodando", "atual": 0, "total": len(pares),
            "sucessos": 0, "erros": 0, "logs": [],
        }

    threading.Thread(
        target=_executar_associar_rastreadores,
        args=(job_id, pares, token),
        daemon=True,
    ).start()

    return jsonify(ok=True, job_id=job_id, total=len(pares))


@app.route("/api/associar-rastreadores/status/<job_id>")
def associar_rastreadores_status(job_id):
    with ASSOCIAR_RASTREADORES_JOBS_LOCK:
        job = ASSOCIAR_RASTREADORES_JOBS.get(job_id)
        if not job:
            return jsonify(ok=False, error="Job não encontrado."), 404
        resultado = dict(job)
    return jsonify(ok=True, **resultado)


# --- CONVERSOR KML -> SSX (Áreas/Rotas) ---
# Motor de conversão em conversorkml.py (portado do projeto standalone "Conversor
# de Áreas e Rotas"), aqui só a camada web em cima das mesmas funções puras.
CONVERSOES = {}
CONVERSOES_LOCK = threading.Lock()
CONVERSOR_TAMANHO_PARTE = 1000  # abaixo do limite de importação do SSX, pra manter os arquivos leves

# Avisos automáticos que aparecem em praticamente todo registro quando se força a
# conversão Rota -> Área (cada anel é fechado automaticamente). Sem compactar,
# um KML com milhares de Placemarks devolveria milhares de linhas "problemáticas"
# pro navegador renderizar (mesmo travamento que a tela de migração já evita).
CONVERSOR_AVISOS_COMPACTAVEIS = (
    "GeoIntegrationCode truncado",
    "polígono fechado automaticamente",
    "Coordenadas excedem",
)


@app.route("/api/conversor/converter", methods=["POST"])
def conversor_converter():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    arquivo = request.files["arquivo"]

    tipo = request.form.get("tipo", "areas")
    categoria = request.form.get("categoria", "").strip() or None
    grupo = request.form.get("grupo", "").strip() or None
    tolerancia_texto = request.form.get("tolerancia", "").strip()
    tolerancia = None
    if tolerancia_texto:
        try:
            tolerancia = int(tolerancia_texto)
        except ValueError:
            return jsonify(ok=False, error=f"Tolerância deve ser um número inteiro: '{tolerancia_texto}'"), 400

    cor_texto = request.form.get("cor", "").strip()
    cor = None
    if cor_texto:
        try:
            cor = int(cor_texto)
        except ValueError:
            return jsonify(ok=False, error=f"Cor inválida: '{cor_texto}'"), 400
        if cor not in range(1, 14):
            return jsonify(ok=False, error="Cor deve ser um código de 1 a 13 (ver tabela do manual)."), 400

    try:
        kml_text = conversorkml.extrair_texto_kml(arquivo.read())
    except UnicodeDecodeError:
        return jsonify(ok=False, error="Arquivo KML não está em UTF-8."), 400
    except zipfile.BadZipFile:
        return jsonify(ok=False, error="Arquivo KMZ corrompido ou inválido."), 400
    except ValueError as e:
        return jsonify(ok=False, error=str(e)), 400

    config = conversorkml.Config(
        categoria=categoria,
        grupo=grupo,
        tolerancia=tolerancia,
        cor=cor,
        forcar_poligono=(tipo == "areas"),
    )

    try:
        registros = conversorkml.processar(kml_text, config)
    except ValueError as e:
        return jsonify(ok=False, error=str(e)), 400

    nome_base = os.path.splitext(arquivo.filename or "conversao")[0]
    conv_id = uuid.uuid4().hex
    with CONVERSOES_LOCK:
        CONVERSOES[conv_id] = {"registros": registros, "nome_base": nome_base, "sufixo": tipo}

    n_erro = sum(1 for r in registros if r["erros"])
    n_ok = len(registros) - n_erro
    n_partes = -(-n_ok // CONVERSOR_TAMANHO_PARTE) if n_ok > CONVERSOR_TAMANHO_PARTE else 1

    avisos_compactados = {"geo_truncado": 0, "anel_fechado": 0, "coordenadas_longas": 0}
    problematicos = []
    for r in registros:
        if not r["erros"] and not r["avisos"]:
            continue
        so_compactaveis = not r["erros"] and all(
            any(chave in av for chave in CONVERSOR_AVISOS_COMPACTAVEIS) for av in r["avisos"]
        )
        if so_compactaveis:
            for av in r["avisos"]:
                if "GeoIntegrationCode truncado" in av:
                    avisos_compactados["geo_truncado"] += 1
                elif "polígono fechado automaticamente" in av:
                    avisos_compactados["anel_fechado"] += 1
                elif "Coordenadas excedem" in av:
                    avisos_compactados["coordenadas_longas"] += 1
            continue
        problematicos.append({
            "indice": r["indice"],
            "nome": r["nome"],
            "tipo_original": r["tipo_original"],
            "convertido": r["convertido"],
            "codigo": r["dados"].get("GeoIntegrationCode", ""),
            "erros": r["erros"],
            "avisos": r["avisos"],
        })

    # Teto de linhas detalhadas na tela: com KMLs de milhares de Placemarks e um
    # aviso genérico (ex.: descrição longa) presente em quase todo registro, a
    # lista completa ainda poderia estourar e travar o navegador ao renderizar.
    LIMITE_PROBLEMATICOS = 500
    problematicos_ocultos = max(0, len(problematicos) - LIMITE_PROBLEMATICOS)
    problematicos = problematicos[:LIMITE_PROBLEMATICOS]

    return jsonify(
        ok=True,
        conv_id=conv_id,
        total=len(registros),
        n_ok=n_ok,
        n_erro=n_erro,
        n_partes=n_partes,
        tamanho_parte=CONVERSOR_TAMANHO_PARTE,
        max_linhas_importacao=conversorkml.MAX_LINHAS_IMPORTACAO,
        avisos_compactados=avisos_compactados,
        problematicos=problematicos,
        problematicos_ocultos=problematicos_ocultos,
    )


@app.route("/api/conversor/download/<conv_id>/<formato>/<int:parte>")
def conversor_download(conv_id, formato, parte):
    with CONVERSOES_LOCK:
        dados = CONVERSOES.get(conv_id)
    if not dados:
        return jsonify(ok=False, error="Conversão não encontrada. Converta novamente."), 404
    if formato not in ("kml", "csv"):
        return jsonify(ok=False, error="Formato inválido."), 400

    validos = [r for r in dados["registros"] if not r["erros"]]
    inicio = (parte - 1) * CONVERSOR_TAMANHO_PARTE
    fatia = validos[inicio:inicio + CONVERSOR_TAMANHO_PARTE]
    if not fatia:
        return jsonify(ok=False, error="Parte não encontrada."), 404

    sufixo = dados["sufixo"]
    n_partes = -(-len(validos) // CONVERSOR_TAMANHO_PARTE) if len(validos) > CONVERSOR_TAMANHO_PARTE else 1
    sufixo_parte = f"_parte{parte}" if n_partes > 1 else ""

    if formato == "kml":
        conteudo = conversorkml.gerar_kml(fatia).encode("utf-8")
        mimetype = "application/vnd.google-earth.kml+xml"
        nome_arquivo = f"{dados['nome_base']}_SSX_{sufixo}{sufixo_parte}.kml"
    else:
        conteudo = conversorkml.gerar_csv(fatia).encode("ascii", errors="ignore")
        mimetype = "text/csv"
        nome_arquivo = f"{dados['nome_base']}_SSX_{sufixo}{sufixo_parte}.csv"

    return Response(
        conteudo,
        mimetype=mimetype,
        headers={"Content-Disposition": f'attachment; filename="{nome_arquivo}"'},
    )


# --- FEED (publicações da equipe, estilo comunidade: curtidas e comentários) ---
# Publicação pode ser geral ou vinculada a um cliente.
FEED_PAGINA = 20
FEED_PAGINA_MAX = 100
FEED_TEXTO_MAX = 2000


def _feed_pode_excluir(autor_id):
    return session.get("app_usuario_id", "") == autor_id or session.get("app_usuario_perfil") == "adm"


def _feed_texto_valido(data):
    texto = str(data.get("texto", "")).strip()
    return texto if texto and len(texto) <= FEED_TEXTO_MAX else None


#  "autor_id" fixo (não é o id de nenhum Usuario real) — o post sai como
# publicado por uma espécie de mascote do sistema, não pela própria pessoa
# aniversariante, então só admin apaga (ver _feed_pode_excluir).
SASHA_AUTOR_ID = "sasha-robo"
SASHA_AUTOR_NOME = "Sasha Robô"


def _gerar_posts_aniversario_hoje():
    """Publica automaticamente no feed quem faz aniversário hoje (campo
    "aniversario" de Minha Conta), assinado pela Sasha Robô. "aniversario_post_em"
    (Usuario, Postgres) guarda a última data (YYYY-MM-DD) em que já postou —
    sem isso, cada carregamento do feed no dia criaria um post novo."""
    hoje = _hoje_mm_dd()
    hoje_iso = _hoje_iso()
    for usuario in usuarios_sql.usuarios_aniversariantes_hoje(hoje):
        if usuario.get("aniversario_post_em") == hoje_iso:
            continue
        nome = f"{usuario.get('nome', '')} {usuario.get('sobrenome', '')}".strip() or usuario.get("usuario", "")
        feed_sql.criar_post(
            texto=f"🎉 Hoje é aniversário de {nome}! A equipe deseja um feliz aniversário!",
            autor_id=SASHA_AUTOR_ID, autor_nome=SASHA_AUTOR_NOME,
            cliente_id=None, cliente_nome="", tipo="aniversario",
        )
        usuarios_sql.marcar_aniversario_postado(usuario["id"], hoje_iso)


@app.route("/api/feed", methods=["GET"])
def listar_feed():
    """Publicações mais recentes primeiro, paginadas pelo `criado_em` da última
    (cursor `antes_de`). `limite` deixa o front recarregar tudo que já está na
    tela de uma vez, sem perder as páginas já carregadas."""
    if not request.args.get("antes_de", "").strip():
        # Só na primeira página (não em "carregar mais") — ponto natural em
        # que todo mundo que abre o Feed passa, sem precisar de agendador.
        _gerar_posts_aniversario_hoje()
    try:
        limite = min(max(int(request.args.get("limite", FEED_PAGINA)), 1), FEED_PAGINA_MAX)
    except ValueError:
        limite = FEED_PAGINA
    antes_de = request.args.get("antes_de", "").strip()
    cursor = None
    if antes_de:
        try:
            cursor = datetime.fromisoformat(antes_de)
        except ValueError:
            return jsonify(ok=False, error="Cursor inválido."), 400
    posts = feed_sql.listar_feed(cursor, limite, session.get("app_usuario_id", ""), _sou_admin())
    return jsonify(ok=True, posts=posts)


@app.route("/api/feed", methods=["POST"])
@requer_operador
def criar_post_feed():
    data = request.get_json(force=True) or {}
    texto = _feed_texto_valido(data)
    if texto is None:
        return jsonify(ok=False, error=f"Escreva a publicação (até {FEED_TEXTO_MAX} caracteres)."), 400

    cliente_id_raw = str(data.get("cliente_id", "")).strip()
    cliente_id, cliente_nome = None, ""
    if cliente_id_raw:
        if not cliente_id_raw.isdigit():
            return jsonify(ok=False, error="Cliente não encontrado."), 404
        cliente = clientes_sql.buscar_cliente_por_id(int(cliente_id_raw))
        if not cliente:
            return jsonify(ok=False, error="Cliente não encontrado."), 404
        cliente_id, cliente_nome = cliente["id"], cliente["cliente"]

    post = feed_sql.criar_post(
        texto=texto, autor_id=session.get("app_usuario_id", ""), autor_nome=session.get("app_usuario_nome", ""),
        cliente_id=cliente_id, cliente_nome=cliente_nome,
    )
    registrar_acao(
        acao="criar", entidade_tipo="post", entidade_id=post["id"],
        entidade_nome=texto[:80], titulo="Publicação no feed",
        cliente_id=cliente_id, cliente_nome=cliente_nome,
    )
    return jsonify(ok=True, post=post)


@app.route("/api/feed/<int:post_id>", methods=["DELETE"])
@requer_operador
def excluir_post_feed(post_id):
    post = feed_sql.buscar_post(post_id)
    if not post:
        return jsonify(ok=False, error="Publicação não encontrada."), 404
    if not _feed_pode_excluir(post.get("autor_id", "")):
        return jsonify(ok=False, error="Só quem publicou (ou um admin) pode excluir."), 403
    # Comentários/curtidas somem junto via ON DELETE CASCADE.
    feed_sql.excluir_post(post_id)
    registrar_acao(
        acao="excluir", entidade_tipo="post", entidade_id=post_id,
        entidade_nome=str(post.get("texto", ""))[:80], titulo="Publicação excluída do feed",
        cliente_id=post.get("cliente_id") or None, cliente_nome=post.get("cliente_nome", ""),
    )
    return jsonify(ok=True)


@app.route("/api/feed/<int:post_id>/curtir", methods=["POST"])
@requer_operador
def curtir_post_feed(post_id):
    if not feed_sql.buscar_post(post_id):
        return jsonify(ok=False, error="Publicação não encontrada."), 404
    curtido, total = feed_sql.alternar_curtida(post_id, session.get("app_usuario_id", ""))
    return jsonify(ok=True, curtido_por_mim=curtido, curtidas_total=total)


@app.route("/api/feed/<int:post_id>/comentarios", methods=["GET"])
def listar_comentarios_feed(post_id):
    comentarios = feed_sql.listar_comentarios(post_id)
    for c in comentarios:
        c["pode_excluir"] = _feed_pode_excluir(c.get("autor_id", ""))
    return jsonify(ok=True, comentarios=comentarios)


@app.route("/api/feed/<int:post_id>/comentarios", methods=["POST"])
@requer_operador
def criar_comentario_feed(post_id):
    data = request.get_json(force=True) or {}
    texto = _feed_texto_valido(data)
    if texto is None:
        return jsonify(ok=False, error=f"Escreva o comentário (até {FEED_TEXTO_MAX} caracteres)."), 400
    if not feed_sql.buscar_post(post_id):
        return jsonify(ok=False, error="Publicação não encontrada."), 404

    comentario = feed_sql.criar_comentario(
        post_id, texto, session.get("app_usuario_id", ""), session.get("app_usuario_nome", ""),
    )
    comentario["pode_excluir"] = True  # quem comenta sempre pode excluir o próprio comentário
    return jsonify(ok=True, comentario=comentario)


@app.route("/api/feed/comentarios/<int:comentario_id>", methods=["DELETE"])
@requer_operador
def excluir_comentario_feed(comentario_id):
    comentario = feed_sql.buscar_comentario(comentario_id)
    if not comentario:
        return jsonify(ok=False, error="Comentário não encontrado."), 404
    if not _feed_pode_excluir(comentario.get("autor_id", "")):
        return jsonify(ok=False, error="Só quem comentou (ou um admin) pode excluir."), 403
    feed_sql.excluir_comentario(comentario_id)
    return jsonify(ok=True)


if __name__ == "__main__":
    # threaded=True: sem isso, o servidor de dev do Werkzeug atende 1
    # requisição POR VEZ pro processo inteiro — qualquer chamada lenta em
    # andamento (ex.: sincronizar planilha de CS, criar planilha no Drive,
    # qualquer chamada à API do Google Sheets/Drive) prende TODAS as outras
    # abas/requisições até terminar, inclusive rotas que já são rápidas
    # (como /api/migracao/clientes). É a causa mais provável de "às vezes
    # trava, às vezes não" no ambiente local — em produção isso é papel do
    # gunicorn (múltiplos workers), não desse app.run().
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
