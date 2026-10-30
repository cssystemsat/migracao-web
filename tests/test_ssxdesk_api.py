import unittest
from unittest.mock import Mock, patch

import requests

import ssxdesk_api


class ChamadaSsxDeskTest(unittest.TestCase):
    @patch.object(ssxdesk_api, "_API_KEY", "test-key")
    @patch.object(ssxdesk_api.requests, "get")
    def test_transforma_erro_http_da_api_em_erro_exibivel(self, get):
        response = Mock(status_code=500)
        response.raise_for_status.side_effect = requests.HTTPError("server error")
        get.return_value = response

        with self.assertRaisesRegex(
            ssxdesk_api.SsxDeskApiError,
            "temporariamente indisponível \\(HTTP 500\\)",
        ):
            ssxdesk_api._chamada("/tickets")

    @patch.object(ssxdesk_api, "_API_KEY", "test-key")
    @patch.object(ssxdesk_api.requests, "get")
    def test_preserva_resposta_json_de_sucesso(self, get):
        response = Mock(status_code=200)
        response.json.return_value = {"data": []}
        get.return_value = response

        self.assertEqual(ssxdesk_api._chamada("/tickets"), {"data": []})


if __name__ == "__main__":
    unittest.main()
