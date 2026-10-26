"""Migra Cliente (+ eventos, migrações, veículos, modelos de comando,
tarefas, credenciais, credenciais de cliente, feed) do Firestore pro
Postgres — login/usuários (ver migrar_usuarios_para_postgres.py) já migrou
antes; aqui já pressupõe que os usuários existem no Postgres (pra resolver
FK de responsável/autor).

Diferente do script de usuários, as PKs aqui são seriais NOVAS (não
preserva id do Firestore) — por isso a idempotência é "wipe-and-reload":
`--apply` apaga (TRUNCATE ... CASCADE) todas as tabelas novas e reconstrói
do zero a partir do Firestore a cada rodada. Seguro porque é cutover direto
(nada mais escreve nessas tabelas depois do corte) e o Firestore nunca é
tocado, só lido.

Ignora de propósito `implantacao_clientes`/`migracao_clientes` (coleções
legadas, predecessoras do modelo unificado `clientes`) — decisão explícita
de aceitar perder esses dados de teste (ver docs/HISTORICO_DECISOES.md).

Usa os models diretamente (não a camada clientes_sql.py/etc.) pra poder
preservar `criado_em` original do Firestore e fazer o TRUNCATE em massa —
mesmo estilo de migrar_usuarios_para_postgres.py.

Uso (precisa de FIREBASE_CREDENTIALS_JSON e DATABASE_URL apontando pro
Postgres de destino — mesmas variáveis de rodar app.py normalmente):
    ./venv/Scripts/python.exe migrar_clientes_para_postgres.py            # dry-run
    ./venv/Scripts/python.exe migrar_clientes_para_postgres.py --apply    # aplica de verdade
"""
import sys

from sqlalchemy import text

import app
import criptografia
from db_sql import engine, obter_sessao
from models import (
    Cliente, ClienteEvento, Credencial, CredencialCliente, FeedComentario,
    FeedPost, FeedPostCurtida, Migracao, MigracaoModeloComando, MigracaoVeiculo,
    Tarefa, Usuario,
)

APLICAR = "--apply" in sys.argv

CAMPOS_CLIENTE = [
    "tem_implantacao", "data_entrada", "objetivo", "valor_contrato", "etapa",
    "estagio", "momento", "flag", "persona", "decisor_nome", "decisor_whatsapp",
    "decisor_estado", "decisor_cidade", "implantado", "implantado_em",
    "implantado_por", "concluido_em", "concluido_por", "marcos_concluidos",
    "marcos_concluidos_em", "marcos_atualizado_em", "marcos_itens_feitos",
    "marcos_itens_extras", "marcos_concluidos_manual", "marcos_prioridades",
    "motivo_atraso", "ultima_acao", "ultima_acao_data", "dados_planilha",
]
CAMPOS_EVENTO = ["setor", "titulo", "descricao", "data", "responsavel", "tag"]
CAMPOS_MIGRACAO = [
    "plataforma_origem", "link_planilha", "link_acesso_origem",
    "login_acesso_origem", "qtd_clientes", "qtd_placas", "percentual_migracao",
    "percentual_atualizado_em", "etapa", "status", "data_inicio", "data_fim", "motivo",
]
CAMPOS_VEICULO = [
    "cliente", "veiculo", "equipamento", "id_equipamento", "apn", "ls_apn",
    "numero_linha", "comando", "ultima_comunicacao", "status",
]
CAMPOS_MODELO = ["modelo", "porta", "comando_template"]


def resolver_usuario_por_nome(nomes_usuarios, nome):
    nome = (nome or "").strip()
    return nomes_usuarios.get(nome.lower()) if nome else None


with obter_sessao() as sessao:
    nomes_usuarios = {
        u.nome_responsavel.strip().lower(): u.id
        for u in sessao.query(Usuario).all()
        if u.nome_responsavel and u.nome_responsavel.strip()
    }
    ids_usuarios_existentes = {u.id for u in sessao.query(Usuario.id).all()}

