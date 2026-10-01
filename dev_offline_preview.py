"""Sobe o app Flask com um Firestore FALSO — zero leitura/escrita real no
Firebase. Serve pra desenvolver/visualizar a interface (layout, fluxos, telas)
sem gastar a cota do Firestore de verdade.

Uso:
    ./venv/Scripts/python.exe dev_offline_preview.py            # continua de onde parou
    ./venv/Scripts/python.exe dev_offline_preview.py --limpar   # apaga tudo e recria os exemplos
    ./venv/Scripts/python.exe dev_offline_preview.py --um-cliente           # banco só com 1 cliente de teste
    ./venv/Scripts/python.exe dev_offline_preview.py --um-cliente --limpar  # zera esse banco de 1 cliente

Os dados ficam salvos em .dados_offline.json (fora do git; com --um-cliente,
em .dados_offline_um_cliente.json — arquivo separado, não mistura) — o que você
cadastra continua lá depois de reiniciar. Na primeira vez (ou com --limpar)
cria dados de exemplo; login impresso no console ao subir.

Não é um substituto de teste real (sem validar regra nenhuma do Firestore de
verdade) — só visual/fluxo.
"""
import atexit
import json
import os
import sys
import threading
import time
import uuid

# --- FIREBASE-FAKE: precisa vir ANTES de importar app.py, que já cria o client
# de verdade na hora do import. ---
os.environ.setdefault("FIREBASE_CREDENTIALS_JSON", '{"type": "service_account"}')

import firebase_admin
from firebase_admin import credentials as fb_credentials, firestore as fb_firestore

MODO_UM_CLIENTE = "--um-cliente" in sys.argv
ARQUIVO_DADOS = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    ".dados_offline_um_cliente.json" if MODO_UM_CLIENTE else ".dados_offline.json",
)


class StorePersistente(dict):
    """Dict {caminho(tupla): dados} que se grava em ARQUIVO_DADOS. A gravação
    é agrupada (1s depois da última escrita) — importar mil veículos não vira
    mil regravações do arquivo."""

    def __init__(self, arquivo=None):
        super().__init__()
        self._arquivo = arquivo
        self._lock = threading.Lock()
        self._timer = None

    def carregar(self):
        if not self._arquivo or not os.path.exists(self._arquivo):
            return False
        with open(self._arquivo, encoding="utf-8") as f:
            for caminho, dados in json.load(f):
                self[tuple(caminho)] = dados
        return True

    def marcar_alterado(self):
        if not self._arquivo:
            return
        with self._lock:
            if self._timer is None:
                self._timer = threading.Timer(1.0, self.gravar)
                self._timer.daemon = True
                self._timer.start()

    def gravar(self):
        if not self._arquivo:
            return
        with self._lock:
            self._timer = None
            # Lista de [caminho, dados] (não "a/b/c": id de documento pode ter "/").
            conteudo = [[list(k), v] for k, v in list(self.items())]
        tmp = self._arquivo + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(conteudo, f, ensure_ascii=False, default=str)
        os.replace(tmp, self._arquivo)


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
        self._store.marcar_alterado()

    def update(self, data):
        atual = dict(self._store.get(self.path, {}))
        atual.update(data)
        self._store[self.path] = atual
        self._store.marcar_alterado()

    def delete(self):
        self._store.pop(self.path, None)
        self._store.marcar_alterado()

    def collection(self, nome):
        return FakeCollectionRef(self._store, self.path + (nome,))

    @property
    def parent(self):
        """Collection que contém este documento — imita DocumentReference.parent
        do client de verdade (usado por collection_group pra achar o pai)."""
        return FakeCollectionRef(self._store, self.path[:-1])


class FakeCollectionRef:
    def __init__(self, store, path, filtros=None, limite=None, ordem=None):
        self._store = store
        self.path = path
        self._filtros = filtros or []
        self._limite = limite
        self._ordem = ordem or []

    def document(self, doc_id=None):
        if doc_id is None:
            doc_id = uuid.uuid4().hex
        return FakeDocumentRef(self._store, self.path + (doc_id,))

    @property
    def parent(self):
        """Documento que contém esta coleção — None se for coleção raiz (ex.:
        db.collection("clientes").parent). Imita CollectionReference.parent."""
        if len(self.path) <= 1:
            return None
        return FakeDocumentRef(self._store, self.path[:-1])

    def where(self, filter=None):
        return FakeCollectionRef(self._store, self.path, self._filtros + [filter], self._limite, self._ordem)

    def limit(self, n):
        return FakeCollectionRef(self._store, self.path, self._filtros, n, self._ordem)

    def order_by(self, campo, direction="ASCENDING"):
        return FakeCollectionRef(self._store, self.path, self._filtros, self._limite,
                                 self._ordem + [(campo, direction == "DESCENDING")])

    def count(self):
        return _Contagem(sum(1 for _ in self.stream()))

    def stream(self):
        prefixo = self.path
        resultados = []
        for caminho, dados in list(self._store.items()):
            if len(caminho) == len(prefixo) + 1 and caminho[:-1] == prefixo and _match(dados, self._filtros):
                resultados.append(FakeSnapshot(caminho[-1], dados, reference=FakeDocumentRef(self._store, caminho)))
        # Ordena do último critério pro primeiro (sort estável = ordem composta).
        for campo, desc in reversed(self._ordem):
            resultados.sort(key=lambda s: (s._data.get(campo) is None, str(s._data.get(campo) or "")), reverse=desc)
        if self._limite is not None:
            resultados = resultados[: self._limite]
        return iter(resultados)


