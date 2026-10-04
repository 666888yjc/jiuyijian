/**
 * hash 路由的路径/查询分离（纯函数，node 可直跑做断言）。
 *
 * 背景：路由是 hash 式（navigate("/t/x/review?field=f1") → location.hash）。
 * App.tsx 原来直接 path.split("/")，查询串会让 parts[2] 变成 "review?field=f1"
 * 而落进 NotFound。HE-09 需要"排除列表逐条跳核对页指定字段"，查询串是
 * 最不改动既有路由形状的传参方式，故先补这个分离函数。
 *
 * 只做分离，不做默认值猜测：没有查询串时 query 为空 Map，调用方自行决定
 * 要不要理会——与产品其他降级路径一样，不假装有参数。
 */
export function splitHashPath(path: string): { pathname: string; query: URLSearchParams } {
  const i = path.indexOf("?");
  if (i < 0) return { pathname: path, query: new URLSearchParams() };
  return { pathname: path.slice(0, i), query: new URLSearchParams(path.slice(i + 1)) };
}