print(f"Usuarios carregados pra resolver FK: {len(ids_usuarios_existentes)} (por nome_responsavel: {len(nomes_usuarios)}).")
print()

if APLICAR:
    print("Apagando tabelas novas (TRUNCATE ... CASCADE) antes de reconstruir...")
    with engine.begin() as conn:
        conn.execute(text(
            "TRUNCATE TABLE clientes, cliente_eventos, migracoes, migracao_veiculos, "
            "migracao_modelos_comando, tarefas, credenciais, credenciais_cliente, "
            "feed_posts, feed_post_curtidas, feed_comentarios RESTART IDENTITY CASCADE"
        ))
    print("OK, tabelas limpas.")
    print()

# --- CLIENTES (+ eventos, migrações, veículos, modelos) ---
clientes_docs = list(app.db.collection("clientes").stream())
print(f"Encontrados {len(clientes_docs)} clientes em 'clientes' (Firestore).")

mapa_cliente_id = {}  # doc_id Firestore -> id novo (Postgres)
total_eventos = total_migracoes = total_veiculos = total_modelos = 0

with obter_sessao() as sessao:
    for d in clientes_docs:
        dados = d.to_dict() or {}
        idcentral = str(dados.get("idcentral", "")).strip()
        if not idcentral:
            print(f"  - {d.id}  SEM IDCENTRAL — pulado")
            continue

        csm_nome = str(dados.get("csm", "")).strip()
        vendedor_nome = str(dados.get("vendedor", "")).strip()
        cliente = Cliente(
            idcentral=idcentral,
            cliente=str(dados.get("cliente", "")).strip(),
            responsavel_usuario_id=resolver_usuario_por_nome(nomes_usuarios, csm_nome),
            csm_nome=csm_nome,
            vendedor_usuario_id=resolver_usuario_por_nome(nomes_usuarios, vendedor_nome),
            vendedor_nome=vendedor_nome,
            codigo_idcentral=dados.get("codigo_idcentral"),
        )
        for campo in CAMPOS_CLIENTE:
            if campo in dados:
                setattr(cliente, campo, dados[campo])
        if APLICAR:
            sessao.add(cliente)
            sessao.flush()
            mapa_cliente_id[d.id] = cliente.id
        print(f"  - {d.id}  idcentral={idcentral!r}  {dados.get('cliente', '')!r}")

        for ev in d.reference.collection("eventos").stream():
            total_eventos += 1
            if APLICAR:
                ev_dados = ev.to_dict() or {}
                novo_evento = ClienteEvento(cliente_id=cliente.id)
                for campo in CAMPOS_EVENTO:
                    setattr(novo_evento, campo, ev_dados.get(campo, ""))
                sessao.add(novo_evento)

        for mig in d.reference.collection("migracoes").stream():
            total_migracoes += 1
            mig_dados = mig.to_dict() or {}
            nova_migracao = Migracao(cliente_id=cliente.id if APLICAR else None)
            for campo in CAMPOS_MIGRACAO:
                if campo in mig_dados:
                    setattr(nova_migracao, campo, mig_dados[campo])
            nova_migracao.senha_acesso_origem_cifrada = criptografia.cifrar(
                mig_dados.get("senha_acesso_origem", "")
            )
            if APLICAR:
                sessao.add(nova_migracao)
                sessao.flush()

            for v in mig.reference.collection("veiculos").stream():
                total_veiculos += 1
                if APLICAR:
                    v_dados = v.to_dict() or {}
                    novo_veiculo = MigracaoVeiculo(migracao_id=nova_migracao.id)
                    for campo in CAMPOS_VEICULO:
                        setattr(novo_veiculo, campo, v_dados.get(campo, "") if campo != "status"
                                else v_dados.get(campo, "Aguardando"))
                    sessao.add(novo_veiculo)

            for m in mig.reference.collection("modelos_comando").stream():
                total_modelos += 1
                if APLICAR:
                    m_dados = m.to_dict() or {}
                    novo_modelo = MigracaoModeloComando(migracao_id=nova_migracao.id)
                    for campo in CAMPOS_MODELO:
                        setattr(novo_modelo, campo, m_dados.get(campo, ""))
                    sessao.add(novo_modelo)

