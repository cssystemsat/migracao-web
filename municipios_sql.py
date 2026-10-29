"""Acesso SQL ao cache de municípios do IBGE (ver models.MunicipioIbge). A
rota /api/localidades/municipios/<uf> lê só daqui — quem alimenta a tabela é
sincronizar_municipios_ibge.py, roda manual (nunca a cada abertura de tela)."""
from db_sql import obter_sessao, obter_sessao_leitura
from models import MunicipioIbge


def listar_por_uf(uf):
    with obter_sessao_leitura() as sessao:
        linhas = (
            sessao.query(MunicipioIbge)
            .filter(MunicipioIbge.uf == uf)
            .order_by(MunicipioIbge.nome)
            .all()
        )
        return [m.nome for m in linhas]


def tem_dados(uf):
    with obter_sessao_leitura() as sessao:
        return sessao.query(MunicipioIbge.id).filter(MunicipioIbge.uf == uf).first() is not None


def substituir_municipios_uf(uf, nomes):
    """Substitui por completo a lista de municípios de uma UF (delete + insert)
    — mais simples que upsert por nome porque o IBGE não manda id estável
    nenhum pra gente guardar, e o volume por UF é pequeno (no máximo ~650,
    caso de MG)."""
    with obter_sessao() as sessao:
        sessao.query(MunicipioIbge).filter(MunicipioIbge.uf == uf).delete()
        sessao.add_all(MunicipioIbge(uf=uf, nome=nome) for nome in nomes)
