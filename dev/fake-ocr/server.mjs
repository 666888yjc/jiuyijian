// 假 Cloud Agents / 假 OCR 服务：独立可跑版本（长期回归夹具，仅本地）。
// 用法：node dev/fake-ocr/server.mjs [port]   默认 5000
// 控制面：GET /health、GET /_fake/state、POST /_fake/reset、POST /_fake/scenario、POST /_fake/declare
// API 面（真实 functions/extraction.mjs 直接对它跑）：/api/v1/cloud/{models,agents,environments,sessions,sessions/:id/events}
// 说明：夹具 node dev/api-fixture/server.mjs 已把同一 handler 挂在它自己的端口上，
//       所以「一条命令」验收不需要单独起本服务；本服务是给「想把假模型端点单独部署/换掉」的场景留的。
import http from "node:http";
import { createFakeOcrHandler } from "./handler.mjs";

const PORT = Number(process.argv[2] || process.env.FAKE_OCR_PORT || 5000);
const fake = createFakeOcrHandler();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (await fake.handle(req, res, url)) return;
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "fake_ocr_not_found", pathname: url.pathname }));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "fake_ocr_error", detail: String(error?.message ?? error) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-ocr] 假 Cloud Agents ready at http://127.0.0.1:${PORT}/health`);
  console.log(`[fake-ocr] 内置场景 ${fake.scenarios.length} 个；GET /_fake/state 看自证计数`);
});