print(f"Total: {len(mapa_cliente_id) if APLICAR else len(clientes_docs)} clientes, "
      f"{total_eventos} eventos, {total_migracoes} migrações, {total_veiculos} veículos, "
      f"{total_modelos} modelos de comando.")
print()

# --- TAREFAS ---
tarefas_docs = list(app.db.collection("tarefas").stream())
print(f"Encontradas {len(tarefas_docs)} tarefas em 'tarefas' (Firestore).")
tarefas_ok, tarefas_puladas = 0, []
with obter_sessao() as sessao:
    for t in tarefas_docs:
        dados = t.to_dict() or {}
        cliente_fs_id = dados.get("cliente_id") or None
        cliente_id_novo = mapa_cliente_id.get(cliente_fs_id) if cliente_fs_id else None
        responsavel_id = dados.get("responsavel_id", "")
        if responsavel_id not in ids_usuarios_existentes:
            tarefas_puladas.append((t.id, f"responsavel_id {responsavel_id!r} não existe no Postgres"))
            continue
        criado_por = dados.get("criado_por") or None
        if criado_por and criado_por not in ids_usuarios_existentes:
            criado_por = None  # autor sumiu — não bloqueia a tarefa, só perde a referência
        if APLICAR:
            nova_tarefa = Tarefa(
                titulo=dados.get("titulo", ""), descricao=dados.get("descricao", ""),
                data_limite=dados.get("data_limite", ""), cliente_id=cliente_id_novo,
                idcentral=dados.get("idcentral", ""), cliente_nome=dados.get("cliente_nome", ""),
                responsavel_id=responsavel_id, responsavel_nome=dados.get("responsavel_nome", ""),
                concluida=bool(dados.get("concluida")), concluida_em=dados.get("concluida_em", ""),
                criado_por=criado_por, criado_por_nome=dados.get("criado_por_nome", ""),
                criado_em=dados.get("criado_em", ""), resultado=dados.get("resultado", ""),
                resultado_descricao=dados.get("resultado_descricao", ""),
                finalizada_por_nome=dados.get("finalizada_por_nome", ""),
            )
            sessao.add(nova_tarefa)
        tarefas_ok += 1
print(f"Total: {tarefas_ok} tarefas migradas, {len(tarefas_puladas)} puladas.")
for tid, motivo in tarefas_puladas:
    print(f"  - PULADA {tid}: {motivo}")
print()

# --- CREDENCIAIS (manuais) ---
cred_docs = list(app.db.collection("credenciais").stream())
print(f"Encontradas {len(cred_docs)} credenciais manuais em 'credenciais' (Firestore).")
with obter_sessao() as sessao:
    for cdoc in cred_docs:
        dados = cdoc.to_dict() or {}
        if APLICAR:
            sessao.add(Credencial(
                nome=dados.get("nome", ""), login=dados.get("login", ""),
                senha_cifrada=criptografia.cifrar(dados.get("senha", "")),
            ))
print(f"Total: {len(cred_docs)} credenciais manuais migradas.")
print()

# --- CREDENCIAIS DE CLIENTE (doc id = idcentral) ---
credcli_docs = list(app.db.collection("credenciais_cliente").stream())
print(f"Encontradas {len(credcli_docs)} credenciais de cliente em 'credenciais_cliente' (Firestore).")
idcentral_para_cliente_id = {}
if APLICAR:
    with obter_sessao() as sessao:
        for cliente_id_fs, cliente_id_novo in mapa_cliente_id.items():
            c = sessao.get(Cliente, cliente_id_novo)
            idcentral_para_cliente_id[c.idcentral] = cliente_id_novo
