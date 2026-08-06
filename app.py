import base64
import hmac
import io
import json
import os
import threading
import time
import uuid

import firebase_admin
import openpyxl
import pandas as pd
import requests
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from flask import Flask, Response, jsonify, redirect, render_template, request, session, stream_with_context, url_for

app = Flask(__name__)
app.secret_key = os.environ.get("MIGRACAO_SECRET_KEY", os.urandom(24))
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

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

# Senha de acesso ao PRÓPRIO app (protege a ferramenta quando publicada na internet).
# Só é exigida se a variável de ambiente APP_ACCESS_PASSWORD estiver definida;
# em uso local (sem a variável) o app funciona normalmente, sem tela de login extra.
APP_ACCESS_PASSWORD = os.environ.get("APP_ACCESS_PASSWORD")


@app.before_request
def exigir_senha_app():
    if not APP_ACCESS_PASSWORD:
        return
    if request.endpoint in ("login_app", "static"):
        return
    if not session.get("app_ok"):
        return redirect(url_for("login_app"))


@app.route("/login-app", methods=["GET", "POST"])
def login_app():
    erro = None
    if request.method == "POST":
        senha = request.form.get("senha", "")
        if APP_ACCESS_PASSWORD and hmac.compare_digest(senha, APP_ACCESS_PASSWORD):
            session["app_ok"] = True
            return redirect(url_for("index"))
        erro = "Senha incorreta."
    return render_template("login_app.html", erro=erro)

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
        headers=["CLIENTE", "DOC", "STATUS"],
        campos=["TradingName", "DocumentNumber", "Active"],
    ),
    "veiculos": dict(
        endpoint="/Administration/Vehicle/List",
        payload=None,
        headers=["CLIENTE", "PLACA", "COD"],
        campos=["ClientTrading", "Identification", "VehicleIntegrationCode"],
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


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def status():
    return jsonify(authenticated=bool(session.get("token")))


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True) or {}
    usuario = str(data.get("login", "")).strip()
    senha = str(data.get("senha", ""))
    if not usuario or not senha:
        return jsonify(ok=False, error="Informe login e senha."), 400
    try:
        r = requests.post(f"{BASE_URL}/Login", data={"Username": usuario, "Password": senha}, timeout=10)
        r.raise_for_status()
        token = r.json().get("AccessToken")
        if not token:
            return jsonify(ok=False, error="Resposta sem token de acesso."), 400
        session["token"] = token
        return jsonify(ok=True)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha ao autenticar: {e}"), 400


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(ok=True)


# --- LOGINS SALVOS (para trocar de cliente rapidamente) ---
# Guardados no Firestore (coleção "credenciais"), sobrevive a redeploys.
@app.route("/api/credenciais", methods=["GET"])
def listar_credenciais():
    docs = db.collection(CREDENCIAIS_COLLECTION).stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    return jsonify(ok=True, credenciais=lista)


@app.route("/api/credenciais", methods=["POST"])
def criar_credencial():
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
    doc_ref = db.collection(CREDENCIAIS_COLLECTION).document(cred_id)
    if not doc_ref.get().exists:
        return jsonify(ok=False, error="Login não encontrado."), 404
    doc_ref.delete()
    return jsonify(ok=True)