class FakeClient:
    def __init__(self, store):
        self._store = store

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

    def where(self, filter=None):
        return _ResultadoFixo([s for s in self._resultados if _match(s._data, [filter])])

    def count(self):
        return _Contagem(len(self._resultados))

    def stream(self):
        return iter(self._resultados)


class _Contagem:
    """Imita o retorno de query.count().get(): [[AggregationResult(value=n)]]."""
    def __init__(self, n):
        self.value = n

    def get(self):
        return [[self]]


if "--limpar" in sys.argv and os.path.exists(ARQUIVO_DADOS):
    os.remove(ARQUIVO_DADOS)

_STORE = StorePersistente(ARQUIVO_DADOS)
_DADOS_CARREGADOS = _STORE.carregar()
atexit.register(_STORE.gravar)

_FAKE_DB = FakeClient(_STORE)
fb_credentials.Certificate = lambda *a, **k: object()
firebase_admin.initialize_app = lambda *a, **k: None
fb_firestore.client = lambda *a, **k: _FAKE_DB

import app  # noqa: E402  (import atrasado de propósito — precisa vir depois dos patches acima)

assert app.db is _FAKE_DB, "app.py não pegou o Firestore fake — checar se o patch rodou antes do import."


def _criar_dados_exemplo():
    app._criar_usuario_app("admin", "admin123", perfil="adm", nome_responsavel="Duda")

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

    # Clientes da lista única (Implantação), em marcos diferentes — pra testar
    # Kanban, Ficha e a aba Marcos sem precisar cadastrar nada.
    base = {"objetivo": "", "valor_contrato": 0, "csm": "Duda", "estagio": app.ESTAGIO_CLIENTE_PADRAO,
            "momento": "", "flag": "", "vendedor": "", "persona": "", "decisor_nome": "",
            "decisor_whatsapp": "", "decisor_estado": "", "decisor_cidade": "",
            "ultima_acao": "", "ultima_acao_data": ""}
    exemplos = [
        ("1234", "Cliente Exemplo (offline)", "2026-09-15", [], []),
        ("2001", "Transportes Kick-off", "2026-09-25", [], []),
        ("2002", "Logística Quick Win", "2026-09-05", ["marco-1"],
         [{"id": "px-video", "nome": "Videotelemetria", "itens": [
             {"id": "sx-camera", "texto": "Apontar câmera"},
             {"id": "sx-regras", "texto": "Criar regras/templates"},
             {"id": "sx-treino", "texto": "Treinamento de videotelemetria"}]},
          {"id": "px-can", "nome": "Rede CAN", "itens": [
             {"id": "sx-can", "texto": "Validar leitura da rede CAN"}]}]),
        ("2003", "Frota Atrasada", "2026-06-20", ["marco-1"], []),
    ]
    for idcentral, nome, entrada, concluidos, prioridades in exemplos:
        feitos = [i["id"] for m in concluidos for i in app.IMPLANTACAO_CHECKLIST_PADRAO[m]]
        if prioridades:
            feitos.append(prioridades[0]["itens"][0]["id"])
        app.db.collection(app.CLIENTES_COLLECTION).document().set(dict(
            base, idcentral=idcentral, cliente=nome, data_entrada=entrada,
            etapa=app._etapa_a_partir_dos_marcos(concluidos), marcos_concluidos=concluidos,
            marcos_concluidos_manual=[], marcos_itens_feitos=feitos, marcos_itens_extras={},
            marcos_prioridades=prioridades,
        ))


def _criar_um_cliente():
    """Banco mínimo: só o login admin e 1 cliente de teste (sem migração),
    no Marco 1 — pra testar um fluxo do zero sem os exemplos atrapalhando."""
    app._criar_usuario_app("admin", "admin123", perfil="adm", nome_responsavel="Duda")
    app.db.collection(app.CLIENTES_COLLECTION).document().set({
        "idcentral": "9999", "cliente": "Cliente Teste", "data_entrada": time.strftime("%Y-%m-%d"),
        "objetivo": "", "valor_contrato": 0, "csm": "Duda", "estagio": app.ESTAGIO_CLIENTE_PADRAO,
        "momento": "", "flag": "", "vendedor": "", "persona": "", "decisor_nome": "",
        "decisor_whatsapp": "", "decisor_estado": "", "decisor_cidade": "",
        "ultima_acao": "", "ultima_acao_data": "",
        "etapa": "marco-1", "marcos_concluidos": [], "marcos_concluidos_manual": [],
        "marcos_itens_feitos": [], "marcos_itens_extras": {}, "marcos_prioridades": [],
    })


if not _DADOS_CARREGADOS:
    if MODO_UM_CLIENTE:
        _criar_um_cliente()
    else:
        _criar_dados_exemplo()

print("=" * 60)
print("Servidor OFFLINE (Firestore fake, nada real é lido/escrito)")
print(f"Dados: {ARQUIVO_DADOS} ({'carregados' if _DADOS_CARREGADOS else 'exemplos novos'})")
if MODO_UM_CLIENTE:
    print("Modo UM CLIENTE: só 'Cliente Teste' (IdCentral 9999)")
print("Login de exemplo: admin / admin123")
print("Abra: http://127.0.0.1:5051")
print("=" * 60)

app.app.run(host="127.0.0.1", port=5051, debug=False)
