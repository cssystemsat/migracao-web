"""Migra "migracao_clientes" pra dentro de clientes/<id>/migracoes/<id> (Fase 3
do plano de reestruturação).

Pra cada cliente de migração:
  - Se o idcentral bate com um cliente já existente em "clientes" -> anexa como
    tentativa de migração desse cliente (não cria cliente novo).
  - Senão (sem idcentral, ou idcentral tipo "PENDENTE-..." que não bate com
    ninguém) -> cria um cliente novo em "clientes" (estagio="implantacao",
    decisão já tomada antes) usando o nome da migração, e anexa a tentativa nele.
    O idcentral (mesmo "PENDENTE-...") é preservado no cliente novo, não é
    apagado — é informação real de que falta vincular esse cliente depois.

Em ambos os casos, copia veículos e modelos de comando pra debaixo da tentativa
nova. NÃO apaga "migracao_clientes" (cópia aditiva, igual migrar_clientes.py) —
dá pra conferir a coleção nova antes de decidir remover a antiga depois.

Uso:
    ./venv/Scripts/python.exe migrar_migracao_para_clientes.py            # dry-run
    ./venv/Scripts/python.exe migrar_migracao_para_clientes.py --apply    # aplica
"""
import sys

import app

APLICAR = "--apply" in sys.argv

clientes_por_idcentral = {}
for d in app.db.collection(app.CLIENTES_COLLECTION).stream():
    dados = d.to_dict() or {}
    idc = str(dados.get("idcentral", "")).strip()
    if idc:
        clientes_por_idcentral[idc] = d.id

docs = list(app.db.collection(app.MIGRACAO_COLLECTION).stream())
print(f"Encontrados {len(docs)} clientes em '{app.MIGRACAO_COLLECTION}'.")
print()

total_veiculos = 0
total_criados = 0
total_vinculados = 0

for doc in docs:
    dados = doc.to_dict() or {}
    nome = dados.get("nome", "(sem nome)")
    idcentral = str(dados.get("idcentral", "")).strip()

    cliente_id = clientes_por_idcentral.get(idcentral)
    criar_cliente_novo = cliente_id is None

    veiculos = list(doc.reference.collection("veiculos").stream())
    modelos = list(doc.reference.collection("modelos_comando").stream())
    etapa = dados.get("etapa") or app.MIGRACAO_ETAPA_PADRAO
    status_tentativa = "concluida" if etapa == "concluido" else "em_andamento"
    total_veiculos += len(veiculos)

    if criar_cliente_novo:
        total_criados += 1
        print(f"  - {nome!r}  idcentral={idcentral!r}  ->  CRIA cliente novo  "
              f"veiculos={len(veiculos)} modelos={len(modelos)} status_tentativa={status_tentativa}")
    else:
        total_vinculados += 1
        print(f"  - {nome!r}  idcentral={idcentral!r}  ->  anexa no cliente existente {cliente_id}  "
              f"veiculos={len(veiculos)} modelos={len(modelos)} status_tentativa={status_tentativa}")

    if not APLICAR:
        continue

    if criar_cliente_novo:
        novo_cliente_ref = app.db.collection(app.CLIENTES_COLLECTION).document()
        novo_cliente_ref.set({
            "idcentral": idcentral,
            "cliente": nome,
            "data_entrada": "",
            "objetivo": "",
            "valor_contrato": 0,
            "csm": dados.get("cs", ""),
            "etapa": app.IMPLANTACAO_ETAPA_PADRAO,
            "estagio": app.ESTAGIO_CLIENTE_PADRAO,
        })
        cliente_id = novo_cliente_ref.id

    migracao_ref = app.db.collection(app.CLIENTES_COLLECTION).document(cliente_id).collection("migracoes").document()
    migracao_ref.set({
        "plataforma_origem": dados.get("plataforma_origem", ""),
        "link_planilha": dados.get("link_planilha", ""),
        "qtd_clientes": dados.get("qtd_clientes", 0),
        "qtd_placas": dados.get("qtd_placas", 0),
        "percentual_migracao": dados.get("percentual_migracao", 0),
        "etapa": etapa,
        "status": status_tentativa,
        "data_inicio": "",
        "data_fim": "",
        "motivo": "",
    })
    for v in veiculos:
        migracao_ref.collection("veiculos").document(v.id).set(v.to_dict())
    for m in modelos:
        migracao_ref.collection("modelos_comando").document(m.id).set(m.to_dict())

print()
print(f"Total: {len(docs)} migrações ({total_vinculados} vinculadas a cliente existente, "
      f"{total_criados} viraram cliente novo), {total_veiculos} veículos ao todo.")
if not APLICAR:
    print("(dry-run - nada foi escrito. Rode de novo com --apply pra aplicar de verdade.)")
else:
    print("Aplicado. 'migracao_clientes' NAO foi apagada (copia aditiva).")
