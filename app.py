import base64
import hashlib
import io
import json
import os
import re
import threading
import time
import unicodedata
import uuid
import zlib
from functools import wraps

import firebase_admin
import openpyxl
import pandas as pd
import requests
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from flask import Flask, Response, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

import conversorkml
import validador_importacao
from auditoria import diff_campos, registrar_acao

app = Flask(__name__)
app.secret_key = os.environ.get("MIGRACAO_SECRET_KEY", os.urandom(24))
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# Sobe 0.1 a cada edição publicada (3.0 -> 3.1 -> 3.2 ...); só sobe o inteiro quando pedido.
APP_VERSION = "4.0"

BASE_URL = "https://integration.systemsatx.com.br"

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
CREDENCIAIS_COLLECTION = "credenciais"
# Credencial da SSX por cliente (Fase 3b) — coleção própria, documento = idcentral,
# pra nunca duplicar/dessincronizar entre implantacao_clientes e migracao_clientes.
CREDENCIAIS_CLIENTE_COLLECTION = "credenciais_cliente"

# --- CONTAS DE ACESSO À PRÓPRIA FERRAMENTA (protege o app quando publicado na internet) ---
# Guardadas no Firestore (coleção "app_usuarios") — a migração dessa tabela pro Postgres
# (Fase 1 de schema_relacional_alvo_v3, ver models.Usuario/migrar_usuarios_para_postgres.py)
# está PRONTA MAS NÃO ATIVA: produção hoje é o Render (usuários reais, sem Postgres
# provisionado lá ainda) e o destino combinado pro Postgres é o servidor da empresa,
# ainda sem data definida. Quando esse banco existir de verdade, trocar estas funções
# pra usar obter_sessao()/models.Usuario (a versão anterior deste arquivo já tinha essa
# implementação pronta) e rodar migrar_usuarios_para_postgres.py --apply uma vez.
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


def _sem_usuarios_cadastrados():
    return len(list(db.collection(APP_USUARIOS_COLLECTION).limit(1).stream())) == 0


def _buscar_usuario_app(usuario):
    usuario_norm = usuario.strip().lower()
    docs = db.collection(APP_USUARIOS_COLLECTION).where(
        filter=FieldFilter("usuario_norm", "==", usuario_norm)
    ).limit(1).stream()
    for d in docs:
        return dict(d.to_dict(), id=d.id)
    return None


def _buscar_usuario_por_id(usuario_id):
    if not usuario_id:
        return None
    doc = db.collection(APP_USUARIOS_COLLECTION).document(usuario_id).get()
    return dict(doc.to_dict(), id=doc.id) if doc.exists else None


def _perfil_de_usuario(dados_usuario):
    """Lê o perfil de um doc de app_usuarios. Compatível com docs antigos que só têm
    a flag booleana 'admin' (de antes do perfil/área existirem): admin=True vira 'adm',
    o resto vira o perfil padrão."""
    perfil = dados_usuario.get("perfil")
    if perfil in PERFIS_USUARIO:
        return perfil
    return "adm" if dados_usuario.get("admin") else PERFIL_PADRAO


def _contar_admins(excluir_id=None):
    total = 0
    for d in db.collection(APP_USUARIOS_COLLECTION).stream():
        if excluir_id and d.id == excluir_id:
            continue
        if _perfil_de_usuario(d.to_dict()) == "adm":
            total += 1
    return total


def _criar_usuario_app(usuario, senha, perfil=PERFIL_PADRAO, area=None, nome_responsavel=""):
    doc_ref = db.collection(APP_USUARIOS_COLLECTION).document()
    dados = {
        "usuario": usuario,
        "usuario_norm": usuario.strip().lower(),
        "senha_hash": generate_password_hash(senha),
        "perfil": perfil,
        "area": area or None,
        "nome_responsavel": nome_responsavel,
    }
    doc_ref.set(dados)
    return dict(dados, id=doc_ref.id)


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
    # foto em si é servida por /api/app-usuario/foto, lida do Firestore por request.
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


@app.route("/login-app", methods=["GET", "POST"])
def login_app():
    # Sessão ainda válida (ex.: usuário clicou "Voltar" no navegador e caiu aqui) —
    # manda direto pro app em vez de reexibir o formulário de login.
    if session.get("app_ok"):
        return redirect(url_for("index"))
    modo_setup = _sem_usuarios_cadastrados()
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
                novo = _criar_usuario_app(usuario, senha, perfil="adm")
                _sessao_login_app(novo)
                return redirect(url_for("index"))
        else:
            doc = _buscar_usuario_app(usuario) if usuario else None
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
    docs = db.collection(APP_USUARIOS_COLLECTION).stream()
    lista = [
        {
            "id": d.id,
            "usuario": d.to_dict().get("usuario"),
            "perfil": _perfil_de_usuario(d.to_dict()),
            "area": d.to_dict().get("area") or "",
            "nome_responsavel": d.to_dict().get("nome_responsavel", ""),
        }
        for d in docs
    ]
    return jsonify(ok=True, usuarios=lista)


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
    docs = db.collection(APP_USUARIOS_COLLECTION).stream()
    lista = []
    for d in docs:
        dados = d.to_dict()
        area_usuario = dados.get("area") or ""
        if area and area_usuario != area:
            continue
        if area_prefix and not area_usuario.startswith(area_prefix):
            continue
        lista.append({"id": d.id, "nome": (dados.get("nome_responsavel") or dados.get("usuario") or "")})
    lista.sort(key=lambda u: u["nome"].lower())
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
    if _buscar_usuario_app(usuario):
        return jsonify(ok=False, error="Já existe um usuário com esse nome."), 400
    novo = _criar_usuario_app(usuario, senha, perfil=perfil, area=area, nome_responsavel=nome_responsavel)
    return jsonify(ok=True, usuario=dict(
        id=novo["id"], usuario=novo["usuario"], perfil=novo["perfil"], area=novo["area"] or "",
        nome_responsavel=novo["nome_responsavel"],
    ))


@app.route("/api/app-usuarios/<usuario_id>", methods=["PUT"])
def editar_app_usuario(usuario_id):
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem gerenciar usuários."), 403
    data = request.get_json(force=True) or {}
    doc_ref = db.collection(APP_USUARIOS_COLLECTION).document(usuario_id)
    doc = doc_ref.get()
    if not doc.exists:
        return jsonify(ok=False, error="Usuário não encontrado."), 404

    atual = doc.to_dict()
    novo_nome = str(data.get("usuario", atual["usuario"])).strip()
    nova_senha = str(data.get("senha", "")).strip()
    perfil_atual = _perfil_de_usuario(atual)
    novo_perfil = str(data.get("perfil", perfil_atual)).strip()
    if novo_perfil not in PERFIS_USUARIO:
        novo_perfil = perfil_atual
    nova_area = str(data.get("area", atual.get("area") or "")).strip()
    if nova_area not in AREAS_USUARIO:
        nova_area = None
    novo_responsavel = str(data.get("nome_responsavel", atual.get("nome_responsavel", ""))).strip()

    if not novo_nome:
        return jsonify(ok=False, error="Informe o nome do usuário."), 400
    if nova_senha and len(nova_senha) < 4:
        return jsonify(ok=False, error="A senha deve ter pelo menos 4 caracteres."), 400

    outro = _buscar_usuario_app(novo_nome)
    if outro and outro["id"] != usuario_id:
        return jsonify(ok=False, error="Já existe um usuário com esse nome."), 400

    # Não deixa remover o último administrador (senão ninguém mais gerencia usuários).
    if perfil_atual == "adm" and novo_perfil != "adm":
        if _contar_admins(excluir_id=usuario_id) == 0:
            return jsonify(ok=False, error="Precisa existir pelo menos um administrador."), 400

    dados = {
        "usuario": novo_nome,
        "usuario_norm": novo_nome.lower(),
        "perfil": novo_perfil,
        "area": nova_area,
        "nome_responsavel": novo_responsavel,
        "senha_hash": atual["senha_hash"],
        # set() substitui o doc inteiro — sem isso, editar um usuário aqui (tela
        # de admin) apagaria os campos de perfil pessoal (ver /api/app-usuario/perfil).
        "nome": atual.get("nome", ""),
        "sobrenome": atual.get("sobrenome", ""),
        "aniversario": atual.get("aniversario", ""),
        "telefone_profissional": atual.get("telefone_profissional", ""),
        "email": atual.get("email", ""),
        "foto": atual.get("foto", ""),
    }
    if nova_senha:
        dados["senha_hash"] = generate_password_hash(nova_senha)

    doc_ref.set(dados)

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
    doc_ref = db.collection(APP_USUARIOS_COLLECTION).document(usuario_id)
    doc = doc_ref.get()
    if not doc.exists:
        return jsonify(ok=False, error="Usuário não encontrado."), 404
    if _perfil_de_usuario(doc.to_dict()) == "adm":
        if _contar_admins(excluir_id=usuario_id) == 0:
            return jsonify(ok=False, error="Precisa existir pelo menos um administrador."), 400
    doc_ref.delete()
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
    doc_ref = db.collection(APP_USUARIOS_COLLECTION).document(usuario_id)
    doc = doc_ref.get()
    if not doc.exists:
        return jsonify(ok=False, error="Usuário não encontrado."), 404
    if not check_password_hash(doc.to_dict()["senha_hash"], senha_atual):
        return jsonify(ok=False, error="Senha atual incorreta."), 400
    doc_ref.update({"senha_hash": generate_password_hash(senha_nova)})
    return jsonify(ok=True)


