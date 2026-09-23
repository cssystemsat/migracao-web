"""AINDA NÃO É PRA RODAR EM PRODUÇÃO — guardado pronto pra quando o Postgres do
servidor da empresa existir (produção hoje é Render, sem Postgres provisionado
lá; app.py continua 100% Firestore pra usuários por enquanto).

Migra os logins da ferramenta de "app_usuarios" (Firestore) pra "usuarios"
(Postgres) — Fase 1 do schema_relacional_alvo_v3.

Preserva o ID do documento Firestore como chave primária em Postgres (não gera
um id novo) — é o mesmo valor que tarefas.responsavel_id/criado_por,
log_auditoria.usuario_id, historico_cliente.autor_id e o cookie de sessão já
guardam, então nada mais precisa remapear id nenhum.

`area` sai sempre vazia (ninguém tem área ainda — a Fase 0 do pedido é só
poder cadastrar; atribuir área pra cada usuário existente é manual, depois,
em Gerenciar Usuários).

Por segurança, é uma CÓPIA aditiva/idempotente — não apaga nada do Firestore,
e rodar de novo não duplica (mesmo id, sobrescreve).

Uso (precisa de FIREBASE_CREDENTIALS_JSON com a credencial de verdade e
DATABASE_URL apontando pro Postgres de destino — mesmas variáveis de rodar
app.py normalmente):
    ./venv/Scripts/python.exe migrar_usuarios_para_postgres.py            # dry-run, só mostra o que faria
    ./venv/Scripts/python.exe migrar_usuarios_para_postgres.py --apply    # aplica de verdade
"""
import sys

import app
from models import Usuario

APLICAR = "--apply" in sys.argv

docs = list(app.db.collection(app.APP_USUARIOS_COLLECTION).stream())
print(f"Encontrados {len(docs)} usuários em '{app.APP_USUARIOS_COLLECTION}' (Firestore).")
print()

total = 0
ja_existentes = 0
with app.obter_sessao() as sessao:
    for d in docs:
        usuario_id = d.id
        dados = d.to_dict() or {}
        perfil = app._perfil_de_usuario(dados)

        existente = sessao.get(Usuario, usuario_id)
        status_txt = "JA EXISTE NO POSTGRES (seria sobrescrito)" if existente else "novo"
        if existente:
            ja_existentes += 1

        nome_usuario = dados.get("usuario", "(sem nome)")
        print(f"  - {usuario_id}  {nome_usuario!r}  perfil={perfil}  [{status_txt}]")
        total += 1

        if not APLICAR:
            continue

        alvo = existente or Usuario(id=usuario_id)
        alvo.usuario = dados.get("usuario", "")
        alvo.usuario_norm = dados.get("usuario_norm", "") or str(dados.get("usuario", "")).strip().lower()
        alvo.senha_hash = dados.get("senha_hash", "")
        alvo.perfil = perfil
        alvo.area = None  # atribuição manual, depois, em Gerenciar Usuários
        alvo.nome_responsavel = dados.get("nome_responsavel", "")
        alvo.nome = dados.get("nome", "")
        alvo.sobrenome = dados.get("sobrenome", "")
        alvo.aniversario = dados.get("aniversario", "")
        alvo.telefone_profissional = dados.get("telefone_profissional", "")
        alvo.email = dados.get("email", "")
        alvo.foto = dados.get("foto", "")
        if not existente:
            sessao.add(alvo)

print()
print(f"Total: {total} usuários, {ja_existentes} já existiam no Postgres.")
if not APLICAR:
    print("(dry-run - nada foi escrito. Rode de novo com --apply pra aplicar de verdade.)")
else:
    print("Aplicado. 'app_usuarios' (Firestore) NAO foi apagada (cópia aditiva) - dá pra conferir "
          "o login em Postgres funcionando antes de decidir remover a coleção antiga depois.")
