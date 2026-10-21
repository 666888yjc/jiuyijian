// 把「CloudBase 函数需要的那部分」组装成一个干净的上传目录（R122 的同款纪律：
// 上传面必须显式列名，不许拿仓库根往上传——回归证据、.bak、out/ 都在仓库里）。
//
// 用法：node dev/tcb-deploy/stage.mjs [输出目录=~/jyj-scratch/tcb-deploy]
// 产出：package.json（依赖 @cloudbase/node-sdk，沙箱里 npm install）＋functions/*.mjs＋dev/backend-local/*.mjs
// 明确**不**带：index.ts（Qoder Deno 入口，已退役；它带 npm: 前缀说明符，Node 侧不认）、
//              node_modules（沙箱自己装）、docs/、dev/regression/、任何 .json 证据件。
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { homedir } from "node:os";

const ROOT = join(import.meta.dirname, "../..");
const OUT = process.argv[2] ? join(process.argv[2]) : join(homedir(), "jyj-scratch", "tcb-deploy");

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "functions"), { recursive: true });
mkdirSync(join(OUT, "dev", "backend-local"), { recursive: true });

// 1) functions：整目录 .mjs，排除退役的 Deno 入口（index.ts 带 npm: 说明符，Node 侧不认；
//    它也不在 TCB 函数的导入图里——TCB 入口在 dev/cloud-app/，见下）
const fnDir = join(ROOT, "functions");
const fnFiles = readdirSync(fnDir).filter((n) => n.endsWith(".mjs"));
for (const n of fnFiles) cpSync(join(fnDir, n), join(OUT, "functions", n));
// 2) CloudBase 函数入口三件套（tcb-app/tcb-db/tcb-storage）——**不在 functions/ 里**：
//    R115 的 Deno 入口普查会装配 functions/ 下每个 .mjs，Node 侧文件（import @cloudbase/node-sdk）
//    在 Deno 里解不了裸标识符会误报。它们的家与 dev/local-app/ 对等，部署时按仓库结构镜像过去。
const caDir = join(ROOT, "dev", "cloud-app");
for (const n of readdirSync(caDir).filter((x) => /^tcb-.*\.mjs$/.test(x))) cpSync(join(caDir, n), join(OUT, "dev", "cloud-app", n));
// 3) OpenAI 兼容传输（tcb-app 的模型接缝，与 dev/local-app、dev/cloud-app 共用同一份）
const blDir = join(ROOT, "dev", "backend-local");
for (const n of readdirSync(blDir).filter((x) => x.endsWith(".mjs"))) cpSync(join(blDir, n), join(OUT, "dev", "backend-local", n));
// 4) 部署清单
writeFileSync(join(OUT, "package.json"), `${JSON.stringify({
  name: "jiuyijian-tcb-app",
  private: true,
  type: "module",
  scripts: { start: "node dev/cloud-app/tcb-app.mjs" },
  dependencies: { "@cloudbase/node-sdk": "^3.18.3" },
}, null, 2)}\n`, "utf8");
// 4b) scf_bootstrap：SCF 自定义运行时的入口（与 jlau-ai-assistant 同 env 同款形状：不传 handler，
//     平台跑这个脚本；应用自己听 PORT||9000）。exec 让信号直达 node，收停时能把落盘队列冲完。
writeFileSync(join(OUT, "scf_bootstrap"), "#!/bin/bash\nexec node dev/cloud-app/tcb-app.mjs\n", { mode: 0o755, encoding: "utf8" });
// 4c) **随包装依赖**：HTTP 函数不支持云端装依赖（`--install-dependency true` 对 HTTP 函数无效，
//     Node 22+ 运行时干脆禁了云安装）⇒ node_modules 必须打进上传包。这一步放在 staging 里而不是
//     留给部署者手打——2026-10-19 实测过：stage 会 rm -rf 整个输出目录，重新 stage 后漏掉 install
//     直接部署，函数启动即崩（裸导入找不到 @cloudbase/node-sdk，所有请求 443 空响应）。
//     装完顺手自证：包里的 node_modules/@cloudbase/node-sdk 必须真的在。
const npmInstall = spawnSync("npm", ["install", "--omit=dev", "--no-fund", "--no-audit"], {
  cwd: OUT, stdio: "inherit", shell: process.platform === "win32",
});
if (npmInstall.status !== 0) { console.error(`拒绝：staging 目录里 npm install 失败（退出码 ${npmInstall.status}）`); process.exit(2); }
if (!existsSync(join(OUT, "node_modules", "@cloudbase", "node-sdk", "package.json"))) {
  console.error("拒绝：装完了但 node_modules/@cloudbase/node-sdk 不在——上传包里没有它，函数启动即崩");
  process.exit(2);
}

// 4) 上传面自检：凭证形状零容忍（与 dev/credential-shape-scan.mjs 同一条红线，这里是上传前的最后一道）。
//    扫描面＝上传包里的三个代码目录（functions／cloud-app／backend-local），按目录各自读。
//    wbpk 前缀那条形状按仓库同款写法（credential-shape-scan.mjs:40 的注释）拼出来构造：
//    源码文本里不存在那个连续字面量——否则 export 的字面扫描会把「检测器自己」当成泄漏命中，
//    而探测能力一字不少（拼出来的正则是同一条）。
const SECRET_SHAPES = [
  new RegExp(["wbpk", "_", "[A-Za-z0-9]{8,}"].join("")),
  /sk-[A-Za-z0-9]{16,}/,
  /SILICONFLOW_API_KEY\s*=\s*["'][^"']+["']/,
];
const scanDirs = [["functions", join(OUT, "functions")], ["dev/cloud-app", join(OUT, "dev", "cloud-app")], ["dev/backend-local", join(OUT, "dev", "backend-local")]];
let hits = 0;
let scanned = 0;
for (const [label, dir] of scanDirs) {
  for (const n of readdirSync(dir)) {
    if (!n.endsWith(".mjs")) continue;
    scanned += 1;
    const text = readFileSync(join(dir, n), "utf8");
    for (const re of SECRET_SHAPES) if (re.test(text)) { console.error(`凭证形状命中：${label}/${n} → ${re}`); hits += 1; }
  }
}
if (!scanned) { console.error("拒绝：上传面一个 .mjs 都没扫到（staging 坏了？）"); process.exit(2); }
if (hits) { console.error(`拒绝：上传面有 ${hits} 处凭证形状`); process.exit(2); }

console.log(`staged → ${OUT}`);
console.log(`  functions: ${readdirSync(join(OUT, "functions")).length} 个 .mjs｜cloud-app: ${readdirSync(join(OUT, "dev", "cloud-app")).length} 个｜backend-local: ${readdirSync(join(OUT, "dev", "backend-local")).length} 个｜扫过 ${scanned} 个・凭证形状 0 处`);
console.log("  入口：node dev/cloud-app/tcb-app.mjs（PORT 由平台注入；TCB 凭据函数运行时隐式提供）");