def _perfil_pessoal(usuario_doc):
    """Campos de "Minha Conta" — nunca inclui senha_hash/usuario_norm (uso interno)."""
    return {
        "usuario": usuario_doc.get("usuario", ""),
        "nome": usuario_doc.get("nome", ""),
        "sobrenome": usuario_doc.get("sobrenome", ""),
        "aniversario": usuario_doc.get("aniversario", ""),
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
    usuario_doc = _buscar_usuario_por_id(usuario_id)
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

    doc_ref = db.collection(APP_USUARIOS_COLLECTION).document(usuario_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Usuário não encontrado."), 404

    dados = {
        "nome": str(data.get("nome", "")).strip(),
        "sobrenome": str(data.get("sobrenome", "")).strip(),
        "aniversario": aniversario,
        "telefone_profissional": str(data.get("telefone_profissional", "")).strip(),
        "email": str(data.get("email", "")).strip(),
        "foto": foto,
    }
    doc_ref.update(dados)
    _marcar_foto_na_sessao(foto)
    return jsonify(ok=True, perfil=_perfil_pessoal(dict(dados, usuario=session.get("app_usuario_nome", ""))))


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
    doc_ref = db.collection(APP_USUARIOS_COLLECTION).document(usuario_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Usuário não encontrado."), 404
    doc_ref.update({"foto": foto})
    _marcar_foto_na_sessao(foto)
    return jsonify(ok=True)


@app.route("/api/app-usuario/foto")
def foto_meu_perfil():
    """Serve a foto de perfil como imagem de verdade (não fica na sessão —
    ver comentário em _sessao_login_app sobre o limite de 4KB do cookie)."""
    usuario_id = session.get("app_usuario_id")
    if not usuario_id:
        return "", 401
    usuario_doc = _buscar_usuario_por_id(usuario_id)
    foto = usuario_doc.get("foto") if usuario_doc else None
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
]
BOOL_FIELDS = ["Active", "ChangePasswordNextLogin", "SendPasswordEmail"]

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
    "uo": {
        "titulo": "UO",
        "endpoint": "/Administration/OrganizationalUnit/Insert",
        "defaults": {},
        "campos": [
            "Name", "OrganizationalUnitIntegrationCode", "TypeOrganizationalUnit",
            "ParentOrganizationalUnitIntegrationCode", "ClientIntegrationCode",
            "Note", "Active", "ExternalIntegrationCode",
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
    "uo": {},
    "usuario": {},
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
        endpoint="/Administration/Tracker/ListOutdatedTrackedUnits",
        payload=[{"PropertyName": "EventDate", "Condition": "Equal", "Value": None}],
        headers=["CLIENTE", "TRACKER", "UNIT"],
        campos=["ClientTradingName", "Tracker", "TrackedUnit"],
    ),
    "uos": dict(
        endpoint="/Administration/OrganizationalUnit/List",
        payload=None,
        headers=["NOME", "COD", "TIPO"],
        campos=["Name", "OrganizationalUnitIntegrationCode", "TypeOrganizationalUnit"],
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


def requisicao_padrao(endpoint, payload, token):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    r = requests.post(f"{BASE_URL}{endpoint}", json=payload if payload is not None else [], headers=headers, timeout=20)
    r.raise_for_status()
    return r.json()


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
    # Login manual (avulso) nunca fica vinculado a um cliente específico —
    # mesmo que a sessão já estivesse vinculada a um antes.
    session.pop("token_idcentral", None)
    return jsonify(ok=True)


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


@app.route("/api/ficha/<idcentral>/autenticar", methods=["POST"])
def ficha_autenticar(idcentral):
    doc = db.collection(CREDENCIAIS_CLIENTE_COLLECTION).document(idcentral).get()
    dados = doc.to_dict() if doc.exists else None
    if not dados or not dados.get("login") or not dados.get("senha"):
        return jsonify(ok=False, error="Esse cliente ainda não tem credencial da SSX cadastrada."), 400
    token, erro = _autenticar_ssx(dados["login"], dados["senha"])
    if erro:
        return jsonify(ok=False, error=erro), 400
    session["token"] = token
    session["token_idcentral"] = idcentral
    return jsonify(ok=True)


@app.route("/api/ficha/<idcentral>/sair", methods=["POST"])
def ficha_sair(idcentral):
    # Só limpa se a sessão realmente estiver vinculada a ESTE cliente — nunca
    # mexe numa autenticação avulsa (ou de outro cliente) por engano.
    if session.get("token_idcentral") == idcentral:
        session.pop("token", None)
        session.pop("token_idcentral", None)
    return jsonify(ok=True)


@app.route("/api/logout-avulso", methods=["POST"])
def logout_avulso():
    # Limpa só o token de login avulso (Área de Importação e Consulta), ao sair
    # da tela — igual ficha_sair acima, mas pro caso sem idcentral. Nunca mexe
    # numa sessão vinculada a cliente (token_idcentral setado), e diferente de
    # /api/logout (botão "Sair"), NÃO desloga da ferramenta em si.
    if not session.get("token_idcentral"):
        session.pop("token", None)
    return jsonify(ok=True)


@app.route("/api/ficha/<idcentral>/credencial", methods=["PUT"])
def ficha_salvar_credencial(idcentral):
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem alterar a credencial da SSX do cliente."), 403
    data = request.get_json(force=True) or {}
    login_novo = str(data.get("login", "")).strip()
    senha_nova = str(data.get("senha", ""))
    if not login_novo:
        return jsonify(ok=False, error="Informe o login."), 400
    doc_ref = db.collection(CREDENCIAIS_CLIENTE_COLLECTION).document(idcentral)
    dados_atuais = doc_ref.get().to_dict() or {}
    # Senha em branco = mantém a que já estava salva (mesmo padrão da senha de
    # usuário em "Gerenciar usuários" — não obriga redigitar pra só trocar o login).
    senha_final = senha_nova if senha_nova else dados_atuais.get("senha", "")
    if not senha_final:
        return jsonify(ok=False, error="Informe a senha."), 400
    doc_ref.set({"login": login_novo, "senha": senha_final})
    return jsonify(ok=True, login=login_novo, credencial_configurada=True)


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(ok=True)


# --- LOGINS SALVOS (para trocar de cliente rapidamente) ---
# Guardados no Firestore (coleção "credenciais"), sobrevive a redeploys.
# Admin-only: são senhas em texto puro, e essa lista não é vinculada a um
# cliente/dono específico — restrito assim pra não expor senha de terceiros
# a qualquer perfil logado.
@app.route("/api/credenciais", methods=["GET"])
def listar_credenciais():
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem ver os logins salvos."), 403
    docs = db.collection(CREDENCIAIS_COLLECTION).stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
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
    doc_ref = db.collection(CREDENCIAIS_COLLECTION).document()
    dados = {"nome": nome, "login": login, "senha": senha}
    doc_ref.set(dados)
    return jsonify(ok=True, credencial=dict(dados, id=doc_ref.id))


@app.route("/api/credenciais/<cred_id>", methods=["PUT"])
def editar_credencial(cred_id):
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem editar logins salvos."), 403
    data = request.get_json(force=True) or {}
    nome = str(data.get("nome", "")).strip()
    login = str(data.get("login", "")).strip()
    senha = str(data.get("senha", ""))
    if not nome or not login or not senha:
        return jsonify(ok=False, error="Informe nome, login e senha."), 400
    doc_ref = db.collection(CREDENCIAIS_COLLECTION).document(cred_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Login não encontrado."), 404
    dados = {"nome": nome, "login": login, "senha": senha}
    doc_ref.set(dados)
    return jsonify(ok=True, credencial=dict(dados, id=cred_id))


@app.route("/api/credenciais/<cred_id>", methods=["DELETE"])
def excluir_credencial(cred_id):
    if not _sou_admin():
        return jsonify(ok=False, error="Apenas administradores podem excluir logins salvos."), 403
    doc_ref = db.collection(CREDENCIAIS_COLLECTION).document(cred_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Login não encontrado."), 404
    doc_ref.delete()
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
IMPLANTACAO_SETORES = ["Implantação", "Migração", "Suporte", "Comercial"]
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
# TODO: itens provisórios — trocar pela lista real de cada marco.
IMPLANTACAO_CHECKLIST_PADRAO = {
    "marco-1": [
        {"id": "m1-kickoff", "texto": "Reunião de kickoff realizada"},
        {"id": "m1-acessos", "texto": "Acessos da plataforma enviados"},
    ],
    "marco-2": [
        {"id": "m2-treinamento", "texto": "Treinamento inicial realizado"},
        {"id": "m2-cadastros", "texto": "Cadastros básicos configurados"},
    ],
    "marco-3": [
        {"id": "m3-operacao", "texto": "Cliente operando na plataforma"},
    ],
    "marco-4": [
        {"id": "m4-validacao", "texto": "Validação da operação com o decisor"},
    ],
    "marco-5": [
        {"id": "m5-encerramento", "texto": "Reunião de encerramento da implantação"},
    ],
}


def _etapa_a_partir_dos_marcos(marcos_concluidos):
    for marco in IMPLANTACAO_MARCOS:
        if marco not in marcos_concluidos:
            return marco
    return "concluido"


def _marcos_concluidos_derivados(itens_feitos, itens_extras, concluidos_manual):
    """Marco conclui sozinho quando todos os itens dele (padrão + extras do
    cliente) estão feitos, ou quando foi marcado como concluído manualmente."""
    feitos = set(itens_feitos)
    concluidos = []
    for marco in IMPLANTACAO_MARCOS:
        ids = [i["id"] for i in IMPLANTACAO_CHECKLIST_PADRAO.get(marco, [])]
        ids += [i["id"] for i in itens_extras.get(marco, [])]
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
    return {
        "setor": setor,
        "titulo": titulo,
        "descricao": str(data.get("descricao", "")).strip(),
        "data": str(data.get("data", "")).strip(),
        "responsavel": str(data.get("responsavel", "")).strip(),
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


# --- CLIENTES (lista única, Fase de reestruturação) ---
# Substitui aos poucos "implantacao_clientes": em vez de uma coleção por setor,
# cada cliente tem um "estagio" (Implantação -> Onboarding -> Ongoing, sequencial,
# um só por vez). Migração NÃO é um estágio — é uma condição paralela com
# histórico de tentativas (ver "clientes/<id>/migracoes" mais abaixo).
# Por enquanto isso roda em paralelo com "implantacao_clientes"/"migracao_clientes"
# (aditivo, nada removido ainda) até os dados existentes serem migrados de verdade.
CLIENTES_COLLECTION = "clientes"
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
    }


def _idcentrals_existentes(excluir_id=None):
    """Mapa {idcentral: doc_id} de todo mundo em CLIENTES_COLLECTION (idcentral
    vazio fica de fora). Usado tanto pro cadastro/edição manual quanto pra
    importação em massa, pra barrar dois clientes com o mesmo IdCentral —
    a Ficha do Cliente (GET /api/ficha/<idcentral>) busca por esse campo com
    .limit(1), então uma duplicata deixaria o segundo cliente invisível."""
    mapa = {}
    for d in db.collection(CLIENTES_COLLECTION).stream():
        if excluir_id and d.id == excluir_id:
            continue
        idcentral = (d.to_dict() or {}).get("idcentral")
        if idcentral:
            mapa[idcentral] = d.id
    return mapa


def _recalcular_ultima_acao_cliente(cliente_id):
    """Mesmo racional de _recalcular_ultima_acao_implantacao, pra coleção nova."""
    doc_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id)
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


@app.route("/api/clientes", methods=["GET"])
def listar_clientes():
    docs = list(db.collection(CLIENTES_COLLECTION).stream())
    lista = []
    for d in docs:
        cliente = dict(d.to_dict(), id=d.id)
        cliente.setdefault("etapa", IMPLANTACAO_ETAPA_PADRAO)
        cliente.setdefault("marcos_concluidos", [])
        cliente.setdefault("estagio", ESTAGIO_CLIENTE_PADRAO)
        cliente.setdefault("ultima_acao", "")
        cliente.setdefault("ultima_acao_data", "")
        cliente.setdefault("momento", "")
        cliente.setdefault("flag", "")
        cliente.setdefault("vendedor", "")
        cliente.setdefault("persona", "")
        cliente.setdefault("decisor_nome", "")
        cliente.setdefault("decisor_whatsapp", "")
        cliente.setdefault("decisor_estado", "")
        cliente.setdefault("decisor_cidade", "")
        lista.append(cliente)
    lista.sort(key=lambda c: c["ultima_acao_data"], reverse=True)
    return jsonify(ok=True, clientes=lista)


@app.route("/api/clientes", methods=["POST"])
def criar_cliente():
    data = request.get_json(force=True) or {}
    dados = _dados_cliente(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o IdCentral do cliente."), 400
    if dados["idcentral"] in _idcentrals_existentes():
        return jsonify(ok=False, error="Já existe um cliente com esse IdCentral."), 400
    doc_ref = db.collection(CLIENTES_COLLECTION).document()
    doc_ref.set(dados)
    registrar_acao(
        acao="criar", entidade_tipo="cliente", entidade_id=doc_ref.id,
        entidade_nome=dados["cliente"], titulo="Cliente criado",
        cliente_id=doc_ref.id, idcentral=dados["idcentral"], cliente_nome=dados["cliente"],
    )
    return jsonify(ok=True, cliente=dict(dados, id=doc_ref.id))


@app.route("/api/clientes/<cliente_id>", methods=["PUT"])
def editar_cliente(cliente_id):
    data = request.get_json(force=True) or {}
    dados = _dados_cliente(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o IdCentral do cliente."), 400
    doc_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id)
    doc_atual = doc_ref.get()
    if not doc_atual.exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    doc_atual_dict = doc_atual.to_dict() or {}
    if not _sou_admin():
        dados["idcentral"] = doc_atual_dict.get("idcentral", "")
    if dados["idcentral"] in _idcentrals_existentes(excluir_id=cliente_id):
        return jsonify(ok=False, error="Já existe um cliente com esse IdCentral."), 400
    dados["ultima_acao"] = doc_atual_dict.get("ultima_acao", "")
    dados["ultima_acao_data"] = doc_atual_dict.get("ultima_acao_data", "")
    # Etapa/marcos só mudam pelo endpoint dedicado (PUT .../marcos) — o
    # formulário geral não manda mais esses campos, então sem isso qualquer
    # edição comum (nome, objetivo...) resetaria o progresso pro Marco 1.
    dados["etapa"] = doc_atual_dict.get("etapa", IMPLANTACAO_ETAPA_PADRAO)
    dados["marcos_concluidos"] = doc_atual_dict.get("marcos_concluidos", [])
    # doc_ref.set() abaixo substitui o documento inteiro — o checklist dos
    # marcos (só escrito por PUT .../marcos) precisa ser carregado junto.
    for campo in ("marcos_itens_feitos", "marcos_itens_extras", "marcos_concluidos_manual"):
        if campo in doc_atual_dict:
            dados[campo] = doc_atual_dict[campo]
    mudancas = diff_campos(doc_atual_dict, dados, ROTULOS_CLIENTE)
    doc_ref.set(dados)
    if mudancas:
        registrar_acao(
            acao="editar", entidade_tipo="cliente", entidade_id=cliente_id,
            entidade_nome=dados["cliente"], mudancas=mudancas, titulo="Cliente editado",
            cliente_id=cliente_id, idcentral=dados["idcentral"], cliente_nome=dados["cliente"],
        )
    return jsonify(ok=True, cliente=dict(dados, id=cliente_id))


@app.route("/api/clientes/<cliente_id>/marcos", methods=["PUT"])
def salvar_marcos_cliente(cliente_id):
    data = request.get_json(force=True) or {}
    doc_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id)
    doc_atual = doc_ref.get()
    if not doc_atual.exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    doc_atual_dict = doc_atual.to_dict() or {}

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
    ids_validos = ids_extras | {i["id"] for itens in IMPLANTACAO_CHECKLIST_PADRAO.values() for i in itens}
    itens_feitos = [i for i in dict.fromkeys(data.get("itens_feitos") or []) if i in ids_validos]
    concluidos_manual = [m for m in IMPLANTACAO_MARCOS if m in (data.get("concluidos_manual") or [])]

    marcos_concluidos = _marcos_concluidos_derivados(itens_feitos, itens_extras, concluidos_manual)
    etapa = _etapa_a_partir_dos_marcos(marcos_concluidos)
    doc_ref.update({
        "marcos_itens_feitos": itens_feitos,
        "marcos_itens_extras": itens_extras,
        "marcos_concluidos_manual": concluidos_manual,
        "marcos_concluidos": marcos_concluidos,
        "etapa": etapa,
    })

    antes = set(doc_atual_dict.get("marcos_concluidos") or [])
    depois = set(marcos_concluidos)
    partes = [f"{m.replace('marco-', 'Marco ')} concluído" for m in IMPLANTACAO_MARCOS if m in depois - antes]
    partes += [f"{m.replace('marco-', 'Marco ')} reaberto" for m in IMPLANTACAO_MARCOS if m in antes - depois]
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
        marcos_concluidos_manual=concluidos_manual,
    )


@app.route("/api/clientes/<cliente_id>", methods=["DELETE"])
def excluir_cliente(cliente_id):
    doc_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id)
    doc_atual = doc_ref.get()
    if not doc_atual.exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    doc_atual_dict = doc_atual.to_dict() or {}
    for ev in doc_ref.collection("eventos").stream():
        ev.reference.delete()
    for mig in doc_ref.collection("migracoes").stream():
        for v in mig.reference.collection("veiculos").stream():
            v.reference.delete()
        for m in mig.reference.collection("modelos_comando").stream():
            m.reference.delete()
        mig.reference.delete()
    # Tarefas ficam numa coleção top-level (não subcoleção), por isso não somem
    # sozinhas com doc_ref.delete() como eventos/migracoes acima — precisa
    # apagar explicitamente, senão fica tarefa órfã apontando pra um cliente_id
    # que não existe mais.
    for tarefa in db.collection(TAREFAS_COLLECTION).where(filter=FieldFilter("cliente_id", "==", cliente_id)).stream():
        tarefa_dados = tarefa.to_dict() or {}
        tarefa.reference.delete()
        registrar_acao(
            acao="excluir", entidade_tipo="tarefa", entidade_id=tarefa.id,
            entidade_nome=tarefa_dados.get("titulo", ""), titulo="Tarefa excluída (cliente removido)",
            cliente_id=cliente_id, idcentral=doc_atual_dict.get("idcentral", ""),
            cliente_nome=doc_atual_dict.get("cliente", ""), tipo_historico="tarefa", tarefa_id=tarefa.id,
        )
    doc_ref.delete()
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

    clientes_por_idcentral = {}
    for d in db.collection(CLIENTES_COLLECTION).stream():
        dados = d.to_dict() or {}
        idc = str(dados.get("idcentral", "")).strip()
        if idc:
            clientes_por_idcentral[idc] = (d.id, dados)

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

    existentes = _idcentrals_existentes()
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
            novo_ref = db.collection(CLIENTES_COLLECTION).document()
            novo_ref.set(dados)
            existentes[novo["idcentral"]] = novo_ref.id
            criados += 1
        else:
            doc_ref = db.collection(CLIENTES_COLLECTION).document(item["cliente_id"])
            if not doc_ref.get().exists:
                ignorados.append({"idcentral": novo["idcentral"], "cliente": novo["cliente"],
                                   "motivo": "Cliente foi removido nesse meio tempo."})
                continue
            campos = {c: novo[c] for c in campos_chaves if not (c == "momento" and not novo[c])}
            campos["dados_planilha"] = item["linha_raw"]
            doc_ref.update(campos)
            atualizados += 1

    return jsonify(ok=True, criados=criados, atualizados=atualizados, ignorados=ignorados)


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

    existentes = _idcentrals_existentes()
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

    # Revalida os IdCentrals contra o Firestore na hora de gravar (pode ter
    # mudado desde o preview — ex.: outra pessoa importando ao mesmo tempo).
    existentes = _idcentrals_existentes()
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
        # .set() um por um (sem db.batch()): o Firestore fake usado pros testes
        # locais (dev_offline_preview.py) não implementa batch().
        db.collection(CLIENTES_COLLECTION).document().set(dados)
        sucessos += 1

    return jsonify(ok=True, sucessos=sucessos, erros=erros)


# --- LOCALIDADES (Estado/Cidade do Decisor) ---
# Estado é lista fixa (nunca muda). Município vem da API de Localidades do
# IBGE (pública, sem chave) — cache em memória por UF pra não repetir a
# chamada externa toda vez que alguém abrir o mesmo estado.
_CACHE_MUNICIPIOS_IBGE = {}


@app.route("/api/localidades/estados")
def listar_estados_brasil():
    return jsonify(ok=True, estados=ESTADOS_BRASIL)


@app.route("/api/localidades/municipios/<uf>")
def listar_municipios_ibge(uf):
    uf = uf.strip().upper()
    if uf not in SIGLAS_ESTADOS_BRASIL:
        return jsonify(ok=False, error="UF inválida."), 400
    if uf in _CACHE_MUNICIPIOS_IBGE:
        return jsonify(ok=True, municipios=_CACHE_MUNICIPIOS_IBGE[uf], cache=True)
    try:
        r = requests.get(
            f"https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios",
            timeout=10,
        )
        r.raise_for_status()
        municipios = sorted(m["nome"] for m in r.json())
    except (requests.exceptions.RequestException, ValueError, KeyError):
        return jsonify(ok=False, error="Não foi possível carregar os municípios agora. Tente novamente."), 502
    _CACHE_MUNICIPIOS_IBGE[uf] = municipios
    return jsonify(ok=True, municipios=municipios, cache=False)


@app.route("/api/clientes/<cliente_id>/eventos", methods=["GET"])
def listar_eventos_cliente(cliente_id):
    doc_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    docs = doc_ref.collection("eventos").stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    return jsonify(ok=True, eventos=lista)


@app.route("/api/clientes/<cliente_id>/eventos", methods=["POST"])
def criar_evento_cliente(cliente_id):
    doc_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    data = request.get_json(force=True) or {}
    dados = _dados_implantacao_evento(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o setor e o título."), 400
    evento_ref = doc_ref.collection("eventos").document()
    evento_ref.set(dados)
    _recalcular_ultima_acao_cliente(cliente_id)
    return jsonify(ok=True, evento=dict(dados, id=evento_ref.id))


@app.route("/api/clientes/<cliente_id>/eventos/<evento_id>", methods=["PUT"])
def editar_evento_cliente(cliente_id, evento_id):
    data = request.get_json(force=True) or {}
    dados = _dados_implantacao_evento(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o setor e o título."), 400
    evento_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("eventos").document(evento_id)
    if not evento_ref.get().exists:
        return jsonify(ok=False, error="Acontecimento não encontrado."), 404
    evento_ref.set(dados)
    _recalcular_ultima_acao_cliente(cliente_id)
    return jsonify(ok=True, evento=dict(dados, id=evento_id))


@app.route("/api/clientes/<cliente_id>/eventos/<evento_id>", methods=["DELETE"])
def excluir_evento_cliente(cliente_id, evento_id):
    evento_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("eventos").document(evento_id)
    if not evento_ref.get().exists:
        return jsonify(ok=False, error="Acontecimento não encontrado."), 404
    evento_ref.delete()
    _recalcular_ultima_acao_cliente(cliente_id)
    return jsonify(ok=True)


# --- TAREFAS (vinculadas a um cliente, atribuídas a um usuário do app) ---
# Coleção top-level (não subcoleção de clientes) de propósito: precisa ser
# consultada tanto por cliente_id (Ficha > Visão Geral) quanto por
# responsavel_id (Minha Conta > Tarefas) sem duplicar dado em dois lugares.
# cliente_nome/responsavel_nome ficam denormalizados no próprio doc da tarefa
# (mesmo racional de "ultima_acao" no cadastro do cliente) pra Minha Conta
# não precisar de 1 fetch extra por cliente diferente na lista.
TAREFAS_COLLECTION = "tarefas"
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
    """Sempre filtrado no Firestore (.where), nunca .stream() da coleção
    inteira — evita ler tarefa de todo mundo só pra montar a lista de 1
    cliente ou de 1 usuário."""
    cliente_id = request.args.get("cliente_id", "").strip()
    apenas_minhas = request.args.get("apenas_minhas") == "1"
    minhas_e_criadas = request.args.get("minhas_e_criadas") == "1"
    usuario_id = session.get("app_usuario_id", "")
    colecao = db.collection(TAREFAS_COLLECTION)
    if cliente_id:
        docs = list(colecao.where(filter=FieldFilter("cliente_id", "==", cliente_id)).stream())
    elif apenas_minhas:
        docs = list(colecao.where(filter=FieldFilter("responsavel_id", "==", usuario_id)).stream())
    elif minhas_e_criadas:
        # Central de tarefas (Minha Conta): as que são minhas + as que eu criei
        # pra outras pessoas (acompanhamento). Duas consultas simples em vez de
        # um OR, que exigiria índice composto no Firestore; o dict tira a
        # duplicata de quando eu criei uma tarefa pra mim mesmo.
        por_id = {}
        for campo in ("responsavel_id", "criado_por"):
            for d in colecao.where(filter=FieldFilter(campo, "==", usuario_id)).stream():
                por_id[d.id] = d
        docs = list(por_id.values())
    else:
        return jsonify(ok=False, error="Informe cliente_id, apenas_minhas=1 ou minhas_e_criadas=1."), 400
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    # Tarefa criada antes de criado_por_nome existir só tem o id — resolve o
    # nome aqui (1 leitura por criador distinto, não por tarefa).
    nomes_criadores = {}
    for t in lista:
        if t.get("criado_por_nome") or not t.get("criado_por"):
            continue
        uid = t["criado_por"]
        if uid not in nomes_criadores:
            u = _buscar_usuario_por_id(uid) or {}
            nomes_criadores[uid] = u.get("nome_responsavel") or u.get("usuario") or ""
        t["criado_por_nome"] = nomes_criadores[uid]
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
    cliente_id = str(data.get("cliente_id", "")).strip()
    cliente_dados = {}
    if cliente_id:
        cliente_doc = db.collection(CLIENTES_COLLECTION).document(cliente_id).get()
        if not cliente_doc.exists:
            return jsonify(ok=False, error="Cliente não encontrado."), 404
        cliente_dados = cliente_doc.to_dict() or {}

    responsavel_id = str(data.get("responsavel_id", "")).strip()
    responsavel_dados = _buscar_usuario_por_id(responsavel_id)
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
    doc_ref = db.collection(TAREFAS_COLLECTION).document()
    doc_ref.set(dados)
    registrar_acao(
        acao="criar", entidade_tipo="tarefa", entidade_id=doc_ref.id,
        entidade_nome=dados["titulo"], titulo="Tarefa criada",
        cliente_id=dados["cliente_id"] or None, idcentral=dados["idcentral"],
        cliente_nome=dados["cliente_nome"], tipo_historico="tarefa", tarefa_id=doc_ref.id,
    )
    return jsonify(ok=True, tarefa=dict(dados, id=doc_ref.id))


@app.route("/api/tarefas/<tarefa_id>", methods=["PUT"])
@requer_operador
def editar_tarefa(tarefa_id):
    doc_ref = db.collection(TAREFAS_COLLECTION).document(tarefa_id)
    atual = doc_ref.get()
    if not atual.exists:
        return jsonify(ok=False, error="Tarefa não encontrada."), 404
    data = request.get_json(force=True) or {}
    dados = _dados_tarefa(data)
    if dados is None:
        return jsonify(ok=False, error="Informe o título e uma data limite válida."), 400

    responsavel_id = str(data.get("responsavel_id", "")).strip()
    if responsavel_id:
        responsavel_dados = _buscar_usuario_por_id(responsavel_id)
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
        cliente_id = str(data.get("cliente_id", "")).strip()
        if cliente_id:
            cliente_doc = db.collection(CLIENTES_COLLECTION).document(cliente_id).get()
            if not cliente_doc.exists:
                return jsonify(ok=False, error="Cliente não encontrado."), 404
            cliente_dados = cliente_doc.to_dict() or {}
            dados["cliente_id"] = cliente_id
            dados["idcentral"] = cliente_dados.get("idcentral", "")
            dados["cliente_nome"] = cliente_dados.get("cliente", "")
        else:
            dados["cliente_id"] = ""
            dados["idcentral"] = ""
            dados["cliente_nome"] = ""

    doc_ref.update(dados)
    tarefa_completa = dict(atual.to_dict(), **dados, id=tarefa_id)
    mudancas = diff_campos(atual.to_dict(), tarefa_completa, ROTULOS_TAREFA)
    if mudancas:
        registrar_acao(
            acao="editar", entidade_tipo="tarefa", entidade_id=tarefa_id,
            entidade_nome=tarefa_completa.get("titulo", ""), mudancas=mudancas, titulo="Tarefa editada",
            cliente_id=tarefa_completa.get("cliente_id") or None, idcentral=tarefa_completa.get("idcentral", ""),
            cliente_nome=tarefa_completa.get("cliente_nome", ""), tipo_historico="tarefa", tarefa_id=tarefa_id,
        )
    return jsonify(ok=True, tarefa=tarefa_completa)


@app.route("/api/tarefas/<tarefa_id>/concluir", methods=["POST"])
@requer_operador
def concluir_tarefa(tarefa_id):
    doc_ref = db.collection(TAREFAS_COLLECTION).document(tarefa_id)
    doc_atual = doc_ref.get()
    if not doc_atual.exists:
        return jsonify(ok=False, error="Tarefa não encontrada."), 404
    dados_atuais = doc_atual.to_dict() or {}
    # "concluida" continua significando "encerrada" (sai da lista de pendentes)
    # — o desfecho de verdade fica em "resultado": concluída ou cancelada
    # (não pôde ser feita). Cancelar exige descrição, pra quem criou a tarefa
    # entender o porquê. Tarefa antiga encerrada sem "resultado" = concluída.
    data = request.get_json(silent=True) or {}
    resultado = data.get("resultado") if data.get("resultado") in TAREFA_RESULTADOS else "concluida"
    descricao = str(data.get("descricao", "")).strip()[:1000]
    if resultado == "cancelada" and not descricao:
        return jsonify(ok=False, error="Descreva por que a tarefa foi cancelada."), 400
    doc_ref.update({
        "concluida": True,
        "concluida_em": time.strftime("%Y-%m-%d"),
        "resultado": resultado,
        "resultado_descricao": descricao,
        "finalizada_por_nome": session.get("app_usuario_responsavel") or session.get("app_usuario_nome", ""),
    })
    registrar_acao(
        acao="concluir" if resultado == "concluida" else "cancelar", entidade_tipo="tarefa", entidade_id=tarefa_id,
        entidade_nome=dados_atuais.get("titulo", ""),
        titulo="Tarefa concluída" if resultado == "concluida" else "Tarefa cancelada",
        cliente_id=dados_atuais.get("cliente_id") or None, idcentral=dados_atuais.get("idcentral", ""),
        cliente_nome=dados_atuais.get("cliente_nome", ""), tipo_historico="tarefa", tarefa_id=tarefa_id,
    )
    return jsonify(ok=True)


@app.route("/api/tarefas/<tarefa_id>/reabrir", methods=["POST"])
@requer_operador
def reabrir_tarefa(tarefa_id):
    doc_ref = db.collection(TAREFAS_COLLECTION).document(tarefa_id)
    doc_atual = doc_ref.get()
    if not doc_atual.exists:
        return jsonify(ok=False, error="Tarefa não encontrada."), 404
    dados_atuais = doc_atual.to_dict() or {}
    doc_ref.update({
        "concluida": False, "concluida_em": "",
        "resultado": "", "resultado_descricao": "", "finalizada_por_nome": "",
    })
    registrar_acao(
        acao="reabrir", entidade_tipo="tarefa", entidade_id=tarefa_id,
        entidade_nome=dados_atuais.get("titulo", ""), titulo="Tarefa reaberta",
        cliente_id=dados_atuais.get("cliente_id") or None, idcentral=dados_atuais.get("idcentral", ""),
        cliente_nome=dados_atuais.get("cliente_nome", ""), tipo_historico="tarefa", tarefa_id=tarefa_id,
    )
    return jsonify(ok=True)


@app.route("/api/tarefas/<tarefa_id>", methods=["DELETE"])
@requer_operador
def excluir_tarefa(tarefa_id):
    doc_ref = db.collection(TAREFAS_COLLECTION).document(tarefa_id)
    doc_atual = doc_ref.get()
    if not doc_atual.exists:
        return jsonify(ok=False, error="Tarefa não encontrada."), 404
    dados_atuais = doc_atual.to_dict() or {}
    doc_ref.delete()
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
    "qtd_clientes": 0,
    "qtd_placas": 0,
    "percentual_migracao": 0,
    "etapa": MIGRACAO_ETAPA_PADRAO,
    "status": STATUS_MIGRACAO_PADRAO,
    "data_inicio": "",
    "data_fim": "",
    "motivo": "",
}


@app.route("/api/clientes/<cliente_id>/migracoes", methods=["GET"])
def listar_migracoes_cliente(cliente_id):
    doc_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    docs = doc_ref.collection("migracoes").stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    lista.sort(key=lambda m: m.get("data_inicio") or "", reverse=True)
    return jsonify(ok=True, migracoes=lista)


@app.route("/api/clientes/<cliente_id>/migracoes", methods=["POST"])
def iniciar_migracao_cliente(cliente_id):
    """Cria uma nova tentativa de migração — é o que o toggle "Tem Migração?
    Sim" do cadastro do cliente chama. Recusa se já existir uma em andamento."""
    doc_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    em_andamento = list(
        doc_ref.collection("migracoes")
        .where(filter=FieldFilter("status", "==", "em_andamento"))
        .limit(1)
        .stream()
    )
    if em_andamento:
        return jsonify(ok=False, error="Esse cliente já tem uma migração em andamento."), 400
    data = request.get_json(force=True) or {}
    dados = dict(CAMPOS_MIGRACAO_ATTEMPT_PADRAO)
    dados["plataforma_origem"] = str(data.get("plataforma_origem", "")).strip()
    dados["link_planilha"] = str(data.get("link_planilha", "")).strip()
    dados["data_inicio"] = time.strftime("%Y-%m-%d")
    migracao_ref = doc_ref.collection("migracoes").document()
    migracao_ref.set(dados)
    return jsonify(ok=True, migracao=dict(dados, id=migracao_ref.id))


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>", methods=["PUT"])
def editar_migracao_cliente(cliente_id, migracao_id):
    ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document(migracao_id)
    atual = ref.get()
    if not atual.exists:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    data = request.get_json(force=True) or {}
    atual_dados = atual.to_dict()
    atualizacoes = {
        "plataforma_origem": str(data.get("plataforma_origem", atual_dados.get("plataforma_origem", ""))).strip(),
        "link_planilha": str(data.get("link_planilha", atual_dados.get("link_planilha", ""))).strip(),
        "qtd_clientes": _para_int(data.get("qtd_clientes", atual_dados.get("qtd_clientes", 0))),
        "qtd_placas": _para_int(data.get("qtd_placas", atual_dados.get("qtd_placas", 0))),
        "percentual_migracao": _para_float(data.get("percentual_migracao", atual_dados.get("percentual_migracao", 0))),
    }
    etapa = str(data.get("etapa", "")).strip()
    if etapa in MIGRACAO_ETAPAS:
        atualizacoes["etapa"] = etapa
    ref.update(atualizacoes)
    return jsonify(ok=True, dados=dict(atual_dados, **atualizacoes))


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/finalizar", methods=["POST"])
def finalizar_migracao_cliente(cliente_id, migracao_id):
    """Ação simples de "terminou": marca concluída com a data de hoje."""
    ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document(migracao_id)
    if not ref.get().exists:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    dados = {"status": "concluida", "data_fim": time.strftime("%Y-%m-%d")}
    ref.update(dados)
    return jsonify(ok=True, **dados)


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/cancelar", methods=["POST"])
def cancelar_migracao_cliente(cliente_id, migracao_id):
    """Cancela uma migração em andamento — só existe esse caminho (pela Ficha,
    Configurações de Migração); o cadastro do cliente não deixa mais editar ou
    remover uma migração já ativa, só ver e iniciar quando não houver nenhuma."""
    ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document(migracao_id)
    if not ref.get().exists:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    data = request.get_json(force=True) or {}
    dados = {
        "status": "cancelada",
        "data_fim": time.strftime("%Y-%m-%d"),
        "motivo": str(data.get("motivo", "")).strip(),
    }
    ref.update(dados)
    return jsonify(ok=True, **dados)


# --- CLIENTES EM MIGRAÇÃO (coleção antiga, ainda em uso pelo frontend atual) ---
# Coleção independente: uma linha nasce quando alguém importa veículos com a
# opção "Criar planilha" marcada (não mais atrelada aos logins salvos).
MIGRACAO_COLLECTION = "migracao_clientes"
CAMPOS_MIGRACAO_PADRAO = {
    "nome": "",
    "idcentral": "",
    "cs": "",
    "plataforma_origem": "",
    "link_planilha": "",
    "qtd_clientes": 0,
    "qtd_placas": 0,
    "percentual_migracao": 0,
    "etapa": MIGRACAO_ETAPA_PADRAO,
}


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


def obter_ou_criar_cliente_migracao(nome):
    """Retorna o id da linha do cliente (por nome), criando-a se ainda não existir."""
    query = db.collection(MIGRACAO_COLLECTION).where(filter=FieldFilter("nome", "==", nome)).limit(1).stream()
    existente = next(query, None)
    if existente:
        return existente.id
    dados = dict(CAMPOS_MIGRACAO_PADRAO)
    dados["nome"] = nome
    doc_ref = db.collection(MIGRACAO_COLLECTION).document()
    doc_ref.set(dados)
    return doc_ref.id


def _veiculo_doc_id(cliente, veiculo):
    """ID determinístico por (cliente, veículo) — reimportar o mesmo veículo atualiza a
    linha existente em vez de duplicar."""
    chave = f"{cliente}||{veiculo}".encode("utf-8")
    return hashlib.sha1(chave).hexdigest()


STATUS_VEICULO_VALIDOS = ["Aguardando", "Enviar", "Enviado", "Migrado", "Cancelado"]
STATUS_VEICULO_PADRAO = "Aguardando"


def salvar_veiculos_migracao(cliente_migracao_id, veiculos):
    """Upsert por (cliente, veículo). Usa merge para não apagar 'comando'/'status' já definidos.
    Veículos novos entram com status "Aguardando"; veículos reimportados mantêm o status atual."""
    subcolecao = db.collection(MIGRACAO_COLLECTION).document(cliente_migracao_id).collection("veiculos")
    for v in veiculos:
        doc_id = _veiculo_doc_id(v["cliente"], v["veiculo"])
        doc_ref = subcolecao.document(doc_id)
        dados = dict(v)
        if not doc_ref.get().exists:
            dados["status"] = STATUS_VEICULO_PADRAO
        doc_ref.set(dados, merge=True)


def recalcular_contagens_migracao(cliente_migracao_id):
    """Recalcula qtd_clientes/qtd_placas a partir do total acumulado de veículos salvos.
    Só usado logo após uma importação (uma leitura da subcoleção por importação, não por
    edição de célula — o autosave usa atualizar_contagens_migracao, que não relê nada)."""
    subcolecao = db.collection(MIGRACAO_COLLECTION).document(cliente_migracao_id).collection("veiculos")
    docs = [d.to_dict() for d in subcolecao.stream()]
    clientes = {d.get("cliente") for d in docs if d.get("cliente")}
    placas = {d.get("veiculo") for d in docs if d.get("veiculo")}
    qtd_clientes, qtd_placas = len(clientes), len(placas)
    db.collection(MIGRACAO_COLLECTION).document(cliente_migracao_id).update({
        "qtd_clientes": qtd_clientes, "qtd_placas": qtd_placas,
    })
    return qtd_clientes, qtd_placas


@app.route("/api/migracao/clientes", methods=["GET"])
def listar_clientes_migracao():
    docs = db.collection(MIGRACAO_COLLECTION).stream()
    lista = []
    for d in docs:
        c = dict(d.to_dict(), id=d.id)
        c.setdefault("etapa", MIGRACAO_ETAPA_PADRAO)
        c.setdefault("idcentral", "")
        lista.append(c)
    lista.sort(key=lambda c: c["nome"].lower())
    return jsonify(ok=True, clientes=lista)


@app.route("/api/ficha/<idcentral>")
def obter_ficha_cliente(idcentral):
    """Busca o cliente único (coleção "clientes") por IdCentral, junto com o
    histórico de tentativas de migração dele. Mantém a chave "implantacao" (nome
    de antes da reestruturação) e uma "migracao" (singular = tentativa atual/mais
    recente) pra não precisar reescrever toda a Ficha de uma vez; "migracoes"
    (plural) é a lista completa, pro histórico."""
    doc_cliente = next(
        db.collection(CLIENTES_COLLECTION)
        .where(filter=FieldFilter("idcentral", "==", idcentral)).limit(1).stream(),
        None,
    )
    if not doc_cliente:
        return jsonify(ok=False, error="Nenhum cliente encontrado com esse IdCentral."), 404

    implantacao = dict(doc_cliente.to_dict(), id=doc_cliente.id)
    implantacao.setdefault("etapa", IMPLANTACAO_ETAPA_PADRAO)
    implantacao.setdefault("marcos_concluidos", [])
    implantacao.setdefault("estagio", ESTAGIO_CLIENTE_PADRAO)
    implantacao.setdefault("momento", "")
    implantacao.setdefault("flag", "")
    implantacao.setdefault("vendedor", "")
    implantacao.setdefault("persona", "")
    implantacao.setdefault("decisor_nome", "")
    implantacao.setdefault("decisor_whatsapp", "")
    implantacao.setdefault("decisor_estado", "")
    implantacao.setdefault("decisor_cidade", "")

    migracoes = [dict(d.to_dict(), id=d.id) for d in doc_cliente.reference.collection("migracoes").stream()]
    migracoes.sort(key=lambda m: m.get("data_inicio") or "", reverse=True)
    migracao_atual = next((m for m in migracoes if m.get("status") == "em_andamento"), None)
    if migracao_atual is None and migracoes:
        migracao_atual = migracoes[0]

    doc_cred = db.collection(CREDENCIAIS_CLIENTE_COLLECTION).document(idcentral).get()
    dados_cred = doc_cred.to_dict() if doc_cred.exists else None
    credencial_configurada = bool(dados_cred and dados_cred.get("login") and dados_cred.get("senha"))
    resposta = dict(
        ok=True,
        idcentral=idcentral,
        implantacao=implantacao,
        migracao=migracao_atual,
        migracoes=migracoes,
        credencial_configurada=credencial_configurada,
    )
    # O login em si só aparece pra admin (é quem cadastra/edita); pro resto dos
    # perfis, só o booleano "configurada" — o suficiente pra habilitar o botão
    # Autenticar sem expor a credencial.
    if _sou_admin() and dados_cred:
        resposta["credencial_login"] = dados_cred.get("login", "")
    return jsonify(**resposta)


@app.route("/api/migracao/clientes", methods=["POST"])
def criar_cliente_migracao():
    data = request.get_json(force=True) or {}
    nome = str(data.get("nome", "")).strip()
    if not nome:
        return jsonify(ok=False, error="Informe o nome do cliente."), 400
    cliente_id = obter_ou_criar_cliente_migracao(nome)
    doc = db.collection(MIGRACAO_COLLECTION).document(cliente_id).get()
    return jsonify(ok=True, cliente=dict(doc.to_dict(), id=cliente_id))


@app.route("/api/migracao/clientes/<cliente_id>", methods=["DELETE"])
def excluir_cliente_migracao(cliente_id):
    doc_ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    for v in doc_ref.collection("veiculos").stream():
        v.reference.delete()
    for m in doc_ref.collection("modelos_comando").stream():
        m.reference.delete()
    doc_ref.delete()
    return jsonify(ok=True)


@app.route("/api/migracao/clientes/<cliente_id>", methods=["PUT"])
def atualizar_cliente_migracao(cliente_id):
    doc_ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id)
    atual = doc_ref.get()
    if not atual.exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    data = request.get_json(force=True) or {}
    atual_dados = atual.to_dict()
    # Cada campo só é trocado se vier na requisição — senão mantém o valor que já
    # estava salvo. É o formulário na tela que hoje sempre manda tudo junto; isso
    # aqui é só pra rota também ficar segura pra uma chamada parcial (ex.: só
    # atualizar o idcentral) não zerar o resto do cadastro do cliente.
    dados = {
        "idcentral": str(data.get("idcentral", atual_dados.get("idcentral", ""))).strip(),
        "cs": str(data.get("cs", atual_dados.get("cs", ""))).strip(),
        "plataforma_origem": str(data.get("plataforma_origem", atual_dados.get("plataforma_origem", ""))).strip(),
        "link_planilha": str(data.get("link_planilha", atual_dados.get("link_planilha", ""))).strip(),
        "qtd_clientes": _para_int(data.get("qtd_clientes", atual_dados.get("qtd_clientes", 0))),
        "qtd_placas": _para_int(data.get("qtd_placas", atual_dados.get("qtd_placas", 0))),
        "percentual_migracao": _para_float(data.get("percentual_migracao", atual_dados.get("percentual_migracao", 0))),
    }
    etapa = str(data.get("etapa", "")).strip()
    if etapa in MIGRACAO_ETAPAS:
        dados["etapa"] = etapa
    if not _sou_admin():
        # Mesma regra da Implantação: só admin altera um IdCentral já existente.
        dados["idcentral"] = atual_dados.get("idcentral", "")
    doc_ref.update(dados)
    return jsonify(ok=True, dados=dict(atual_dados, **dados))


# --- MODELOS DE RASTREADOR POR CLIENTE (padroniza o Comando pelo Equipamento) ---
# Cada cliente em migração tem sua própria tabela de {modelo, porta, comando_template}.
# O comando_template usa o placeholder literal "{porta}", substituído pela porta
# cadastrada pra esse modelo nesse cliente — ex.: "ip,200.152.62.20,{porta}" com
# porta "123456" vira "ip,200.152.62.20,123456". Usado tanto na tela (quando o
# Equipamento de um veículo é selecionado) quanto na importação com "Criar planilha".
def _resolver_comando_modelo(template, porta):
    return (template or "").replace("{porta}", porta or "")


def _dados_modelo_comando(data):
    modelo = str(data.get("modelo", "")).strip()
    if not modelo:
        return None
    return {
        "modelo": modelo,
        "porta": str(data.get("porta", "")).strip(),
        "comando_template": str(data.get("comando_template", "")).strip(),
    }


def _preencher_comandos_por_modelo(cliente_migracao_id, veiculos):
    """Preenche 'comando' em cada dict de veiculos (in-place) cujo 'equipamento'
    bata (case-insensitive) com um modelo cadastrado pra esse cliente."""
    docs = db.collection(MIGRACAO_COLLECTION).document(cliente_migracao_id).collection("modelos_comando").stream()
    mapa = {}
    for d in docs:
        m = d.to_dict()
        modelo = str(m.get("modelo", "")).strip().lower()
        if modelo:
            mapa[modelo] = m
    if not mapa:
        return
    for v in veiculos:
        equipamento = str(v.get("equipamento", "")).strip().lower()
        modelo = mapa.get(equipamento)
        if modelo:
            v["comando"] = _resolver_comando_modelo(modelo.get("comando_template"), modelo.get("porta"))


def _reaplicar_comando_em_veiculos_existentes(veiculos_ref, modelo, porta, comando_template):
    """Ao criar/editar um modelo, atualiza na hora o 'comando' de veículos já
    cadastrados nessa subcoleção cujo 'equipamento' bate (case-insensitive) com ele.
    Retorna quantos veículos foram atualizados. Recebe a referência da subcoleção
    (não um cliente_id) pra servir tanto o cliente de migração antigo quanto uma
    tentativa de migração nova — mesma lógica, containers diferentes."""
    modelo_norm = str(modelo or "").strip().lower()
    if not modelo_norm:
        return 0
    comando_resolvido = _resolver_comando_modelo(comando_template, porta)
    atualizados = 0
    for v in veiculos_ref.stream():
        dados = v.to_dict()
        if str(dados.get("equipamento", "")).strip().lower() == modelo_norm:
            v.reference.update({"comando": comando_resolvido})
            atualizados += 1
    return atualizados


def _listar_modelos_impl(container_ref):
    docs = container_ref.collection("modelos_comando").stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    lista.sort(key=lambda m: (m.get("modelo") or "").lower())
    return lista


def _salvar_modelo_impl(container_ref, modelo_ref, data):
    """Cria (modelo_ref recém-gerado) ou substitui (edição) um modelo de comando,
    e reaplica o comando resolvido nos veículos já cadastrados cujo equipamento
    bate. Retorna (dados, veiculos_atualizados), ou None se dados inválidos."""
    dados = _dados_modelo_comando(data)
    if dados is None:
        return None
    modelo_ref.set(dados)
    atualizados = _reaplicar_comando_em_veiculos_existentes(
        container_ref.collection("veiculos"), dados["modelo"], dados["porta"], dados["comando_template"]
    )
    return dados, atualizados


@app.route("/api/migracao/clientes/<cliente_id>/modelos", methods=["GET"])
def listar_modelos_comando_migracao(cliente_id):
    container_ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id)
    if not container_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    return jsonify(ok=True, modelos=_listar_modelos_impl(container_ref))


@app.route("/api/migracao/clientes/<cliente_id>/modelos", methods=["POST"])
def criar_modelo_comando_migracao(cliente_id):
    container_ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id)
    if not container_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    modelo_ref = container_ref.collection("modelos_comando").document()
    resultado = _salvar_modelo_impl(container_ref, modelo_ref, request.get_json(force=True) or {})
    if resultado is None:
        return jsonify(ok=False, error="Informe o modelo do rastreador."), 400
    dados, atualizados = resultado
    return jsonify(ok=True, modelo=dict(dados, id=modelo_ref.id), veiculos_atualizados=atualizados)


@app.route("/api/migracao/clientes/<cliente_id>/modelos/<modelo_id>", methods=["PUT"])
def editar_modelo_comando_migracao(cliente_id, modelo_id):
    container_ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id)
    modelo_ref = container_ref.collection("modelos_comando").document(modelo_id)
    if not modelo_ref.get().exists:
        return jsonify(ok=False, error="Modelo não encontrado."), 404
    resultado = _salvar_modelo_impl(container_ref, modelo_ref, request.get_json(force=True) or {})
    if resultado is None:
        return jsonify(ok=False, error="Informe o modelo do rastreador."), 400
    dados, atualizados = resultado
    return jsonify(ok=True, modelo=dict(dados, id=modelo_id), veiculos_atualizados=atualizados)


