import unittest
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import migracoes_sql
from models import Base, Migracao, MigracaoVeiculo


class ListarVeiculosPaginaTest(unittest.TestCase):
    """Cobre a paginação/filtro/ordenação/resumo no banco (ver
    listar_veiculos_pagina e calcular_resumo_veiculos em migracoes_sql.py),
    que substituiu o filtro/ordenação em memória no front — isso travava a
    tela em central grande (ex. Cartracking)."""

    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine, tables=[Migracao.__table__, MigracaoVeiculo.__table__])
        self.session_local = sessionmaker(bind=self.engine, future=True, expire_on_commit=False)

        @contextmanager
        def sessao(escrita):
            db = self.session_local()
            try:
                yield db
                if escrita:
                    db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

        self.patches = (
            migracoes_sql.obter_sessao,
            migracoes_sql.obter_sessao_leitura,
        )
        migracoes_sql.obter_sessao = lambda: sessao(True)
        migracoes_sql.obter_sessao_leitura = lambda: sessao(False)

        with self.session_local() as db:
            db.add_all([
                MigracaoVeiculo(migracao_id=1, cliente="Ana", veiculo="AAA1111", status="Migrado"),
                MigracaoVeiculo(migracao_id=1, cliente="Ana", veiculo="AAA2222", status="Aguardando"),
                MigracaoVeiculo(migracao_id=1, cliente="Bruno", veiculo="BBB1111", status="Migrado"),
                MigracaoVeiculo(migracao_id=1, cliente="Bruno", veiculo="BBB2222", status="Cancelado"),
                MigracaoVeiculo(migracao_id=1, cliente="Carla", veiculo="CCC1111", status="Sem rastreador"),
                # Migração diferente — nunca pode aparecer nos resultados acima.
                MigracaoVeiculo(migracao_id=2, cliente="Outro", veiculo="ZZZ9999", status="Migrado"),
            ])
            db.commit()

    def tearDown(self):
        migracoes_sql.obter_sessao, migracoes_sql.obter_sessao_leitura = self.patches
        self.engine.dispose()

    def test_pagina_respeita_tamanho_e_total_ignora_outra_migracao(self):
        itens, total = migracoes_sql.listar_veiculos_pagina(1, pagina=0, tamanho=2)
        self.assertEqual(total, 5)
        self.assertEqual(len(itens), 2)

        itens_pagina2, total2 = migracoes_sql.listar_veiculos_pagina(1, pagina=2, tamanho=2)
        self.assertEqual(total2, 5)
        self.assertEqual(len(itens_pagina2), 1)

    def test_filtro_por_status(self):
        itens, total = migracoes_sql.listar_veiculos_pagina(1, status="Migrado")
        self.assertEqual(total, 2)
        self.assertTrue(all(v["status"] == "Migrado" for v in itens))

    def test_filtro_por_busca_ignora_caixa(self):
        itens, total = migracoes_sql.listar_veiculos_pagina(1, busca="bru")
        self.assertEqual(total, 2)
        self.assertTrue(all(v["cliente"] == "Bruno" for v in itens))

    def test_filtro_por_coluna_cliente(self):
        itens, total = migracoes_sql.listar_veiculos_pagina(1, filtros_coluna={"cliente": "ana"})
        self.assertEqual(total, 2)
        self.assertTrue(all(v["cliente"] == "Ana" for v in itens))

    def test_filtros_de_colunas_diferentes_combinam_em_e(self):
        # "Ana" + placa terminada em 2222 -> só AAA2222, não AAA1111.
        itens, total = migracoes_sql.listar_veiculos_pagina(
            1, filtros_coluna={"cliente": "ana", "veiculo": "2222"},
        )
        self.assertEqual(total, 1)
        self.assertEqual(itens[0]["veiculo"], "AAA2222")

    def test_ordenacao_desc_por_veiculo(self):
        itens, _ = migracoes_sql.listar_veiculos_pagina(1, tamanho=10, ordenar_por="veiculo", ordem_asc=False)
        placas = [v["veiculo"] for v in itens]
        self.assertEqual(placas, sorted(placas, reverse=True))

    def test_resumo_por_status_e_por_cliente(self):
        resumo = migracoes_sql.calcular_resumo_veiculos(1)
        self.assertEqual(resumo["total"], 5)
        self.assertEqual(resumo["por_status"]["Migrado"], 2)
        self.assertEqual(resumo["por_status"]["Cancelado"], 1)
        # Bruno: Migrado + Cancelado -> Cancelado fica fora da contagem (total=1, migrado=1).
        self.assertEqual(resumo["por_cliente"]["Bruno"], {"total": 1, "migrado": 1})
        # Carla só tem "Sem rastreador" -> fora da contagem por cliente também.
        self.assertNotIn("Carla", resumo["por_cliente"])
        self.assertEqual(resumo["por_cliente"]["Ana"], {"total": 2, "migrado": 1})


if __name__ == "__main__":
    unittest.main()
