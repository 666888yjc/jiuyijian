// 上传体积护栏的唯一出处，以及"太大时先压一层再存"的处理。
//
// 为什么必须有这个模块（2026-09-27 用户实测反馈"手机照片根本传不上来，都大于 10MB"）：
// 10MB 不是我们的产品选择，而是**平台对象存储的单文件上限**（Sites Storage `file_size_limit=10485760`，
// 且管理接口在本通道不可用 ⇒ 我们无法调高它）。此前超限就直接拒，于是"拍照→上传"这条最主的路径
// 在手机上基本走不通（现代手机主摄 1200 万像素起，文档模式/全景/连拍动辄 12–30MB）。
//
// 所以这里做两件事：
// ① 上限只有一个数，页面文案、输入框说明、护栏判断都从这一处出（此前 `DocsPage` 里手抄了三遍）；
// ② 图片超限时**先在本地压到限内再传**——不是把照片丢掉，而是存一份仍然看得清、
//    能作为交接单证据的副本；并且必须把"存的是压缩副本"如实说给家属，
//    不能让他以为服务器上躺着手机里那张原图（红线③：不许声称它没有做到的可回溯）。
//
// PDF 走不通这条路：重新编码 PDF 需要引入新的解析/压缩依赖（不在本轮范围，也不该偷偷塞依赖），
// 所以超限的 PDF 仍然拒收，但要把原因和出路说清楚，并强调手工录入永远可用。

/** 平台对象存储的单文件上限（10 MiB）。调高它要平台侧改配额，改我们这里的数没有用。 */
export const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

/** 留一点余量：压到 9.2MB 以下再收手，避免边界值在传输环节被判超限。 */
export const FIT_TARGET_BYTES = Math.floor(UPLOAD_LIMIT_BYTES * 0.92);

export function uploadLimitLabel(): string {
  return `${Math.round(UPLOAD_LIMIT_BYTES / (1024 * 1024))}MB`;
}

export function overUploadLimit(bytes: number): boolean {
  return bytes > UPLOAD_LIMIT_BYTES;
}

/** 手机上真正的拦路格式：iPhone 默认 HEIC/HEIF，多数浏览器不解码，`file.type` 还可能带空格的变体。 */
export function isHeic(mime: string): boolean {
  return /^image\/hei(c|f)$/i.test(mime.trim());
}

export interface FitResult {
  /** 最终用于保存/上传的文件（未超限时就是原件本身） */
  file: File;
  /** 是否被压过：决定要不要如实说明"存的是压缩副本" */
  compressed: boolean;
  originalBytes: number;
  storedBytes: number;
  /** 压不下来（极端大图）时给的原因码，交由文案层出话 */
  failed?: "decode_failed" | "canvas_unavailable" | "too_complex";
}

// 长边从 4032 起降：文档照片要保留住 A4 上小号打印字的可读性，1800px（识别通路用的那档）在纸面上偏小。
// 导出给回归层：下限是一道"证据还得看得见"的判据，不是实现细节。
export const EDGE_LADDER = [4032, 3200, 2560, 2048, 1600];
export const QUALITY_LADDER = [0.92, 0.86, 0.78, 0.7];

/**
 * 把超限图片压到存储上限以内；未超限原样返回。
 * 只走本机 canvas，不外传任何字节；编码固定 JPEG（服务端与识别通路都只认 JPEG/PNG/PDF）。
 */
export async function fitToUploadLimit(file: File, opts: { force?: boolean } = {}): Promise<FitResult> {
  const originalBytes = file.size;
  // force：HEIC 这类「本机可能打得开、但服务端与识别通路都不收」的格式，无论多大都必须转 JPEG。
  if (!opts.force && !overUploadLimit(originalBytes)) {
    return { file, compressed: false, originalBytes, storedBytes: originalBytes };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // 解码不了（HEIC 或坏文件）：交给调用方给格式建议，不假装"文件太大"。
    return { file, compressed: false, originalBytes, storedBytes: originalBytes, failed: "decode_failed" };
  }
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return { file, compressed: false, originalBytes, storedBytes: originalBytes, failed: "canvas_unavailable" };
    for (const edge of EDGE_LADDER) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITY_LADDER) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob) continue;
        if (blob.size <= FIT_TARGET_BYTES) {
          return {
            file: new File([blob], renameToJpeg(file.name), { type: "image/jpeg", lastModified: file.lastModified }),
            compressed: true,
            originalBytes,
            storedBytes: blob.size,
          };
        }
      }
    }
    // 全部档位都超限：留下的仍是原件，所以"存下多大"只能说原件的数——拿"试过的最小一份"冒充会编出一个存不进任何地方的数字。
    return { file, compressed: false, originalBytes, storedBytes: originalBytes, failed: "too_complex" };
  } finally {
    bitmap.close();
  }
}

