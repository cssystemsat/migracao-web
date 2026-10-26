"""Acesso SQL a ClienteDocumento (Postgres) — anexos da Ficha do cliente
(ficha de entrada, contrato). Mesmo padrão de blob base64 que usuarios_sql
usa pra foto de perfil (ver UsuarioFoto), mas com `tipo` fixo em vez de
tabela 1:1 — ver TIPOS_DOCUMENTO_CLIENTE em app.py pros tipos válidos.

`listar_metadados` nunca devolve `conteudo` (pode ter alguns MB em base64) —
só usada pra montar o card de Documentos da Ficha. `obter_arquivo` é o único
ponto que lê o conteúdo inteiro, pra servir o PDF de verdade.
"""
from db_sql import obter_sessao, obter_sessao_leitura
from models import ClienteDocumento


def _metadados(doc):
    return {
        "nome_arquivo": doc.nome_arquivo,
        "tamanho": doc.tamanho,
        "enviado_em": doc.enviado_em,
        "enviado_por": doc.enviado_por,
    }


def listar_metadados(cliente_id):
    """{tipo: metadados|None} — sem conteúdo, pra exibir status no card."""
    with obter_sessao_leitura() as sessao:
        docs = sessao.query(ClienteDocumento).filter_by(cliente_id=cliente_id).all()
    por_tipo = {doc.tipo: _metadados(doc) for doc in docs}
    return por_tipo


def obter_arquivo(cliente_id, tipo):
    """Com conteúdo — só pra servir o download/visualização do PDF."""
    with obter_sessao_leitura() as sessao:
        doc = (
            sessao.query(ClienteDocumento)
            .filter_by(cliente_id=cliente_id, tipo=tipo)
            .first()
        )
        if not doc:
            return None
        return {
            "nome_arquivo": doc.nome_arquivo,
            "conteudo": doc.conteudo,
            "tamanho": doc.tamanho,
            "enviado_em": doc.enviado_em,
            "enviado_por": doc.enviado_por,
        }


def salvar_documento(cliente_id, tipo, nome_arquivo, conteudo, tamanho, enviado_em, enviado_por):
    """Upsert — substitui o documento anterior desse tipo, se existir."""
    with obter_sessao() as sessao:
        existente = (
            sessao.query(ClienteDocumento)
            .filter_by(cliente_id=cliente_id, tipo=tipo)
            .first()
        )
        if existente:
            existente.nome_arquivo = nome_arquivo
            existente.conteudo = conteudo
            existente.tamanho = tamanho
            existente.enviado_em = enviado_em
            existente.enviado_por = enviado_por
        else:
            sessao.add(ClienteDocumento(
                cliente_id=cliente_id, tipo=tipo, nome_arquivo=nome_arquivo,
                conteudo=conteudo, tamanho=tamanho, enviado_em=enviado_em, enviado_por=enviado_por,
            ))
    return _metadados(existente) if existente else {
        "nome_arquivo": nome_arquivo, "tamanho": tamanho, "enviado_em": enviado_em, "enviado_por": enviado_por,
    }


def excluir_documento(cliente_id, tipo):
    with obter_sessao() as sessao:
        existente = (
            sessao.query(ClienteDocumento)
            .filter_by(cliente_id=cliente_id, tipo=tipo)
            .first()
        )
        if not existente:
            return False
        sessao.delete(existente)
        return True