@app.route("/api/migracao/clientes/<cliente_id>/modelos/<modelo_id>", methods=["DELETE"])
def excluir_modelo_comando_migracao(cliente_id, modelo_id):
    ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id).collection("modelos_comando").document(modelo_id)
    if not ref.get().exists:
        return jsonify(ok=False, error="Modelo não encontrado."), 404
    ref.delete()
    return jsonify(ok=True)


# --- Mesmas rotas de modelo de comando, para uma tentativa de migração nova
# (clientes/<id>/migracoes/<id>) — mesma lógica de _listar_modelos_impl/_salvar_modelo_impl. ---
@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/modelos", methods=["GET"])
def listar_modelos_comando_cliente(cliente_id, migracao_id):
    container_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document(migracao_id)
    if not container_ref.get().exists:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    return jsonify(ok=True, modelos=_listar_modelos_impl(container_ref))


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/modelos", methods=["POST"])
def criar_modelo_comando_cliente(cliente_id, migracao_id):
    container_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document(migracao_id)
    if not container_ref.get().exists:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    modelo_ref = container_ref.collection("modelos_comando").document()
    resultado = _salvar_modelo_impl(container_ref, modelo_ref, request.get_json(force=True) or {})
    if resultado is None:
        return jsonify(ok=False, error="Informe o modelo do rastreador."), 400
    dados, atualizados = resultado
    return jsonify(ok=True, modelo=dict(dados, id=modelo_ref.id), veiculos_atualizados=atualizados)


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/modelos/<modelo_id>", methods=["PUT"])
def editar_modelo_comando_cliente(cliente_id, migracao_id, modelo_id):
    container_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document(migracao_id)
    modelo_ref = container_ref.collection("modelos_comando").document(modelo_id)
    if not modelo_ref.get().exists:
        return jsonify(ok=False, error="Modelo não encontrado."), 404
    resultado = _salvar_modelo_impl(container_ref, modelo_ref, request.get_json(force=True) or {})
    if resultado is None:
        return jsonify(ok=False, error="Informe o modelo do rastreador."), 400
    dados, atualizados = resultado
    return jsonify(ok=True, modelo=dict(dados, id=modelo_id), veiculos_atualizados=atualizados)


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/modelos/<modelo_id>", methods=["DELETE"])
def excluir_modelo_comando_cliente(cliente_id, migracao_id, modelo_id):
    ref = (
        db.collection(CLIENTES_COLLECTION).document(cliente_id)
        .collection("migracoes").document(migracao_id)
        .collection("modelos_comando").document(modelo_id)
    )
    if not ref.get().exists:
        return jsonify(ok=False, error="Modelo não encontrado."), 404
    ref.delete()
    return jsonify(ok=True)


