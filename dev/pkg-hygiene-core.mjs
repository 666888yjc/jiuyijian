// 交付包卫生判定核（R152）：找出「一个文件都没有」的目录壳。
//
// 为什么需要它：`dev/sync-b1.mjs` 的镜像清理只删**文件**——`walkFiles` 只回文件、
// rmSync 也只落在文件上。于是包内 `app/dist-mutant-<pid>` 这一类变测 debris
// （包内自检 B 项跑 `gates/dist-audit-mutate` 的泄漏，或中途被进程杀掉的残留）
// 的**文件**每次刷新都被当陈旧文件删掉，空目录却永远留在交付包里：2026-10-18 现读
// 6 个（pid 分属不同轮次，各含 2 个空子目录、0 个文件，且不在 SHA256SUMS 的 attest 范围）。
//
// 口径（壳从宽、删从窄）：
//   · 壳＝其下（递归、不跳过任何目录）一个文件都没有的目录。`.stale-*` 反举证证据
//     是**文件**，装着它的目录因此不在收割范围——attest 面不受影响；
//   · 含 node_modules 的目录只要模块里有文件就不是壳；只有整个空掉的才连模块一起收
//     （空模块零信息，收掉不丢任何被 attest 的东西）。
// 本模块不写盘：只回答"哪些目录是壳"（自底向上），删不删由调用方决定——
// 判据层因此能不落盘地打它，变异件也只需要换判断串。
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * @param {string} base 要扫描的目录（交付包里被计划 owns 的顶层目录，或测试夹具根）
 * @returns {string[]} 壳目录的绝对路径，自底向上（子在前父在后，调用方按序删不会挡住子级）
 */
export function findEmptyDirs(base) {
  const shells = [];
  // 后序：先问孩子们有没有文件，再决定自己是不是壳。返回值＝这棵子树里有没有文件。
  const visit = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false; // base 不存在或不是目录：无从判定，不当壳报
    }
    let hasFileBeneath = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (visit(path.join(dir, entry.name))) hasFileBeneath = true;
      } else {
        hasFileBeneath = true; // 直接子项就是文件——这一格不许被"只看目录"的变异骗过去
      }
    }
    if (!hasFileBeneath) shells.push(dir);
    return hasFileBeneath;
  };
  visit(base);
  return shells;
}
