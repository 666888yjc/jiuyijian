// 本机识别链路的"假模型端点"：只在回环上应答，用来端到端验证 `dev/local-app/server.mjs` 那条
// OpenAI 兼容通路真的把请求发出去、SSE 真的被收回来——**验证链路时不需要动用任何真实模型额度，
// 也不让任何图片离开这台机器**。
//
// 它不是新造的假件：直接挂 `dev/fake-llm/handler.mjs`（A2 llm 通路用的那一份，长期回归夹具）。
// 那份会主动核形状——system 提示词必须逐字等于产品的 `AGENT_SYSTEM`、必须 `stream:true`、
// 必须带 `data:image/...` 的图，任何一条不满足就 400。所以"本机遇到的传输层"与"A2 里那条"
// 是同一把尺子，不是两条松紧不同的绳子。
// 用法：node dev/local-app/fake-model.mjs [port=5599]
import { createServer } from "node:http";
import { createFakeLlmHandler } from "../fake-llm/handler.mjs";
import { AGENT_SYSTEM } from "../../functions/extraction.mjs";

const PORT = Number(process.argv[2] || 5599);
const fake = createFakeLlmHandler({ getSystemPrompt: () => AGENT_SYSTEM });
// 本机自证用的小开关：那份夹具按请求头 `x-fake-scenario` 选剧本，而真实传输层不会带这种头。
// 所以这里允许把"下一单用什么剧本"设成默认值并替它把头补上——只影响这台假服务自己。
let forcedScenario = "";

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/_default" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { body = null; }
      const name = String(body?.scenario ?? "");
      if (name && !fake.scenarios.includes(name)) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "unknown_scenario", got: name }));
        return;
      }
      forcedScenario = name;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, scenario: forcedScenario || "report" }));
      return;
    }
    if (url.pathname === "/v1/chat/completions" && forcedScenario && !req.headers["x-fake-scenario"]) {
      req.headers["x-fake-scenario"] = forcedScenario;
    }
    // 这份长期回归夹具的签名是 handle(req, res, url)（URL 对象由调用方给）——夹具里也是这么调的。
    if (await fake.handle(req, res, url)) return;
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, fake: "local-model" }));
      return;
    }
    res.writeHead(404).end("not found");
  } catch (error) {
    // 假服务自己出错时不许把进程带走：一次未捕获异常会让客户端只看到 ECONNRESET，
    // 排障时看起来像"网络不通"而不是"这一跳坏了"（R103 给前门补过的同一课）。
    console.error(`[local-fake-model] ${req.method} ${url.pathname} 处理失败：${String(error?.stack ?? error).split("\n").slice(0, 3).join(" ⏐ ")}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "local_fake_model_error" } }));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[local-fake-model] OpenAI 兼容假端点：http://127.0.0.1:${PORT}/v1/chat/completions`);
});