def _listar_veiculos_impl(container_ref):
    docs = container_ref.collection("veiculos").stream()
    lista = []
    for d in docs:
        dados = d.to_dict()
        dados.setdefault("comando", "")
        dados.setdefault("apn", "")
        dados.setdefault("ls_apn", "")
        dados.setdefault("ultima_comunicacao", "")
        dados.setdefault("status", STATUS_VEICULO_PADRAO)
        lista.append(dict(dados, id=d.id))
    lista.sort(key=lambda v: (v.get("cliente") or "", v.get("veiculo") or ""))
    return lista


CAMPOS_VEICULO_ATUALIZAVEIS = [
    "comando", "apn", "ls_apn", "ultima_comunicacao", "equipamento", "id_equipamento", "numero_linha",
]


def _atualizar_veiculo_impl(veiculo_ref, data):
    """Retorna (atualizacoes, None) e já grava, ou (None, mensagem_erro) se inválido."""
    atualizacoes = {}
    for campo in CAMPOS_VEICULO_ATUALIZAVEIS:
        if campo in data:
            atualizacoes[campo] = str(data.get(campo, ""))
    if "status" in data:
        status = str(data.get("status", "")).strip()
        if status not in STATUS_VEICULO_VALIDOS:
            return None, "Status inválido."
        atualizacoes["status"] = status
    if not atualizacoes:
        return None, "Nada para atualizar."
    veiculo_ref.update(atualizacoes)
    return atualizacoes, None