# --- CLIENTES EM MIGRAÇÃO ---
# Coleção independente: uma linha nasce quando alguém importa veículos com a
# opção "Criar planilha" marcada (não mais atrelada aos logins salvos).
MIGRACAO_COLLECTION = "migracao_clientes"
CAMPOS_MIGRACAO_PADRAO = {
    "nome": "",
    "cs": "",
    "plataforma_origem": "",
    "qtd_clientes": 0,
    "qtd_placas": 0,
    "percentual_migracao": 0,
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


def upsert_cliente_migracao(nome, qtd_clientes, qtd_placas):
    """Cria a linha do cliente se não existir (por nome); se existir, atualiza as quantidades."""
    query = db.collection(MIGRACAO_COLLECTION).where(filter=FieldFilter("nome", "==", nome)).limit(1).stream()
    existente = next(query, None)
    if existente:
        existente.reference.update({"qtd_clientes": qtd_clientes, "qtd_placas": qtd_placas})
        return existente.id
    dados = dict(CAMPOS_MIGRACAO_PADRAO)
    dados.update({"nome": nome, "qtd_clientes": qtd_clientes, "qtd_placas": qtd_placas})
    doc_ref = db.collection(MIGRACAO_COLLECTION).document()
    doc_ref.set(dados)
    return doc_ref.id


@app.route("/api/migracao/clientes", methods=["GET"])
def listar_clientes_migracao():
    docs = db.collection(MIGRACAO_COLLECTION).stream()
    lista = [dict(d.to_dict(), id=d.id) for d in docs]
    lista.sort(key=lambda c: c["nome"].lower())
    return jsonify(ok=True, clientes=lista)


@app.route("/api/migracao/clientes/<cliente_id>", methods=["PUT"])
def atualizar_cliente_migracao(cliente_id):
    doc_ref = db.collection(MIGRACAO_COLLECTION).document(cliente_id)
    atual = doc_ref.get()
    if not atual.exists:
        return jsonify(ok=False, error="Cliente não encontrado."), 404
    data = request.get_json(force=True) or {}
    dados = {
        "cs": str(data.get("cs", "")).strip(),
        "plataforma_origem": str(data.get("plataforma_origem", "")).strip(),
        "qtd_clientes": _para_int(data.get("qtd_clientes")),
        "qtd_placas": _para_int(data.get("qtd_placas")),
        "percentual_migracao": _para_float(data.get("percentual_migracao")),
    }
    doc_ref.update(dados)
    return jsonify(ok=True, dados=dict(atual.to_dict(), **dados))


@app.route("/api/list/<tipo>")
def listar(tipo):
    token = session.get("token")
    if not token:
        return jsonify(ok=False, error="Autentique-se primeiro."), 401
    config = LISTAGENS.get(tipo)
    if not config:
        return jsonify(ok=False, error="Listagem desconhecida."), 404
    try:
        data = requisicao_padrao(config["endpoint"], config["payload"], token)
    except requests.exceptions.RequestException as e:
        return jsonify(ok=False, error=f"Falha na consulta: {e}"), 400
    rows = [[item.get(c) for c in config["campos"]] for item in (data or [])]
    return jsonify(ok=True, headers=config["headers"], rows=rows)


@app.route("/api/import/params/<tipo>")
def import_params(tipo):
    config = PARAMS.get(tipo)
    if not config:
        return jsonify(ok=False, error="Tipo desconhecido."), 404
    labels = LABELS.get(tipo, {})
    campos = [{"nome": c, "rotulo": labels.get(c, c)} for c in config["campos"]]
    return jsonify(ok=True, titulo=config["titulo"], campos=campos)


@app.route("/api/import/upload", methods=["POST"])
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


@app.route("/api/import/run", methods=["POST"])
def import_run():
    token = session.get("token")
    if not token:
        return jsonify(ok=False, error="Autentique-se primeiro."), 401

    body = request.get_json(force=True) or {}
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
        df = UPLOADS.get(file_id)
    if df is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400

    endpoint = tipo_config["endpoint"]

    def gerar():
        sucessos = erros = 0
        total = len(df)
        clientes_importados = set()
        placas_importadas = set()
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        for pos, (index, row) in enumerate(df.iterrows()):
            payload = montar_payload(tipo_config, mapping, row)
            try:
                resp = requests.post(f"{BASE_URL}{endpoint}", json=payload, headers=headers, timeout=20)
                if resp.status_code in (200, 201):
                    sucessos += 1
                    if criar_planilha:
                        if payload.get("ClientIntegrationCode"):
                            clientes_importados.add(payload["ClientIntegrationCode"])
                        if payload.get("Identification"):
                            placas_importadas.add(payload["Identification"])
                else:
                    erros += 1
                    yield json.dumps({
                        "type": "log",
                        "message": f"Erro linha {pos + 1}: {resp.text}",
                    }) + "\n"
            except requests.exceptions.RequestException as e:
                erros += 1
                yield json.dumps({"type": "log", "message": f"Erro linha {pos + 1}: {e}"}) + "\n"

            pct = int(((pos + 1) / total) * 100) if total else 100
            yield json.dumps({
                "type": "progress", "pct": pct, "atual": pos + 1, "total": total,
                "sucessos": sucessos, "erros": erros,
            }) + "\n"

        with UPLOADS_LOCK:
            UPLOADS.pop(file_id, None)

        resultado_planilha = None
        if criar_planilha:
            qtd_clientes = len(clientes_importados)
            qtd_placas = len(placas_importadas)
            upsert_cliente_migracao(nome_cliente_planilha, qtd_clientes, qtd_placas)
            resultado_planilha = {"nome": nome_cliente_planilha, "qtd_clientes": qtd_clientes, "qtd_placas": qtd_placas}

        yield json.dumps({"type": "done", "sucessos": sucessos, "erros": erros, "planilha": resultado_planilha}) + "\n"

    return Response(stream_with_context(gerar()), mimetype="application/x-ndjson")


# --- ENVIO DE COMANDO (SMS Market) ---
# Portado do "Configurador de rastreadores V5.0" (tkinter). A lógica de geração
# de comando por modelo/comando e o fluxo de envio (único, livre, em massa)
# foram mantidos fiéis ao programa original, inclusive peculiaridades dele
# (ex.: alguns modelos retornam um texto diferente do exibido na tela original;
# aqui exibimos sempre o texto que é realmente enviado).
SMS_BASE_URL = "https://api.smsmarket.com.br/webservice-rest"

UPLOADS_MASSA = {}
UPLOADS_MASSA_LOCK = threading.Lock()


def gerar_comando_sms(modelo, comando, id_, apn, loginapn, porta, operadora):
    """Retorna o texto do comando a ser enviado, ou None se a combinação não é suportada."""

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


def _enviar_sms(numero, conteudo, campaign_id):
    auth = session.get("sms_auth")
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
def comando_gerar():
    data = request.get_json(force=True) or {}
    texto = gerar_comando_sms(
        modelo=data.get("modelo", ""),
        comando=data.get("comando", ""),
        id_=data.get("id", ""),
        apn=data.get("apn", ""),
        loginapn=data.get("loginapn", ""),
        porta=data.get("porta", ""),
        operadora=data.get("operadora", ""),
    )
    if texto is None:
        return jsonify(ok=False, error="Comando não implementado para este modelo."), 400
    return jsonify(ok=True, texto=texto)


@app.route("/api/comando/enviar", methods=["POST"])
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
def comando_upload_massa():
    if "arquivo" not in request.files:
        return jsonify(ok=False, error="Nenhum arquivo enviado."), 400
    conteudo = request.files["arquivo"].read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(conteudo))
        total_linhas = max(wb.active.max_row - 1, 0)
    except Exception as e:
        return jsonify(ok=False, error=f"Falha ao ler Excel: {e}"), 400
    file_id = uuid.uuid4().hex
    with UPLOADS_MASSA_LOCK:
        UPLOADS_MASSA[file_id] = conteudo
    return jsonify(ok=True, file_id=file_id, total_linhas=total_linhas)