credcli_ok, credcli_orfas = 0, []
with obter_sessao() as sessao:
    for cdoc in credcli_docs:
        dados = cdoc.to_dict() or {}
        cliente_id_novo = idcentral_para_cliente_id.get(cdoc.id)
        if APLICAR and cliente_id_novo is None:
            credcli_orfas.append(cdoc.id)
            continue
        if APLICAR:
            sessao.add(CredencialCliente(
                cliente_id=cliente_id_novo, login=dados.get("login", ""),
                senha_cifrada=criptografia.cifrar(dados.get("senha", "")),
            ))
        credcli_ok += 1
print(f"Total: {credcli_ok - len(credcli_orfas) if APLICAR else credcli_ok} credenciais de cliente migradas, "
      f"{len(credcli_orfas)} órfãs (idcentral sem cliente correspondente).")
for idc in credcli_orfas:
    print(f"  - ÓRFÃ: idcentral {idc!r}")
print()

# --- FEED (posts, curtidas, comentários) ---
posts_docs = list(app.db.collection("feed_posts").stream())
print(f"Encontrados {len(posts_docs)} posts em 'feed_posts' (Firestore).")
mapa_post_id = {}
total_curtidas = 0
with obter_sessao() as sessao:
    for p in posts_docs:
        dados = p.to_dict() or {}
        cliente_fs_id = dados.get("cliente_id") or None
        novo_post = FeedPost(
            texto=dados.get("texto", ""), autor_id=dados.get("autor_id", ""),
            autor_nome=dados.get("autor_nome", ""),
            cliente_id=mapa_cliente_id.get(cliente_fs_id) if cliente_fs_id else None,
            cliente_nome=dados.get("cliente_nome", ""),
            comentarios_total=dados.get("comentarios_total", 0), tipo=dados.get("tipo", ""),
        )
        if dados.get("criado_em"):
            novo_post.criado_em = dados["criado_em"]
        if APLICAR:
            sessao.add(novo_post)
            sessao.flush()
            mapa_post_id[p.id] = novo_post.id
            for usuario_id in dados.get("curtidas", []):
                if usuario_id in ids_usuarios_existentes:
                    sessao.add(FeedPostCurtida(post_id=novo_post.id, usuario_id=usuario_id))
                    total_curtidas += 1
print(f"Total: {len(posts_docs)} posts, {total_curtidas} curtidas migradas.")
print()

coment_docs = list(app.db.collection("feed_comentarios").stream())
print(f"Encontrados {len(coment_docs)} comentários em 'feed_comentarios' (Firestore).")
coment_ok, coment_orfaos = 0, []
with obter_sessao() as sessao:
    for cdoc in coment_docs:
        dados = cdoc.to_dict() or {}
        post_id_novo = mapa_post_id.get(dados.get("post_id"))
        if APLICAR and post_id_novo is None:
            coment_orfaos.append(cdoc.id)
            continue
        autor_id = dados.get("autor_id") or None
        if autor_id and autor_id not in ids_usuarios_existentes:
            autor_id = None
        if APLICAR:
            novo_comentario = FeedComentario(
                post_id=post_id_novo, texto=dados.get("texto", ""),
                autor_id=autor_id, autor_nome=dados.get("autor_nome", ""),
            )
            if dados.get("criado_em"):
                novo_comentario.criado_em = dados["criado_em"]
            sessao.add(novo_comentario)
        coment_ok += 1
print(f"Total: {coment_ok - len(coment_orfaos) if APLICAR else coment_ok} comentários migrados, "
      f"{len(coment_orfaos)} órfãos (post não encontrado).")
print()

if not APLICAR:
    print("(dry-run - nada foi escrito. Rode de novo com --apply pra aplicar de verdade.)")
else:
    print("Aplicado. Firestore NAO foi apagado/alterado - fica intacto como backup, sem prazo de remoção.")
