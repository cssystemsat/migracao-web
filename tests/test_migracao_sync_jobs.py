import unittest
from contextlib import contextmanager
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import migracoes_sql
from models import Base, Migracao, MigracaoSsxSyncJob, MigracaoVeiculo


class PersistenciaJobsSincronizacaoTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", future=True)
        Base.metadata.create_all(
            self.engine,
            tables=[
                Migracao.__table__,
                MigracaoVeiculo.__table__,
                MigracaoSsxSyncJob.__table__,
            ],
        )
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
            patch("migracoes_sql.obter_sessao", side_effect=lambda: sessao(True)),
            patch("migracoes_sql.obter_sessao_leitura", side_effect=lambda: sessao(False)),
        )
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.engine.dispose()

    def test_preview_persistida_e_aplicacao_idempotente(self):
        diff = {
            "a_criar": [
                {"campos": {"cliente": "Cliente teste", "veiculo": "ABC1234", "id_equipamento": "tracker-1"}}
            ],
            "a_atualizar": [],
            "nao_cadastrados": [],
        }
        migracoes_sql.criar_job_sincronizacao_ssx(42, "job-persistente")
        migracoes_sql.atualizar_job_sincronizacao_ssx("job-persistente", "concluido", diff=diff)

        preview = migracoes_sql.buscar_job_sincronizacao_ssx(42, "job-persistente")
        self.assertEqual(preview["status"], "concluido")
        self.assertEqual(preview["diff"]["a_criar"][0]["campos"]["veiculo"], "ABC1234")

        resultado, erro = migracoes_sql.aplicar_job_sincronizacao_ssx(42, "job-persistente")
        self.assertIsNone(erro)
        self.assertEqual(resultado["criadas"], 1)

        repeticao, erro = migracoes_sql.aplicar_job_sincronizacao_ssx(42, "job-persistente")
        self.assertIsNone(erro)
        self.assertTrue(repeticao["ja_aplicado"])
        self.assertEqual(repeticao["criadas"], 1)
        with self.session_local() as sessao:
            self.assertEqual(sessao.query(MigracaoVeiculo).count(), 1)
            job = sessao.get(MigracaoSsxSyncJob, "job-persistente")
            self.assertEqual(job.status, "aplicado")
            self.assertIsNone(job.diff)

    def test_job_nao_pode_ser_usado_em_outra_migracao(self):
        migracoes_sql.criar_job_sincronizacao_ssx(42, "job-protegido")

        self.assertIsNone(migracoes_sql.buscar_job_sincronizacao_ssx(99, "job-protegido"))
        resultado, erro = migracoes_sql.aplicar_job_sincronizacao_ssx(99, "job-protegido")
        self.assertIsNone(resultado)
        self.assertEqual(erro, "nao_encontrado")

    def test_preview_grande_persiste_todos_os_itens(self):
        diff = {
            "a_criar": [
                {"campos": {"cliente": "Cliente teste", "veiculo": f"ABC{i:04d}"}}
                for i in range(29261)
            ],
            "a_atualizar": [],
            "nao_cadastrados": [],
        }
        migracoes_sql.criar_job_sincronizacao_ssx(42, "job-grande")
        migracoes_sql.atualizar_job_sincronizacao_ssx("job-grande", "concluido", diff=diff)

        preview = migracoes_sql.buscar_job_sincronizacao_ssx(42, "job-grande")
        self.assertEqual(len(preview["diff"]["a_criar"]), 29261)


if __name__ == "__main__":
    unittest.main()
