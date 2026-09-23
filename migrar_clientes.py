"""Migra os cadastros de "implantacao_clientes" pra "clientes" (Fase de
reestruturação: lista única de clientes com campo "estagio").

Por segurança, é uma CÓPIA aditiva — não apaga nada da coleção antiga. Dá pra
conferir a coleção nova funcionando antes de decidir remover a velha depois
(Fase 4 do plano), e rodar de novo não duplica nada (mesmo id, mesmo evento).

Uso (precisa de FIREBASE_CREDENTIALS_JSON setada com a credencial de verdade,
igual rodar o app.py normalmente):
    ./venv/Scripts/python.exe migrar_clientes.py            # dry-run, só mostra o que faria
    ./venv/Scripts/python.exe migrar_clientes.py --apply    # aplica de verdade
"""
import sys

import app

APLICAR = "--apply" in sys.argv

docs = list(app.db.collection(app.IMPLANTACAO_CLIENTES_COLLECTION).stream())
print(f"Encontrados {len(docs)} clientes em '{app.IMPLANTACAO_CLIENTES_COLLECTION}'.")
print()

total_eventos = 0
ja_existentes = 0
for d in docs:
    cliente_id = d.id
    dados = d.to_dict()
    dados.setdefault("estagio", app.ESTAGIO_CLIENTE_PADRAO)
    destino_ref = app.db.collection(app.CLIENTES_COLLECTION).document(cliente_id)
    ja_existe = destino_ref.get().exists
    if ja_existe:
        ja_existentes += 1

    eventos = list(d.reference.collection("eventos").stream())
    total_eventos += len(eventos)

    nome = dados.get("cliente", "(sem nome)")
    status_txt = "JA EXISTE NA NOVA (seria sobrescrito)" if ja_existe else "novo"
    print(f"  - {cliente_id}  {nome!r}  [{status_txt}]  eventos={len(eventos)}")

    if APLICAR:
        destino_ref.set(dados)
        for ev in eventos:
            destino_ref.collection("eventos").document(ev.id).set(ev.to_dict())

print()
print(f"Total: {len(docs)} clientes, {total_eventos} eventos, {ja_existentes} já existiam na coleção nova.")
if not APLICAR:
    print("(dry-run - nada foi escrito. Rode de novo com --apply pra aplicar de verdade.)")
else:
    print("Aplicado. 'implantacao_clientes' NAO foi apagada (copia aditiva) - dá pra conferir "
          "a 'clientes' antes de decidir remover a antiga depois.")
