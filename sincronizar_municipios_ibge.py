"""Popula/atualiza o cache de municípios do IBGE (ver models.MunicipioIbge,
municipios_sql.py) — é o ÚNICO lugar que chama a API de Localidades do IBGE;
a rota /api/localidades/municipios/<uf> só lê do banco.

Roda manual: na primeira vez (seed inicial, tabela vazia) e depois só quando
o IBGE incluir/alterar algum município (evento raro — não tem job agendado
pra isso).

Uso (precisa de DATABASE_URL apontando pro banco de destino, igual rodar
app.py normalmente):
    ./venv/Scripts/python.exe sincronizar_municipios_ibge.py        # todas as 27 UFs
    ./venv/Scripts/python.exe sincronizar_municipios_ibge.py SP RJ  # só as UFs informadas
"""
import sys

import requests

import municipios_sql
from app import SIGLAS_ESTADOS_BRASIL

ufs = [u.upper() for u in sys.argv[1:]] or sorted(SIGLAS_ESTADOS_BRASIL)

invalidas = [u for u in ufs if u not in SIGLAS_ESTADOS_BRASIL]
if invalidas:
    sys.exit(f"UF inválida: {', '.join(invalidas)}")

for uf in ufs:
    r = requests.get(
        f"https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios",
        timeout=10,
    )
    r.raise_for_status()
    nomes = sorted(m["nome"] for m in r.json())
    municipios_sql.substituir_municipios_uf(uf, nomes)
    print(f"{uf}: {len(nomes)} municípios salvos.")

print()
print("Pronto.")