CAMPOS_VEICULO_ITEM = [
    "cliente", "veiculo", "equipamento", "id_equipamento", "apn", "ls_apn",
    "numero_linha", "comando", "ultima_comunicacao",
]


def _salvar_item_veiculo_impl(container_ref, item):
    """Upsert de 1 veículo (cria ou renomeia) — compartilhado entre o container
    "cliente de migração" antigo e uma tentativa de migração nova. Retorna o dict
    salvo (com id), ou None se faltar cliente/veículo."""
    cliente = str(item.get("cliente", "")).strip()
    veiculo = str(item.get("veiculo", "")).strip()
    if not cliente or not veiculo:
        return None

    subcolecao = container_ref.collection("veiculos")
    novo_id = _veiculo_doc_id(cliente, veiculo)
    antigo_id = item.get("id")
    dados = {campo: str(item.get(campo, "")) for campo in CAMPOS_VEICULO_ITEM}

    novo_ref = subcolecao.document(novo_id)
    if antigo_id and antigo_id != novo_id and not str(antigo_id).startswith("novo-"):
        # Cliente/Veículo mudaram: era um registro existente (id real) —
        # migra o status pro novo doc e remove o antigo pra não duplicar.
        antigo_ref = subcolecao.document(antigo_id)
        antigo_doc = antigo_ref.get()
        if antigo_doc.exists:
            status_existente = antigo_doc.to_dict().get("status")
            if status_existente:
                dados["status"] = status_existente
            antigo_ref.delete()
    if "status" not in dados and not novo_ref.get().exists:
        dados["status"] = STATUS_VEICULO_PADRAO

    novo_ref.set(dados, merge=True)
    return dict(dados, id=novo_id)


