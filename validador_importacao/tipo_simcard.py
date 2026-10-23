"""Regras de validação da Importação de SIM Cards da SSX.

Baseado no manual "SSX - Importação de SIM Cards" (v1.0, 15/07/2018): lista
de campos, obrigatoriedade, tipo/tamanho e a seção "Regras e exceções".
"""
from .campos import CampoSpec, TipoImportacao

CAMPOS_SIMCARD = [
    CampoSpec("iccid", "ICCID", "texto", tamanho_max=40, obrigatorio=True,
              descricao="Número de série do chip."),
    CampoSpec("apn_dominio", "Domínio da APN", "texto", tamanho_max=100, obrigatorio=True,
              descricao="Domínio da APN cadastrada no SSX."),
    CampoSpec("ddi", "DDI", "texto", obrigatorio=True, somente_numeros=True),
    CampoSpec("ddd", "DDD", "texto", obrigatorio=True, somente_numeros=True),
    CampoSpec("telefone", "Telefone", "texto", obrigatorio=True, somente_numeros=True),
    CampoSpec("dia_corte", "Dia de corte", "byte",
              descricao="Dia do mês que renova o período de cobrança da operadora de telefonia."),
    CampoSpec("valor_plano", "Valor do plano", "decimal",
              descricao='Valor cobrado mensalmente pela operadora pelo tráfego de dados. '
                        'Separador decimal: "." (ponto).'),
    CampoSpec("limite_megabytes", "Limite de megabytes", "decimal",
              descricao="Limite de transferência de dados contratados em megabytes."),
    CampoSpec("pin", "PIN", "texto", tamanho_max=8,
              descricao="PIN - Personal Identification Number - Senha do SIM card."),
    CampoSpec("puk", "PUK", "texto", tamanho_max=8,
              descricao="PUK - PIN Unlock Key - Código para desbloqueio do SIM card."),
]

TIPO_SIMCARD = TipoImportacao(
    chave="simcard",
    titulo="SIM Card",
    campos=CAMPOS_SIMCARD,
    chaves_unicas=("iccid",),
)
