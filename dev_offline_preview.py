"""Sobe o app Flask com um Firestore FALSO em memória — zero leitura/escrita real no
Firebase. Serve só pra visualizar a interface (layout, fluxos, telas) com dados de
exemplo enquanto a cota do Firestore de verdade estiver sendo economizada.

Uso:
    ./venv/Scripts/python.exe dev_offline_preview.py

Login de exemplo impresso no console ao subir.

Não é um substituto de teste real (dados fictícios, sem validar regra nenhuma do
Firestore de verdade) — só visual/fluxo.
"""
import os
import uuid

# --- FIREBASE-FAKE: precisa vir ANTES de importar app.py, que já cria o client
# de verdade na hora do import. ---
os.environ.setdefault("FIREBASE_CREDENTIALS_JSON", '{"type": "service_account"}')

import firebase_admin
from firebase_admin import credentials as fb_credentials, firestore as fb_firestore


class FakeSnapshot:
    def __init__(self, doc_id, data, reference=None):
        self.id = doc_id
        self._data = data
        self.exists = data is not None
        self.reference = reference

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


def _match(data, filtros):
    for f in filtros:
        atual = data.get(f.field_path)
        if f.op_string == "==" and atual != f.value:
            return False
        if f.op_string == "array_contains" and f.value not in (atual or []):
            return False
    return True


class FakeDocumentRef:
    def __init__(self, store, path):
        self._store = store
        self.path = path
        self.id = path[-1]

    def get(self):
        return FakeSnapshot(self.id, self._store.get(self.path), reference=self)

    def set(self, data, merge=False):
        if merge and self.path in self._store:
            atual = dict(self._store[self.path])
            atual.update(data)
            self._store[self.path] = atual
        else:
            self._store[self.path] = dict(data)

    def update(self, data):
        atual = dict(self._store.get(self.path, {}))
        atual.update(data)
        self._store[self.path] = atual

    def delete(self):
        self._store.pop(self.path, None)

    def collection(self, nome):
        return FakeCollectionRef(self._store, self.path + (nome,))


class FakeCollectionRef:
    def __init__(self, store, path, filtros=None, limite=None):
        self._store = store
        self.path = path
        self._filtros = filtros or []
        self._limite = limite

    def document(self, doc_id=None):
        if doc_id is None:
            doc_id = uuid.uuid4().hex
        return FakeDocumentRef(self._store, self.path + (doc_id,))

    def where(self, filter=None):
        return FakeCollectionRef(self._store, self.path, self._filtros + [filter], self._limite)

    def limit(self, n):
        return FakeCollectionRef(self._store, self.path, self._filtros, n)

    def stream(self):
        prefixo = self.path
        resultados = []
        for caminho, dados in list(self._store.items()):
            if len(caminho) == len(prefixo) + 1 and caminho[:-1] == prefixo and _match(dados, self._filtros):
                resultados.append(FakeSnapshot(caminho[-1], dados, reference=FakeDocumentRef(self._store, caminho)))
        if self._limite is not None:
            resultados = resultados[: self._limite]
        return iter(resultados)


class FakeClient:
    def __init__(self):
        self._store = {}

    def collection(self, nome):
        return FakeCollectionRef(self._store, (nome,))

    def collection_group(self, nome):
        resultados = []
        for caminho, dados in list(self._store.items()):
            # Nome da coleção é sempre o penúltimo segmento do caminho do documento.
            if len(caminho) >= 2 and caminho[-2] == nome:
                resultados.append(FakeSnapshot(caminho[-1], dados, reference=FakeDocumentRef(self._store, caminho)))
        return _ResultadoFixo(resultados)


class _ResultadoFixo:
    def __init__(self, resultados):
        self._resultados = resultados

    def stream(self):
        return iter(self._resultados)


_FAKE_DB = FakeClient()
fb_credentials.Certificate = lambda *a, **k: object()
firebase_admin.initialize_app = lambda *a, **k: None
fb_firestore.client = lambda *a, **k: _FAKE_DB

import app  # noqa: E402  (import atrasado de propósito — precisa vir depois dos patches acima)

assert app.db is _FAKE_DB, "app.py não pegou o Firestore fake — checar se o patch rodou antes do import."

# --- Dados de exemplo ---
usuario_demo = app._criar_usuario_app("admin", "admin123", perfil="adm", nome_responsavel="Duda")

cliente_id = app.obter_ou_criar_cliente_migracao("Cliente Exemplo (offline)")
app.db.collection(app.MIGRACAO_COLLECTION).document(cliente_id).update({
    "cs": "Duda",
    "plataforma_origem": "iTrack",
    "link_planilha": "https://docs.google.com/spreadsheets/d/exemplo-offline",
    "etapa": "importacao",
    "idcentral": "1234",
})
app.salvar_veiculos_migracao(cliente_id, [
    {"cliente": "Transportadora Alfa", "veiculo": "ABC1D23", "equipamento": "J16", "id_equipamento": "100001",
     "apn": "internet.claro", "ls_apn": "claro/claro", "numero_linha": "11999990001",
     "comando": "ip,200.152.62.20,123456", "ultima_comunicacao": "20/08/2026", "status": "Migrado"},
    {"cliente": "Transportadora Alfa", "veiculo": "ABC2D34", "equipamento": "J16", "id_equipamento": "100002",
     "apn": "internet.claro", "ls_apn": "claro/claro", "numero_linha": "11999990002",
     "comando": "ip,200.152.62.20,123456", "ultima_comunicacao": "18/08/2026", "status": "Enviado"},
    {"cliente": "Logística Beta", "veiculo": "XYZ9K87", "equipamento": "GV-50", "id_equipamento": "200001",
     "apn": "zap.vivo.com.br", "ls_apn": "vivo/vivo", "numero_linha": "11999990003",
     "comando": "", "ultima_comunicacao": "", "status": "Aguardando"},
    {"cliente": "Logística Beta", "veiculo": "XYZ9K88", "equipamento": "GV-50", "id_equipamento": "200002",
     "apn": "zap.vivo.com.br", "ls_apn": "vivo/vivo", "numero_linha": "11999990004",
     "comando": "", "ultima_comunicacao": "", "status": "Cancelado"},
])
app.recalcular_contagens_migracao(cliente_id)

print("=" * 60)
print("Servidor OFFLINE (Firestore fake, nada real é lido/escrito)")
print("Login: admin / admin123")
print("Abra: http://127.0.0.1:5051")
print("=" * 60)

app.app.run(host="127.0.0.1", port=5051, debug=False)