@app.route("/api/migracao/clientes/<cliente_id>/veiculos", methods=["GET"])
def listar_veiculos_migracao(cliente_id):
    container_ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id)
    if not container_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    return jsonify(ok=True, veiculos=_listar_veiculos_impl(container_ref))


@app.route("/api/migracao/clientes/<cliente_id>/veiculos/<veiculo_id>", methods=["PUT"])
def atualizar_veiculo_migracao(cliente_id, veiculo_id):
    ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id).collection("veiculos").document(veiculo_id)
    if not ref.get().exists:
        return jsonify(ok=False, error="Veículo não encontrado."), 404
    atualizacoes, erro = _atualizar_veiculo_impl(ref, request.get_json(force=True) or {})
    if erro:
        return jsonify(ok=False, error=erro), 400
    return jsonify(ok=True, **atualizacoes)


@app.route("/api/migracao/clientes/<cliente_id>/veiculos/<veiculo_id>", methods=["DELETE"])
def excluir_veiculo_migracao(cliente_id, veiculo_id):
    ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id).collection("veiculos").document(veiculo_id)
    ref.delete()
    return jsonify(ok=True)


@app.route("/api/migracao/clientes/<cliente_id>/veiculos/item", methods=["POST"])
def salvar_item_veiculo_migracao(cliente_id):
    """Cria ou renomeia (upsert) UM veículo por vez — usado pelo autosave de Cliente/Veículo,
    que muda a identidade do doc (id é hash de cliente+veículo, ver _veiculo_doc_id)."""
    container_ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id)
    if not container_ref.get().exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    resultado = _salvar_item_veiculo_impl(container_ref, request.get_json(force=True) or {})
    if resultado is None:
        return jsonify(ok=False, error="Informe cliente e veículo."), 400
    return jsonify(ok=True, veiculo=resultado)


