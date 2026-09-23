"""Apaga da coleção antiga "migracao_clientes" os clientes que NÃO têm vínculo
(idcentral) com nenhum cliente da coleção "clientes" — são os cards que aparecem
soltos na tela "Controle de Migração" sem corresponder a nenhum cliente de
Implantação.

Ação destrutiva de verdade (apaga o cliente de migração + veículos + modelos de
comando dele). Não mexe em nada que tenha idcentral batendo com um cliente
existente — só nos órfãos.

Uso:
    ./venv/Scripts/python.exe limpar_migracao_orfa.py            # dry-run, só mostra
    ./venv/Scripts/python.exe limpar_migracao_orfa.py --apply    # apaga de verdade
"""
import sys

import app

APLICAR = "--apply" in sys.argv

idcentrais_validos = {
    (d.to_dict() or {}).get("idcentral", "").strip()
    for d in app.db.collection(app.CLIENTES_COLLECTION).stream()
}
idcentrais_validos.discard("")

docs = list(app.db.collection(app.MIGRACAO_COLLECTION).stream())
print(f"Encontrados {len(docs)} clientes em '{app.MIGRACAO_COLLECTION}'.")
print()

orfaos = []
vinculados = []
for d in docs:
    dados = d.to_dict() or {}
    idcentral = str(dados.get("idcentral", "")).strip()
    nome = dados.get("nome", "(sem nome)")
    if idcentral and idcentral in idcentrais_validos:
        vinculados.append((d, nome, idcentral))
    else:
        orfaos.append((d, nome, idcentral))

print(f"Vinculados a um cliente existente (NÃO mexidos): {len(vinculados)}")
for _, nome, idcentral in vinculados:
    print(f"  - {nome!r}  idcentral={idcentral!r}")

print()
print(f"Órfãos (sem idcentral ou sem cliente correspondente) — {'SERÃO APAGADOS' if APLICAR else 'seriam apagados'}: {len(orfaos)}")
total_veiculos_apagados = 0
for doc, nome, idcentral in orfaos:
    veiculos = list(doc.reference.collection("veiculos").stream())
    modelos = list(doc.reference.collection("modelos_comando").stream())
    total_veiculos_apagados += len(veiculos)
    print(f"  - {nome!r}  idcentral={idcentral!r}  veiculos={len(veiculos)}  modelos={len(modelos)}")
    if APLICAR:
        for v in veiculos:
            v.reference.delete()
        for m in modelos:
            m.reference.delete()
        doc.reference.delete()

print()
print(f"Total: {len(orfaos)} clientes órfãos, {total_veiculos_apagados} veículos junto.")
if not APLICAR:
    print("(dry-run - nada foi apagado. Rode de novo com --apply pra apagar de verdade.)")
else:
    print("Apagado.")