@app.route("/api/comando/enviar-massa", methods=["POST"])
def comando_enviar_massa():
    if not session.get("sms_auth"):
        return jsonify(ok=False, error="Autentique-se na SMS Market primeiro."), 401

    body = request.get_json(force=True) or {}
    file_id = body.get("file_id")
    intervalo = _para_int(body.get("intervalo"))

    with UPLOADS_MASSA_LOCK:
        conteudo = UPLOADS_MASSA.get(file_id)
    if conteudo is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400

    wb = openpyxl.load_workbook(io.BytesIO(conteudo))
    sheet = wb.active
    coluna1 = [str(cell.value) for cell in sheet["A"]]
    coluna2 = [str(cell.value) for cell in sheet["B"]]
    coluna3 = [str(cell.value) for cell in sheet["C"]]

    def gerar():
        sucessos = erros = 0
        linha = 1
        total = max(len(coluna1) - 1, 1)
        valor_coluna1 = coluna1[1] if len(coluna1) > 1 else "None"

        while valor_coluna1 != "None":
            valor_coluna1 = coluna1[linha - 1] if linha <= len(coluna1) else None
            valor_coluna2 = coluna2[linha - 1] if linha <= len(coluna2) else None
            valor_coluna3 = coluna3[linha - 1] if linha <= len(coluna3) else None

            if valor_coluna1 is None and valor_coluna2 is None:
                break

            resposta, erro = _enviar_sms(valor_coluna2, valor_coluna1, valor_coluna3)
            if erro:
                erros += 1
                yield json.dumps({"type": "log", "message": f"Erro linha {linha}: {erro}"}) + "\n"
            else:
                sucessos += 1
                yield json.dumps({"type": "log", "message": f"Linha {linha}: {resposta}"}) + "\n"

            pct = min(int((linha / total) * 100), 100)
            yield json.dumps({
                "type": "progress", "pct": pct, "atual": linha, "total": total,
                "sucessos": sucessos, "erros": erros,
            }) + "\n"

            time.sleep(intervalo)
            linha += 1

        with UPLOADS_MASSA_LOCK:
            UPLOADS_MASSA.pop(file_id, None)

        saldo = None
        usuario, senha = session.get("sms_usuario"), session.get("sms_senha")
        if usuario and senha:
            try:
                saldo = _consultar_saldo_sms(usuario, senha)
            except requests.exceptions.RequestException:
                pass

        yield json.dumps({"type": "done", "sucessos": sucessos, "erros": erros, "saldo": saldo}) + "\n"

    return Response(stream_with_context(gerar()), mimetype="application/x-ndjson")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