@app.route("/api/migracao/clientes/<cliente_id>", methods=["PATCH"])
def atualizar_contagens_migracao(cliente_id):
    """Atualiza só qtd_clientes/qtd_placas, já calculados no navegador a partir da lista de
    veículos carregada — evita reler a subcoleção inteira a cada linha criada/excluída."""
    data = request.get_json(force=True) or {}
    atualizacoes = {}
    if "qtd_clientes" in data:
        atualizacoes["qtd_clientes"] = _para_int(data.get("qtd_clientes"))
    if "qtd_placas" in data:
        atualizacoes["qtd_placas"] = _para_int(data.get("qtd_placas"))
    if not atualizacoes:
        return jsonify(ok=False, error="Nada para atualizar."), 400
    db.collection(MIGRACAO_COLLECTION).document(cliente_id).update(atualizacoes)
    return jsonify(ok=True, **atualizacoes)


# --- Mesmas rotas de veículos, para uma tentativa de migração nova
# (clientes/<id>/migracoes/<id>) — mesma lógica de _listar_veiculos_impl e cia. ---
@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/veiculos", methods=["GET"])
def listar_veiculos_cliente(cliente_id, migracao_id):
    container_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document(migracao_id)
    if not container_ref.get().exists:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    return jsonify(ok=True, veiculos=_listar_veiculos_impl(container_ref))


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/veiculos/<veiculo_id>", methods=["PUT"])
def atualizar_veiculo_cliente(cliente_id, migracao_id, veiculo_id):
    ref = (
        db.collection(CLIENTES_COLLECTION).document(cliente_id)
        .collection("migracoes").document(migracao_id)
        .collection("veiculos").document(veiculo_id)
    )
    if not ref.get().exists:
        return jsonify(ok=False, error="Veículo não encontrado."), 404
    atualizacoes, erro = _atualizar_veiculo_impl(ref, request.get_json(force=True) or {})
    if erro:
        return jsonify(ok=False, error=erro), 400
    return jsonify(ok=True, **atualizacoes)


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/veiculos/<veiculo_id>", methods=["DELETE"])
def excluir_veiculo_cliente(cliente_id, migracao_id, veiculo_id):
    ref = (
        db.collection(CLIENTES_COLLECTION).document(cliente_id)
        .collection("migracoes").document(migracao_id)
        .collection("veiculos").document(veiculo_id)
    )
    ref.delete()
    return jsonify(ok=True)


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>/veiculos/item", methods=["POST"])
def salvar_item_veiculo_cliente(cliente_id, migracao_id):
    container_ref = db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document(migracao_id)
    if not container_ref.get().exists:
        return jsonify(ok=False, error="Migração não encontrada."), 404
    resultado = _salvar_item_veiculo_impl(container_ref, request.get_json(force=True) or {})
    if resultado is None:
        return jsonify(ok=False, error="Informe cliente e veículo."), 400
    return jsonify(ok=True, veiculo=resultado)


