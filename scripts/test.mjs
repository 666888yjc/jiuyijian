// 回归层 B 的入口：起本地夹具 → 等它就绪 → 跑 HTTP 冒烟 → 原样传递退出码。
//
// 为什么需要这一层：`dev/api-fixture/smoke.mjs` 断言的是「跑起来的夹具」，
// 它自己不起服务（夹具不可达时退出码 2）。CI 与贡献者都需要一条命令跑完这件事，
// 所以把「起服务／就绪探测／收场杀干净」收在这里，smoke 的判据一行不动。
//
// 退出码与 smoke 相同：0 全过｜1 有断言红｜2 夹具起不来。
import { spawn } from "node:child_process";
import { once } from "node:events";

const PORT = Number(process.env.FIXTURE_PORT || 8000);
const HOST = "127.0.0.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/health`);
      if (res.ok) return true;
    } catch {
      // 还没起来
    }
    if (Date.now() > until) return false;
    await sleep(200);
  }
}

const fixture = spawn(process.execPath, ["dev/api-fixture/server.mjs", String(PORT)], {
  stdio: ["ignore", "inherit", "inherit"],
});
let smokeCode = 2;
try {
  if (!(await waitHealthy())) {
    console.error(`前置不满足：夹具未能在 15 秒内就绪（http://${HOST}:${PORT}/health）。`);
    process.exit(2);
  }
  const smoke = spawn(process.execPath, ["dev/api-fixture/smoke.mjs", String(PORT)], {
    stdio: "inherit",
  });
  const [code] = await once(smoke, "exit");
  smokeCode = code ?? 2;
} finally {
  fixture.kill("SIGTERM");
}
process.exit(smokeCode);
