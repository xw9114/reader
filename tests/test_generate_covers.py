import base64
import io
import json
import unittest
from unittest.mock import patch

from tools.generate_covers import (
    DEFAULT_IMAGE_BASE_URL,
    DEFAULT_IMAGE_MODEL,
    decode_image_response,
    detect_extension,
    request_cover,
)


class GenerateCoversTests(unittest.TestCase):
    def test_reader_gateway_defaults(self):
        self.assertEqual(DEFAULT_IMAGE_BASE_URL, "https://api.xw9114.online/v1")
        self.assertEqual(DEFAULT_IMAGE_MODEL, "gpt-image-2")

    def test_decodes_base64_png(self):
        image = b"\x89PNG\r\n\x1a\ncover"

        decoded = decode_image_response({"data": [{"b64_json": base64.b64encode(image).decode("ascii")}]})

        self.assertEqual(decoded, image)
        self.assertEqual(detect_extension(decoded), ".png")

    def test_rejects_oversized_base64_image(self):
        encoded = base64.b64encode(b"12345").decode("ascii")

        with patch("tools.generate_covers.MAX_IMAGE_BYTES", 4):
            with self.assertRaisesRegex(ValueError, "超过 12 MiB"):
                decode_image_response({"data": [{"b64_json": encoded}]})

    @patch("tools.generate_covers.urllib.request.urlopen")
    def test_request_uses_openai_images_contract(self, urlopen):
        image = b"\x89PNG\r\n\x1a\ncover"
        response = {"data": [{"b64_json": base64.b64encode(image).decode("ascii")}]}
        urlopen.return_value = io.BytesIO(json.dumps(response).encode("utf-8"))

        result = request_cover(
            DEFAULT_IMAGE_BASE_URL,
            "test-token",
            DEFAULT_IMAGE_MODEL,
            "1024x1536",
            {"title": "测试小说", "chapters": [{"body": "雨夜里的旧城档案馆。"}]},
        )

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request.full_url, "https://api.xw9114.online/v1/images/generations")
        self.assertEqual(request.headers["Authorization"], "Bearer test-token")
        self.assertEqual(payload["model"], "gpt-image-2")
        self.assertEqual(payload["size"], "1024x1536")
        self.assertEqual(payload["output_format"], "png")
        self.assertEqual(result, image)


if __name__ == "__main__":
    unittest.main()