@app.route("/api/clientes/<cliente_id>/migracoes/<migracao_id>", methods=["PATCH"])
def atualizar_contagens_migracao_cliente(cliente_id, migracao_id):
    """Mesmo racional de atualizar_contagens_migracao, na tentativa nova."""
    data = request.get_json(force=True) or {}
    atualizacoes = {}
    if "qtd_clientes" in data:
        atualizacoes["qtd_clientes"] = _para_int(data.get("qtd_clientes"))
    if "qtd_placas" in data:
        atualizacoes["qtd_placas"] = _para_int(data.get("qtd_placas"))
    if not atualizacoes:
        return jsonify(ok=False, error="Nada para atualizar."), 400
    db.collection(CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document(migracao_id).update(atualizacoes)
    return jsonify(ok=True, **atualizacoes)


@app.route("/api/dashboard")
def dashboard_indicadores():
    clientes_migracao = list(db.collection(MIGRACAO_COLLECTION).stream())
    total_clientes = len(clientes_migracao)
    migracao_ativos = sum(
        1 for d in clientes_migracao
        if (d.to_dict().get("etapa") or MIGRACAO_ETAPA_PADRAO) != "concluido"
    )

    clientes_implantacao = list(db.collection(IMPLANTACAO_CLIENTES_COLLECTION).stream())
    total_implantacao = len(clientes_implantacao)
    implantacao_ativos = sum(
        1 for d in clientes_implantacao
        if (d.to_dict().get("etapa") or IMPLANTACAO_ETAPA_PADRAO) != "concluido"
    )

    por_status = {s: 0 for s in STATUS_VEICULO_VALIDOS}
    total_veiculos = 0
    for doc in db.collection_group("veiculos").stream():
        total_veiculos += 1
        status = doc.to_dict().get("status") or STATUS_VEICULO_PADRAO
        por_status[status] = por_status.get(status, 0) + 1

    # Coleção "clientes" nova (Fase de reestruturação) — roda em paralelo com os
    # contadores antigos acima até os dados serem migrados de verdade.
    por_estagio = {e: 0 for e in ESTAGIOS_CLIENTE}
    for d in db.collection(CLIENTES_COLLECTION).stream():
        estagio = d.to_dict().get("estagio") or ESTAGIO_CLIENTE_PADRAO
        por_estagio[estagio] = por_estagio.get(estagio, 0) + 1
    migracoes_em_andamento = sum(
        1 for d in db.collection_group("migracoes").stream()
        if (d.to_dict().get("status") or STATUS_MIGRACAO_PADRAO) == "em_andamento"
    )

    return jsonify(
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


def _extrair_aninhado(payload, *chaves):
    atual = payload
    for chave in chaves:
        if not isinstance(atual, dict):
            return None
        atual = atual.get(chave)
    return atual


def _executar_import(job_id, tipo_config, mapping, df, endpoint, token, criar_planilha, nome_cliente_planilha):
    sucessos = erros = 0
    veiculos_para_planilha = []
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    for pos, (index, row) in enumerate(df.iterrows()):
        payload = montar_payload(tipo_config, mapping, row)
        try:
            resp = requests.post(f"{BASE_URL}{endpoint}", json=payload, headers=headers, timeout=20)
            if resp.status_code in (200, 201):
                sucessos += 1
                if criar_planilha:
                    cliente = payload.get("ClientIntegrationCode")
                    veiculo = payload.get("Identification")
                    if cliente and veiculo:
                        ddi = _extrair_aninhado(payload, "Tracker1", "Simcard1", "CountryCode") or ""
                        ddd = _extrair_aninhado(payload, "Tracker1", "Simcard1", "AreaCode") or ""
                        numero = _extrair_aninhado(payload, "Tracker1", "Simcard1", "PhoneNumber") or ""
                        equipamento = _extrair_aninhado(payload, "Tracker1", "TrackerTemplateIntegrationCode") or ""
                        id_equipamento = _extrair_aninhado(payload, "Tracker1", "IdTracker") or ""
                        veiculos_para_planilha.append({
                            "cliente": str(cliente),
                            "veiculo": str(veiculo),
                            "equipamento": str(equipamento),
                            "id_equipamento": str(id_equipamento),
                            "numero_linha": f"{ddi}{ddd}{numero}",
                        })
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

    resultado_planilha = None
    if criar_planilha:
        cliente_migracao_id = obter_ou_criar_cliente_migracao(nome_cliente_planilha)
        if veiculos_para_planilha:
            # Preenche o Comando sozinho quando o Equipamento bate com um modelo
            # já cadastrado pra esse cliente (Modelo de rastreador / Porta / Comando).
            _preencher_comandos_por_modelo(cliente_migracao_id, veiculos_para_planilha)
            salvar_veiculos_migracao(cliente_migracao_id, veiculos_para_planilha)
        qtd_clientes, qtd_placas = recalcular_contagens_migracao(cliente_migracao_id)
        resultado_planilha = {"nome": nome_cliente_planilha, "qtd_clientes": qtd_clientes, "qtd_placas": qtd_placas}

    with IMPORT_JOBS_LOCK:
        IMPORT_JOBS[job_id]["status"] = "concluido"
        IMPORT_JOBS[job_id]["planilha"] = resultado_planilha


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
    criar_planilha = bool(body.get("criar_planilha")) and tipo == "veiculo"
    nome_cliente_planilha = str(body.get("nome_cliente_planilha", "")).strip()

    tipo_config = PARAMS.get(tipo)
    if not tipo_config:
        return jsonify(ok=False, error="Tipo desconhecido."), 404
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna."), 400
    if criar_planilha and not nome_cliente_planilha:
        return jsonify(ok=False, error="Informe o nome do cliente para criar a planilha em Clientes em migração."), 400

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
        args=(job_id, tipo_config, mapping, df, endpoint, token, criar_planilha, nome_cliente_planilha),
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
    "Anel de área fechado automaticamente",
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
        kml_text = arquivo.read().decode("utf-8")
    except UnicodeDecodeError:
        return jsonify(ok=False, error="Arquivo KML não está em UTF-8."), 400

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
                elif "Anel de área fechado automaticamente" in av:
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


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
