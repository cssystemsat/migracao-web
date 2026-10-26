"""Acesso SQL a Credencial (login manual, admin-only) e CredencialCliente
(extensão 1:1 de Cliente — PK é cliente_id, substitui o idcentral como doc id
do Firestore). Senha sempre cifrada (criptografia.py); dict devolvido traz a
senha em texto puro na mesma chave de antes."""
import criptografia
from db_sql import obter_sessao, obter_sessao_leitura
from models import Cliente, Credencial, CredencialCliente


def _credencial_para_dict(c):
    return {"id": c.id, "nome": c.nome, "login": c.login, "senha": criptografia.decifrar(c.senha_cifrada)}


def listar_credenciais_manuais():
    with obter_sessao_leitura() as sessao:
        return [_credencial_para_dict(c) for c in sessao.query(Credencial).all()]


def criar_credencial(nome, login, senha):
    nova = Credencial(nome=nome, login=login, senha_cifrada=criptografia.cifrar(senha))
    with obter_sessao() as sessao:
        sessao.add(nova)
        sessao.flush()
        return _credencial_para_dict(nova)


def editar_credencial(cred_id, nome, login, senha):
    with obter_sessao() as sessao:
        alvo = sessao.get(Credencial, cred_id)
        if not alvo:
            return None
        alvo.nome = nome
        alvo.login = login
        alvo.senha_cifrada = criptografia.cifrar(senha)
        return _credencial_para_dict(alvo)


def excluir_credencial(cred_id):
    with obter_sessao() as sessao:
        alvo = sessao.get(Credencial, cred_id)
        if not alvo:
            return False
        sessao.delete(alvo)
        return True


def obter_credencial_cliente(cliente_id):
    with obter_sessao_leitura() as sessao:
        cred = sessao.get(CredencialCliente, cliente_id)
        if not cred:
            return None
        return {"login": cred.login, "senha": criptografia.decifrar(cred.senha_cifrada)}


def salvar_credencial_cliente(cliente_id, login, senha):
    """`senha` já deve vir resolvida (vazio -> mantém a atual) por quem chamar
    — a validação "precisa ter senha" fica na rota, igual antes."""
    senha_cifrada = criptografia.cifrar(senha)
    with obter_sessao() as sessao:
        cred = sessao.get(CredencialCliente, cliente_id)
        if cred:
            cred.login = login
            cred.senha_cifrada = senha_cifrada
        else:
            sessao.add(CredencialCliente(cliente_id=cliente_id, login=login, senha_cifrada=senha_cifrada))


def listar_credenciais_clientes_para_logins_salvos():
    """Mesmo formato de antes (id="cliente:<idcentral>") pra aparecer junto
    com as manuais em /api/credenciais."""
    with obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(CredencialCliente, Cliente)
            .join(Cliente, CredencialCliente.cliente_id == Cliente.id)
            .all()
        )
        lista = []
        for cred, cliente in linhas:
            if not cred.login or not cred.senha_cifrada:
                continue
            lista.append({
                "id": f"cliente:{cliente.idcentral}",
                "nome": cliente.cliente or cliente.idcentral,
                "login": cred.login,
                "senha": criptografia.decifrar(cred.senha_cifrada),
                "origem": "cliente",
                "idcentral": cliente.idcentral,
            })
        return lista
