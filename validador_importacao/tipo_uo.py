"""Regras de validação da Importação de Unidades Organizacionais da SSX.

Diferente dos outros tipos (Cliente, Veículo, Rastreador, SIM Card, Área),
Unidade Organizacional NÃO TEM um "layout oficial de arquivo" documentado
pela SSX — o próprio endpoint
`POST /Administration/OrganizationalUnit/Insert` é o único jeito de
cadastrar uma UO (confirmado no Swagger,
https://integration.systemsatx.com.br, spec "SSX_Administration_Integration").
Por isso os campos/tamanhos abaixo vêm direto do schema
`OrganizationalUnitInsertParameter` do Swagger, não de um manual em PDF.

"TypeOrganizationalUnit" é o único campo de referência que NÃO precisa já
existir na SSX — o próprio schema documenta que o sistema cria o tipo
automaticamente se o nome informado não existir ainda. "Código de
integração da Unidade Organizacional pai" e "Código de integração do
cliente" já existem como catálogos consultáveis
(`LISTAGENS["uos"]`/`LISTAGENS["clientes"]` em app.py) — ver
conversor_uo.verificar_referencias_ssx.
"""
from .campos import CampoSpec, TipoImportacao

CAMPOS_UO = [
    CampoSpec("codigo_integracao", "Código de integração", "texto", tamanho_max=40,
              obrigatorio=True,
              descricao="É através dele que as operações entre os sistemas são realizadas."),
    CampoSpec("nome", "Nome", "texto", tamanho_max=100, obrigatorio=True),
    CampoSpec("tipo", "Tipo da Unidade Organizacional", "texto", tamanho_max=100, obrigatorio=True,
              descricao='O nome deve ser exatamente o nome cadastrado no Portal SSX. '
                        "Caso não exista, o sistema cria automaticamente."),
    CampoSpec("unidade_pai", "Código de integração da Unidade Organizacional pai", "texto", tamanho_max=40,
              descricao="Código identificador da Unidade Organizacional pai."),
    CampoSpec("codigo_integracao_cliente", "Código de integração do cliente", "texto",
              descricao="Se ausente, a Unidade Organizacional é criada para a central."),
    CampoSpec("descricao", "Descrição", "texto", tamanho_max=1000),
]

TIPO_UO = TipoImportacao(
    chave="uo",
    titulo="Unidade Organizacional",
    campos=CAMPOS_UO,
    chaves_unicas=("codigo_integracao",),
)
