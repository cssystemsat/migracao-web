import hmac
import json
import os
import threading
import uuid

import firebase_admin
import pandas as pd
import requests
from firebase_admin import credentials, firestore
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
# Uma linha por login salvo em "Gerenciar logins" (o nome vem sempre de lá).
# Os dados de acompanhamento da migração ficam numa coleção à parte, indexada
# pelo mesmo id do login, para não duplicar/desalinhar o nome do cliente.
MIGRACAO_COLLECTION = "migracao_dados"
CAMPOS_MIGRACAO_PADRAO = {
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


@app.route("/api/migracao/clientes", methods=["GET"])
def listar_clientes_migracao():
    credenciais = {d.id: d.to_dict() for d in db.collection(CREDENCIAIS_COLLECTION).stream()}
    dados_migracao = {d.id: d.to_dict() for d in db.collection(MIGRACAO_COLLECTION).stream()}
    lista = []
    for cred_id, cred in credenciais.items():
        dados = dict(CAMPOS_MIGRACAO_PADRAO)
        dados.update(dados_migracao.get(cred_id, {}))
        lista.append({"id": cred_id, "nome": cred.get("nome", ""), **dados})
    lista.sort(key=lambda c: c["nome"].lower())
    return jsonify(ok=True, clientes=lista)


@app.route("/api/migracao/clientes/<cred_id>", methods=["PUT"])
def atualizar_cliente_migracao(cred_id):
    if not db.collection(CREDENCIAIS_COLLECTION).document(cred_id).get().exists:
        return jsonify(ok=False, error="Cliente não encontrado (verifique em Gerenciar logins)."), 404
    data = request.get_json(force=True) or {}
    dados = {
        "cs": str(data.get("cs", "")).strip(),
        "plataforma_origem": str(data.get("plataforma_origem", "")).strip(),
        "qtd_clientes": _para_int(data.get("qtd_clientes")),
        "qtd_placas": _para_int(data.get("qtd_placas")),
        "percentual_migracao": _para_float(data.get("percentual_migracao")),
    }
    db.collection(MIGRACAO_COLLECTION).document(cred_id).set(dados)
    return jsonify(ok=True, dados=dados)


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

    tipo_config = PARAMS.get(tipo)
    if not tipo_config:
        return jsonify(ok=False, error="Tipo desconhecido."), 404
    if not mapping:
        return jsonify(ok=False, error="Mapeie ao menos uma coluna."), 400

    with UPLOADS_LOCK:
        df = UPLOADS.get(file_id)
    if df is None:
        return jsonify(ok=False, error="Arquivo não encontrado. Envie novamente."), 400

    endpoint = tipo_config["endpoint"]

    def gerar():
        sucessos = erros = 0
        total = len(df)
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        for pos, (index, row) in enumerate(df.iterrows()):
            payload = montar_payload(tipo_config, mapping, row)
            try:
                resp = requests.post(f"{BASE_URL}{endpoint}", json=payload, headers=headers, timeout=20)
                if resp.status_code in (200, 201):
                    sucessos += 1
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
        yield json.dumps({"type": "done", "sucessos": sucessos, "erros": erros}) + "\n"

    return Response(stream_with_context(gerar()), mimetype="application/x-ndjson")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