/** 扩展名换成 .jpg：存的确实不再是原来那张 PNG/HEIC，文件名要跟着说真话。 */
export function renameToJpeg(name: string): string {
  const base = name.replace(/\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i, "").slice(0, 290);
  return `${base || "image"}.jpg`;
}

/** 给人看的一句话：说清存的是压缩副本、原图还在设备上。 */
export function compressedNotice(originalBytes: number, storedBytes: number): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return `照片过大，已压到 ${mb(storedBytes)}MB 保存（原来约 ${mb(originalBytes)}MB）；手机相册里的原图没有被改动。放大原件时看的是这份压缩副本。`;
}

/**
 * 三种"没保存"的说法。共同纪律：先说是哪个文件、再说为什么、最后给一条此刻就能做的出路；
 * 不许把"我们改不了平台配额"说成"文件有问题"，也不许承诺"重传就好"这种把同一堵墙再撞一遍的出路。
 */
export function fitFailureNotice(name: string, reason: NonNullable<FitResult["failed"]>, heic: boolean): string {
  if (heic) {
    return `「${name}」是 iPhone 常用的 HEIC 格式，这台设备的浏览器读不出它，这次没保存。请在 iPhone「设置 → 相机 → 格式」里选「兼容性最好」后重拍，或把这张图截图成 PNG 再传。`;
  }
  if (reason === "canvas_unavailable") {
    return `「${name}」这次没保存：这台设备的浏览器无法进行本机图片处理（内存不足或浏览器限制）。换浏览器或重启后再试一次即可；不想等的话，手工录入永远可用，录进来的内容同样会进入交接单，只是标为「自述」。`;
  }
  if (reason === "decode_failed") {
    return `「${name}」这次没保存：文件本身读不出图像内容（可能已损坏或不是浏览器支持的图片格式）。请重新拍摄，或在手机上另存为 JPG 后再传；不想等的话，手工录入永远可用。`;
  }
  return `「${name}」即使压到最低一档仍然超过 ${uploadLimitLabel()}，这次没保存。请重新拍一次（对准纸面、少留四周空白）；不想等的话，手工录入永远可用，录进来的内容同样会进入交接单，只是标为「自述」。`;
}

/** 超限 PDF：重新编码 PDF 要引入新依赖，不在本轮范围，所以如实拒收并给出立刻能做的出路。 */
export function pdfOversizeNotice(name: string): string {
  return `「${name}」超过 ${uploadLimitLabel()}——这是站点存储对单个文件的限制，我们自己改不了，PDF 又不能在手机上无损压小，所以这次没保存。可以把它按页拆成几个小于 ${uploadLimitLabel()} 的 PDF 分别上传，或直接手工录入（手工录入的内容同样会进入交接单，只是标为「自述」）。`;
}

/** 格式根本不支持：给出收哪些格式，以及不必等的出路。 */
export function formatUnsupportedNotice(name: string): string {
  return `「${name}」这个格式还不支持（只收照片 JPG／PNG、iPhone 照片 HEIC，以及 PDF）。请在手机上转成这几种再传，或直接手工录入——手工录入的内容同样会进入交接单，只是标为「自述」。`;
}

/**
 * 上传区那句格式＋体积说明。体积这一半**只在真要写对象存储时成立**：
 * 本机模式不往服务器写任何东西，那 10MB 上限对它不适用，说"超限会压小后保存"就是许诺一件不发生的事。
 */
export function uploadHint(serverUpload: boolean): string {
  return serverUpload
    ? `支持 JPG / PNG / HEIC / PDF（单个 ≤${uploadLimitLabel()}，超限照片会先在本机压小后保存）。`
    : "支持 JPG / PNG / HEIC / PDF。";
}
